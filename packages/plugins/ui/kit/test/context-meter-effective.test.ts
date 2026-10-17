/**
 * The context ring may under-report a stale sample, never over-report.
 *
 * Measured defect: on a real session the ring read 12% (`used=120,479` of
 * `1,000,000`) while the next request was over 1.03M tokens and compaction fired
 * — the provider sample was older than the conversation. A ring that says 12%
 * while the harness is about to compact is worse than no ring: it teaches the
 * reader to ignore it.
 *
 * So the ring draws the LARGER of the provider sample and the local
 * full-request estimate, and says which one it is showing.
 */
import { describe, expect, test } from "bun:test";
import { effectiveContextUsed, usedIsEstimate } from "../src/context-meter";

describe("effectiveContextUsed", () => {
  test("the sample wins while it is ahead", () => {
    expect(
      effectiveContextUsed({ used: 900_000, requestTokens: 100_000 }),
    ).toBe(900_000);
    expect(usedIsEstimate({ used: 900_000, requestTokens: 100_000 })).toBe(
      false,
    );
  });

  test("the estimate wins when the sample is stale", () => {
    // The measured case: a 12% ring about to compact.
    expect(
      effectiveContextUsed({ used: 120_479, requestTokens: 1_036_290 }),
    ).toBe(1_036_290);
    expect(usedIsEstimate({ used: 120_479, requestTokens: 1_036_290 })).toBe(
      true,
    );
  });

  test("a usage without an estimate behaves exactly as before", () => {
    expect(effectiveContextUsed({ used: 4200 })).toBe(4200);
    expect(usedIsEstimate({ used: 4200 })).toBe(false);
  });

  test("negative or absent figures never produce a negative ring", () => {
    expect(effectiveContextUsed({ used: -5, requestTokens: 0 })).toBe(0);
  });
});
