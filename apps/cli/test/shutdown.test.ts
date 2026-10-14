import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { settleShutdown, shutdownStepTimeoutMs } from "../src/command-helpers";

const repoRoot = resolve(import.meta.dir, "../../..");

/**
 * 20s, the runtime-condition budget the client harness documents: this
 * waits on a SPAWNED subprocess writing a file, which crosses a process
 * boundary — a 5s default is a lottery under the concurrent suite (a
 * different victim every run). The per-test cap still bounds a hang.
 */
async function waitForFile(path: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${path}`);
}

test("settleShutdown bounds a hung step and still runs the next one", async () => {
  process.env.NATALIA_SHUTDOWN_STEP_TIMEOUT_MS = "300";
  try {
    const calls: string[] = [];
    await settleShutdown("hung", () => new Promise<never>(() => {}));
    calls.push("after-hung");
    await settleShutdown("ok", async () => {
      calls.push("next-step");
    });
    expect(calls).toEqual(["after-hung", "next-step"]);
  } finally {
    delete process.env.NATALIA_SHUTDOWN_STEP_TIMEOUT_MS;
  }
});

test("settleShutdown swallows a failing step", async () => {
  process.env.NATALIA_SHUTDOWN_STEP_TIMEOUT_MS = "500";
  try {
    await settleShutdown("boom", async () => {
      throw new Error("nope");
    });
    expect(shutdownStepTimeoutMs()).toBe(500);
  } finally {
    delete process.env.NATALIA_SHUTDOWN_STEP_TIMEOUT_MS;
  }
});

/**
 * POSIX signals are the whole subject of the test below: the child is driven
 * by SIGINT delivered twice, and what is proven is that waitSignal absorbs the
 * repeat while the graceful path finishes instead of letting it hit the OS
 * default. Windows has no such signal — a spawned process there cannot be made
 * to raise one, so the child would sit in `await waitSignal()` until the test
 * timed out, which proves nothing about either side. The Windows shutdown path
 * is the RPC session shutdown, not a signal, and this drives none of it. So the
 * test runs where the signal exists and skips, saying why, where it does not.
 */
const posixTest = process.platform === "win32" ? test.skip : test;

posixTest(
  "waitSignal absorbs a repeated SIGINT so shutdown can finish",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "natalia-signal-"));
    const helper = resolve(repoRoot, "apps/cli/src/command-helpers.ts");
    const script = join(dir, "signal-probe.ts");
    const mark = (name: string) => JSON.stringify(join(dir, name));
    await writeFile(
      script,
      [
        `import { waitSignal } from ${JSON.stringify(helper)};`,
        `import { writeFileSync } from "node:fs";`,
        `writeFileSync(${mark("ready")}, "");`,
        `await waitSignal();`,
        `writeFileSync(${mark("shutdown-start")}, "");`,
        `await Bun.sleep(500);`,
        `writeFileSync(${mark("shutdown-done")}, "");`,
        `process.exit(0);`,
      ].join("\n"),
    );
    const child = Bun.spawn(["bun", script], {
      cwd: repoRoot,
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await waitForFile(join(dir, "ready"));
      child.kill("SIGINT");
      await waitForFile(join(dir, "shutdown-start"));
      // The old `process.once` listener was already removed, so this second
      // signal used to hit the OS default and abort the shutdown.
      child.kill("SIGINT");
      await waitForFile(join(dir, "shutdown-done"));
      const code = await child.exited;
      expect(code).toBe(0);
    } finally {
      child.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  },
);
