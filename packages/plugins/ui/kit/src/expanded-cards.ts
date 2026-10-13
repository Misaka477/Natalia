/**
 * Which tool cards the reader expanded, keyed by row.
 *
 * The transcript is a virtual list: a row scrolled out of the viewport
 * unmounts, and its `expanded` local signal died with it. The 2026-10-13
 * audit watched a reader expand a 202-line read, scroll away, come back,
 * and find the card collapsed again — the expansion the reader asked for
 * silently undid itself (audit ③). Expansion is row-scoped truth, not
 * component state, so it lives here keyed by the card's row id and a
 * remount reads it back.
 *
 * The key is the message id plus the call's index inside it: a message can
 * carry several tool calls, and the durable `ToolCall` shape has no id of
 * its own. One key per rendered card, stable across a remount because both
 * halves are durable facts.
 */

const expandedCards = new Set<string>();

/** The row key of one tool call: the message's id plus its index. */
export function toolCardKey(messageID: string, index: number): string {
  return `${messageID}:${index}`;
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
