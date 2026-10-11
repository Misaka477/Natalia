/**
 * W6: the skill catalog's lifecycle — the garbage collector the catalog
 * never had.
 *
 * A self-evolving system that can only ADD skills is a system that fills
 * up: the user's design note scores every expert by usage, success rate,
 * recency and storage cost, evicts below a dynamic threshold, exempts a
 * protected set, and gives new skills a cold-start protection period so
 * they can gather usage history before becoming evictable.
 *
 * The honest caveat, stated rather than papered over: this system has NO
 * durable usage facts — skill activation is runtime state and command
 * executions are not journaled, so `uses`/`successes`/`lastUsedAt` arrive
 * from the caller (today: nowhere, which the CLI says out loud). The
 * scorer is built anyway because the LAW is what was missing: a caller
 * with a usage source plugs it in, and until then a gc that cannot see
 * usage refuses to guess. An eviction policy running on invented numbers
 * would delete the skills nobody measured.
 */

/** What the scorer reads about one skill. */
export type SkillLifecycleEntry = {
  name: string;
  /** How often it was reached for in the window (0 when unmeasured). */
  uses: number;
  /** How often it worked (0 when unmeasured). */
  successes: number;
  /** When it was last used (epoch ms), or undefined when never. */
  lastUsedAt?: number;
  /** Its size in bytes (the cost term). */
  bytes: number;
  /** When it was created (epoch ms) — the cold-start clock. */
  createdAt: number;
  /** The user's protected set: never evictable, whatever the score. */
  protected?: boolean;
};

export type SkillEvictionRow = {
  name: string;
  score: number;
  reason: string;
};

export type SkillGcReport = {
  /** The evictable rows, worst first. */
  evict: SkillEvictionRow[];
  /** The rows kept, with why (protected, cold-start, or scoring above). */
  keep: Array<{ name: string; reason: string }>;
  /** How much the eviction would reclaim, in bytes. */
  reclaimableBytes: number;
};

/** The weights (the design note's α, β, δ) — named so tuning is a constant. */
export const SKILL_SUCCESS_WEIGHT = 1;
export const SKILL_RECENCY_WEIGHT = 0.5;
export const SKILL_COST_WEIGHT = 0.2;
/** New skills are untouchable for this long (the cold-start protection). */
export const SKILL_COLD_START_MS = 7 * 24 * 60 * 60 * 1000;
/** The recency decay's half-life-ish scale. */
export const SKILL_RECENCY_SCALE_MS = 30 * 24 * 60 * 60 * 1000;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** One skill's lifecycle score: success × recency, minus the storage cost. */
export function skillScore(
  entry: SkillLifecycleEntry,
  now: number,
  options: { maxBytes?: number } = {},
): number {
  const successRate =
    entry.uses > 0 ? clamp01(entry.successes / entry.uses) : 0;
  const age =
    entry.lastUsedAt === undefined ? 0 : Math.max(0, now - entry.lastUsedAt);
  const recency =
    entry.lastUsedAt === undefined
      ? 0
      : Math.exp(-age / SKILL_RECENCY_SCALE_MS);
  const maxBytes = options.maxBytes ?? 1;
  const cost = clamp01(entry.bytes / Math.max(1, maxBytes));
  return (
    SKILL_SUCCESS_WEIGHT * successRate +
    SKILL_RECENCY_WEIGHT * recency -
    SKILL_COST_WEIGHT * cost
  );
}

/**
 * The dry run: which skills a gc WOULD evict, worst first, with the
 * protected set and the cold-start window honored. Pure, so the law is a
 * unit test rather than a hope — and so a caller with no usage facts can
 * see that nothing is evictable instead of being told a lie.
 */
export function skillGcReport(
  entries: readonly SkillLifecycleEntry[],
  now: number,
  options: { maxBytes?: number; threshold?: number } = {},
): SkillGcReport {
  const maxBytes =
    options.maxBytes ?? Math.max(1, ...entries.map((entry) => entry.bytes));
  const scored = entries.map((entry) => ({
    entry,
    score: skillScore(entry, now, { maxBytes }),
  }));
  // The dynamic threshold: the mean, so a catalog that is uniformly good
  // evicts nothing and one that is uniformly dead empties.
  const mean =
    scored.reduce((sum, row) => sum + row.score, 0) /
    Math.max(1, scored.length);
  const threshold = options.threshold ?? mean;
  const evict: SkillEvictionRow[] = [];
  const keep: Array<{ name: string; reason: string }> = [];
  let reclaimableBytes = 0;
  for (const row of scored) {
    const { entry } = row;
    if (entry.protected) {
      keep.push({ name: entry.name, reason: "protected by the user" });
      continue;
    }
    if (now - entry.createdAt < SKILL_COLD_START_MS) {
      keep.push({
        name: entry.name,
        reason: "cold-start protection (gathering usage history)",
      });
      continue;
    }
    if (entry.uses === 0) {
      // No usage facts at all: never evict on absence of evidence.
      keep.push({ name: entry.name, reason: "no usage facts — not guessing" });
      continue;
    }
    if (row.score < threshold) {
      evict.push({
        name: entry.name,
        score: row.score,
        reason: `score ${row.score.toFixed(3)} below the catalog's mean ${threshold.toFixed(3)}`,
      });
      reclaimableBytes += entry.bytes;
      continue;
    }
    keep.push({ name: entry.name, reason: `score ${row.score.toFixed(3)}` });
  }
  evict.sort((left, right) => left.score - right.score);
  return { evict, keep, reclaimableBytes };
}
