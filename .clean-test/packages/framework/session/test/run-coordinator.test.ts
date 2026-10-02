import { expect, test } from "bun:test";
import {
  releaseSessionRunCoordinator,
  SessionRunCoordinator,
  sessionRunCoordinator,
} from "../src";

test("joins concurrent runs for one session", async () => {
  const coordinator = new SessionRunCoordinator();
  let release: (() => void) | undefined;
  let runs = 0;
  const drain = async () => {
    runs++;
    await new Promise<void>((resolve) => (release = resolve));
  };
  const first = coordinator.run(drain);
  while (!release) await Bun.sleep(1);
  const second = coordinator.run(drain);
  expect(runs).toBe(1);
  release?.();
  await Promise.all([first, second]);
  expect(runs).toBe(1);
});

test("coalesces repeated wakes into one successor drain", async () => {
  const coordinator = new SessionRunCoordinator();
  let release: (() => void) | undefined;
  let runs = 0;
  const drain = async () => {
    runs++;
    if (runs === 1) await new Promise<void>((resolve) => (release = resolve));
  };
  const first = coordinator.run(drain);
  while (!release) await Bun.sleep(1);
  await Promise.all([
    coordinator.wake(drain),
    coordinator.wake(drain),
    coordinator.wake(drain),
  ]);
  release?.();
  await first;
  await coordinator.idle();
  expect(runs).toBe(2);
});

test("waking while idle starts a non-blocking drain", async () => {
  const coordinator = new SessionRunCoordinator();
  let runs = 0;
  await coordinator.wake(async () => {
    runs++;
  });
  await coordinator.idle();
  expect(runs).toBe(1);
});

test("wake during interruption cleanup starts one successor", async () => {
  const coordinator = new SessionRunCoordinator();
  let cleanup: (() => void) | undefined;
  let second = false;
  const first = async (signal: AbortSignal) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => (cleanup = resolve), {
        once: true,
      });
    });
  };
  const successor = async () => {
    second = true;
  };
  await coordinator.wake(first);
  while (!coordinator.active) await Bun.sleep(1);
  const interrupt = coordinator.interrupt();
  while (!cleanup) await Bun.sleep(1);
  await coordinator.wake(successor);
  cleanup?.();
  await interrupt;
  await coordinator.idle();
  expect(second).toBe(true);
});

test("same durable session ID shares a process-local coordinator", async () => {
  const first = sessionRunCoordinator("ses_shared");
  const second = sessionRunCoordinator("ses_shared");
  expect(second).toBe(first);
  await first.run(async () => undefined);
  expect(releaseSessionRunCoordinator("ses_shared")).toBe(true);
});
