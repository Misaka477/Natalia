/**
 * S9's production half: the trigger law.
 *
 * A verdict wake is due when the journal's tail shows the shape "an
 * assistant turn finished, and then a HUMAN turn was submitted" — the
 * user's follow-up is the verdict on the answer that preceded it, and Nia
 * is woken to read the exchange and judge it.
 *
 * Three exclusions, each of which is a real way to wake her for nothing:
 *  - an INTERNAL wake (a goal round, a collaboration injection) is not a
 *    human verdict — nobody spoke;
 *  - a turn that never finished has no answer to judge;
 *  - the same pair must not wake her twice (idempotence by turnID).
 *
 * Pure, so the law is a unit test rather than a hope.
 */

import type { RuntimeEvent } from "@anthelia/contracts";

/**
 * The verdict-wake decision, from the two facts the caller already holds:
 * the turn that just finished, and whether the submission arriving now is
 * the user's own. Pure, so the law is a unit test rather than a hope — and
 * so the runtime wiring is a one-liner that cannot get the law wrong.
 *
 * The shape: a HUMAN submission after a FINISHED assistant turn. The
 * user's follow-up is the verdict on the answer that preceded it, and Nia
 * is woken to read the exchange and judge it.
 */
export function verdictWakeDue(input: {
  /** The turn that just finished (undefined when none has). */
  lastFinishedTurnID?: string;
  /** Whether the arriving submission is a runtime-generated wake. */
  submissionInternal?: boolean;
}): { wake: boolean; turnID?: string; reason: string } {
  if (input.submissionInternal === true)
    return {
      wake: false,
      reason: "the arriving submission is an internal wake — nobody spoke",
    };
  if (!input.lastFinishedTurnID)
    return {
      wake: false,
      reason: "no finished assistant turn precedes it — nothing to judge",
    };
  return {
    wake: true,
    turnID: input.lastFinishedTurnID,
    reason: `a human turn follows the finished turn ${input.lastFinishedTurnID}`,
  };
}

/**
 * The turn that finished most recently, read from the journal's tail.
 * `undefined` when the newest turn is still in flight (no answer to judge)
 * or when nothing has run yet.
 */
export function lastFinishedTurnID(
  events: readonly RuntimeEvent[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "turn.finished") return event.id;
    if (event.type === "turn.started") return undefined;
  }
  return undefined;
}

/**
 * Whether this turn has already had its verdict wake (idempotence): the
 * journal already carries a verdict-requested fact for it.
 */
export function verdictAlreadyRequested(
  events: readonly RuntimeEvent[],
  turnID: string,
): boolean {
  return events.some(
    (event) =>
      event.type === "verdict.requested" &&
      (event as { turnID?: string }).turnID === turnID,
  );
}
