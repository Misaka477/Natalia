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

import { holdoutDeltaFromRuns } from "./trigger-facts";

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

/**
 * The trigger's fact: what gets journaled when the gates pass.
 *
 * The runtime's turn boundary calls this with the three facts it already
 * holds; the answer is either a durable fact (the system noticed, on the
 * record, that a round is due — with the reason, so a reader can see WHY)
 * or nothing. The dedupe key is the top trigger's capability: the same gap
 * being announced once per turn is noise, and noise is how a journal
 * teaches people to stop reading it.
 *
 * Pure, so the wiring is a one-liner that cannot get the law wrong.
 */
export function triggerFactFrom(input: {
  triggers: readonly { capability: string; score: number }[];
  runs: readonly { holdout?: number }[];
  activeEvolutions: number;
  /** The capabilities already announced (from the journal's own facts). */
  alreadyTriggered: readonly string[];
}):
  | {
      fact: {
        capability: string;
        potential: number;
        holdoutDelta: number;
        reason: string;
        at: string;
      };
    }
  | { none: true; reason: string } {
  const top = input.triggers[0];
  const decision = evolutionTrigger({
    topPotential: top?.score ?? 0,
    holdoutDelta: holdoutDeltaFromRuns(input.runs),
    activeEvolutions: input.activeEvolutions,
  });
  if (!decision.run || !top) return { none: true, reason: decision.reason };
  if (input.alreadyTriggered.includes(top.capability))
    return {
      none: true,
      reason: `${top.capability} is already announced — the same gap once per turn is noise`,
    };
  return {
    fact: {
      capability: top.capability,
      potential: top.score,
      holdoutDelta: holdoutDeltaFromRuns(input.runs),
      reason: decision.reason,
      at: new Date().toISOString(),
    },
  };
}
