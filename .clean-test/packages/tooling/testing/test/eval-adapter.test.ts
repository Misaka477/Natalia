import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";
import { scoreRun, segmentTurns } from "@natalia/engineering-intelligence";
import {
  evalOutcomeFromScore,
  loadEvalBenchmark,
  loadEvalTaskDir,
  loadEvalTaskDirs,
  parseEvalTask,
  runEvalTasks,
} from "../src/eval-adapter";

/**
 * D6b — the external-benchmark adapter: their task format in, our
 * journal-scored rows out, in their results vocabulary. Fixtures are a
 * copy of the external benchmark's manifest+task (devref is gitignored),
 * with the harness roster section dropped: it carries an upstream trace
 * name the import guard keeps out of the tree. When the live reference
 * exists it is parsed in full (the living check).
 */

const fixtures = join(import.meta.dir, "fixtures", "eval");
const liveRoot = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "devref",
  "eval",
);

test("a task directory parses into a runner-ready descriptor (all fields)", async () => {
  const task = await loadEvalTaskDir(
    join(fixtures, "tasks", "typed-variable-bindings"),
  );
  expect(task).toMatchObject({
    // task.name is the source-prefixed canonical id (matches the
    // manifest's task_ids); the directory is the bare slug.
    id: "source_a/typed-variable-bindings",
    title: "Add typed variable bindings",
    language: "go",
    repository: "https://example.invalid/repository",
    baseCommit: "0000000000000000000000000000000000000000",
    agentTimeoutSec: 5400,
    verifierTimeoutSec: 1800,
  });
  expect(task.instruction).toContain("TypedBindings"); // our own example instruction
  expect(task.dockerImage).toBe("example/base:1");
  expect(task.collectCommands).toHaveLength(1);
  expect(task.collectCommands[0]).toContain("git diff --binary");
});

test("malformed tasks fail loudly with the directory named", async () => {
  await expect(loadEvalTaskDir(join(fixtures, "no-such-task"))).rejects.toThrow(
    /not an eval task directory/u,
  );
  expect(() =>
    parseEvalTask({ taskDirName: "x", instruction: "", toml: "task.name='y'" }),
  ).toThrow(/instruction.md is empty/u);
  expect(() =>
    parseEvalTask({ taskDirName: "x", instruction: "ok", toml: "" }),
  ).toThrow(/names no task/u);
});

test("the benchmark manifest's invariants come through", async () => {
  const manifest = await loadEvalBenchmark(join(fixtures, "benchmark.json"));
  expect(manifest.name).toBe("eval-fixture/v1");
  expect(manifest.status).toBe("frozen");
  expect(manifest.task_count).toBe(30);
  expect(manifest.task_ids).toHaveLength(30);
  expect(manifest.canonical_selection).toBe("first valid attempt 1");
  // Existing file, invalid JSON: the error names file and cause.
  await expect(
    loadEvalBenchmark(
      join(fixtures, "tasks", "typed-variable-bindings", "instruction.md"),
    ),
  ).rejects.toThrow(/not an eval benchmark manifest \(invalid JSON/u);
  // Valid JSON, wrong shape: caught by the key validation.
  await expect(
    loadEvalBenchmark(join(import.meta.dir, "..", "package.json")),
  ).rejects.toThrow(/not an eval benchmark/u);
});

test("the living reference parses when present (gitignored devref, skipped otherwise)", async () => {
  if (!existsSync(liveRoot)) return; // a clone without devref: the frozen fixtures above carry the format
  const manifest = await loadEvalBenchmark(join(liveRoot, "benchmark.json"));
  expect(manifest.task_ids.length).toBeGreaterThan(0);
  const tasks = await loadEvalTaskDirs(join(liveRoot, "tasks"));
  expect(tasks.length).toBe(manifest.task_count);
  // Ids must land in the manifest's source-prefixed form: they are the
  // row keys of the eval-data vocabulary, so the bridge depends on them.
  expect(tasks.map((task) => task.id).sort()).toEqual(
    [...manifest.task_ids].sort(),
  );
});

test("execution folds into their results vocabulary with infra never scored as failure", async () => {
  const tasks = await loadEvalTaskDirs(join(fixtures, "tasks"));
  expect(tasks).toHaveLength(1);
  let call = 0;
  const report = await runEvalTasks(
    [
      tasks[0]!,
      { ...tasks[0]!, id: "t2", title: "two" },
      { ...tasks[0]!, id: "t3", title: "three" },
    ],
    async () => {
      call += 1;
      if (call === 3) throw new Error("docker unavailable"); // infra, not a task failure
      return {
        success: call === 1,
        inputTokens: 100,
        outputTokens: 20,
        durationMs: 900,
        retries: call === 2 ? 1 : 0,
      };
    },
    { model: "m-1", generatedAt: "2026-01-01T00:00:00.000Z" },
  );
  expect(report.generated_by).toBe("natalia");
  expect(report.model).toBe("m-1");
  expect(report.generated_at).toBe("2026-01-01T00:00:00.000Z");
  // 1 success of 2 VALID rows: the infra cell is excluded, not failed.
  expect(report.overview).toMatchObject({
    evaluation_count: 3,
    infra_invalid_cells: 1,
    pass_rate: 0.5,
    success_rate_expected: 0.5,
    total_input_tokens: 200,
    total_output_tokens: 40,
    total_retries: 1,
  });
  expect(report.tasks.map((row) => row.id)).toEqual([
    "source_a/typed-variable-bindings",
    "t2",
    "t3",
  ]);
  const infraRow = report.tasks.find((row) => row.id === "t3")!;
  expect(infraRow).toMatchObject({
    completed: 0,
    expected: 1,
    successful: 0,
    valid_coverage: 0,
  });
  expect(infraRow.natalia?.infraInvalid).toBe(true);
  expect(report.harnesses[0]).toMatchObject({
    id: "natalia-runtime",
    completed: 3,
    pass_rate: 0.5,
  });
});

test("a scored journal turn bridges into their vocabulary (D5 RunScore -> row)", async () => {
  const journal = [
    {
      type: "turn.submitted",
      id: "adm",
      text: "solve it",
      byteLength: 8,
      lineCount: 1,
      sha256: "sha_eval",
    },
    { type: "turn.started", id: "turn_1" },
    {
      type: "runtime.step_usage",
      id: "u1",
      inputTokens: 700,
      outputTokens: 120,
    },
    { type: "content.delta", id: "d1", text: "x", attempt: 2 },
    {
      type: "turn.finished",
      id: "turn_1",
      stopReason: "done",
      durationMs: 4_000,
    },
  ] as unknown as RuntimeEvent[];
  const windows = segmentTurns(journal);
  const score = scoreRun(windows[0]!, { sessionID: "ses_eval" });
  const report = await runEvalTasks(
    [
      {
        id: "source_a/our-turn",
        title: "a journal turn",
        instruction: "solve it",
        collectCommands: [],
      },
    ],
    async () => evalOutcomeFromScore(score),
    { model: "m-1", generatedAt: "2026-01-01T00:00:00.000Z" },
  );
  expect(report.tasks[0]).toMatchObject({
    id: "source_a/our-turn",
    completed: 1,
    successful: 1,
    valid_coverage: 1,
  });
  expect(report.tasks[0]!.natalia).toMatchObject({
    inputTokens: 700,
    outputTokens: 120,
    retries: 1,
    infraInvalid: false,
  });
  expect(report.overview.pass_rate).toBe(1);
  expect(score.promptKey).toBe("sha_eval");
});

test("zero valid rows report honest zeros instead of NaN", async () => {
  const report = await runEvalTasks(
    [{ id: "only", title: "only", instruction: "x", collectCommands: [] }],
    async () => {
      throw new Error("no runtime here");
    },
    { model: "m-1" },
  );
  expect(report.overview.pass_rate).toBe(0);
  expect(report.overview.infra_invalid_cells).toBe(1);
  expect(report.overview.success_rate_expected).toBe(0);
});
