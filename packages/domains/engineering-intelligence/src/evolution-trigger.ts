/**
 * S8: when should a round of self-iteration run?
 *
 * Until now the answer was "when a human typed the command" — the whole
 * loop was human-triggered, which is why the system was a tool chain
 * rather than a self-iterating one. The reference design's continuous
 * loop (its Phase 5) triggers on a THRESHOLD, not on a schedule: run the
 * benchmark periodically, and when a score drops or a failure rate exceeds
 * a threshold, optimize that target. Its own monitor is a stub, so this is
 * the law it never wrote down.
 *
 * Three gates, each of which can refuse and each of which names itself —
 * a refusal that says only "no" teaches the operator nothing:
 *
 *  1. the BUDGET gate (replacing the resource lock the reference design
 *     needed for a GPU and we do not: we call APIs, so the scarce thing is
 *     concurrent model calls, not VRAM). At most N rounds in flight.
 *  2. the NEED gate: a ranked trigger above the floor. A catalog of
 *     triggers none of which is worth acting on is not a reason to spend.
 *  3. the SIGNAL gate: the holdout moved the wrong way. A round answers a
 *     regression; with nothing regressing there is nothing to answer.
 *
 * The curiosity controller (W4) decides which AXIS a round takes, not
 * whether one runs — that separation is deliberate: exploration without a
 * signal is just spending.
 */

/** A ranked trigger below this potential is noise, not a target. */
export const TRIGGER_POTENTIAL_FLOOR = 0.1;
/** A holdout decline at least this large is the signal (2%, the reference's regression threshold). */
export const TRIGGER_HOLDOUT_DECLINE = 0.02;
/** How many evolution rounds may be in flight at once (the budget replacing the resource lock). */
export const EVOLUTION_CONCURRENCY = 2;

export function evolutionTrigger(input: {
  /** The top-ranked trigger's potential (0 when nothing ranked). */
  topPotential: number;
  /** This round's holdout movement (negative is a decline). */
  holdoutDelta: number;
  /** How many evolution rounds are in flight right now. */
  activeEvolutions: number;
  /** The concurrency budget (default the named constant). */
  budget?: number;
}): { run: boolean; reason: string } {
  const budget = input.budget ?? EVOLUTION_CONCURRENCY;
  if (input.activeEvolutions >= budget)
    return {
      run: false,
      reason: `the concurrency budget is spent (${input.activeEvolutions}/${budget} rounds in flight) — the scarce resource is concurrent model calls, not VRAM`,
    };
  if (!(input.topPotential >= TRIGGER_POTENTIAL_FLOOR))
    return {
      run: false,
      reason: `no ranked trigger above ${TRIGGER_POTENTIAL_FLOOR} (top was ${input.topPotential.toFixed(3)}) — nothing worth answering`,
    };
  if (input.holdoutDelta > -TRIGGER_HOLDOUT_DECLINE)
    return {
      run: false,
      reason: `the holdout moved ${input.holdoutDelta >= 0 ? "up" : "flat"} (${input.holdoutDelta >= 0 ? "+" : ""}${input.holdoutDelta.toFixed(4)}) — a round answers a regression, and there is none`,
    };
  return {
    run: true,
    reason: `a trigger at ${input.topPotential.toFixed(3)} with the holdout down ${Math.abs(input.holdoutDelta).toFixed(4)} — run a round`,
  };
}
