import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { BenchTurnSubmitter } from "../src/external-bench-run";
import { runExternalBenchmark } from "../src/external-bench-run";

/**
 * G-c's outer half — the batch loop's contract, against the REAL frozen
 * eval: each task's instruction submitted, each join recorded, and
 * every failure carried as the task's own reason (a fake success is the
 * thing this loop must never produce).
 */

// The frozen-eval corpus is INPUT DATA (the surface reads whatever
// directory it is handed, or NATALIA_EVAL_DIR names). A previous revision
// pointed these tests at the repository's devref/eval — a gitignored
// developer corpus — which made the suite depend on state no clone has
// (CI failed with ENOENT on benchmark.json). The fixture below is the
// minimal REAL subset, committed: the full index and the 360-cell data,
// plus the two tasks these tests load. Point NATALIA_EVAL_DIR at the
// full corpus to run against it locally.
const EVAL_DIR = resolve(import.meta.dir, "fixtures/eval");

function submitter(
  answers: Record<
    string,
    { ok: true; turnID: string } | { ok: false; reason: string }
  >,
): BenchTurnSubmitter {
  return async (_prompt, taskID) =>
    answers[taskID] ?? { ok: false, reason: "unreachable" };
}

test("the loop submits each task's instruction and records the joins", async () => {
  const taskIDs = [
    "terminal-bench/regex-log",
    "terminal-bench/chess-best-move",
  ];
  const submitted: string[] = [];
  const joins: Array<{ taskID: string; turnID: string }> = [];
  const result = await runExternalBenchmark({
    dir: EVAL_DIR,
    taskIDs,
    submitTurn: async (prompt, taskID) => {
      submitted.push(prompt);
      // The REAL instructions carry the task's content (the oracle).
      expect(prompt.length).toBeGreaterThan(50);
      return { ok: true, turnID: `turn_${taskID}` };
    },
    recordJoin: async (input) => {
      joins.push(input);
      return { recorded: true, success: true };
    },
  });
  expect(result.benchmark).toBe("FrontierHarness Eval v1");
  expect(result.scanned).toBe(2);
  expect(result.recorded).toBe(2);
  expect(result.failed).toBe(0);
  expect(submitted).toHaveLength(2);
  expect(joins).toEqual([
    {
      taskID: "terminal-bench/regex-log",
      turnID: "turn_terminal-bench/regex-log",
    },
    {
      taskID: "terminal-bench/chess-best-move",
      turnID: "turn_terminal-bench/chess-best-move",
    },
  ]);
  for (const outcome of result.outcomes) {
    expect(outcome.recorded).toBe(true);
    expect(outcome.success).toBe(true);
    expect(outcome.reason).toBeUndefined();
  }
});

test("a submit failure is the task's own reason — nothing recorded, no fake success", async () => {
  const result = await runExternalBenchmark({
    dir: EVAL_DIR,
    taskIDs: ["terminal-bench/regex-log"],
    submitTurn: async () => ({ ok: false, reason: "no provider configured" }),
    recordJoin: async () => ({ recorded: true, success: true }),
  });
  expect(result.recorded).toBe(0);
  expect(result.failed).toBe(1);
  expect(result.outcomes[0]).toMatchObject({
    recorded: false,
    reason: "no provider configured",
  });
  // The join recorder was never reached for a failed submit.
  expect(result.outcomes[0]!.success).toBeUndefined();
});

test("a turn with no score answers the join without a success (never invented)", async () => {
  const result = await runExternalBenchmark({
    dir: EVAL_DIR,
    taskIDs: ["terminal-bench/regex-log"],
    submitTurn: async () => ({ ok: true, turnID: "turn_x" }),
    recordJoin: async () => ({ recorded: true }),
  });
  expect(result.recorded).toBe(1);
  expect(result.outcomes[0]).toMatchObject({ recorded: true });
  // success stays undefined (the journal had no finish — defensive,
  // never zero-invented).
  expect(result.outcomes[0]!.success).toBeUndefined();
});

test("the cap narrows a workspace-wide batch, and the join failure is carried", async () => {
  const capped = await runExternalBenchmark({
    dir: EVAL_DIR,
    limit: 3,
    submitTurn: async () => ({ ok: true, turnID: "turn_x" }),
    recordJoin: async () => ({ recorded: false, success: false }),
  });
  expect(capped.scanned).toBe(3);
  expect(capped.recorded).toBe(0);
  expect(capped.failed).toBe(3);
  for (const outcome of capped.outcomes)
    expect(outcome).toMatchObject({
      recorded: false,
      reason: "join_not_recorded",
    });
});
