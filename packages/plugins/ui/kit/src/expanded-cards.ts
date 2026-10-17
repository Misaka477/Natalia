/**
 * Which tool cards the reader expanded, keyed by the CALL, not by a position.
 *
 * The reference implementation keys its tool rows by the event's own `callId`
 * (`call:${callId}`) and keeps the disclosure in the row component's local state;
 * a row's identity is therefore durable and its open state cannot move onto a
 * neighbour. This module is the same idea for a list that re-mounts its rows: the
 * durable call id is the key, and a position is only the fallback for a row that
 * has none (a hand-built row in a test, or a host that skipped the projection).
 *
 * The key used to be `${messageID}:${index}` unconditionally — and while each
 * message carries exactly one call today, an index is a POSITION: the moment a
 * message gains or loses a call before this one, the same card reads a different
 * key and the reader's expansion is either lost or applied to its neighbour.
 */

const expandedCards = new Set<string>();

/**
 * The row key of one tool call: its durable id when the projection carries one,
 * otherwise the message id plus the call's index in that message.
 *
 * @param toolCall - the row's call, for its `callID`.
 * @param messageID - the enclosing message's durable id.
 * @param index - the call's position inside that message.
 * @returns the key the expansion state is stored under.
 */
export function toolCardKey(
  toolCall: { callID?: string } | undefined,
  messageID: string,
  index: number,
): string {
  return toolCall?.callID ? `call:${toolCall.callID}` : `${messageID}:${index}`;
}

/** Whether the reader expanded this card (collapsed by default). */
export function isCardExpanded(key: string): boolean {
  return expandedCards.has(key);
}

/** Record the reader's expansion (or collapse) so a remount restores it. */
export function setCardExpanded(key: string, expanded: boolean): void {
  if (expanded) expandedCards.add(key);
  else expandedCards.delete(key);
}

/** Test seam: forget every expansion (a fresh transcript starts collapsed). */
export function resetExpandedCards(): void {
  expandedCards.clear();
}
