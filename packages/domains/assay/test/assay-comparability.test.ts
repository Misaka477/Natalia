import { describe, expect, test } from "bun:test";
import { compareAssayRuns } from "../src/assay-comparability";
import type { AssayEvidenceInput } from "../src/assay-runs";

function record(
  overrides: Partial<AssayEvidenceInput> = {},
): AssayEvidenceInput {
  return {
    id: "ev_1",
    taskID: "task_a",
    objective: "close the line",
    commit: "abc123",
    environment: "win32-x64",
    validations: [{ command: "bun test", result: "passed", safeSummary: "ok" }],
    ...overrides,
  };
}

describe("compareAssayRuns", () => {
  test("the same checks on the same tree in the same environment is comparable", () => {
    const comparison = compareAssayRuns({
      previous: record({ id: "ev_1" }),
      current: record({ id: "ev_2" }),
    });
    expect(comparison.comparable).toBe(true);
    expect(comparison.differences).toEqual([]);
    expect(comparison.unknown).toEqual([]);
    expect(comparison.why).toContain("same checks");
  });

  test("a dropped check makes it incomparable, and the sentence names the command", () => {
    const comparison = compareAssayRuns({
      previous: record({
        validations: [
          { command: "bun test", result: "passed", safeSummary: "ok" },
          { command: "bun run typecheck", result: "passed", safeSummary: "ok" },
        ],
      }),
      current: record(),
    });
    expect(comparison.comparable).toBe(false);
    expect(comparison.differences.join("\n")).toContain("no longer runs");
    expect(comparison.differences.join("\n")).toContain("bun run typecheck");
    expect(comparison.why.startsWith("not comparable:")).toBe(true);
  });

  test("an extra check is a difference too — a wider green is a different green", () => {
    const comparison = compareAssayRuns({
      previous: record(),
      current: record({
        validations: [
          { command: "bun test", result: "passed", safeSummary: "ok" },
          {
            command: "npm run docs:check",
            result: "passed",
            safeSummary: "ok",
          },
        ],
      }),
    });
    expect(comparison.comparable).toBe(false);
    expect(comparison.differences.join("\n")).toContain("also ran");
  });

  test("two commands that earn the same class are still two measurements", () => {
    const comparison = compareAssayRuns({
      previous: record(),
      current: record({
        validations: [
          {
            command: "bun test --filter x",
            result: "passed",
            safeSummary: "ok",
          },
        ],
      }),
    });
    expect(comparison.comparable).toBe(false);
  });

  test("different trees are named with both commits", () => {
    const comparison = compareAssayRuns({
      previous: record({ commit: "abc123" }),
      current: record({ commit: "def456" }),
    });
    expect(comparison.comparable).toBe(false);
    expect(comparison.differences.join("\n")).toContain("abc123");
    expect(comparison.differences.join("\n")).toContain("def456");
  });

  test("a missing commit is 'cannot say', not 'comparable'", () => {
    const comparison = compareAssayRuns({
      previous: record({ commit: undefined }),
      current: record({ commit: "def456" }),
    });
    expect(comparison.comparable).toBe(false);
    expect(comparison.differences).toEqual([]);
    expect(comparison.unknown.join("\n")).toContain("only the later record");
    expect(comparison.why).toContain("cannot say");
  });

  test("neither record carrying a commit is still not comparable", () => {
    const comparison = compareAssayRuns({
      previous: record({ commit: undefined, environment: undefined }),
      current: record({ commit: undefined, environment: undefined }),
    });
    expect(comparison.comparable).toBe(false);
    expect(comparison.unknown).toHaveLength(2);
    expect(comparison.unknown.join("\n")).toContain(
      "neither record carries a commit",
    );
  });

  test("a different environment is a difference, not a footnote", () => {
    const comparison = compareAssayRuns({
      previous: record({ environment: "linux-arm64" }),
      current: record({ environment: "win32-x64" }),
    });
    expect(comparison.comparable).toBe(false);
    expect(comparison.differences.join("\n")).toContain(
      "different environments",
    );
  });

  test("the same command twice in one record is one check", () => {
    const comparison = compareAssayRuns({
      previous: record({
        validations: [
          { command: "bun test", result: "passed", safeSummary: "ok" },
          { command: "bun test", result: "passed", safeSummary: "ok" },
        ],
      }),
      current: record(),
    });
    expect(comparison.comparable).toBe(true);
  });
});
