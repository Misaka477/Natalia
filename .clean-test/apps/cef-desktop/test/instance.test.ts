import { expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSingleInstance,
  requestExit,
  requestShow,
} from "../src/instance";
import { resolve } from "node:path";

/** Absolute path to the module under test, for the child process. */
function resolveSourcePath(): string {
  return new URL("../src/instance.ts", import.meta.url).pathname;
}

function freshState(): string {
  return mkdtempSync(join(tmpdir(), "natalia-instance-"));
}

test("the first launch owns the lock and is not told it was already running", async () => {
  const state = freshState();
  const handle = await acquireSingleInstance({ stateDir: state });
  expect(handle.wasAlreadyRunning).toBe(false);
  await handle.close();
});

test("a second launch hands off to the first instead of starting a copy", async () => {
  const state = freshState();
  const first = await acquireSingleInstance({
    stateDir: state,
    onShow: () => undefined,
  });
  const second = await acquireSingleInstance({ stateDir: state });
  expect(second.wasAlreadyRunning).toBe(true);
  await second.close();
  await first.close();
});

test("the running instance is asked to show its window, and it answers", async () => {
  const state = freshState();
  let shows = 0;
  const owner = await acquireSingleInstance({
    stateDir: state,
    onShow: () => {
      shows += 1;
    },
  });
  expect(await requestShow({ stateDir: state })).toBe(true);
  expect(shows).toBe(1);
  // The explicit-exit entry point works too, which is the other half of
  // "close the window but keep running": the user needs a way OUT.
  let exits = 0;
  const quitting = await acquireSingleInstance({
    stateDir: state,
    appName: "natalia-exit",
    onExit: () => {
      exits += 1;
    },
  });
  expect(await requestExit({ stateDir: state, appName: "natalia-exit" })).toBe(
    true,
  );
  expect(exits).toBe(1);
  await quitting.close();
  await owner.close();
});

test("a killed instance's lock does not make the app unlaunchable", async () => {
  const state = freshState();
  // A REAL crash: a child process that takes the lock and is SIGKILLed, leaving
  // its socket file behind with nobody listening. This is the state a user hits
  // after a power loss or a kill -9, and the app must come back.
  const child = Bun.spawn(["bun", "-e", CRASH_PROGRAM(state)], {
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  const socket = join(state, "natalia.instance.sock");
  // Wait until it has actually taken the lock.
  const deadline = Date.now() + 5000;
  while (!existsSync(socket) && Date.now() < deadline) await Bun.sleep(20);
  expect(existsSync(socket)).toBe(true);
  child.kill(9);
  await child.exited;
  // The litter survives the kill.
  expect(existsSync(socket)).toBe(true);

  const revived = await acquireSingleInstance({ stateDir: state });
  expect(revived.wasAlreadyRunning).toBe(false);
  await revived.close();
  expect(existsSync(socket)).toBe(false);
});

test("a live foreign pid is not mistaken for this app's own dead lock", async () => {
  const state = freshState();
  const { writeFileSync } = await import("node:fs");
  const { spawn } = await import("node:child_process");
  // A real, live process that is not this app. The takeover path looks at pid
  // liveness to decide whether a socket-less record is litter, and it must not
  // conclude "dead" about a pid that exists.
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid!;
  writeFileSync(join(state, "natalia.instance.pid"), `${pid}\n`);
  let asked: number | undefined;
  const handle = await acquireSingleInstance({
    stateDir: state,
    isProcessAlive: (candidate) => {
      asked = candidate;
      return candidate === pid;
    },
  });
  // It consulted the recorded pid rather than assuming litter, and did not treat
  // another instance as running (there was no socket to hand off to).
  expect(asked).toBe(pid);
  expect(handle.wasAlreadyRunning).toBe(false);
  // The record now names the process that owns it.
  expect(readFileSync(join(state, "natalia.instance.pid"), "utf8").trim()).toBe(
    `${process.pid}`,
  );
  await handle.close();
  try {
    process.kill(pid, 9);
  } catch {
    /* already gone */
  }
});

/** The program the killed-lock test runs: take the lock, then wait forever. */
function CRASH_PROGRAM(state: string): string {
  return `
    const { acquireSingleInstance } = await import(${JSON.stringify(
      new URL("../src/instance.ts", import.meta.url).pathname,
    )});
    const handle = await acquireSingleInstance({ stateDir: ${JSON.stringify(state)} });
    console.log("READY");
    await new Promise(() => undefined);
  `;
}
