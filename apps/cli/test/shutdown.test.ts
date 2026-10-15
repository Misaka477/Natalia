import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  exitAfterShutdown,
  settleShutdown,
  shutdownStepTimeoutMs,
} from "../src/command-helpers";

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
 * The exit must wait for the line to be WRITTEN, not for a guessed delay.
 *
 * Measured reasoning, not preference: a fixed 50ms sleep was the previous
 * mechanism, and it is wrong in both directions — too short and a redirected
 * console loses the last line (which is how "the last thing it printed"
 * becomes nothing, the reported symptom the sequence exists to fix), and
 * longer than needed is time the user spends watching a process that has
 * already finished. The write callback is the deterministic answer.
 */
test("exitAfterShutdown exits only after the shutdown line is written", () => {
  const written: string[] = [];
  const exits: number[] = [];
  let release: (() => void) | undefined;
  exitAfterShutdown(7, {
    write: (line, done) => {
      written.push(line);
      release = done;
    },
    exit: (code) => exits.push(code),
  });
  // The line is handed to the stream, and the process has NOT gone yet.
  expect(written).toHaveLength(1);
  expect(written[0]).toContain("exiting with code 7");
  expect(exits).toEqual([]);
  release?.();
  expect(exits).toEqual([7]);
});

test("exitAfterShutdown still exits when the write never completes", async () => {
  const exits: number[] = [];
  exitAfterShutdown(0, {
    write: () => {
      /* a stream that never calls back: a closed pipe */
    },
    exit: (code) => exits.push(code),
  });
  // Nothing is synchronous about the exit, even on the backstop path.
  expect(exits).toEqual([]);
  await Bun.sleep(1_200);
  expect(exits).toEqual([0]);
}, 10_000);

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
