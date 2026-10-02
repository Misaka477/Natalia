import type { TranscriptPage } from "@anthelia/contracts";

/**
 * Shared cursor arithmetic for transcript-like read surfaces.
 *
 * The cursor is source-owned and opaque to callers. It points at an index
 * *between* projected rows; `older` pages end before that index and `newer`
 * pages start at it. Every page surface uses the same shape so the UI can share
 * one paging controller.
 */
export type TranscriptCursorDirection = "older" | "newer";

export function encodeTranscriptCursor(
  prefix: string,
  direction: TranscriptCursorDirection,
  index: number,
): string {
  return `${prefix}-${direction}:${index}`;
}

export function decodeTranscriptCursor(
  prefix: string,
  cursor: string | undefined,
): { direction: TranscriptCursorDirection; index: number } | undefined {
  if (!cursor) return undefined;
  const match = new RegExp(`^${prefix}-(older|newer):(\\d+)$`, "u").exec(
    cursor,
  );
  if (!match) return undefined;
  const index = Number(match[2]);
  if (!Number.isSafeInteger(index) || index < 0) return undefined;
  return {
    direction: match[1] as TranscriptCursorDirection,
    index,
  };
}

/** Slice one page from an already ordered (oldest-first) item list. */
export function paginateTranscript<T>(
  items: readonly T[],
  cursor: string | undefined,
  limitInput: number | undefined,
  prefix: string,
): TranscriptPage<T> {
  const limit = Math.min(500, Math.max(1, limitInput ?? 100));
  const decoded = decodeTranscriptCursor(prefix, cursor);
  let start: number;
  let end: number;
  if (!decoded) {
    end = items.length;
    start = Math.max(0, end - limit);
  } else if (decoded.direction === "older") {
    end = Math.min(items.length, decoded.index);
    start = Math.max(0, end - limit);
  } else {
    start = Math.min(items.length, decoded.index);
    end = Math.min(items.length, start + limit);
  }
  return {
    data: items.slice(start, end),
    cursor: {
      ...(start > 0
        ? { previous: encodeTranscriptCursor(prefix, "older", start) }
        : {}),
      ...(end < items.length
        ? { next: encodeTranscriptCursor(prefix, "newer", end) }
        : {}),
    },
  };
}
