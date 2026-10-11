/**
 * W8: the escalation ladder.
 *
 * A phase gate that fails used to say "stop and reassess" and nothing
 * else — the loop had no ladder, so a stalled run ended in a shrug. The
 * user's design note has one: incremental patching → same-domain
 * replacement → framework change, with a quantitative trigger (the
 * Plasticity Index: successful acquisitions over rollbacks). A sustained
 * decline means the current core has hit its limit and the answer is one
 * level up, not another round of the same thing.
 *
 * Our highest two rungs already exist as code — `apply_generation`'s four
 * faces with their automatic rollback ARE the shadow-training-plus-atomic-
 * -transition protocol. What was missing is the rung BELOW them and the
 * trigger that says which rung to take. This module supplies both, and it
 * stops at ADVICE: it never performs a migration. The human reads the
 * advice and runs the command (the same boundary S5 lands candidates
 * through).
 */

/** The plasticity index: acquisitions over rollbacks, clamped for display. */
export type PlasticityIndex = {
  /** Candidates that beat their parent (an acquisition). */
  acquisitions: number;
  /** Candidates the gates refused, or that regressed (a rollback). */
  rollbacks: number;
  /**
   * The ratio, or 0 when there is nothing to divide. A sustained decline
   * is the paper's signal that the core has reached its information
   * density limit.
   */
  value: number;
};

export function plasticityIndex(input: {
  acquisitions: number;
  rollbacks: number;
}): PlasticityIndex {
  const value =
    input.rollbacks > 0
      ? input.acquisitions / input.rollbacks
      : input.acquisitions;
  return {
    acquisitions: input.acquisitions,
    rollbacks: input.rollbacks,
    value,
  };
}

/** The ladder's rungs, lowest first. */
export type EscalationStep =
  /** The measurement is the likely culprit: a stronger judge, more samples. */
  | "retry-with-a-stronger-judge"
  /** The artifact is the likely culprit: replace the same-domain one. */
  | "supersede-same-domain"
  /** The core is the likely culprit: propose a framework change. */
  | "propose-generation";

export type EscalationAdvice = {
  /** The rung to take, or undefined when there is nothing to escalate. */
  step?: EscalationStep;
  /** Why this rung, in the reader's terms. */
  reason: string;
  /** The plasticity index the advice read. */
  plasticity: PlasticityIndex;
};

/**
 * Which rung a stalled loop should take.
 *
 * The law: the FIRST suspicion is always the measurement (a cheap judge
 * cannot see what it cannot score, and a small sample is noise); only when
 * the measurement has been given a fair chance and the plasticity index
 * is still falling does the advice move up. A run that beat its floor gets
 * no advice at all — there is nothing to escalate.
 */
export function escalationAdvice(input: {
  /** Whether the phase gate passed (the floor was beaten). */
  beatFloor: boolean;
  plasticity: PlasticityIndex;
  /** Rounds since the last strict improvement (the curiosity's failure count). */
  consecutiveFailures: number;
  /** How many candidates this run evaluated (a fair chance's denominator). */
  evaluated: number;
}): EscalationAdvice {
  if (input.beatFloor)
    return {
      reason: "the floor was beaten — nothing to escalate",
      plasticity: input.plasticity,
    };
  // Too few candidates to blame anything but the sample: say so rather
  // than manufacturing a diagnosis.
  if (input.evaluated < 3)
    return {
      step: "retry-with-a-stronger-judge",
      reason: `only ${input.evaluated} candidate(s) evaluated — too few to distinguish a weak judge from a weak artifact; mine more samples or raise --samples`,
      plasticity: input.plasticity,
    };
  if (input.consecutiveFailures < 2)
    return {
      step: "retry-with-a-stronger-judge",
      reason:
        "the judge is the first suspect: a cheap judge cannot score what it cannot see (procedure and conciseness are UNJUDGED), so switch --judge or add samples before blaming the artifact",
      plasticity: input.plasticity,
    };
  if (input.plasticity.value >= 1)
    return {
      step: "supersede-same-domain",
      reason:
        "candidates keep being accepted but none beats the floor — the artifact's neighbourhood is exhausted; look for a same-domain skill to replace (W7)",
      plasticity: input.plasticity,
    };
  return {
    step: "propose-generation",
    reason: `plasticity ${input.plasticity.value.toFixed(2)} (${input.plasticity.acquisitions} acquisitions / ${input.plasticity.rollbacks} rollbacks) with ${input.consecutiveFailures} stalled rounds — the core has hit its limit; propose a framework change through the four faces (apply_generation), never by hand`,
    plasticity: input.plasticity,
  };
}
