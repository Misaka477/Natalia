/**
 * W7: same-domain supersession — a better candidate may REPLACE an older
 * skill in the same domain.
 *
 * The necessity gate (L4's `skillCandidateDecision`) only refuses a
 * candidate that RESTATES an existing skill; it has no way to say "this one
 * is better than that one, and they cover the same ground". So the catalog
 * accumulates near-duplicates: the old skill stays because nothing removes
 * it, and the better one is refused for looking too much like it.
 *
 * This is the study's same-domain replacement (Alg 15) with its margin μ:
 * when a candidate and an old skill are in the same domain (token overlap ≥
 * θ, the same yardstick the necessity gate uses) and the candidate beats
 * the old skill on the HOLDOUT by at least μ, the loop reports a
 * replacement suggestion. **It only ever suggests** — the replacement is a
 * human's decision in the queue, and the removal goes through the same
 * boundary as any other write. A loop that could retire its own skills
 * without a human in the middle would be the failure this design exists to
 * prevent.
 *
 * The two constants are the study's, and they are named here so a real run
 * can calibrate them (the same discipline the stability weights follow).
 */

/** Same domain: token overlap at least this (the necessity gate's own yardstick). */
export const SUPERSESSION_DOMAIN_OVERLAP = 0.6;
/** The holdout margin a candidate must clear to suggest replacing (μ). */
export const SUPERSESSION_MARGIN = 0.1;

export type SupersessionTarget = {
  name: string;
  description: string;
  /** The skill's own holdout score, when it has one. */
  holdoutScore?: number;
};

export function supersessionSuggestion(input: {
  candidate: SupersessionTarget & { holdoutScore: number };
  existing: readonly SupersessionTarget[];
}):
  | {
      suggestion: {
        replace: string;
        with: string;
        margin: number;
        overlap: number;
      };
    }
  | { none: true; reason: string } {
  const body = new Set(
    `${input.candidate.name} ${input.candidate.description}`
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 2),
  );
  if (!body.size)
    return { none: true, reason: "the candidate has no tokens to compare" };
  let best: { name: string; margin: number; overlap: number } | undefined;
  for (const skill of input.existing) {
    if (skill.name === input.candidate.name) continue;
    const other = new Set(
      `${skill.name} ${skill.description}`
        .toLowerCase()
        .split(/[^a-z0-9]+/u)
        .filter((token) => token.length > 2),
    );
    if (!other.size) continue;
    let shared = 0;
    for (const token of body) if (other.has(token)) shared += 1;
    const overlap = shared / Math.min(body.size, other.size);
    if (overlap < SUPERSESSION_DOMAIN_OVERLAP) continue;
    // A skill without a holdout score has nothing to be beaten ON: the
    // margin is unmeasured, and an unmeasured margin is not a margin.
    if (typeof skill.holdoutScore !== "number") continue;
    const margin = input.candidate.holdoutScore - skill.holdoutScore;
    if (margin < SUPERSESSION_MARGIN) continue;
    if (!best || margin > best.margin)
      best = { name: skill.name, margin, overlap };
  }
  if (!best)
    return {
      none: true,
      reason:
        "no same-domain skill is beaten by the margin — the catalog keeps what it has",
    };
  return {
    suggestion: {
      replace: best.name,
      with: input.candidate.name,
      margin: best.margin,
      overlap: best.overlap,
    },
  };
}
