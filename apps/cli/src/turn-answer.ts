/**
 * The answer of ONE daemon turn, out of `session.messages`'s page.
 *
 * `session.messages` answers a page of projected turns
 * (`{data: [{turnID, submitted, rows: [{kind, event}]}]}`), and the
 * assistant's confirmed text is the `content.done` row inside a turn's own
 * projection. Two facts make the lookup by-turn rather than by-recency:
 *
 *  1. every sample of every candidate submits into the SAME session, so
 *     "the last assistant row in the session" is only correct for the most
 *     recent turn — and for a turn that produced no answer it is the
 *     PREVIOUS sample's answer, which would then be scored as this one's.
 *     Corrupt data that looks like a weak candidate is the worst kind.
 *  2. `submit.andWait` answers the submitted turn, so the turn's id is in
 *     hand at call time.
 *
 * Pure: the page in, the text (or a refusal naming the turn) out.
 */

/** The page's shape as this module reads it (structural, not nominal). */
export type TurnMessagePage = {
  data?: Array<{
    turnID?: string;
    submitted?: { id?: string };
    rows?: Array<{
      kind?: string;
      event?: { type?: string; text?: string };
    }>;
  }>;
};

/**
 * The turn's own assistant answer, or a refusal naming the turn.
 *
 * A turn with no `content.done` answer is a REFUSAL, never a fallback to
 * another turn's text: the caller scores what this turn actually said.
 */
export function assistantAnswerFromPage(
  page: TurnMessagePage,
  turnID: string | undefined,
): { ok: true; text: string } | { ok: false; reason: string } {
  const messages = page.data ?? [];
  if (!messages.length)
    return { ok: false, reason: "the session has no turns" };
  const own =
    turnID === undefined
      ? messages.at(-1)
      : messages.find(
          (message) =>
            message.turnID === turnID || message.submitted?.id === turnID,
        );
  if (!own)
    return {
      ok: false,
      reason: `no projection for turn ${turnID} in the session page`,
    };
  const rows = own.rows ?? [];
  const done = [...rows]
    .reverse()
    .find(
      (row) =>
        row.kind === "assistant" &&
        row.event?.type === "content.done" &&
        (row.event.text ?? "").trim(),
    );
  if (done?.event?.text?.trim()) return { ok: true, text: done.event.text };
  return {
    ok: false,
    reason: turnID
      ? `turn ${turnID} produced no assistant answer`
      : "the turn produced no assistant answer",
  };
}

/**
 * Whether the daemon is mid-turn, read from the session's own projection.
 *
 * The last projected turn carries a `stopReason` once it settles; an
 * unsettled one is a turn in flight — somebody's. The evolution waits for
 * it rather than queueing behind it: a user's turn must never wait behind
 * a mutation experiment. Pure, so the wait's condition is a unit test
 * rather than a hope.
 */
export function daemonIsMidTurn(page: {
  data?: Array<{ stopReason?: string }>;
}): boolean {
  const last = (page.data ?? []).at(-1);
  return last !== undefined && last.stopReason === undefined;
}
