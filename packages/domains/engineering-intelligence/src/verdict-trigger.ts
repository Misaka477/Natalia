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

/** What the trigger reads: the session's event tail. */
export function shouldWakeForVerdict(events: readonly RuntimeEvent[]): {
  wake: boolean;
  turnID?: string;
  reason: string;
} {
  // The newest admission decides, and what precedes it supplies the turn
  // to judge. Two passes, in that order: find the newest submission, then
  // look at everything before it for the last assistant turn that
  // FINISHED (a turn still in flight has no answer to judge).
  let newestSubmission = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.type === "turn.submitted") {
      newestSubmission = index;
      break;
    }
  }
  if (newestSubmission < 0)
    return { wake: false, reason: "no turn submission in the tail" };
  const admission = events[newestSubmission] as { internal?: boolean };
  if (admission.internal === true)
    return {
      wake: false,
      reason: "the newest admission is an internal wake — nobody spoke",
    };
  for (let index = newestSubmission - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "turn.finished")
      return {
        wake: true,
        turnID: event.id,
        reason: `a human turn follows the finished turn ${event.id}`,
      };
    if (event.type === "turn.started")
      return {
        wake: false,
        reason: `turn ${event.id} is still in flight — no answer to judge`,
      };
  }
  return {
    wake: false,
    reason: "no finished assistant turn precedes it — nothing to judge",
  };
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
