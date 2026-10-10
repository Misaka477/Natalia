/**
 * L6's benchmark layer: a fixed capability task set that gates candidates
 * INDEPENDENTLY of fitness.
 *
 * The reference study's clearest rule: "A variant that improves skill
 * quality by 20% but drops TBLite by 5% is REJECTED." Fitness measures the
 * thing being optimized; the benchmark measures everything else. A loop
 * with only fitness is an overfitting machine — it will happily trade a
 * capability it was not asked about for the one it was.
 *
 * The layering is theirs too: a FAST subset gates every candidate (cheap,
 * runs always), the FULL set runs only for the top few (expensive, runs
 * rarely). A benchmark that costs as much as the optimization itself gets
 * skipped the first time somebody is in a hurry.
 *
 * The tasks themselves are this repository's own engineering corpus —
 * typecheck, the test suite, one real defect fix — because a benchmark
 * borrowed from somebody else's task list measures somebody else's
 * capabilities. The runner is a seam (the caller executes the commands);
 * this module owns the task set's shape, the layering, and the separation
 * rule.
 */

/** One benchmark task: a command, and what "passing" means for it. */
export type BenchmarkTask = {
  id: string;
  /** The command the runner executes (a shell string, like validation's). */
  command: string;
  /** Which layer this task belongs to. */
  layer: "fast" | "full";
  /** What the task measures, in words (the report names it). */
  measures: string;
};

/** The runner seam: one command in, its exit code out. */
export type BenchmarkRunner = (command: string) => Promise<{
  exitCode: number;
  output: string;
}>;

/** One task's outcome for one candidate. */
export type BenchmarkOutcome = {
  taskID: string;
  ok: boolean;
  exitCode: number;
  /** The bounded safe output (the runner redacts; we bound again). */
  summary: string;
};

export type BenchmarkReport = {
  outcomes: BenchmarkOutcome[];
  passed: number;
  failed: number;
  /** The pass rate over the tasks that ran. */
  passRate: number;
};

/**
 * The first benchmark: this repository's own engineering corpus. The fast
 * layer is the cheap, broad check (typecheck); the full layer is the
 * expensive, deep one (the whole suite plus a real repair task).
 */
export const ENGINEERING_BENCHMARK: readonly BenchmarkTask[] = [
  {
    id: "typecheck",
    command: "bun run typecheck",
    layer: "fast",
    measures: "the whole tree still compiles",
  },
  {
    id: "guards",
    command: "npm run guard:imports && npm run guard:deps",
    layer: "fast",
    measures: "the architecture guards still hold",
  },
  {
    id: "core-tests",
    command:
      "bun test ./packages/core/contracts/test ./packages/core/tools/test",
    layer: "fast",
    measures: "the kernel's contracts and tools still behave",
  },
  {
    id: "full-suite",
    command: "bun test ./packages/framework/client/test",
    layer: "full",
    measures: "the runtime's real boot path still behaves",
  },
];

/** The fast layer's ids (every candidate's gate). */
export function fastTaskIDs(
  tasks: readonly BenchmarkTask[] = ENGINEERING_BENCHMARK,
): string[] {
  return tasks.filter((task) => task.layer === "fast").map((task) => task.id);
}

/** The full layer's ids (the top few only). */
export function fullTaskIDs(
  tasks: readonly BenchmarkTask[] = ENGINEERING_BENCHMARK,
): string[] {
  return tasks.filter((task) => task.layer === "full").map((task) => task.id);
}

/** Run the given tasks through the runner, bounding each summary. */
export async function runBenchmark(input: {
  tasks: readonly BenchmarkTask[];
  runner: BenchmarkRunner;
}): Promise<BenchmarkReport> {
  const outcomes: BenchmarkOutcome[] = [];
  for (const task of input.tasks) {
    const result = await input.runner(task.command);
    outcomes.push({
      taskID: task.id,
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      summary: result.output.slice(0, 2_000),
    });
  }
  const passed = outcomes.filter((outcome) => outcome.ok).length;
  return {
    outcomes,
    passed,
    failed: outcomes.length - passed,
    passRate: outcomes.length ? passed / outcomes.length : 0,
  };
}

/**
 * The separation rule: fitness and the benchmark are independent axes, and
 * a candidate must not trade one for the other.
 *
 * A candidate that raises fitness while the benchmark REGRESSES is refused
 * — that is the whole point of having a benchmark. A candidate that raises
 * fitness while the benchmark is merely unverified is also refused: an
 * absent check is not a passing check (the gate matrix's G7 rule, applied
 * to the same question).
 */
export type SeparationVerdict =
  | { ok: true; reason: string }
  | { ok: false; reason: string };

export function checkSeparation(input: {
  fitnessDelta: number;
  benchmark: BenchmarkReport | undefined;
  /** The baseline's benchmark pass rate (the regression's denominator). */
  baselinePassRate: number;
}): SeparationVerdict {
  if (!input.benchmark)
    return {
      ok: false,
      reason:
        "benchmark unverified — a candidate may not land on an unmeasured capability",
    };
  const rate = input.benchmark.passRate;
  if (rate < input.baselinePassRate)
    return {
      ok: false,
      reason:
        `benchmark regressed ${(input.baselinePassRate * 100).toFixed(0)}% → ${(rate * 100).toFixed(0)}% ` +
        `while fitness moved ${input.fitnessDelta >= 0 ? "+" : ""}${input.fitnessDelta.toFixed(4)} — ` +
        "a capability trade is a rejection, not a bargain",
    };
  return {
    ok: true,
    reason: `benchmark held at ${(rate * 100).toFixed(0)}% (baseline ${(input.baselinePassRate * 100).toFixed(0)}%)`,
  };
}

/**
 * The layering: the fast subset gates EVERY candidate; the full set runs
 * only for the top few. `topCount` is how many candidates get the full
 * layer (the reference study's 3).
 */
export function tasksForLayer(input: {
  layer: "fast" | "full";
  tasks?: readonly BenchmarkTask[];
}): BenchmarkTask[] {
  const tasks = input.tasks ?? ENGINEERING_BENCHMARK;
  return tasks.filter((task) => task.layer === input.layer);
}
