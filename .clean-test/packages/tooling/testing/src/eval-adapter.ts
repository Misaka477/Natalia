import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunScore } from "@natalia/engineering-intelligence";

/**
 * D6b — the external-benchmark adapter (G-c, "先内后外"): the
 * external eval benchmark's TASK format in (the gitignored `devref/eval`
 * reference carries the real zoo), our journal-scored rows out, in
 * THEIR results shape so their own reporting can place us.
 *
 * Two directions, one seam:
 *  - IN: a task directory (instruction.md + task.toml, parsed with
 *    bun's native TOML — no dependency) -> an EvalTaskDescriptor: the
 *    prompt plus the environment/verifier facts a runner needs;
 *  - OUT: injected execution (real runtime with keys, or a scripted
 *    harness in tests — docker/network live runs are the caller's
 *    environment, not this module's) -> rows in eval-data.json's
 *    vocabulary (id/title/completed/expected/successful/
 *    valid_coverage + a pass_rate overview), HONESTLY: fields we cannot
 *    measure are absent, never fabricated; infrastructure throws are
 *    counted as `infra_invalid_cells` and EXCLUDED from the pass rate
 *    (their published invariant: infra failures are not task failures).
 */

export type EvalTaskDescriptor = {
  id: string;
  title: string;
  instruction: string;
  language?: string;
  repository?: string;
  baseCommit?: string;
  dockerImage?: string;
  agentTimeoutSec?: number;
  verifierTimeoutSec?: number;
  collectCommands: string[];
};

export type EvalRunOutcome = {
  success: boolean;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  retries?: number;
};

export type EvalTaskRow = {
  id: string;
  title: string;
  completed: number;
  expected: number;
  successful: number;
  valid_coverage: number;
  /** Additive ours: the fields their vocabulary has no name for. */
  natalia?: {
    inputTokens: number;
    outputTokens: number;
    retries: number;
    infraInvalid: boolean;
  };
};

export type EvalReport = {
  generated_at: string;
  /** Marks the file as ours: same shape, not their run. */
  generated_by: "natalia";
  model: string;
  harnesses: Array<{ id: string; completed: number; pass_rate: number }>;
  overview: Record<string, number>;
  tasks: EvalTaskRow[];
};

/** The pure core: one task's files -> a runner-ready descriptor. */
export function parseEvalTask(input: {
  taskDirName: string;
  instruction: string;
  toml: string;
}): EvalTaskDescriptor {
  const tomlDoc = Bun.TOML.parse(input.toml) as {
    task?: { name?: string };
    metadata?: {
      task_id?: string;
      display_title?: string;
      language?: string;
      repository_url?: string;
      base_commit_hash?: string;
    };
    agent?: { timeout_sec?: number };
    verifier?: { timeout_sec?: number; collect?: Array<{ command?: string }> };
    environment?: { docker_image?: string };
  };
  const metadata = tomlDoc.metadata ?? {};
  const instruction = input.instruction.trim();
  if (!instruction)
    throw new Error(`${input.taskDirName}/instruction.md is empty`);
  if (!tomlDoc.task?.name && !metadata.task_id)
    throw new Error(`${input.taskDirName}/task.toml names no task`);
  return {
    // The canonical id is SOURCE-PREFIXED (`source_a/task-001`):
    // `task.name` carries it, `metadata.task_id` is only the bare slug,
    // and the manifest's task_ids — the row keys of the eval-data
    // vocabulary — match this form. The living-reference test caught the
    // distinction by parsing the real zoo.
    id: tomlDoc.task?.name ?? metadata.task_id ?? input.taskDirName,
    title: metadata.display_title || tomlDoc.task?.name || input.taskDirName,
    instruction,
    language: metadata.language,
    repository: metadata.repository_url,
    baseCommit: metadata.base_commit_hash,
    dockerImage: tomlDoc.environment?.docker_image,
    agentTimeoutSec: tomlDoc.agent?.timeout_sec,
    verifierTimeoutSec: tomlDoc.verifier?.timeout_sec,
    collectCommands: (tomlDoc.verifier?.collect ?? [])
      .map((entry) => entry.command)
      .filter((command): command is string => typeof command === "string"),
  };
}

export async function loadEvalTaskDir(
  dir: string,
): Promise<EvalTaskDescriptor> {
  const name = dir.split("/").pop() ?? dir;
  let instruction: string;
  let toml: string;
  try {
    instruction = await readFile(join(dir, "instruction.md"), "utf8");
    toml = await readFile(join(dir, "task.toml"), "utf8");
  } catch (error) {
    throw new Error(
      `${name}: not an eval task directory (${(error as Error).message})`,
    );
  }
  return parseEvalTask({ taskDirName: name, instruction, toml });
}

export async function loadEvalTaskDirs(
  tasksRoot: string,
): Promise<EvalTaskDescriptor[]> {
  const entries = await readdir(tasksRoot, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(tasksRoot, entry.name))
    .sort();
  const tasks: EvalTaskDescriptor[] = [];
  for (const dir of dirs) tasks.push(await loadEvalTaskDir(dir));
  return tasks;
}

export async function loadEvalBenchmark(benchmarkPath: string): Promise<{
  name: string;
  status: string;
  task_count: number;
  task_ids: string[];
  canonical_selection: string;
}> {
  let text: string;
  try {
    text = await readFile(benchmarkPath, "utf8");
  } catch (error) {
    throw new Error(
      `${benchmarkPath}: not an eval benchmark manifest (${(error as Error).message})`,
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `${benchmarkPath}: not an eval benchmark manifest (invalid JSON: ${(error as Error).message})`,
    );
  }
  if (typeof parsed.name !== "string" || !Array.isArray(parsed.task_ids))
    throw new Error(`${benchmarkPath}: not an eval benchmark manifest`);
  return parsed as never;
}

/**
 * The journal side of the bridge: a scored turn from D5 (segmentTurns +
 * scoreRun) IS the outcome of a real run — stopReason-derived success,
 * summed tokens, furthest-attempt retries. The type import is the
 * compile-time proof that OUR scorer's shape fits the seam.
 */
export function evalOutcomeFromScore(score: RunScore): EvalRunOutcome {
  return {
    success: score.success === true,
    inputTokens: score.inputTokens,
    outputTokens: score.outputTokens,
    durationMs: score.durationMs,
    retries: score.retries,
  };
}

/**
 * Runs tasks through an INJECTED executor and folds their outcomes into
 * the benchmark's results vocabulary. An executor throw = infra: the
 * row stays (completed/expected recorded) but the cell is marked
 * infra_invalid and EXCLUDED from the pass rate — their published
 * invariant, honored here.
 */
export async function runEvalTasks(
  tasks: readonly EvalTaskDescriptor[],
  execute: (task: EvalTaskDescriptor) => Promise<EvalRunOutcome>,
  options: { model: string; generatedAt?: string } = { model: "unknown" },
): Promise<EvalReport> {
  const rows: EvalTaskRow[] = [];
  let successfulTotal = 0;
  let validTotal = 0;
  let infraInvalid = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let retries = 0;
  for (const task of tasks) {
    let outcome: EvalRunOutcome | undefined;
    let infraInvalidRow = false;
    try {
      outcome = await execute(task);
    } catch {
      infraInvalidRow = true;
      infraInvalid += 1;
    }
    const ok = outcome?.success === true;
    if (!infraInvalidRow) {
      validTotal += 1;
      if (ok) successfulTotal += 1;
    }
    inputTokens += outcome?.inputTokens ?? 0;
    outputTokens += outcome?.outputTokens ?? 0;
    retries += outcome?.retries ?? 0;
    rows.push({
      id: task.id,
      title: task.title,
      completed: outcome ? 1 : 0,
      expected: 1,
      successful: ok && !infraInvalidRow ? 1 : 0,
      valid_coverage: infraInvalidRow ? 0 : 1,
      ...(infraInvalidRow || outcome
        ? {
            natalia: {
              inputTokens: outcome?.inputTokens ?? 0,
              outputTokens: outcome?.outputTokens ?? 0,
              retries: outcome?.retries ?? 0,
              infraInvalid: infraInvalidRow,
            },
          }
        : {}),
    });
  }
  const passRate = validTotal ? successfulTotal / validTotal : 0;
  return {
    generated_at: options.generatedAt ?? new Date().toISOString(),
    generated_by: "natalia",
    model: options.model,
    harnesses: [
      {
        id: "natalia-runtime",
        completed: rows.length,
        pass_rate: Number(passRate.toFixed(6)),
      },
    ],
    overview: {
      evaluation_count: rows.length,
      completed_cells: rows.length,
      expected_cells: rows.length,
      pass_rate: Number(passRate.toFixed(6)),
      success_rate_expected: Number(passRate.toFixed(6)),
      infra_invalid_cells: infraInvalid,
      total_input_tokens: inputTokens,
      total_output_tokens: outputTokens,
      total_retries: retries,
    },
    tasks: rows,
  };
}
