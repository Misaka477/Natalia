/**
 * The provider prefix-cache tier (RINA Phase 5's observable surface).
 *
 * The fabric's law is that EVERY cache tier is independently observable —
 * the L1 fabric has its metrics per kind; the provider's prefix cache
 * (the static-prompt stability that keeps a provider's automatic cache
 * hitting) had its raw number only inside per-step usage events. This is
 * its first-class share: how much of this session's billed input the
 * provider served from cache.
 *
 * Pure and small on purpose: the accumulation lives on the execution
 * state (per step, O(1)); this module only derives.
 */

/** A tier's accumulated usage (the execution state's shape). */
export type ProviderCacheUsage = {
  steps: number;
  inputTokens: number;
  cacheReadTokens: number;
};

/**
 * The cache-read share of the billed input: 0 when nothing was billed
 * (a division by zero reads as "no cache observed", never as a crash or
 * an invented 100%).
 */
export function providerCacheShare(usage: ProviderCacheUsage): number {
  if (usage.inputTokens <= 0) return 0;
  return usage.cacheReadTokens / usage.inputTokens;
}

/**
 * The snapshot posture's provider row: `undefined` when the session has
 * run no step — a tier with no use rides nothing rather than inventing
 * zeros (the same discipline the L1 fabric's posture has).
 */
export function providerCachePosture(usage: ProviderCacheUsage | undefined):
  | {
      steps: number;
      inputTokens: number;
      cacheReadTokens: number;
      hitShare: number;
    }
  | undefined {
  if (!usage || usage.steps <= 0) return undefined;
  return {
    steps: usage.steps,
    inputTokens: usage.inputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    hitShare: providerCacheShare(usage),
  };
}

/** Fold one step's usage into the accumulator (a per-step add, pure). */
export function foldProviderCacheUsage(
  usage: ProviderCacheUsage,
  step: { inputTokens: number; cacheReadInputTokens?: number },
): ProviderCacheUsage {
  return {
    steps: usage.steps + 1,
    inputTokens: usage.inputTokens + Math.max(0, step.inputTokens),
    cacheReadTokens:
      usage.cacheReadTokens + Math.max(0, step.cacheReadInputTokens ?? 0),
  };
}
