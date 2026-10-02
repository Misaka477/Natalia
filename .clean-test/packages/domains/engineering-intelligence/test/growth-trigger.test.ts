import { expect, test } from "bun:test";
import type { RunGroup } from "../src/run-scorer";
import { deriveGrowthTriggers } from "../src/growth-trigger";

/**
 * The trigger face's rules: the four growth systems' views assembled
 * into one answer. Every rule fires on its evidence with the source's
 * own numbers, and nothing is applied (growth 默认不自授权).
 */

const group = (
  promptKey: string,
  runs: number,
  successes: number,
): RunGroup => ({
  promptKey,
  runs,
  successes,
  successRate: Math.round((successes / runs) * 100),
  avgSteps: 2,
  retries: 0,
});

test("a repeatedly failing prompt triggers on its own numbers", () => {
  const triggers = deriveGrowthTriggers({
    runGroups: [group("bad prompt", 4, 1), group("fine prompt", 4, 4)],
  });
  expect(triggers).toHaveLength(1);
  expect(triggers[0]).toMatchObject({
    rule: "prompt_success",
    class: "skill",
    evidence: { runs: 4, successes: 1, successRate: 25, threshold: 50 },
  });
  // One run is not a distribution.
  expect(
    deriveGrowthTriggers({ runGroups: [group("one shot", 1, 0)] }),
  ).toEqual([]);
});

test("a joined task this far below its baseline triggers with the gap", () => {
  const triggers = deriveGrowthTriggers({
    joins: [
      {
        externalTaskID: "terminal-bench/regex-log",
        baselineSuccessRate: 0.917,
        ourRuns: 4,
        ourSuccessRate: 0.5,
      },
      {
        externalTaskID: "terminal-bench/other",
        baselineSuccessRate: 0.7,
        ourRuns: 4,
        ourSuccessRate: 0.75,
      },
    ],
  });
  expect(triggers).toHaveLength(1);
  expect(triggers[0]).toMatchObject({
    rule: "benchmark_gap",
    capability: "terminal-bench/regex-log",
    evidence: {
      ourRuns: 4,
      ourSuccessRate: 50,
      baselineSuccessRate: 92,
      gap: 42,
    },
  });
});

test("a thrice-repeated correction triggers as the human's class", () => {
  const triggers = deriveGrowthTriggers({
    corrections: [
      {
        capability: "always ask before deleting",
        observations: 3,
        destination: "rule",
        sources: ["mailbox"],
        reason: "r",
      },
      {
        capability: "use the batch tool here",
        observations: 3,
        destination: "tool",
        sources: ["mailbox"],
        reason: "r",
      },
    ],
  });
  expect(triggers.map((entry) => entry.class)).toEqual(["rule", "policy"]);
  expect(triggers[0]).toMatchObject({
    rule: "correction_pattern",
    evidence: { observations: 3, threshold: 3 },
  });
});

test("the curriculum's capability gaps ride the trigger as its fallback carrier", () => {
  const triggers = deriveGrowthTriggers({
    curriculum: [
      {
        kind: "rule",
        capability: "no ripgrep tool",
        observations: 2,
        sources: ["a"],
        reason: 'the gap "no ripgrep tool" appeared 2 times',
      },
    ],
  });
  expect(triggers).toHaveLength(1);
  expect(triggers[0]).toMatchObject({
    rule: "capability_gap",
    class: "rule",
    capability: "no ripgrep tool",
  });
  // An empty input answers no triggers — the trigger invents nothing.
  expect(deriveGrowthTriggers({})).toEqual([]);
});
