import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePwshPath, startDetachedProcess } from "../src/index";

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
      // The Windows branch is `cmd /c pwsh -Command …` with the worker script
      // on an env var: a console app under DETACHED_PROCESS exits 0 without
      // running its command, so cmd.exe is the survivor that carries it. The
      // fixture therefore points the host at the pwsh the resolver honours
      // (NATALIA_PWSH_EXECUTABLE), and the PID must be a REAL Windows one —
      // not a pid echoed by the launcher script, which the env-var design
      // makes impossible.
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
