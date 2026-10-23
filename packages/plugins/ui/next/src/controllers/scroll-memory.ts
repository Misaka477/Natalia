/**
 * Transcript scroll memory: where the reader was, per session.
 *
 * Switching sessions used to land the reader at the bottom of the new
 * session's history, whatever they had been reading. A conversation is
 * read, not scrolled — the honest unit of "scroll position" is the
 * message the reader was looking at, plus how far into that message
 * they were, plus whether they were following the tail.
 *
 * The kit's own anchor (the first visible row's key and its offset)
 * is what this remembers; the kit restores it when it can. What this
 * module adds is the part the kit has no business owning: which session
 * each anchor belongs to, and how many to keep.
 */

/** Where the reader was in one session's transcript. */
export interface TranscriptAnchor {
  /** The message id the reader was looking at. */
  messageID: string;
  /** Pixels from that message's top edge to the viewport's top edge. */
  offsetInRow: number;
  /** Whether the transcript was following the tail at that moment. */
  following: boolean;
}

/** How many sessions to remember. Older anchors are evicted first. */
const MAX_REMEMBERED_SESSIONS = 32;

export class TranscriptScrollMemory {
  private readonly anchors = new Map<string, TranscriptAnchor>();

  /** Remember an anchor, dropping the oldest session past the cap. */
  remember(sessionID: string, anchor: TranscriptAnchor): void {
    // Re-insert so the Map's own order is the recency order.
    this.anchors.delete(sessionID);
    this.anchors.set(sessionID, anchor);
    while (this.anchors.size > MAX_REMEMBERED_SESSIONS) {
      const oldest = this.anchors.keys().next();
      if (oldest.done) break;
      this.anchors.delete(oldest.value);
    }
  }

  recall(sessionID: string): TranscriptAnchor | undefined {
    return this.anchors.get(sessionID);
  }

  /** Drop one session's anchor (it was archived, or its history changed). */
  forget(sessionID: string): void {
    this.anchors.delete(sessionID);
  }

  clear(): void {
    this.anchors.clear();
  }

  get size(): number {
    return this.anchors.size;
  }
}

/**
 * Read the anchor out of a transcript container: the first message row
 * that reaches the viewport's top edge, and how far past it the edge is.
 * Returns undefined when the container holds no message rows — an empty
 * transcript has no position to remember.
 */
export function readTranscriptAnchor(
  container: HTMLElement | undefined,
  following: boolean,
): TranscriptAnchor | undefined {
  if (!container) return undefined;
  const rows = container.querySelectorAll<HTMLElement>("[data-message-id]");
  if (rows.length === 0) return undefined;
  const top = container.getBoundingClientRect().top;
  let chosen: HTMLElement | undefined;
  let offsetInRow = 0;
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > top) {
      chosen = row;
      offsetInRow = Math.max(0, rect.top - top);
      break;
    }
  }
  // Every row is above the viewport's top edge: the reader is at the end.
  if (!chosen) {
    const last = rows[rows.length - 1]!;
    chosen = last;
    offsetInRow = 0;
  }
  const messageID = chosen.dataset.messageId;
  if (!messageID) return undefined;
  return { messageID, offsetInRow, following };
}

/**
 * The index to scroll to for a remembered anchor, or -1 when the anchor's
 * message is no longer in the list (the session grew past what the reader
 * was reading, or the history was rebuilt) — the caller then falls back to
 * the tail.
 */
export function anchorIndexFor(
  anchor: TranscriptAnchor | undefined,
  messageIDs: readonly string[],
): number {
  if (!anchor) return -1;
  return messageIDs.indexOf(anchor.messageID);
}
