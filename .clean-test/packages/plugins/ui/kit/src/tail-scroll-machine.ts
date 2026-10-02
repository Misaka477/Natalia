/**
 * Pure tail-scroll state machine, aligned with deepseek-harness
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
  readonly following: boolean;
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
}

export type TailScrollEffect =
  | { readonly type: "none" }
  | { readonly type: "measure-and-scroll-end" }
  | { readonly type: "scroll-end" }
  | { readonly type: "restore-anchor"; readonly anchor: TailScrollAnchor };

export function initialTailScrollState(): TailScrollState {
  return {
    initialized: false,
    following: true,
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
    next.following = false;
    next.lastStartKey = input.firstKey;
    return { state: next, effect: { type: "restore-anchor", anchor } };
  }

  // Whole transcript/session replacement: run first-load initialization again.
  if (
    next.initialized &&
    next.lastStartKey !== null &&
    next.lastStartKey !== input.firstKey
  ) {
    next.initialized = false;
    next.following = true;
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
    next.following = true;
    return { state: next, effect: { type: "measure-and-scroll-end" } };
  }

  if (!next.following) return { state: next, effect: { type: "none" } };
  return { state: next, effect: { type: "scroll-end" } };
}
