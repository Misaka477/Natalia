import { expect, test } from "bun:test";
import {
  classifyGap,
  deriveGrowthCurriculum,
  normalizeGap,
  type TaskOutcome,
} from "../src/growth";

/**
 * Discovery G-a — the capability curriculum's contract: evidence-first
 * (gaps come from the journal's completions and task states), pattern
 * over anecdote (the threshold), kind classification, and a proposal
 * that sorts by strength. No auto-execution — the study's rule.
 */

test("a repeated gap becomes a suggestion; a one-off stays an anecdote", () => {
  const curriculum = deriveGrowthCurriculum({
    tasks: [
      { text: "ship the packer", gaps: ["no ripgrep tool", "no jq tool"] },
      { text: "ship the reader", gaps: ["no ripgrep tool"] },
      { text: "whatever", gaps: ["a one-off hiccup"] },
    ],
  });
  expect(curriculum.suggestions).toHaveLength(1);
  expect(curriculum.suggestions[0]).toMatchObject({
    capability: "no ripgrep tool",
    kind: "tool",
    observations: 2,
    sources: ["ship the packer", "ship the reader"],
  });
  expect(curriculum.considered).toEqual({ tasks: 3, gaps: 4 });
});

test("an unbacked plan task is a gap like any other", () => {
  const curriculum = deriveGrowthCurriculum({
    tasks: [
      { text: "wire the docs", unbacked: true, planID: "p1" },
      { text: "wire the docs", unbacked: true, planID: "p1" },
    ],
  });
  expect(curriculum.suggestions).toHaveLength(1);
  expect(curriculum.suggestions[0]).toMatchObject({
    capability: "unbacked plan task: wire the docs",
    observations: 2,
  });
  // The plan id rides the sources for the proposal's provenance.
  expect(curriculum.suggestions[0]!.sources).toContain("p1");
});

test("the gap's kind comes from its keywords, and normalization groups the same gap", () => {
  expect(classifyGap("no ripgrep tool available")).toBe("tool");
  expect(classifyGap("missing skill documentation")).toBe("skill");
  expect(classifyGap("needs a constitution rule")).toBe("rule");
  expect(classifyGap("the permission policy blocks it")).toBe("policy");
  // Case and trailing punctuation must not split one cluster.
  expect(normalizeGap("No Ripgrep Tool.")).toBe("no ripgrep tool");
  const curriculum = deriveGrowthCurriculum({
    tasks: [
      { text: "a", gaps: ["No Ripgrep Tool."] },
      { text: "b", gaps: ["no ripgrep tool"] },
    ],
  });
  expect(curriculum.suggestions).toHaveLength(1);
  expect(curriculum.suggestions[0]!.kind).toBe("tool");
});

test("the strongest cluster sorts first", () => {
  const curriculum = deriveGrowthCurriculum({
    tasks: [
      { text: "a", gaps: ["no jq tool"] },
      { text: "b", gaps: ["no jq tool"] },
      { text: "c", gaps: ["no jq tool"] },
      { text: "d", gaps: ["no yq tool"] },
      { text: "e", gaps: ["no yq tool"] },
    ],
  });
  expect(curriculum.suggestions.map((entry) => entry.capability)).toEqual([
    "no jq tool",
    "no yq tool",
  ]);
  expect(curriculum.suggestions.map((entry) => entry.observations)).toEqual([
    3, 2,
  ]);
});

test("an empty journal answers an empty curriculum, not an invented one", () => {
  expect(deriveGrowthCurriculum({ tasks: [] })).toEqual({
    suggestions: [],
    considered: { tasks: 0, gaps: 0 },
  });
  // Gaps that normalize to nothing are dropped, not counted as patterns.
  expect(
    deriveGrowthCurriculum({ tasks: [{ text: "a", gaps: ["  "] }] }),
  ).toEqual({ suggestions: [], considered: { tasks: 1, gaps: 1 } });
});
