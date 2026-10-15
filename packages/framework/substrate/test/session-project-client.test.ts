import { afterAll, expect, test } from "bun:test";

/**
 * A worker task that never answers must be TOLD it never answered.
 *
 * `run()` posted a message and waited for a reply with no deadline, so a
 * worker that never came up — a spawn that failed, a pool that starved, a
 * module the bundle could not resolve — left the promise pending forever. The
 * caller could not tell "slow" from "never", and the frontend's startup waits
 * on the first of these, so an unbounded one is what turned a broken worker
 * into a window that spun with no error anywhere.
 *
 * The deadline is read from the environment so this case can exercise it
 * without waiting out the production value.
 */
const saved = process.env.NATALIA_WORKER_TASK_TIMEOUT_MS;

afterAll(() => {
  if (saved === undefined) delete process.env.NATALIA_WORKER_TASK_TIMEOUT_MS;
  else process.env.NATALIA_WORKER_TASK_TIMEOUT_MS = saved;
});

test("runtimeWorkerTaskTimeoutMs honours a sane override and rejects a nonsense one", async () => {
  const { runtimeWorkerTaskTimeoutMs } = await import(
    "../src/session-project-client"
  );
  process.env.NATALIA_WORKER_TASK_TIMEOUT_MS = "400";
  expect(runtimeWorkerTaskTimeoutMs()).toBe(400);
  // Below the floor is nonsense: a deadline the scheduler cannot honour is
  // not a shorter deadline, it is a different bug.
  process.env.NATALIA_WORKER_TASK_TIMEOUT_MS = "10";
  expect(runtimeWorkerTaskTimeoutMs()).toBe(15_000);
  process.env.NATALIA_WORKER_TASK_TIMEOUT_MS = "not a number";
  expect(runtimeWorkerTaskTimeoutMs()).toBe(15_000);
  delete process.env.NATALIA_WORKER_TASK_TIMEOUT_MS;
  expect(runtimeWorkerTaskTimeoutMs()).toBe(15_000);
});

test("a real worker task settles, so the deadline is a bound and not the outcome", async () => {
  // The deadline exists for the case this file cannot provoke: a worker that
  // never comes up. What CAN be proven is the other half — that a worker
  // which does answer is not disturbed by the timer, and that the pool the
  // deadline watches is the one real work goes through.
  process.env.NATALIA_WORKER_TASK_TIMEOUT_MS = "300";
  const started = Date.now();
  const { runSessionProjectionInWorker } = await import(
    "../src/session-project-client"
  );
  const rows = await runSessionProjectionInWorker("planDocs", []);
  expect(Array.isArray(rows)).toBe(true);
  // Under the deadline, not near it: a budget the real worker routinely
  // loses is a deadline that fails healthy runs, which is the same defect
  // from the other side.
  expect(Date.now() - started).toBeLessThan(300);
});
