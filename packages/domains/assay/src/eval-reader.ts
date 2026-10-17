import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Discovery G-c's base (the object-store study's "读 devref/eval 的任务
 * 格式"): the FrontierHarness Eval's frozen data read into a typed
 * shape. The eval is the EXTERNAL BASELINE — our internal runs (G-b's
 * same-prompt distribution) have no key joining them to these tasks, so
 * this module reads the baseline and the comparison layer names both
 * sides without inventing a join (the same discipline as G-a's dropped
 * prompt-group link).
 *
 * What the eval's shape is (verified against the frozen data):
 *  - `benchmark.json` — the frozen metadata (task/harness/configuration
 *    counts, the model, the canonical selection rule);
 *  - `results/eval-data.json` — the per-task outcome cells
 *    (`successful`/`expected` counts across a task's configurations)
 *    and the harness list;
 *  - `tasks/<name>/task.toml` — the task's own metadata (difficulty,
 *    category, the upstream dataset it came from).
 */

export type ExternalTask = {
  /** The task's id (e.g. `terminal-bench/regex-log`). */
  id: string;
  title: string;
  /** The configurations that ran this task (the eval's cell count). */
  expected: number;
  /** The successful runs across those configurations. */
  successful: number;
  /** successful/expected in [0,1], one decimal of percent inside 1000. */
  successRate: number;
  difficulty?: string;
  category?: string;
};

export type ExternalBenchmark = {
  name: string;
  status?: string;
  model?: string;
  taskCount: number;
  /** The harnesses that ran (the frozen metadata's declared count). */
  harnessCount: number;
  /** The harness CONFIGURATIONS the results carry (the data's own list). */
  configurationCount: number;
  tasks: ExternalTask[];
  /** The directory the data was read from (the face's provenance). */
  source: string;
};

/** The toml's `[metadata]` fields this module reads (difficulty/category). */
function readTomlMetadata(toml: string): {
  difficulty?: string;
  category?: string;
} {
  const metadata: { difficulty?: string; category?: string } = {};
  let inMetadata = false;
  for (const rawLine of toml.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inMetadata = line === "[metadata]";
      continue;
    }
    if (!inMetadata) continue;
    const match = line.match(/^(difficulty|category)\s*=\s*"([^"]*)"/u);
    if (match) metadata[match[1] as "difficulty" | "category"] = match[2];
  }
  return metadata;
}

/**
 * Reads the frozen eval directory. The read is ALL-OR-NOTHING for the
 * two JSON files (a half-read baseline is worse than none) and
 * best-effort for the per-task toml (a task's metadata absence must not
 * lose its outcome cells).
 */
export async function readExternalBenchmark(
  evalDir: string,
): Promise<ExternalBenchmark> {
  const benchmark = JSON.parse(
    await readFile(join(evalDir, "benchmark.json"), "utf8"),
  ) as {
    name?: string;
    status?: string;
    model?: string;
    harness_count?: number;
  };
  const data = JSON.parse(
    await readFile(join(evalDir, "results", "eval-data.json"), "utf8"),
  ) as {
    tasks: Array<{
      id: string;
      title: string;
      expected: number;
      successful: number;
      checkpoint?: string;
    }>;
    harnesses?: unknown;
  };
  const tasks: ExternalTask[] = [];
  for (const entry of data.tasks) {
    // The task's directory is the id's LAST segment (the eval's own
    // naming, verified against all 30 frozen tasks: the checkpoint label
    // is `ce-<seg>-v1`, the directory is `<seg>`).
    const taskDir = entry.id.split("/").pop() ?? entry.checkpoint ?? "";
    let metadata: { difficulty?: string; category?: string } = {};
    try {
      const toml = await readFile(
        join(evalDir, "tasks", taskDir, "task.toml"),
        "utf8",
      );
      metadata = readTomlMetadata(toml);
    } catch {
      // No toml (or no directory by that name): the outcome cells stay.
    }
    tasks.push({
      id: entry.id,
      title: entry.title,
      expected: entry.expected,
      successful: entry.successful,
      successRate: entry.expected
        ? Math.round((entry.successful / entry.expected) * 1000) / 1000
        : 0,
      ...(metadata.difficulty ? { difficulty: metadata.difficulty } : {}),
      ...(metadata.category ? { category: metadata.category } : {}),
    });
  }
  return {
    name: benchmark.name ?? "unknown",
    ...(benchmark.status ? { status: benchmark.status } : {}),
    ...(benchmark.model ? { model: benchmark.model } : {}),
    taskCount: tasks.length,
    harnessCount: benchmark.harness_count ?? 0,
    configurationCount: Array.isArray(data.harnesses)
      ? data.harnesses.length
      : 0,
    tasks,
    source: evalDir,
  };
}

/** One external task's full face: the cells plus its instruction. */
export type ExternalTaskDetail = ExternalTask & {
  /** The task's instruction — what a submit would carry as its prompt. */
  instruction: string;
  description?: string;
};

/**
 * One task's detail (G-c's adapter layer, the study's "外基准任务格式与
 * 我们 journal 轨迹的适配层"): the instruction read beside the outcome
 * cells, so a harness can submit the prompt and score the run.
 */
export async function loadExternalTask(
  evalDir: string,
  taskID: string,
): Promise<ExternalTaskDetail | undefined> {
  const benchmark = await readExternalBenchmark(evalDir);
  const task = benchmark.tasks.find((entry) => entry.id === taskID);
  if (!task) return undefined;
  const taskDir = taskID.split("/").pop() ?? "";
  const [instruction, toml] = await Promise.all([
    readFile(join(evalDir, "tasks", taskDir, "instruction.md"), "utf8").catch(
      () => "",
    ),
    readFile(join(evalDir, "tasks", taskDir, "task.toml"), "utf8").catch(
      () => "",
    ),
  ]);
  const description = toml.match(/^description\s*=\s*"([^"]*)"/mu)?.[1];
  return {
    ...task,
    instruction,
    ...(description ? { description } : {}),
  };
}
