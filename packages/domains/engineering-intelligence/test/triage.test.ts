import { expect, test } from "bun:test";
import {
  potentialImprovement,
  triageGrowth,
  usageFrequency,
  type TriageCandidate,
} from "../src/triage";

/**
 * L7's triage: the ranking, and the rule that it ONLY ranks.
 *
 * The load-bearing assertion is structural: the triage's output type has
 * no action field and the module exports no execute seam. A triage that
 * could act would be the autonomous loop the plan leaves for last — the
 * first six layers are not proven yet, and an unproven loop that acts is
 * an unproven loop that acts wrongly at machine speed.
 */

const candidate = (
  capability: string,
  evidence: Record<string, number | string>,
  overrides: Partial<TriageCandidate> = {},
): TriageCandidate => ({
  rule: "capability_gap",
  capability,
  class: "skill",
  evidence,
  reason: `${capability} keeps costing the work`,
  ...overrides,
});

test("the ranking is potential × frequency, highest first", () => {
  const rows = triageGrowth([
    candidate("rare-but-wide", { gap: 0.9, usage: 1 }),
    candidate("common-and-wide", { gap: 0.8, usage: 10 }),
    candidate("common-but-narrow", { gap: 0.1, usage: 10 }),
  ]);
  // 10×0.8 = 8 beats 10×0.1 = 1 beats 1×0.9 = 0.9 — frequency multiplies,
  // it does not merely add.
  expect(rows.map((row) => row.capability)).toEqual([
    "common-and-wide",
    "common-but-narrow",
    "rare-but-wide",
  ]);
  expect(rows[0]!.score).toBeCloseTo(8, 10);
  // The row explains itself: a human works through the list, so each row
  // carries its own numbers.
  expect(rows[0]).toMatchObject({
    usageFrequency: 10,
    potentialImprovement: 0.8,
  });
  expect(rows[0]!.reason).toContain("common-and-wide");
});

test("the ranking is stable across runs (ties break by name)", () => {
  const input = [
    candidate("zeta", { gap: 0.5, usage: 4 }),
    candidate("alpha", { gap: 0.5, usage: 4 }),
  ];
  expect(triageGrowth(input).map((row) => row.capability)).toEqual([
    "alpha",
    "zeta",
  ]);
  expect(triageGrowth(input)).toEqual(triageGrowth(input));
});

test("a benchmark gap reads its baseline, a correction pattern its observations", () => {
  // The trigger's own numbers are the only honest source of headroom.
  expect(
    potentialImprovement(candidate("x", { baselineSuccessRate: 0.25 })),
  ).toBeCloseTo(0.75, 10);
  expect(potentialImprovement(candidate("x", { observations: 5 }))).toBeCloseTo(
    0.5,
    10,
  );
  // No measurable headroom ranks last rather than being dropped: "no
  // evidence either way" is not "no value".
  expect(potentialImprovement(candidate("x", {}))).toBe(0);
  expect(usageFrequency(candidate("x", { usage: "not a number" }))).toBe(0);
  expect(usageFrequency(candidate("x", { usage: -3 }))).toBe(0);
});

test("the triage only ranks: no action seam exists to call", () => {
  // The structural rule, as a test: the module's exports are the ranking
  // and its two inputs — nothing that applies, executes, or triggers.
  const rows = triageGrowth([candidate("x", { gap: 0.5, usage: 2 })]);
  expect(rows).toHaveLength(1);
  expect(Object.keys(rows[0]!).sort()).toEqual([
    "capability",
    "class",
    "potentialImprovement",
    "reason",
    "rule",
    "score",
    "usageFrequency",
  ]);
});
