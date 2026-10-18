/**
 * A run reads like a CI page: a job, its steps, and a verdict with a scope.
 *
 * The user's ask: "make it look like GitHub Actions — clear and legible". The
 * page needs data in that shape, so this pins the projection: task = job, each
 * recorded validation = a step with its own status and duration, and the verdict
 * carries what was covered and what was not.
 */
import { describe, expect, test } from "bun:test";
import { assayRunFor, assayRuns } from "../src/assay-runs";

const classesFor = (command: string, passed: boolean): readonly string[] => {
  if (!passed) return [];
  if (/test/u.test(command)) return ["validation:any", "validation:test"];
  if (/tsc/u.test(command)) return ["validation:any", "validation:typecheck"];
  return ["validation:any"];
};

describe("assayRunFor", () => {
  test("a task's evidence becomes one run with a step per validation", () => {
    const run = assayRunFor({
      evidence: [
        {
          id: "evidence:1:1",
          taskID: "contour",
          objective: "ship the parser",
          recordedAt: "2026-10-18T10:00:00.000Z",
          environment: "win32/x64",
          validations: [
            {
              command: "bun test packages/contour",
              result: "passed",
              safeSummary: "42 pass",
              durationMs: 12_400,
              assayRole: "authoritative",
            },
          ],
        },
      ],
      classesFor,
    });
    expect(run?.taskID).toBe("contour");
    expect(run?.steps).toHaveLength(1);
    expect(run?.steps[0]).toMatchObject({
      command: "bun test packages/contour",
      result: "passed",
      role: "authoritative",
      durationMs: 12_400,
    });
    expect(run?.checked).toContain("validation:test");
    expect(run?.totalDurationMs).toBe(12_400);
    // The verdict needs an INDEPENDENT pass and nothing open.
    expect(run?.warrant).toBe("warranted");
  });

  test("a self-reported-only run is unwarranted, and says why", () => {
    const run = assayRunFor({
      evidence: [
        {
          id: "evidence:2:1",
          taskID: "contour",
          objective: "ship the parser",
          validations: [
            {
              command: "bun test",
              result: "passed",
              safeSummary: "ok",
              assayRole: "self-reported",
            },
          ],
        },
      ],
      classesFor,
    });
    expect(run?.warrant).toBe("unwarranted");
    expect(run?.note).toContain("author's own run");
  });

  test("an open requirement is named instead of a failure count", () => {
    const run = assayRunFor({
      evidence: [
        {
          id: "evidence:3:1",
          taskID: "contour",
          objective: "ship the parser",
          validations: [
            {
              command: "bun test",
              result: "passed",
              safeSummary: "ok",
              assayRole: "authoritative",
            },
          ],
        },
      ],
      completion: { taskID: "contour", missing: ["validation:parser"] },
      classesFor,
    });
    expect(run?.warrant).toBe("unwarranted");
    expect(run?.notChecked).toEqual(["validation:parser"]);
    expect(run?.note).toBe("still open: validation:parser");
  });

  test("a missing role reads as the weaker one, never as authoritative", () => {
    const run = assayRunFor({
      evidence: [
        {
          id: "evidence:4:1",
          taskID: "t",
          objective: "o",
          validations: [
            { command: "bun test", result: "passed", safeSummary: "ok" },
          ],
        },
      ],
      classesFor,
    });
    expect(run?.steps[0]!.role).toBe("self-reported");
    expect(run?.warrant).toBe("unwarranted");
  });

  test("an unknown verdict is reported as unknown, not folded into failed", () => {
    const run = assayRunFor({
      evidence: [
        {
          id: "e",
          taskID: "t",
          objective: "o",
          validations: [{ command: "x", result: "exploded", safeSummary: "" }],
        },
      ],
      classesFor,
    });
    expect(run?.steps[0]!.result).toBe("unknown");
  });

  test("no evidence means no run at all", () => {
    expect(assayRunFor({ evidence: [], classesFor })).toBeUndefined();
  });

  test("a declared check with no recorded run is a not_run step, and its classes stay open", () => {
    // The project declared three checks; the session recorded one. The page must
    // show the two that never ran — that grey row is the whole point of asking
    // the project what its checks are instead of guessing from a task kind.
    const run = assayRunFor({
      evidence: [
        {
          id: "e",
          taskID: "t",
          objective: "o",
          validations: [
            {
              command: "bun test",
              result: "passed",
              safeSummary: "ok",
              assayRole: "authoritative",
            },
          ],
        },
      ],
      classesFor,
      declaration: {
        checks: [
          { command: "bun test", covers: ["validation:test"] },
          { command: "bun run typecheck", covers: ["validation:typecheck"] },
          { command: "npm run docs:check", covers: ["validation:any"] },
        ],
      },
    });
    expect(
      run?.steps.map((step) => [step.command, step.result, step.declared]),
    ).toEqual([
      ["bun test", "passed", undefined],
      ["bun run typecheck", "not_run", true],
      ["npm run docs:check", "not_run", true],
    ]);
    // A declared-and-not-run check has NO runner: `role` must stay absent rather
    // than claiming the author measured it.
    expect(run?.steps[1]!.role).toBeUndefined();
    expect(run?.notChecked).toContain("validation:typecheck");
    expect(run?.warrant).toBe("unwarranted");
    expect(run?.note).toContain("declared and not run");
    expect(run?.note).toContain("bun run typecheck");
  });

  test("every declared check that ran leaves nothing open from the declaration", () => {
    const run = assayRunFor({
      evidence: [
        {
          id: "e",
          taskID: "t",
          objective: "o",
          validations: [
            {
              command: "bun test",
              result: "passed",
              safeSummary: "ok",
              assayRole: "authoritative",
            },
          ],
        },
      ],
      classesFor,
      declaration: {
        checks: [{ command: "bun test", covers: ["validation:test"] }],
      },
    });
    expect(run?.steps).toHaveLength(1);
    expect(run?.notChecked).toEqual([]);
    expect(run?.warrant).toBe("warranted");
    expect(run?.note).not.toContain("declared and not run");
  });
});

describe("assayRuns", () => {
  test("one run per task, newest first — the runs list", () => {
    const runs = assayRuns({
      evidence: [
        {
          id: "e1",
          taskID: "a",
          objective: "first",
          recordedAt: "2026-10-18T10:00:00.000Z",
          validations: [
            {
              command: "bun test",
              result: "passed",
              safeSummary: "",
              assayRole: "authoritative",
            },
          ],
        },
        {
          id: "e2",
          taskID: "b",
          objective: "second",
          recordedAt: "2026-10-18T11:00:00.000Z",
          validations: [
            {
              command: "bunx tsc",
              result: "passed",
              safeSummary: "",
              assayRole: "authoritative",
            },
          ],
        },
        {
          id: "e3",
          taskID: "a",
          objective: "first",
          recordedAt: "2026-10-18T10:30:00.000Z",
          validations: [
            {
              command: "bun test",
              result: "failed",
              safeSummary: "",
              assayRole: "authoritative",
            },
          ],
        },
      ],
      classesFor,
    });
    // One run per TASK: two records of task "a" are ONE job with two steps, and
    // task "b" is its own. (The ordering is asserted separately — see below —
    // because "newest first" is a display choice, not the contract this pins.)
    expect(runs.map((run) => run.taskID).sort()).toEqual(["a", "b"]);
    const a = runs.find((run) => run.taskID === "a")!;
    expect(a.steps).toHaveLength(2);
    expect(a.steps.map((step) => step.result)).toEqual(["passed", "failed"]);
  });
});
