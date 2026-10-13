import { expect, test } from "bun:test";
import {
  foldStepUsage,
  roundCost,
  turnIDFromStepUsageID,
} from "../src/round-cost";

/**
 * The goal round's cost is the SUM of its provider steps, not the last
 * step's surface. The 2026-10-13 audit's case: a round whose turn.finished
 * reported 10,973 tokens while its steps had spent 36,678 — the budget
 * guard under-counted 3.3×, and the round kept starting.
 */

test("a step_usage id names its turn", () => {
  expect(turnIDFromStepUsageID("turn_1:usage:0")).toBe("turn_1");
  expect(turnIDFromStepUsageID("turn_1:usage:12")).toBe("turn_1");
  // A turn id that itself contains colons keeps everything before the
  // usage suffix.
  expect(turnIDFromStepUsageID("a:b:turn_1:usage:3")).toBe("a:b:turn_1");
});

test("the round books the sum of its steps", () => {
  let fold = foldStepUsage(undefined, {
    inputTokens: 12_000,
    outputTokens: 800,
  });
  fold = foldStepUsage(fold, { inputTokens: 13_000, outputTokens: 900 });
  fold = foldStepUsage(fold, { inputTokens: 9_978, outputTokens: 0 });
  expect(fold.steps).toBe(3);
  // The audit's number: 36,678 across the round, of which the last step's
  // 10,973 is the only part the turn's own report saw.
  expect(fold.tokens).toBe(36_678);
  const cost = roundCost(fold, { inputTokens: 10_973, outputTokens: 5 });
  expect(cost).toEqual({ tokens: 36_678, source: "steps" });
});

test("a turn with no step usage falls back to its own figures", () => {
  // A provider that reports no usage books nothing rather than a lie.
  expect(roundCost(undefined, {})).toEqual({ tokens: 0, source: "turn" });
  expect(roundCost(undefined, { inputTokens: 7, outputTokens: 3 })).toEqual({
    tokens: 10,
    source: "turn",
  });
  // Steps that reported no tokens at all are the same as no steps.
  const empty = foldStepUsage(undefined, {});
  expect(roundCost(empty, { inputTokens: 4, outputTokens: 1 })).toEqual({
    tokens: 5,
    source: "turn",
  });
});
