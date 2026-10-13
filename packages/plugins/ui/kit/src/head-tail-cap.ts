/**
 * The output cap every tool card shares (UI refactor S2, 2026-10-08).
 *
 * The ruling: **every tool output is collapsed by default and opens by
 * hand**. The shape is the reference implementation's — a capped list shows
 * a head slice, a fold toggle naming how many rows are hidden, and a tail
 * slice, so a long output reads as "this is a window into something longer"
 * rather than a wall of text. Expanding shows everything; collapsing
 * restores the same window.
 *
 * The cap is one constant for the whole transcript row (the reference's
 * chat-row value; its details panel keeps twice as much). One rule for every
 * kind — a read, a terminal, a diff, a search — because the rule is about
 * how much text a row may show, not about what the text means.
 */

/** The collapsed-height cap in content lines for one tool output. */
export const CHAT_OUTPUT_MAX_LINES = 8;

/**
 * A single line longer than this collapses on its own term. The one-line
 * JSON shape — a 5000-character envelope on one line — passes any line
 * count, so it needs its own bound (the 2026-10-07 P0.2 rule, kept).
 */
export const SINGLE_LINE_MAX_CHARS = 400;

/** The head/tail split metrics for a capped list. */
export type HeadTailCap = {
  /** Rows beyond the cap (list length − maxLines); ≤ 0 means nothing is hidden. */
  hidden: number;
  /** Whether the list is over the cap and not expanded. */
  capped: boolean;
  /** Head-slice row count: `ceil(maxLines / 2)`. */
  headLines: number;
  /** Tail-slice row count: the remainder after the head. */
  tailLines: number;
};

/**
 * The split metrics for `total` rows against the cap. Pure arithmetic; the
 * caller slices its own rows so a renderer can layer its own concerns on
 * top (a diff's coloring, a search's grouping).
 */
export function headTailCap(
  total: number,
  maxLines: number,
  expanded: boolean,
): HeadTailCap {
  const hidden = total - maxLines;
  const headLines = Math.ceil(maxLines / 2);
  return {
    hidden,
    capped: hidden > 0 && !expanded,
    headLines,
    tailLines: maxLines - headLines,
  };
}

/** How many rows of this text are hidden by the cap (0 = nothing hidden). */
export function toolOutputHidden(text: string): number {
  const lines = text.split("\n").length;
  if (lines === 1 && Array.from(text).length > SINGLE_LINE_MAX_CHARS) return 1;
  return Math.max(0, lines - CHAT_OUTPUT_MAX_LINES);
}

/**
 * The rows one capped output SHOWS: everything when expanded, the head/tail
 * window when collapsed. Pure, so the toggle's promise — "展开全部" delivers
 * every row — is testable without a DOM.
 *
 * The `expanded` flag used to stop at the cap's metrics: the slice was
 * `ceil(maxLines/2)` head rows whether or not the reader had opened the
 * card, so the toggle named 17 hidden rows and delivered the same 8-row
 * window. A control that promises complete content and delivers the same
 * window is the worst UI bug class there is; the cap now applies only
 * while collapsed, which is the only state the user ruled it belongs to
 * (2026-10-13: the collapsed window is by design, the expanded lie is not).
 */
export function visibleOutputLines<T>(
  lines: readonly T[],
  maxLines: number,
  expanded: boolean,
): { head: T[]; tail: T[] } {
  if (expanded) return { head: [...lines], tail: [] };
  const cap = headTailCap(lines.length, maxLines, expanded);
  return {
    head: lines.slice(0, cap.headLines),
    tail: lines.slice(lines.length - cap.tailLines),
  };
}

/** The collapsed preview of one over-long line: a bounded head plus a mark. */
export function clipLongLine(
  text: string,
  maxChars = SINGLE_LINE_MAX_CHARS,
): string {
  const chars = Array.from(text);
  return chars.length > maxChars
    ? `${chars.slice(0, maxChars).join("")}…`
    : text;
}
