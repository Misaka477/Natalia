/**
 * Token-usage vocabulary shared by the provider runner and every usage surface.
 *
 * Anthropic reports cached traffic in fields separate from `input_tokens`, and
 * `input_tokens` itself excludes anything the cache served. A rate computed as
 * `cacheRead / inputTokens` therefore divides by the *uncached remainder* and
 * reports absurd values — 100k read against 2k fresh input reads as 5000%.
 *
 * The provider trace and the session usage bar need the same number, so the
 * formula lives here once: a surface that derives its own rate is a surface
 * that can silently disagree with every other one.
 */

/** The three input-side counters every provider reports or omits. */
export interface TokenUsageCounters {
  /** Tokens billed as fresh input. Excludes cached traffic on every provider. */
  readonly inputTokens: number;
  /** Tokens served from a previously written prefix cache. */
  readonly cacheReadInputTokens?: number;
  /** Tokens spent writing the prefix cache; billed above base input price. */
  readonly cacheCreationInputTokens?: number;
}

/** Total input-side tokens the request cost, cached traffic included. */
export function totalInputTokens(usage: TokenUsageCounters): number {
  return (
    usage.inputTokens +
    (usage.cacheReadInputTokens ?? 0) +
    (usage.cacheCreationInputTokens ?? 0)
  );
}

/**
 * Share of the request's input that the prefix cache served, 0..1.
 *
 * The denominator counts cache writes because they are paid for: a session
 * that writes millions of cached tokens while reading few is not a high
 * hit-rate session, and a read-only denominator would report it as one.
 * Returns 0 when the request carried no input at all.
 */
export function cacheHitRate(usage: TokenUsageCounters): number {
  const total = totalInputTokens(usage);
  return total > 0 ? (usage.cacheReadInputTokens ?? 0) / total : 0;
}
