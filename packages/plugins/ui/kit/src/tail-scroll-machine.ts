/**
 * Pure tail-scroll state machine, aligned with the reference
 * TrajectoryTable's `tableScrollInitialized` / `followsTableTail` /
 * `olderLoadAnchor` model.
 *
 * The host owns DOM/effects; this module owns only the decisions:
 * when to initialize the tail, when new content may follow it, and when a
 * prepend must restore a saved anchor instead.
 */

export interface TailScrollAnchor {
  /** First visible message id before the prepend. */
  readonly startKey: string | null;
  /** Scroll geometry captured before the older page request. */
  readonly scrollHeight: number;
  readonly scrollTop: number;
  /** First visible semantic row id, used to restore a virtualized window. */
  readonly visibleKey: string | null;
  /** Offset of that row from the scrollport top, in pixels. */
  readonly visibleTop: number;
}

export interface TailScrollState {
  readonly initialized: boolean;
  readonly lastStartKey: string | null;
  readonly olderAnchor: TailScrollAnchor | null;
}

export interface TailScrollInput {
  readonly count: number;
  readonly firstKey: string | null;
  readonly historyLoading: boolean;
  /** Whether the virtualizer has a valid, measured window. */
  readonly virtualReady: boolean;
  /** Whether virtualization is active at all. */
  readonly virtualize: boolean;
  /**
   * The LIVE follow state, owned by the scroll controller — the reader's
   * scroll is the only thing that clears it.
   *
   * This machine used to keep its own `following` flag, which made it a
   * SECOND copy of the same fact: the reader's scroll cleared the
   * controller's copy and left this one untouched, so during streaming the
   * layout effect kept being told "follow" and yanked the viewport back to
   * the bottom — the reader could not scroll up at all while the model
   * streamed. The reference harness has exactly one ref for this, written by
   * `onScroll` and read by the layout effect, and no helper that writes it
   * back to true; this is that, with the flag passed in rather than
   * shadowed.
   */
  readonly following: boolean;
}

export type TailScrollEffect =
  | { readonly type: "none" }
  | { readonly type: "measure-and-scroll-end" }
  | { readonly type: "scroll-end" }
  | { readonly type: "restore-anchor"; readonly anchor: TailScrollAnchor };

export function initialTailScrollState(): TailScrollState {
  return {
    initialized: false,
    lastStartKey: null,
    olderAnchor: null,
  };
}

export function evaluateTailScroll(
  state: TailScrollState,
  input: TailScrollInput,
): { readonly state: TailScrollState; readonly effect: TailScrollEffect } {
  const next = { ...state };

  // A prepend changes the head while an older-page anchor is pending.
  if (
    next.olderAnchor !== null &&
    next.olderAnchor.startKey !== input.firstKey
  ) {
    const anchor = next.olderAnchor;
    next.olderAnchor = null;
    next.lastStartKey = input.firstKey;
    // The host breaks follow for the restore (the controller owns the flag),
    // so this machine only reports WHAT to restore.
    return { state: next, effect: { type: "restore-anchor", anchor } };
  }

  // Whole transcript/session replacement: run first-load initialization again.
  if (
    next.initialized &&
    next.lastStartKey !== null &&
    next.lastStartKey !== input.firstKey
  ) {
    // A different transcript starts at its own tail, whatever the reader was
    // doing in the previous one.
    next.initialized = false;
  }
  next.lastStartKey = input.firstKey;

  if (input.historyLoading || input.count === 0)
    return { state: next, effect: { type: "none" } };

  if (!next.initialized) {
    // Dynamic message heights need a measured virtual window before the one
    // initial scroll-to-end can own the tail.
    if (input.virtualize && !input.virtualReady)
      return { state: next, effect: { type: "none" } };
    next.initialized = true;
    return { state: next, effect: { type: "measure-and-scroll-end" } };
  }

  // The reader's own state decides, not a copy of it.
  if (!input.following) return { state: next, effect: { type: "none" } };
  return { state: next, effect: { type: "scroll-end" } };
}
