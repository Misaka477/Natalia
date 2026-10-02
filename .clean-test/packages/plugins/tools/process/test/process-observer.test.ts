import { afterEach, expect, test } from "bun:test";
import {
  ManagedProcessObserver,
  type ManagedProcessReadyEvent,
  type ManagedProcessSettledEvent,
} from "../src/process-tools";

/** A record the observer can see, standing in for the registry's own. */
function record(input: {
  id: string;
  status: string;
  pid?: number;
  workspaceRoot?: string;
}) {
  return {
    id: input.id,
    command: "sleep 1",
    status: input.status,
    workspaceRoot: input.workspaceRoot ?? "/ws",
    startedAt: "2026-01-01T00:00:00.000Z",
    ...(input.pid === undefined ? {} : { pid: input.pid }),
  };
}

/** A source whose liveness is decided by a set of live pids. */
function source(
  livePids: Set<number>,
  initial = [record({ id: "proc_1", status: "running", pid: 1 })],
) {
  let records = [...initial];
  const settled: Array<{ id: string; status: string }> = [];
  return {
    get records() {
      return records;
    },
    settled,
    snapshot: () => records,
    settle(input: { id: string; status: "exited" | "failed" }) {
      const info = records.find((candidate) => candidate.id === input.id);
      if (!info || info.status !== "running") return undefined;
      records = records.map((candidate) =>
        candidate.id === input.id
          ? {
              ...candidate,
              status: input.status,
              endedAt: "2026-01-01T00:00:01.000Z",
            }
          : candidate,
      );
      settled.push({ id: input.id, status: input.status });
      return {
        kind: "settled" as const,
        id: input.id,
        command: info.command,
        status: input.status,
        workspaceRoot: info.workspaceRoot,
        startedAt: info.startedAt,
        endedAt: "2026-01-01T00:00:01.000Z",
      };
    },
    setLive: (pid: number, alive: boolean) => {
      if (alive) livePids.add(pid);
      else livePids.delete(pid);
    },
    killImpl: (pid: number) => {
      if (livePids.has(pid)) return;
      const error = new Error("ESRCH") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    },
  };
}

/** An observer whose sweep uses the fake liveness, and whose clock is manual. */
function observerFor(input: {
  live: Set<number>;
  initial?: ReturnType<typeof record>[];
}) {
  const src = source(
    input.live,
    input.initial ?? [record({ id: "proc_1", status: "running", pid: 1 })],
  );
  const observer = new ManagedProcessObserver(src, {
    pollMs: 1_000,
    setTimer: (fn) => {
      return { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
  });
  // Restored by the `afterEach` below rather than by the test, so a failing
  // assertion cannot leak a stubbed `process.kill` into later tests.
  const previousKill = process.kill;
  process.kill = src.killImpl as typeof process.kill;
  restores.push(() => {
    process.kill = previousKill;
  });
  return { observer, src };
}

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

test("a sweep settles a process whose pid no longer answers", async () => {
  const live = new Set([1]);
  const harness = observerFor({ live });
  const seen: string[] = [];
  harness.observer.subscribe((event) => seen.push(event.id));
  harness.observer.sync();

  // The process dies, then the sweep runs.
  live.delete(1);
  await harness.observer.sweep();

  expect(harness.src.settled).toEqual([{ id: "proc_1", status: "exited" }]);
  expect(seen).toEqual(["proc_1"]);
});

test("a live process is left alone by the sweep", async () => {
  const live = new Set([1]);
  const harness = observerFor({ live });
  harness.observer.sync();

  await harness.observer.sweep();

  expect(harness.src.settled).toEqual([]);
});

test("the sweep is armed only while something is running", async () => {
  const live = new Set([1]);
  const harness = observerFor({ live });

  harness.observer.sync();
  expect(harness.observer.armed).toBe(true);

  // Nothing left running disarms it, so a session with no processes carries no
  // timer nobody needs.
  harness.src.snapshot().forEach((info) => {
    harness.src.settle({ id: info.id, status: "exited" });
  });
  harness.observer.sync();
  expect(harness.observer.armed).toBe(false);
});

test("a process that is already terminal is never re-settled", async () => {
  // A double settle would report one exit twice, and a notice that arrives twice
  // reads as two processes finishing.
  const live = new Set([1]);
  const harness = observerFor({ live });
  const seen: string[] = [];
  harness.observer.subscribe((event) => seen.push(event.id));
  harness.observer.sync();

  live.delete(1);
  await harness.observer.sweep();
  await harness.observer.sweep();

  expect(seen).toEqual(["proc_1"]);
});

test("a settled event carries the command and the workspace it ran in", async () => {
  const live = new Set([7]);
  const harness = observerFor({
    live,
    initial: [
      record({
        id: "proc_9",
        status: "running",
        pid: 7,
        workspaceRoot: "/other-ws",
      }),
    ],
  });
  const seen: Array<ManagedProcessSettledEvent | ManagedProcessReadyEvent> = [];
  harness.observer.subscribe((event) => seen.push(event));
  harness.observer.sync();

  live.delete(7);
  await harness.observer.sweep();

  expect(seen).toEqual([
    {
      kind: "settled",
      id: "proc_9",
      command: "sleep 1",
      status: "exited",
      workspaceRoot: "/other-ws",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
    },
  ]);
});

test("an unsubscribed sink stops receiving notices", async () => {
  const live = new Set([1]);
  const harness = observerFor({ live });
  const seen: string[] = [];
  const unsubscribe = harness.observer.subscribe((event) =>
    seen.push(event.id),
  );
  harness.observer.sync();

  unsubscribe();
  live.delete(1);
  await harness.observer.sweep();

  expect(seen).toEqual([]);
});

test("dispose disarms the sweep and drops every sink", async () => {
  const live = new Set([1]);
  const harness = observerFor({ live });
  harness.observer.sync();
  expect(harness.observer.armed).toBe(true);

  harness.observer.dispose();

  expect(harness.observer.armed).toBe(false);
});

test("a wait resolves as soon as the observer notices the exit", async () => {
  // The wait is a subscriber on the observer, so it fires on the sweep that
  // notices the exit rather than on its own timer.
  const live = new Set([1]);
  const harness = observerFor({ live });
  const registry = harness.observer;
  const src = harness.src;

  const waiting = new Promise<unknown>((resolve) => {
    registry.subscribe((event) => resolve(event));
  });
  // Drive a sweep by hand rather than waiting for the interval.
  live.delete(1);
  const swept = registry.sweep();

  const [event] = await Promise.all([waiting, swept]);
  expect((event as { id: string }).id).toBe("proc_1");
  expect(src.settled).toEqual([{ id: "proc_1", status: "exited" }]);
});

test("a second sweep does not re-notice a settled process", async () => {
  // The observer settles once, so a wait that started late still gets exactly one
  // notice rather than one per sweep.
  const live = new Set([1]);
  const harness = observerFor({ live });
  const seen: string[] = [];
  harness.observer.subscribe((event) => seen.push(event.id));

  live.delete(1);
  await harness.observer.sweep();
  await harness.observer.sweep();
  await harness.observer.sweep();

  expect(seen).toEqual(["proc_1"]);
});
