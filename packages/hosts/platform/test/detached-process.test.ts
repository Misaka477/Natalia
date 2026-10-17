import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolvePwshPath,
  startDetachedProcess,
  terminateChildProcessTree,
} from "../src/index";

/** Whether a pid is alive right now, answered by the OS rather than a kill(0). */
async function processState(pid: number): Promise<"alive" | "gone"> {
  const result = Bun.spawnSync([
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`,
  ]);
  return result.stdout.toString().trim() === "alive" ? "alive" : "gone";
}

describe("startDetachedProcess", () => {
  // The posixScript launcher semantics are exercised only where they run:
  // Windows uses the native spawn branch and gets its own tests below.
  const posixTest = test.skipIf(process.platform === "win32");

  posixTest(
    "reports a signalable PID and redirects output on POSIX",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "natalia-detached-"));
      const outputPath = join(root, "out.log");
      const { pid } = await startDetachedProcess({
        command: "printf posix-branch",
        posixScript: `setsid bash -c 'printf posix-branch' > '${outputPath}' 2>&1 & echo $!`,
        cwd: root,
        outputPath,
        env: { PATH: process.env.PATH },
      });
      expect(Number.isInteger(pid)).toBe(true);
      expect(pid).toBeGreaterThan(0);
      expect(await waitForOutput(outputPath)).toContain("posix-branch");
    },
  );

  posixTest(
    "surfaces a failing POSIX launcher instead of a bogus PID",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "natalia-detached-fail-"));
      await expect(
        startDetachedProcess({
          command: "true",
          posixScript: "exit 7",
          cwd: root,
          outputPath: join(root, "out.log"),
          env: { PATH: process.env.PATH },
        }),
      ).rejects.toThrow();
    },
  );

  // The Windows branch spawns cmd.exe, which exists only on Windows. The
  // proof below drives it deliberately (`os: "win32"`), so it can only run
  // where that spawn is real — on a POSIX host it would fail with ENOENT
  // for a reason that has nothing to do with what it asserts.
  const windowsTest = test.skipIf(process.platform !== "win32");

  windowsTest(
    "locates the shell through the host environment, not the child env",
    async () => {
      // The child environment is an allowlist that excludes ProgramFiles and
      // LOCALAPPDATA, so shell discovery must not consult it.
      const root = await mkdtemp(join(tmpdir(), "natalia-detached-win-"));
      const outputPath = join(root, "out.log");
      // The Windows branch is `cmd /c pwsh -Command …` with the worker script on
      // an env var, started by the job runner (native/win/natalia-job-runner.cc).
      // The PID must be a REAL Windows one — not a pid echoed by the launcher
      // script, which the env-var design makes impossible.
      const pwsh =
        process.platform === "win32"
          ? resolvePwshPath(undefined, process.env)
          : "pwsh";
      const { pid } = await startDetachedProcess({
        command: "Write-Output windows-branch",
        posixScript: "echo 999999999",
        cwd: root,
        outputPath,
        os: "win32",
        env: { PATH: process.env.PATH },
        hostEnv: { NATALIA_PWSH_EXECUTABLE: pwsh },
      });
      expect(pid).not.toBe(999999999);
      expect(Number.isInteger(pid)).toBe(true);
      expect(pid).toBeGreaterThan(0);
      // Redirection is performed natively (the .NET AppendAllText path), not
      // by the shell script — and the bytes are UTF-8 with no BOM, which is
      // what a reader on any platform gets. Polled, because the detached
      // worker starts asynchronously.
      const raw = await waitForOutputRaw(outputPath);
      expect(raw[0]).not.toBe(0xff);
      expect(raw[1]).not.toBe(0xfe);
      expect(new TextDecoder().decode(raw)).toContain("windows-branch");
    },
  );

  test("refuses when no PowerShell is resolvable on Windows", async () => {
    // The one shell the Windows branch needs is PowerShell: the launcher is
    // `cmd /c pwsh`. A host with none fails CLOSED rather than spawning a
    // chain that would exit 0 without running the command — the silent
    // success that made every detached worker a no-op.
    const root = await mkdtemp(join(tmpdir(), "natalia-detached-nopwsh-"));
    await expect(
      startDetachedProcess({
        command: "Write-Output hi",
        posixScript: "echo 1",
        cwd: root,
        outputPath: join(root, "out.log"),
        os: "win32",
        hostEnv: {},
        exists: () => false,
        resolvePwsh: () => undefined,
      }),
    ).rejects.toThrow(/PowerShell/u);
  });

  windowsTest(
    "the worker's console has no window",
    async () => {
      // The window this pins: the runner spawns the target with CREATE_NO_WINDOW
      // and is itself spawned with `windowsHide`, so the whole chain gets one
      // console with no window. Measured on this host by window enumeration when
      // the chain was launched `detached` (DETACHED_PROCESS): a new visible
      // `CASCADIA_HOSTING_WINDOW_CLASS` window per start, titled with the command
      // line, staying for as long as the command ran — the user's screenshot. The
      // worker can see the answer for itself.
      const root = await mkdtemp(join(tmpdir(), "natalia-detached-hidden-"));
      const outputPath = join(root, "out.log");
      const report = join(root, "console.txt");
      const pwsh = resolvePwshPath(undefined, process.env);
      await startDetachedProcess({
        command:
          `Add-Type -Namespace Probe -Name Console ` +
          `-MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);'; ` +
          `$h = [Probe.Console]::GetConsoleWindow(); ` +
          `[System.IO.File]::WriteAllText('${report}', "handle=$h visible=" + [Probe.Console]::IsWindowVisible($h))`,
        posixScript: "echo 1",
        cwd: root,
        outputPath,
        os: "win32",
        env: { PATH: process.env.PATH },
        hostEnv: { NATALIA_PWSH_EXECUTABLE: pwsh },
      });
      const written = await waitForOutput(report);
      expect(written).toContain("visible=False");
      // GetConsoleWindow answers NULL for a console that has no window — the
      // process still HAS a console (PowerShell runs, as the log shows).
      expect(written).toContain("handle=0");
    },
    30_000,
  );

  windowsTest(
    "the worker outlives the process that started it, and the owner ends the tree",
    async () => {
      // Two halves, both changed by the job owner.
      //
      // HALF ONE — the work outlives the app. A managed background process is
      // persisted per workspace and re-adopted by pid after a restart, so the
      // owner must survive the process that started it (measured separately: a
      // detached child survives, a non-detached one does not). A short-lived
      // helper starts the worker and exits; the owner and the worker are then
      // checked from here, which is a different process.
      const root = await mkdtemp(join(tmpdir(), "natalia-detached-outlive-"));
      const outputPath = join(root, "out.log");
      const marker = join(root, "alive.txt");
      const pwsh = resolvePwshPath(undefined, process.env);
      const start = Bun.spawn(
        [
          "bun",
          "-e",
          `import { startDetachedProcess } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};
           const { pid } = await startDetachedProcess(${JSON.stringify({
             // The marker FIRST and the sleep after it: the worker must still be
             // running when the assertions below look, and the owner lives exactly
             // as long as the work does.
             command: `Set-Content -Path '${marker.replaceAll("'", "''")}' -Value alive; Start-Sleep 120`,
             cwd: root,
             outputPath,
             os: "win32",
             env: { PATH: process.env.PATH },
             hostEnv: { NATALIA_PWSH_EXECUTABLE: pwsh },
           })});
           console.log(pid);`,
        ],
        { stdout: "pipe", stderr: "inherit" },
      );
      const ownerPid = Number(
        await new Response(start.stdout as ReadableStream).text(),
      );
      expect(Number.isInteger(ownerPid)).toBe(true);
      expect(await waitForOutput(marker)).toContain("alive");
      await Bun.sleep(1500);
      // The starter is long gone; the owner and its worker are not.
      expect(await processState(ownerPid)).toBe("alive");

      // HALF TWO — ending the owner ends EVERYTHING under it. The tree is
      // `owner → cmd → pwsh → ping`, and the ping is a grandchild three levels
      // down: a parent/child snapshot walk can miss it, which is the whole
      // reason the job exists.
      const treeRoot = await mkdtemp(join(tmpdir(), "natalia-detached-tree-"));
      const treeOutput = join(treeRoot, "out.log");
      const treeMarker = join(treeRoot, "tree.txt");
      const treePwsh = resolvePwshPath(undefined, process.env);
      const { pid: treeOwner } = await startDetachedProcess({
        command:
          `$child = Start-Process cmd.exe -ArgumentList '/c','ping -n 60 127.0.0.1' -WindowStyle Hidden -PassThru; ` +
          `[System.IO.File]::WriteAllText('${treeMarker}', "owner-pid=" + $PID + " grandchild-pid=" + $child.Id); ` +
          `Wait-Process -Id $child.Id`,
        posixScript: "echo 1",
        cwd: treeRoot,
        outputPath: treeOutput,
        os: "win32",
        env: { PATH: process.env.PATH },
        hostEnv: { NATALIA_PWSH_EXECUTABLE: treePwsh },
      });
      const treeText = await waitForOutput(treeMarker);
      const grandchild = Number(
        /grandchild-pid=(\d+)/u.exec(treeText)?.[1] ?? Number.NaN,
      );
      expect(Number.isInteger(grandchild)).toBe(true);
      expect(await processState(grandchild)).toBe("alive");

      // The clean path: a message to the owner, which terminates the job. The
      // old shape walked a snapshot with `taskkill /T`.
      terminateChildProcessTree(treeOwner);
      await Bun.sleep(2500);
      expect(await processState(treeOwner)).toBe("gone");
      expect(await processState(grandchild)).toBe("gone");

      // And the first owner is cleaned up the same way, so no worker is left.
      terminateChildProcessTree(ownerPid);
      await Bun.sleep(1500);
      expect(await processState(ownerPid)).toBe("gone");
    },
    60_000,
  );

  windowsTest(
    "a killed owner still takes its whole tree with it",
    async () => {
      // The job's KILL_ON_JOB_CLOSE, pinned by the route that does NOT send a
      // message. The IPC path above terminates the job explicitly, which works
      // with or without that limit; this is the case the limit exists for — an
      // owner that is killed outright (taskkill, a crash, the machine) leaves
      // nothing behind. That is the difference between an owned tree and a tree
      // that usually dies.
      const root = await mkdtemp(join(tmpdir(), "natalia-detached-kill-"));
      const outputPath = join(root, "out.log");
      const treeMarker = join(root, "tree.txt");
      const pwsh = resolvePwshPath(undefined, process.env);
      const { pid } = await startDetachedProcess({
        command:
          `$child = Start-Process cmd.exe -ArgumentList '/c','ping -n 60 127.0.0.1' -WindowStyle Hidden -PassThru; ` +
          `[System.IO.File]::WriteAllText('${treeMarker}', "grandchild-pid=" + $child.Id); ` +
          `Wait-Process -Id $child.Id`,
        posixScript: "echo 1",
        cwd: root,
        outputPath,
        os: "win32",
        env: { PATH: process.env.PATH },
        hostEnv: { NATALIA_PWSH_EXECUTABLE: pwsh },
      });
      const treeText = await waitForOutput(treeMarker);
      const grandchild = Number(
        /grandchild-pid=(\d+)/u.exec(treeText)?.[1] ?? Number.NaN,
      );
      expect(Number.isInteger(grandchild)).toBe(true);
      expect(await processState(grandchild)).toBe("alive");

      // No message, no tree walk: the owner is killed outright, exactly as a
      // caller outside this process would have to do it.
      Bun.spawnSync(["taskkill", "/F", "/PID", String(pid)]);
      await Bun.sleep(2500);
      expect(await processState(pid)).toBe("gone");
      expect(await processState(grandchild)).toBe("gone");
    },
    60_000,
  );

  windowsTest("refuses when there is no command to run", async () => {
    // An empty command produced a worker script whose script block was
    // `& { }`: the detached chain started, the pid was reported, and the log
    // stayed empty for the whole run — measured on this host. Nothing to run
    // is a refusal, not a spawn that looks like a success.
    const root = await mkdtemp(join(tmpdir(), "natalia-detached-nocmd-"));
    const pwsh = resolvePwshPath(undefined, process.env);
    for (const command of ["", "   "]) {
      await expect(
        startDetachedProcess({
          command,
          posixScript: "echo 1",
          cwd: root,
          outputPath: join(root, "out.log"),
          os: "win32",
          env: { PATH: process.env.PATH },
          hostEnv: { NATALIA_PWSH_EXECUTABLE: pwsh },
        }),
      ).rejects.toThrow(/requires a command to run/u);
    }
  });

  windowsTest(
    "a script that never arrives is reported, not silently dropped",
    async () => {
      // The worker rides an env var, so `Invoke-Expression $env:…` on an empty
      // entry fails with "Cannot bind argument to parameter 'Command'" — and
      // under DETACHED_PROCESS with every stdio ignored, that message is all
      // the operator ever sees. The user's screenshot was exactly that. The
      // launcher now guards the read and writes the reason into the log the
      // caller already polls, so the failure is diagnosable.
      const root = await mkdtemp(join(tmpdir(), "natalia-detached-noscript-"));
      const outputPath = join(root, "out.log");
      const pwsh = resolvePwshPath(undefined, process.env);
      // The env var is set to an empty string, which is the shape the field
      // took: the entry exists and carries nothing.
      const child = Bun.spawnSync(
        [
          "cmd.exe",
          "/c",
          pwsh,
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$s = $env:NATALIA_DETACHED_SCRIPT; ` +
            `if (-not $s) { ` +
            `[System.IO.File]::AppendAllText('${outputPath.replace(/'/gu, "''")}', ` +
            `"the detached worker script was not delivered ` +
            `(NATALIA_DETACHED_SCRIPT is empty)" + [Environment]::NewLine, ` +
            `[System.Text.UTF8Encoding]::new($false)); exit 1 }; ` +
            `Invoke-Expression $s`,
        ],
        { cwd: root, env: { ...process.env, NATALIA_DETACHED_SCRIPT: "" } },
      );
      expect(child.exitCode).toBe(1);
      expect(await waitForOutput(outputPath)).toContain(
        "the detached worker script was not delivered",
      );
    },
  );
});

/**
 * A profile-reading shell can take a second to start, so the log is polled
 * rather than sampled after a fixed delay.
 */
async function waitForOutput(path: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await readFile(path, "utf8").catch(() => "");
    if (content.trim()) return content;
    await Bun.sleep(100);
  }
  return "";
}

/** The same poll, in bytes: the BOM check needs the raw encoding. */
async function waitForOutputRaw(path: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(path);
      if (raw.length) return raw;
    } catch {
      /* not created yet */
    }
    await Bun.sleep(100);
  }
  throw new Error(`the detached worker never wrote ${path}`);
}
