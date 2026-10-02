/**
 * The session's date, snapshotted once and rolled over when the day changes.
 *
 * An agent asked "is this CHANGELOG current?" or "is this dependency version
 * new?" needs to know what day it is. The timestamp scheme that costs nothing
 * else:
 *
 *   - `sessionStartedAt` is fixed when the session's execution state is first
 *     built and never changes, so the model never sees two contradictory dates
 *     for when the session began.
 *   - The date rides in the `<environment_details>` block, which is already
 *     per-request runtime context. Putting it in the static system prompt would
 *     destroy the cross-session sharing of that prompt: Anthropic's prefix cache
 *     is content-addressed, and ten sessions with identical system prompts share
 *     one entry — a per-session date in it forfeits that.
 *   - Only the date, no time. Seconds make the string look volatile, which
 *     misleads anyone later reading a log or a diff.
 *
 * When the day changes under a long-running session, one `role:"dynamic"` entry
 * is appended rather than the earlier context being rewritten. `dynamic` renders
 * as a user message (ADR D2), so the append lands after the already-cached
 * prefix instead of invalidating it.
 */

/** Calendar date in `YYYY-MM-DD`, local time. */
export function calendarDate(at: Date): string {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, "0");
  const day = `${at.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Today's calendar date, from an injectable clock. */
export function today(now: () => Date = () => new Date()): string {
  return calendarDate(now());
}

/** Entry id for the rollover notice, stable per date so it cannot duplicate. */
export function dateRolloverEntryID(sessionID: string, date: string) {
  return `date:${sessionID}:${date}`;
}

/** Whether the recorded date is behind today's. */
export function dateRolledOver(
  recorded: string | undefined,
  todayDate: string,
) {
  return recorded !== undefined && recorded !== todayDate;
}

/**
 * The model-visible content of one rollover notice.
 *
 * Names both dates, because "the date changed" alone leaves the model to guess
 * whether it moved forward or the record was wrong.
 */
export function dateRolloverContent(from: string, to: string): string {
  return [
    `<runtime_context source="date_rollover" trust="runtime">`,
    `The date changed from ${from} to ${to} while this session was running.`,
    "Anything you judged as current or new earlier in this session was judged " +
      "against the earlier date.",
    `</runtime_context>`,
  ].join("\n");
}

/** The ledger surface this module needs: read the entries, append one. */
export interface RolloverLedger {
  snapshot(): { entries: ReadonlyArray<{ id: string }> };
  add(entry: { id: string; role: "dynamic"; content: string }): void;
}

/**
 * Append the rollover notice when the day has changed under a running session.
 *
 * One notice per date, keyed by the session and the date, so a session that
 * crosses several days appends one per crossing rather than one per turn.
 * `dynamic` renders as a user message, so the append lands after the
 * already-cached prefix instead of invalidating it.
 */
export function appendDateRollover(input: {
  ledger: RolloverLedger;
  sessionID: string;
  recorded: string | undefined;
  todayDate: string;
}): "appended" | "unchanged" {
  if (!dateRolledOver(input.recorded, input.todayDate)) return "unchanged";
  const entryID = dateRolloverEntryID(input.sessionID, input.todayDate);
  // The ledger rejects a duplicate id, so an already-appended notice is left
  // alone rather than rewritten.
  if (input.ledger.snapshot().entries.some((entry) => entry.id === entryID))
    return "unchanged";
  input.ledger.add({
    id: entryID,
    role: "dynamic",
    content: dateRolloverContent(input.recorded!, input.todayDate),
  });
  return "appended";
}
