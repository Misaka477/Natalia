export type TailScrollAlignment = "start" | "center" | "end" | "auto";

export interface TailScrollControllerOptions {
  /** The element that owns the scroll position. */
  getScrollElement(): HTMLElement | undefined;
  /** Prefer the virtualizer's own end alignment when one is mounted. */
  scrollToEnd?(options?: { behavior?: ScrollBehavior }): void;
  /** Prefer the virtualizer's own index alignment when one is mounted. */
  scrollToIndex?(
    index: number,
    options?: { align?: TailScrollAlignment; behavior?: ScrollBehavior },
  ): void;
  /** Pixels from the physical bottom that still count as following. */
  distanceThreshold?: number;
  /** Report near-top so hosts can request older history. */
  nearTopThreshold?: number;
  /** Stop scheduling automatic follow while a host pane is being resized. */
  isPaused?(): boolean;
  onFollowChange?(following: boolean): void;
  onNearTop?(scrollTop: number): void;
  onAfterFollow?(scrollTop: number): void;
  /** CSS selector used to find logical message anchors. */
  anchorSelector?: string;
}

interface ViewportAnchor {
  readonly key: string;
  readonly top: number;
}

export interface OlderScrollAnchor {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly key?: string;
  readonly top?: number;
}

const DEFAULT_DISTANCE_THRESHOLD = 2;
const DEFAULT_NEAR_TOP_THRESHOLD = 80;
const DEFAULT_ANCHOR_SELECTOR = "[data-message-id]";

function asHtmlElement(value: EventTarget | null): HTMLElement | undefined {
  if (value === null) return undefined;
  if (typeof HTMLElement !== "undefined" && value instanceof HTMLElement)
    return value;
  // Tests and non-browser environments can pass a structurally compatible
  // element. The controller only reads geometry/scroll properties.
  if (
    typeof value === "object" &&
    value !== null &&
    "scrollTop" in value &&
    "scrollHeight" in value &&
    "clientHeight" in value
  ) {
    return value as HTMLElement;
  }
  return undefined;
}

function attributeSelector(selector: string, value: string): string {
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(value)
      : value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${selector}[data-message-id="${escaped}"]`;
}

/**
 * The aligned tail follower.
 *
 * There is exactly one follow state. The controller never watches content
 * height; it only follows after explicit data updates, an explicit
 * scroll-to-bottom, or while the reader is already within the bottom
 * threshold. User intent always wins and immediately breaks follow.
 */
export class TailScrollController {
  private readonly distanceThreshold: number;
  private readonly nearTopThreshold: number;
  private readonly anchorSelector: string;
  private readonly options: TailScrollControllerOptions;
  private followTail = true;
  /** Where the last follow-scroll left the pane (see `performScrollToEnd`). */
  private lastProgrammaticTop: number | undefined;
  private disposed = false;
  private cancelFollowSchedule: (() => void) | undefined;
  private cancelRestoreSchedule: (() => void) | undefined;
  private viewportAnchor: ViewportAnchor | undefined;
  private olderAnchor: OlderScrollAnchor | undefined;
  private restoreAttempts = 0;
  private notifyingDataChanged = false;
  private ignoreNextProgrammaticScroll = false;

  constructor(options: TailScrollControllerOptions) {
    this.options = options;
    this.distanceThreshold =
      options.distanceThreshold ?? DEFAULT_DISTANCE_THRESHOLD;
    this.nearTopThreshold =
      options.nearTopThreshold ?? DEFAULT_NEAR_TOP_THRESHOLD;
    this.anchorSelector = options.anchorSelector ?? DEFAULT_ANCHOR_SELECTOR;
  }

  getScrollElement(): HTMLElement | undefined {
    return this.options.getScrollElement();
  }

  isFollowing(): boolean {
    return this.followTail;
  }

  breakFollow(): void {
    this.ignoreNextProgrammaticScroll = false;
    this.setFollowing(false);
    this.cancelPendingFollow();
    this.cancelPendingRestore();
  }

  onUserIntent(): void {
    const element = this.getScrollElement();
    // A pane with no scrollable overflow cannot meaningfully break follow.
    // This covers empty/short Natalia, Navi, Nia, and Subagent panes.
    if (
      element === undefined ||
      element.scrollHeight - element.clientHeight <= this.distanceThreshold
    ) {
      return;
    }
    this.ignoreNextProgrammaticScroll = false;
    this.setFollowing(false);
    this.cancelPendingFollow();
    this.cancelPendingRestore();
    this.viewportAnchor = this.readViewportAnchor();
  }

  /**
   * Re-evaluate follow after a gesture ends. Touch/pointer-down must break
   * follow immediately to win against any in-flight streaming frame, but a
   * tap (or a drag that never leaves the bottom) should not leave a stray
   * jump button visible.
   */
  /**
   * Re-evaluate follow after a gesture ends. This only RE-ARMS (a tap that
   * never left the bottom should not leave a stray jump button); it never
   * clears, because the gesture that moved the reader away already did.
   */
  reconcile(): void {
    if (this.disposed) return;
    const element = this.getScrollElement();
    if (!element) return;
    if (this.isAtBottom(element)) this.setFollowing(true);
  }

  /**
   * A scroll event. This RE-ARMS follow when the reader lands at the bottom
   * and otherwise leaves the flag alone — it never clears it.
   *
   * It used to be `setFollowing(isAtBottom(element))`, which made our own
   * follow-scroll able to break follow: the write lands at the bottom of the
   * content as it was, the event is dispatched afterwards, and by then a
   * streaming chunk has grown `scrollHeight` again — so the event reports
   * "not at the bottom" and follow died. Every later frame was then a no-op
   * and the transcript detached for good, which is exactly what a large
   * burst of output looks like. The reference implementation does not have
   * this race because it writes `scrollTop` synchronously inside its layout
   * effect, so the event sees the same content the write targeted; this
   * controller writes from a rAF, so it has to say who the event belongs to.
   *
   * Clearing follow is the READER's decision, and a reader's decision
   * arrives as a gesture — wheel, touch, pointer, key — each of which calls
   * {@link onUserIntent}. A scroll event cannot tell the two apart, so it
   * does not try: it only resumes following when the reader comes back to
   * the bottom (a scrollbar dragged all the way down, a wheel-down that
   * reached the end).
   */
  onScroll(event: Event): void {
    if (this.disposed || this.isPaused()) return;
    const element =
      asHtmlElement(event.currentTarget) ?? this.getScrollElement();
    if (!element) return;

    if (this.ignoreNextProgrammaticScroll) {
      this.ignoreNextProgrammaticScroll = false;
      // Ours: the pane is still where our write left it (or the content grew
      // past it, which is the streaming burst). Keep follow — the next frame
      // catches up. Breaking here is what detached the transcript whenever a
      // large answer arrived in one piece.
      if (
        this.lastProgrammaticTop !== undefined &&
        element.scrollTop >= this.lastProgrammaticTop - this.distanceThreshold
      ) {
        if (this.isAtBottom(element)) this.setFollowing(true);
        return;
      }
      // The reader moved above our write: theirs, honour it.
    }

    this.setFollowing(this.isAtBottom(element));

    // Older-history paging is a reader action, not an initial-layout side
    // effect. A pinned transcript at scrollTop 0 (short content) must not pull
    // the oldest page before the first tail initialization.
    if (!this.followTail && element.scrollTop <= this.nearTopThreshold) {
      this.options.onNearTop?.(element.scrollTop);
    }
  }

  notifyDataChanged(): void {
    if (
      this.notifyingDataChanged ||
      !this.followTail ||
      this.disposed ||
      this.isPaused()
    )
      return;
    // The reference aligns the tail synchronously in the layout effect that observes
    // the data/structure change. Do the same here so a large block inserted
    // above the viewport cannot race a scroll event into dropping follow
    // before the deferred rAF runs. The follow-up rAF still catches late
    // measurement growth.
    this.notifyingDataChanged = true;
    try {
      this.performScrollToEnd("auto");
      this.scheduleFollowToEnd();
    } finally {
      this.notifyingDataChanged = false;
    }
  }

  captureOlderAnchor(): OlderScrollAnchor | undefined {
    const element = this.getScrollElement();
    if (!element) return undefined;
    const viewportAnchor = this.readViewportAnchor() ?? this.viewportAnchor;
    const anchor: OlderScrollAnchor = {
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      ...(viewportAnchor === undefined
        ? {}
        : { key: viewportAnchor.key, top: viewportAnchor.top }),
    };
    this.olderAnchor = anchor;
    // If the content is shorter than the viewport, the reader is physically
    // at the bottom even though scrollTop is 0. Do not break follow just
    // because a host offered an older-history hook.
    if (!this.isAtBottom(element)) {
      this.setFollowing(false);
      this.cancelPendingFollow();
    }
    this.cancelPendingRestore();
    return anchor;
  }

  restoreOlderAnchor(): void {
    if (this.disposed) return;
    const anchor = this.olderAnchor ?? this.buildAnchorFromViewport();
    this.olderAnchor = undefined;
    this.restoreAttempts = 0;
    this.setFollowing(false);
    this.cancelPendingFollow();
    if (!anchor) return;
    this.applyOlderAnchor(anchor);
    this.scheduleRestoreRetry(anchor);
  }

  /**
   * The data-driven follow: align the tail when the content grew.
   *
   * This is what the layout effect calls on every streaming frame, and it
   * must NOT re-arm follow. It used to (`setFollowing(true)` was the first
   * line of `scrollToBottom`), which is what locked the reader to the bottom
   * while the model streamed: their scroll cleared `followTail`, the next
   * frame's follow call set it straight back and jumped to the end. A
   * follow-scroll is only ever issued while following, so there is nothing
   * to re-arm — and when it is not following, this is a no-op.
   */
  followTailNow(): void {
    if (this.disposed) return;
    if (!this.followTail) return;
    this.cancelPendingRestore();
    this.performScrollToEnd("auto");
    this.scheduleFollowToEnd();
  }

  /**
   * The reader's explicit "go to the bottom" (the jump button, a session
   * switch). Unlike {@link followTailNow} this RE-ARMS follow, because the
   * reader asked for the tail and expects to stay on it.
   */
  scrollToBottom(options?: { behavior?: ScrollBehavior }): void {
    if (this.disposed) return;
    this.setFollowing(true);
    this.cancelPendingRestore();
    this.performScrollToEnd(options?.behavior ?? "auto");
    this.scheduleFollowToEnd();
  }

  scrollToIndex(
    index: number,
    options?: { align?: TailScrollAlignment; behavior?: ScrollBehavior },
  ): void {
    if (this.disposed) return;
    this.ignoreNextProgrammaticScroll = false;
    this.setFollowing(false);
    this.cancelPendingFollow();
    this.cancelPendingRestore();
    this.options.scrollToIndex?.(index, options);
  }

  dispose(): void {
    this.disposed = true;
    this.ignoreNextProgrammaticScroll = false;
    this.cancelPendingFollow();
    this.cancelPendingRestore();
    this.olderAnchor = undefined;
    this.viewportAnchor = undefined;
  }

  private isPaused(): boolean {
    return this.options.isPaused?.() === true;
  }

  private isAtBottom(element: HTMLElement): boolean {
    return (
      element.scrollHeight - element.clientHeight - element.scrollTop <=
      this.distanceThreshold
    );
  }

  private setFollowing(next: boolean): void {
    if (this.followTail === next || this.disposed) return;
    this.followTail = next;
    this.options.onFollowChange?.(next);
  }

  private performScrollToEnd(behavior: ScrollBehavior): void {
    const element = this.getScrollElement();
    if (!element) return;
    this.ignoreNextProgrammaticScroll = true;
    if (this.options.scrollToEnd !== undefined) {
      this.options.scrollToEnd({ behavior });
    } else {
      element.scrollTop = element.scrollHeight;
    }
    // Where our own write left the pane. The next scroll event is attributed
    // by comparing against this: the reader scrolling up moves scrollTop
    // ABOVE it, while our own event (which can arrive after the content has
    // grown again) leaves it exactly here. That is the only deterministic
    // way to tell the two apart when the follow writes from a rAF.
    this.lastProgrammaticTop = element.scrollTop;
    this.options.onAfterFollow?.(element.scrollTop);
  }

  private scheduleFollowToEnd(): void {
    if (
      this.cancelFollowSchedule !== undefined ||
      !this.followTail ||
      this.disposed ||
      this.isPaused()
    )
      return;

    const run = () => {
      this.cancelFollowSchedule = undefined;
      if (!this.followTail || this.disposed || this.isPaused()) return;
      this.performScrollToEnd("auto");
    };

    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(run);
      this.cancelFollowSchedule = () => cancelAnimationFrame(frame);
    } else {
      const timer = setTimeout(run, 0);
      this.cancelFollowSchedule = () => clearTimeout(timer);
    }
  }

  private cancelPendingFollow(): void {
    this.cancelFollowSchedule?.();
    this.cancelFollowSchedule = undefined;
  }

  private cancelPendingRestore(): void {
    this.cancelRestoreSchedule?.();
    this.cancelRestoreSchedule = undefined;
    this.restoreAttempts = 0;
  }

  private scheduleRestoreRetry(anchor: OlderScrollAnchor): void {
    if (anchor.key === undefined || this.restoreAttempts >= 3) return;
    const retry = () => {
      this.cancelRestoreSchedule = undefined;
      if (this.disposed || this.followTail) return;
      this.restoreAttempts += 1;
      this.applyOlderAnchor(anchor);
      this.scheduleRestoreRetry(anchor);
    };
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(retry);
      this.cancelRestoreSchedule = () => cancelAnimationFrame(frame);
    } else {
      const timer = setTimeout(retry, 0);
      this.cancelRestoreSchedule = () => clearTimeout(timer);
    }
  }

  private buildAnchorFromViewport(): OlderScrollAnchor | undefined {
    const anchor = this.viewportAnchor;
    if (anchor === undefined) return undefined;
    const element = this.getScrollElement();
    return {
      scrollHeight: element?.scrollHeight ?? 0,
      scrollTop: element?.scrollTop ?? 0,
      key: anchor.key,
      top: anchor.top,
    };
  }

  private applyOlderAnchor(anchor: OlderScrollAnchor): void {
    const element = this.getScrollElement();
    if (!element) return;
    if (anchor.key !== undefined) {
      const row = this.findAnchorRow(anchor.key);
      if (row !== null) {
        const containerRect = element.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        element.scrollTop +=
          rowRect.top - containerRect.top - (anchor.top ?? 0);
        this.viewportAnchor = { key: anchor.key, top: anchor.top ?? 0 };
        return;
      }
    }
    element.scrollTop =
      anchor.scrollTop + (element.scrollHeight - anchor.scrollHeight);
  }

  private readViewportAnchor(): ViewportAnchor | undefined {
    const element = this.getScrollElement();
    if (!element) return undefined;
    const anchorSelector = this.anchorSelector;
    let rows: HTMLElement[] = [];
    try {
      rows = [...element.querySelectorAll<HTMLElement>(anchorSelector)];
    } catch {
      rows = [];
    }
    const containerRect = element.getBoundingClientRect();
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom)
        continue;
      const key = row.dataset.messageId;
      if (key) return { key, top: rect.top - containerRect.top };
    }
    return undefined;
  }

  private findAnchorRow(key: string): HTMLElement | null {
    const element = this.getScrollElement();
    if (!element) return null;
    try {
      return element.querySelector<HTMLElement>(
        attributeSelector(this.anchorSelector, key),
      );
    } catch {
      return null;
    }
  }
}
