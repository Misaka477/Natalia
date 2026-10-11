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
import { contentTokens } from "./text-tokens";

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

// --- the per-gap benchmark (W13) --------------------------------------------

/**
 * A synthesized capability task: what a NEW capability is measured by.
 *
 * The engineering benchmark above is fixed shell commands — it measures
 * the framework, and it cannot measure a capability that did not exist
 * when it was written. The user's design note fills that hole: from a
 * gap (the domain vector) plus seed facts, synthesize a task set for that
 * capability. A capability with no benchmark cannot be gated (G7 refuses
 * "unmeasured"), so this is the other half of L6.
 */
export type CapabilityTask = {
  id: string;
  /** The capability this task measures (the gap's name). */
  capability: string;
  /** The task text a turn would receive. */
  task: string;
  /** What a good answer contains or does — a rubric, not a gold answer. */
  expected: string;
  layer: "fast" | "full";
};

/**
 * Whether a synthesized task is about the capability at all.
 *
 * The filter is the point: an LLM asked to "generate benchmark tasks for
 * X" will happily produce tasks about anything, and an off-topic benchmark
 * is worse than no benchmark — it gates on the wrong thing and reports a
 * pass. A task whose content does not overlap the capability's own tokens
 * (or the seed facts') is dropped and counted.
 */
export function acceptCapabilityTask(input: {
  task: { task: string; expected: string };
  capability: string;
  seedFacts: readonly string[];
  minOverlap?: number;
}): { ok: boolean; overlap: number; reason: string } {
  const floor = input.minOverlap ?? 0.1;
  const domain = new Set([
    ...contentTokens(input.capability),
    ...input.seedFacts.flatMap((fact) => [...contentTokens(fact)]),
  ]);
  if (!domain.size)
    return {
      ok: false,
      overlap: 0,
      reason: "no domain tokens to measure against",
    };
  const taskTokens = contentTokens(`${input.task.task} ${input.task.expected}`);
  const shared = [...domain].filter((token) => taskTokens.has(token)).length;
  const overlap = shared / domain.size;
  if (overlap < floor)
    return {
      ok: false,
      overlap,
      reason: `the task is off-domain (overlap ${overlap.toFixed(2)} < ${floor}) — an off-topic benchmark gates on the wrong thing`,
    };
  return {
    ok: true,
    overlap,
    reason: `on-domain (overlap ${overlap.toFixed(2)})`,
  };
}

/**
 * Synthesize a per-capability benchmark through a sampler seam (the daemon
 * in the CLI, a scripted fake in tests). Every task passes the domain
 * filter; the dropped ones are counted, because a synthesizer that mostly
 * produces off-domain tasks is telling you the capability is not
 * expressible as tasks yet.
 */
export async function synthesizeCapabilityBenchmark(input: {
  capability: string;
  seedFacts: readonly string[];
  sampler: (prompt: string) => Promise<string>;
  count?: number;
  layer?: "fast" | "full";
}): Promise<{
  tasks: CapabilityTask[];
  dropped: number;
}> {
  const count = input.count ?? 4;
  const layer = input.layer ?? "fast";
  const prompt = [
    `Generate ${count} benchmark tasks for the capability: ${input.capability}.`,
    "Seed facts (the domain's own vocabulary):",
    ...input.seedFacts.map((fact) => `- ${fact}`),
    "",
    "Answer with a JSON array; each item:",
    '{"task": "<the task text a turn would receive>", "expected": "<what a good answer contains or does — a rubric, not a gold answer>"}',
    "Every task MUST be about the capability and use the seed facts' vocabulary.",
  ].join("\n");
  const answer = await input.sampler(prompt);
  const parsed = parseTaskArray(answer);
  const tasks: CapabilityTask[] = [];
  let dropped = 0;
  for (const [index, item] of parsed.entries()) {
    const verdict = acceptCapabilityTask({
      task: item,
      capability: input.capability,
      seedFacts: input.seedFacts,
    });
    if (!verdict.ok) {
      dropped += 1;
      continue;
    }
    tasks.push({
      id: `${input.capability}:${index}`,
      capability: input.capability,
      task: item.task,
      expected: item.expected,
      layer,
    });
  }
  return { tasks, dropped };
}

/** The sampler's JSON array, or nothing (a malformed answer drops all). */
function parseTaskArray(
  answer: string,
): Array<{ task: string; expected: string }> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(answer);
  const body = fenced ? fenced[1]! : answer;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const value: unknown = JSON.parse(body.slice(start, end + 1));
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => {
        const row = item as { task?: unknown; expected?: unknown };
        return typeof row.task === "string" && typeof row.expected === "string"
          ? { task: row.task, expected: row.expected }
          : undefined;
      })
      .filter((item): item is { task: string; expected: string } => !!item);
  } catch {
    return [];
  }
}
