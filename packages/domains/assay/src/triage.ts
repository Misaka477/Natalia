/**
 * L7's triage: rank the growth triggers so a human spends attention where
 * it pays, and NOTHING else.
 *
 * The reference study's Phase 5 is a performance monitor plus an
 * auto-triage that ranks by (potential improvement × usage frequency).
 * The ranking is the whole feature: **this module sorts and explains, it
 * never triggers.** There is no execute seam, no apply path, no candidate
 * factory — a triage that could act would be the autonomous loop the plan
 * deliberately leaves for last, and "the first six layers are not proven
 * yet" is the reason.
 *
 * A human reads the ranking, picks a row, and hands it to the mutation
 * path (the Growth tab's promote action records the fact; the approval
 * policy decides what becomes real). The loop's automation ends at the
 * ranking on purpose.
 */

import type { GrowthTrigger } from "./growth-trigger";

/** What the triage reads (the growth trigger face's shape). */
export type TriageCandidate = {
  /** The trigger's rule (which growth system raised it). */
  rule: GrowthTrigger["rule"];
  /** The capability it names. */
  capability: string;
  /** The destination class the class policy assigns. */
  class: "skill" | "rule" | "policy" | "generation";
  /** The trigger's own evidence numbers (its provenance). */
  evidence: Record<string, number | string>;
  /** Why the trigger fired, in the trigger's own words. */
  reason: string;
};

/**
 * How often the capability was reached for. The triage reads this from the
 * evidence the trigger already carries (usage counts, observation counts)
 * — a second telemetry pipeline would be a second thing to keep honest.
 */
export function usageFrequency(candidate: TriageCandidate): number {
  const value =
    candidate.evidence.usage ??
    candidate.evidence.observations ??
    candidate.evidence.runs ??
    0;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * How much room the capability has to improve. The trigger's own numbers
 * are the only honest source: a benchmark gap reads its baseline, a
 * correction pattern reads its observation count. A capability with no
 * measurable headroom ranks last rather than being dropped — "no evidence
 * either way" is not "no value".
 */
export function potentialImprovement(candidate: TriageCandidate): number {
  const gap = candidate.evidence.gap;
  if (typeof gap === "number" && Number.isFinite(gap) && gap > 0) return gap;
  const baseline = candidate.evidence.baselineSuccessRate;
  if (typeof baseline === "number" && baseline >= 0 && baseline <= 1)
    return 1 - baseline;
  const observations = usageFrequency(candidate);
  return observations > 0 ? Math.min(1, observations / 10) : 0;
}

export type TriageRow = {
  capability: string;
  rule: GrowthTrigger["rule"];
  class: GrowthTrigger["class"];
  /** The ranking number (frequency × potential), for display and sorting. */
  score: number;
  usageFrequency: number;
  potentialImprovement: number;
  /**
   * Why the trigger fired, carried through unchanged. A ranking that drops
   * the reason leaves the reader a number they cannot act on — the row is
   * what a human reads, so it must stay whole.
   */
  reason: string;
  /** The trigger's own evidence numbers (its provenance). */
  evidence: Record<string, number | string>;
};

/**
 * Rank the triggers by (potential improvement × usage frequency), highest
 * first. Ties break by the capability's name so the ranking is stable
 * across runs — a list that reshuffles between reads cannot be worked
 * through.
 */
export function triageGrowth(
  candidates: readonly TriageCandidate[],
): TriageRow[] {
  return candidates
    .map((candidate) => {
      const frequency = usageFrequency(candidate);
      const potential = potentialImprovement(candidate);
      return {
        capability: candidate.capability,
        rule: candidate.rule,
        class: candidate.class,
        score: frequency * potential,
        reason: candidate.reason,
        evidence: candidate.evidence,
        usageFrequency: frequency,
        potentialImprovement: potential,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.capability.localeCompare(right.capability),
    );
}
