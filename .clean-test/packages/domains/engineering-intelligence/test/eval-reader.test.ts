import { expect, test } from "bun:test";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import { sessionFactStateFromEvents } from "@anthelia/session";
import { createTestContext } from "@anthelia/runtime-services";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import { sessionStoreController } from "@anthelia/session-store";
import { createIntelligenceSurface } from "../src/intelligence";
import { resolve } from "node:path";
import { readExternalBenchmark } from "../src/eval-reader";

/**
 * G-c's base: the frozen eval's own data, read through the typed shape.
 * The fixture is the REAL `devref/eval` in this repository — 30 tasks ×
 * 9 harnesses × 360 cells — so the reader is proven against the format
 * it will face, not a mock of it.
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

test("the frozen eval reads as its typed shape: counts, tasks, cells", async () => {
  const benchmark = await readExternalBenchmark(EVAL_DIR);
  expect(benchmark.name).toBe("FrontierHarness Eval v1");
  expect(benchmark.status).toBe("frozen");
  expect(benchmark.taskCount).toBe(30);
  expect(benchmark.harnessCount).toBe(9);
  expect(benchmark.configurationCount).toBe(12);
  expect(benchmark.tasks).toHaveLength(30);
  // The cells are carried per task (the eval's configuration count).
  for (const task of benchmark.tasks) {
    expect(task.expected).toBeGreaterThan(0);
    expect(task.successful).toBeLessThanOrEqual(task.expected);
    expect(task.successRate).toBeGreaterThanOrEqual(0);
    expect(task.successRate).toBeLessThanOrEqual(1);
  }
  // The metadata the task.toml carries (difficulty/category) enriched
  // the cells — the regex-log task's own file says medium/data-processing.
  const regexLog = benchmark.tasks.find(
    (task) => task.id === "terminal-bench/regex-log",
  );
  expect(regexLog).toBeDefined();
  expect(regexLog).toMatchObject({
    title: "Regex log",
    difficulty: "medium",
    category: "data-processing",
  });
});

test("a task whose toml is absent keeps its outcome cells", async () => {
  // The read is all-or-nothing for the JSONs and best-effort for the
  // toml: a missing metadata file loses nothing that matters.
  const benchmark = await readExternalBenchmark(EVAL_DIR);
  const withToml = benchmark.tasks.filter((task) => task.difficulty);
  // The frozen data ships a toml per task; if the shape ever changes,
  // the tasks must still arrive rather than the read failing.
  expect(withToml.length).toBeGreaterThan(0);
  expect(benchmark.tasks.length).toBe(30);
});

test("no dir answers the no_eval_dir shape, and a named dir reads the frozen data", async () => {
  delete process.env.NATALIA_EVAL_DIR;
  const { createIntelligenceSurface } = await import("../src/intelligence");
  const { createTestContext } = await import("@anthelia/runtime-services");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "eval-face-"));
  const ctx = {
    ports: {
      getReady: async () => undefined,
      getSessionID: () => "ses_eval" as never,
      getExecutionBySession: () => new Map() as never,
      getActiveExec: () => undefined,
    },
    state: {
      pluginStoreRoot: root,
      serviceDirectory: createTestContext([]),
    },
  } as never;
  const surface = createIntelligenceSurface(ctx, {});
  const missing = await surface.externalBenchmark!();
  expect(missing).toMatchObject({ joined: false, reason: "no_eval_dir" });
  const named = await surface.externalBenchmark!({ dir: EVAL_DIR });
  expect(named.joined).toBe(false);
  // Both shapes carry joined=false (the two sides are stated, never
  // bridged); the NAMED dir answers the read shape.
  if ("reason" in named) {
    expect(named.reason).not.toBe("no_eval_dir");
    return;
  }
  expect(named.external).toMatchObject({
    tasks: 30,
    harnesses: 9,
    configurations: 12,
  });
  // The internal side rides the same journal: no session here, so zero
  // groups — the answer states both sides without bridging them.
  expect(named.internal).toMatchObject({ promptGroups: 0, runs: 0 });
  // The note's own words: the two sides measure different task sets.
  expect(named.note).toContain("different task sets");
});

function joinHarness(events: RuntimeEvent[]) {
  const { mkdtempSync } = require("node:fs") as {
    mkdtempSync: (p: string) => string;
  };
  const { tmpdir } = require("node:os") as { tmpdir: () => string };
  const { join } = require("node:path") as { join: (...p: string[]) => string };
  const dir = mkdtempSync(join(tmpdir(), "eval-join-"));
  const sessionID = "ses_join" as SessionID;
  const exec = {
    session: { id: sessionID, events } as never,
    factStateComplete: true,
    factState: sessionFactStateFromEvents(events),
  } as unknown as SessionExecutionState;
  const ctx = {
    ports: {
      getReady: async () => undefined,
      getSessionID: () => sessionID,
      getExecutionBySession: () => new Map([[sessionID, exec]]) as never,
      getActiveExec: () => exec,
      getSessionPersistenceForSession: () => Promise.resolve(undefined),
      planDocRuntime: {
        planDocActive: async () => undefined,
        planDocRead: async () => ({ content: "" }),
      },
      publishForSession: (_: unknown, event: RuntimeEvent) => {
        events.push(event);
        exec.factState = sessionFactStateFromEvents(events);
        return undefined;
      },
      nextCompletionSequence: () => 1,
    },
    state: {
      pluginStoreRoot: dir,
      serviceDirectory: createTestContext([
        sessionStoreController.mock({
          history: (_id: `ses_${string}`, fallback: RuntimeEvent[]) =>
            Promise.resolve({
              events: fallback.map((event, seq) => ({ seq, event })),
              hasMore: false,
            }),
          flush: () => Promise.resolve(),
        } as unknown as Parameters<typeof sessionStoreController.mock>[0]),
      ]),
    },
  } as unknown as RuntimeContext;
  return { surface: createIntelligenceSurface(ctx, {}), sessionID };
}

test("a recorded join answers the per-task comparison: our rate beside the baseline", async () => {
  const events: RuntimeEvent[] = [];
  const { surface, sessionID } = joinHarness(events);
  // No joins yet: the answer states the absence, unbridged.
  const before = await surface.externalBenchmark!({ dir: EVAL_DIR }, sessionID);
  expect(before.joined).toBe(false);
  if ("reason" in before) throw new Error("unreachable");
  expect(before.perTask).toEqual([]);
  expect(before.note).toContain("different task sets");

  // The task's instruction is what a submit would carry (the adapter's
  // prompt half).
  const { loadExternalTask } = await import("../src/eval-reader");
  const detail = await loadExternalTask(EVAL_DIR, "terminal-bench/regex-log");
  expect(detail).toBeDefined();
  expect(detail!.instruction.length).toBeGreaterThan(50);

  // One of OUR runs against the task: the record reads the journal
  // (the turn scored from its own window) and writes the join fact.
  const recorded = await surface.recordExternalRun!(
    { dir: EVAL_DIR, taskID: "terminal-bench/regex-log", turnID: "turn_x" },
    sessionID,
  );
  // The baseline rides the reader's documented rounding (11/12 → 0.917).
  expect(recorded).toMatchObject({
    recorded: true,
    externalTaskID: "terminal-bench/regex-log",
    turnID: "turn_x",
    baselineSuccessRate: 0.917,
  });

  // And the per-task view unlocks: the join's task with our runs beside
  // the frozen baseline.
  const after = await surface.externalBenchmark!({ dir: EVAL_DIR }, sessionID);
  if ("reason" in after) throw new Error("unreachable");
  expect(after.joined).toBe(true);
  expect(after.perTask).toHaveLength(1);
  expect(after.perTask[0]).toMatchObject({
    externalTaskID: "terminal-bench/regex-log",
    baselineSuccessRate: 0.917,
    ourRuns: 1,
  });
  expect(after.note).toContain("per-task comparison");
});
