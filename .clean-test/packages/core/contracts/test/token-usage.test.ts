import { describe, expect, test } from "bun:test";
import { cacheHitRate, totalInputTokens } from "../src/token-usage";

describe("totalInputTokens", () => {
  test("counts cached traffic in the denominator", () => {
    expect(
      totalInputTokens({
        inputTokens: 2_000,
        cacheReadInputTokens: 100_000,
        cacheCreationInputTokens: 20_000,
      }),
    ).toBe(122_000);
  });

  test("treats omitted cache fields as zero", () => {
    expect(totalInputTokens({ inputTokens: 1_234 })).toBe(1_234);
  });
});

describe("cacheHitRate", () => {
  test("is write-aware: cache writes are in the denominator", () => {
    // The provider trace used to divide the read by `inputTokens`, which is the
    // *uncached* remainder on every provider. 100k read against 2k fresh input
    // read as 5000%; the correct figure is the read's share of all input.
    expect(
      cacheHitRate({
        inputTokens: 2_000,
        cacheReadInputTokens: 100_000,
        cacheCreationInputTokens: 20_000,
      }),
    ).toBeCloseTo(100_000 / 122_000, 10);
  });

  test("a write-heavy session is not a high hit rate", () => {
    const writeHeavy = cacheHitRate({
      inputTokens: 1_000,
      cacheReadInputTokens: 1_000,
      cacheCreationInputTokens: 1_000_000,
    });
    expect(writeHeavy).toBeCloseTo(1_000 / 1_002_000, 10);
    expect(writeHeavy).toBeLessThan(0.01);
  });

  test("a fully cached request rates 1", () => {
    expect(
      cacheHitRate({
        inputTokens: 0,
        cacheReadInputTokens: 50_000,
      }),
    ).toBe(1);
  });

  test("an uncached request rates 0", () => {
    expect(cacheHitRate({ inputTokens: 7_000 })).toBe(0);
  });

  test("a request with no input at all rates 0 rather than dividing by zero", () => {
    expect(cacheHitRate({ inputTokens: 0 })).toBe(0);
    expect(
      cacheHitRate({
        inputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      }),
    ).toBe(0);
  });
});
