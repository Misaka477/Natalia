import { expect, test } from "bun:test";
import {
  foldProviderCacheUsage,
  providerCachePosture,
  providerCacheShare,
} from "../src/index";

/**
 * The provider prefix-cache tier (RINA Phase 5's observable). Pure here:
 * the accumulation lives on the execution state (per step, O(1)), and
 * the snapshot posture derives from it. The fabric's law — every cache
 * tier independently observable — applied to the provider's automatic
 * prefix cache, whose raw number used to live only inside per-step
 * usage events.
 */

test("the share divides by the billed input, and zero input reads zero", () => {
  expect(
    providerCacheShare({ steps: 3, inputTokens: 100, cacheReadTokens: 90 }),
  ).toBe(0.9);
  // Division by zero never crashes and never invents a full hit.
  expect(
    providerCacheShare({ steps: 1, inputTokens: 0, cacheReadTokens: 0 }),
  ).toBe(0);
  // A provider that reports no cache reads reads 0, not undefined.
  expect(
    providerCacheShare({ steps: 2, inputTokens: 50, cacheReadTokens: 0 }),
  ).toBe(0);
});

test("the fold accumulates per step and clamps the negatives", () => {
  const start = { steps: 0, inputTokens: 0, cacheReadTokens: 0 };
  const one = foldProviderCacheUsage(start, {
    inputTokens: 100,
    cacheReadInputTokens: 90,
  });
  expect(one).toEqual({ steps: 1, inputTokens: 100, cacheReadTokens: 90 });
  const two = foldProviderCacheUsage(one, {
    inputTokens: 200,
    cacheReadInputTokens: 190,
  });
  expect(two).toEqual({ steps: 2, inputTokens: 300, cacheReadTokens: 280 });
  // A provider reporting a negative (a rounding bug upstream) never
  // shrinks the observable.
  const clamped = foldProviderCacheUsage(two, {
    inputTokens: 100,
    cacheReadInputTokens: -5,
  });
  expect(clamped).toEqual({ steps: 3, inputTokens: 400, cacheReadTokens: 280 });
});

test("the posture rides nothing when the session has run no step", () => {
  // The fabric's discipline: a tier with no use rides nothing, never
  // zeros — an absent posture and a zero posture are different facts.
  expect(providerCachePosture(undefined)).toBeUndefined();
  expect(
    providerCachePosture({ steps: 0, inputTokens: 0, cacheReadTokens: 0 }),
  ).toBeUndefined();
  expect(
    providerCachePosture({ steps: 4, inputTokens: 400, cacheReadTokens: 388 }),
  ).toEqual({
    steps: 4,
    inputTokens: 400,
    cacheReadTokens: 388,
    hitShare: 0.97,
  });
});
