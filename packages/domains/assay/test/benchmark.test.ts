import { expect, test } from "bun:test";
import {
  ENGINEERING_BENCHMARK,
  acceptCapabilityTask,
  checkSeparation,
  fastTaskIDs,
  fullTaskIDs,
  runBenchmark,
  synthesizeCapabilityBenchmark,
  tasksForLayer,
  type BenchmarkRunner,
} from "../src/benchmark";

/**
 * L6's benchmark layer: the separation rule and the layering.
 *
 * The load-bearing test is the injected variant: a candidate that raises
 * fitness while the benchmark drops must be REFUSED. A loop with only
 * fitness is an overfitting machine, and this is the test that keeps the
 * machine honest.
 */

/** A runner that answers per command (a scripted seam, no real commands). */
function scriptedRunner(
  results: Record<string, { exitCode: number; output?: string }>,
): BenchmarkRunner {
  return async (command) => {
    const entry = results[command];
    return {
      exitCode: entry?.exitCode ?? 0,
      output: entry?.output ?? "",
    };
  };
}

test("the benchmark is this repository's own engineering corpus, layered", () => {
  // A benchmark borrowed from somebody else's task list measures somebody
  // else's capabilities: the first set is our own typecheck, guards and
  // tests.
  expect(fastTaskIDs()).toContain("typecheck");
  expect(fastTaskIDs().length).toBeGreaterThan(0);
  expect(fullTaskIDs()).toContain("full-suite");
  // The fast layer is a strict subset of the whole set.
  for (const id of fastTaskIDs()) expect(fullTaskIDs()).not.toContain(id);
  expect(tasksForLayer({ layer: "fast" }).length).toBe(fastTaskIDs().length);
});

test("the fast subset gates every candidate and reports per-task outcomes", async () => {
  const fast = tasksForLayer({ layer: "fast" });
  const report = await runBenchmark({
    tasks: fast,
    runner: scriptedRunner({
      "bun run typecheck": { exitCode: 0, output: "clean" },
      "npm run guard:imports && npm run guard:deps": {
        exitCode: 1,
        output: "import guard failed",
      },
      "bun test ./packages/core/contracts/test ./packages/core/tools/test": {
        exitCode: 0,
      },
    }),
  });
  expect(report.passed).toBe(2);
  expect(report.failed).toBe(1);
  expect(report.passRate).toBeCloseTo(2 / 3, 10);
  expect(report.outcomes[1]).toMatchObject({
    taskID: "guards",
    ok: false,
    exitCode: 1,
  });
  // The summary is bounded (a full suite's output is not a report).
  expect(report.outcomes[1]!.summary.length).toBeLessThanOrEqual(2_000);
});

test("the separation rule refuses a fitness gain bought with a capability", () => {
  // THE injected variant: skill quality up 20%, benchmark down 5%. The
  // reference study's sentence, as a test.
  const regressed = checkSeparation({
    fitnessDelta: 0.2,
    benchmark: {
      outcomes: [],
      passed: 19,
      failed: 1,
      passRate: 0.95,
    },
    baselinePassRate: 1,
  });
  expect(regressed.ok).toBe(false);
  expect(regressed.reason).toContain("benchmark regressed 100% → 95%");
  expect(regressed.reason).toContain("a capability trade is a rejection");

  // A held benchmark with a fitness gain is accepted.
  const held = checkSeparation({
    fitnessDelta: 0.2,
    benchmark: { outcomes: [], passed: 3, failed: 0, passRate: 1 },
    baselinePassRate: 1,
  });
  expect(held.ok).toBe(true);
  expect(held.reason).toContain("benchmark held at 100%");

  // An unmeasured capability is not a passing one.
  const unmeasured = checkSeparation({
    fitnessDelta: 0.2,
    benchmark: undefined,
    baselinePassRate: 1,
  });
  expect(unmeasured.ok).toBe(false);
  expect(unmeasured.reason).toContain("unverified");
});

test("the full layer runs only for the top few (the layering's cost rule)", () => {
  // The fast subset is what every candidate pays; the full set is what the
  // top 3 pay. A benchmark that costs as much as the optimization gets
  // skipped the first time somebody is in a hurry.
  const fast = tasksForLayer({ layer: "fast" });
  const full = tasksForLayer({ layer: "full" });
  expect(full.length).toBeGreaterThan(0);
  expect(full.length).toBeLessThan(ENGINEERING_BENCHMARK.length);
  // Every candidate's gate is the fast layer alone.
  const candidateGate = tasksForLayer({ layer: "fast" }).map((task) => task.id);
  expect(candidateGate).not.toContain("full-suite");
});

test("a synthesized off-domain task is dropped — an off-topic benchmark gates on the wrong thing", async () => {
  // W13: an LLM asked to generate tasks for X will happily produce tasks
  // about anything. The filter is the point.
  const { tasks, dropped } = await synthesizeCapabilityBenchmark({
    capability: "retry backoff",
    seedFacts: ["exponential backoff", "jitter", "max attempts"],
    sampler: async () =>
      JSON.stringify([
        {
          task: "Does the retry backoff use exponential jitter within max attempts?",
          expected: "yes, with capped exponential backoff and jitter",
        },
        {
          task: "Bake a sourdough loaf with a poolish pre-ferment",
          expected: "a open crumb and a blistered crust",
        },
      ]),
  });
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.capability).toBe("retry backoff");
  expect(tasks[0]!.layer).toBe("fast");
  expect(dropped).toBe(1);

  // The overlap verdict is inspectable, not just a boolean.
  const verdict = acceptCapabilityTask({
    task: { task: "Bake a sourdough loaf", expected: "an open crumb" },
    capability: "retry backoff",
    seedFacts: ["exponential backoff", "jitter"],
  });
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toContain("off-domain");
});

test("a malformed sampler answer drops everything instead of inventing tasks", async () => {
  const { tasks, dropped } = await synthesizeCapabilityBenchmark({
    capability: "retry backoff",
    seedFacts: ["exponential backoff"],
    sampler: async () => "I'm sorry, I can't help with that.",
  });
  expect(tasks).toEqual([]);
  expect(dropped).toBe(0);
});
