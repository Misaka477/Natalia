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

  test("locates the shell through the host environment, not the child env", async () => {
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
        ? resolvePwshPath({ env: process.env })
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
  });

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
