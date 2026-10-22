/**
 * Scroll-triggered page appending (unified-scroll plan §9): the reader never
 * clicks "加载更多"; scrolling to the end zone appends the next page, exactly
 * as the transcript's `onNearTop` anchor fetches older history. When a page
 * cannot fill the scrollport yet, appending continues until it does or the data
 * is exhausted — so a short list self-extends instead of trapping the reader.
 *
 * The pure `check` is shared by the work-graph virtual window and the
 * governance list tabs; each owner supplies the element, whether more rows
 * exist, and the append request.
 */
export const NEAR_BOTTOM_PX = 240;

/** The minimal scroll geometry the appender reads; a real element satisfies it. */
export type ScrollPortGeometry = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

export type ScrollAutoAppendInput = {
  scrollEl: () => ScrollPortGeometry | null | undefined;
  /** False once every page has been appended; blocks redundant requests. */
  moreAvailable: () => boolean;
  /** Row count (or another stable size signal) used to re-arm after a page. */
  rowCount: () => number;
  append: () => void;
  /** Distance to the end of the list that still triggers a page (px). */
  nearPx?: number;
};

export type ScrollAutoAppend = {
  /** Call from a scroll handler and after every row-count change. */
  check: () => void;
  /** True when the scrollport currently sits inside the end zone. */
  isNearBottom: () => boolean;
};

export function createScrollAutoAppend(
  input: ScrollAutoAppendInput,
): ScrollAutoAppend {
  const nearPx = input.nearPx ?? NEAR_BOTTOM_PX;
  let lastFiredRowCount = -1;

  const isNearBottom = () => {
    const el = input.scrollEl();
    if (!el) return false;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= nearPx;
  };

  const check = () => {
    const el = input.scrollEl();
    if (!el || !input.moreAvailable()) return;
    // A list shorter than the viewport cannot scroll at all: it must grow to
    // become scrollable, so appending stays armed for every new page.
    const underfilled = el.scrollHeight <= el.clientHeight + 1;
    if (!underfilled && !isNearBottom()) {
      lastFiredRowCount = -1;
      return;
    }
    // Re-arm when the page actually grew (otherwise the end zone would keep
    // re-firing on every scroll event without new data).
    if (!underfilled && input.rowCount() === lastFiredRowCount) return;
    lastFiredRowCount = input.rowCount();
    input.append();
  };

  return { check, isNearBottom };
}
