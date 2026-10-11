/**
 * S8's trigger inputs: the three facts, read from where they actually live.
 *
 * The law (`evolutionTrigger`) is pure and tested; this module answers the
 * question the wiring has to answer — where do the three facts come from?
 * Reading them is not free, so each reader is explicit about its source and
 * about what "no data" means:
 *
 *  - the NEED gate reads the triage's top row (the ranking L7 already
 *    computes; a second ranking would be a second thing to keep honest);
 *  - the SIGNAL gate reads the last two rounds' holdout scores from the
 *    run history (the journal the loop already writes);
 *  - the BUDGET gate's fact (rounds in flight) is the runtime's own count,
 *    not a journal read — there is nothing to fold, so it stays a caller
 *    argument.
 *
 * "No data" is never a signal: an empty ranking is 0 potential (nothing
 * worth answering) and a short history is a flat delta (nothing regressed).
 * Both refuse, which is the safe direction — a loop that reads absence as
 * urgency spends on nothing.
 */

/** A triage row as the trigger reads it (L7's ranking, already computed). */
export type RankedTrigger = { score: number };

/** The top-ranked trigger's potential, or 0 when nothing ranked. */
export function topPotentialFromTriggers(
  triggers: readonly RankedTrigger[],
): number {
  // The ranking is already ordered (the triage sorts by frequency ×
  // potential with a stable tie-break), so the first row IS the top.
  return triggers[0]?.score ?? 0;
}

/** One round's holdout score, as the run history carries it. */
export type RoundHoldout = { holdout?: number };

/**
 * The holdout's movement across the last two rounds. A history shorter
 * than two rounds has no movement to report, and "no movement" is 0 — a
 * flat delta, which the signal gate refuses (nothing regressed).
 */
export function holdoutDeltaFromRuns(runs: readonly RoundHoldout[]): number {
  const scored = runs.filter(
    (run): run is { holdout: number } =>
      typeof run.holdout === "number" && Number.isFinite(run.holdout),
  );
  if (scored.length < 2) return 0;
  const latest = scored[scored.length - 1]!.holdout;
  const previous = scored[scored.length - 2]!.holdout;
  return latest - previous;
}
