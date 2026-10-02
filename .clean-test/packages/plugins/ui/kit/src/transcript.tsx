import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type { JSX } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { marked } from "marked";
import type { Attachment, Message, ToolCall } from "./message";
import { TailScrollController } from "./scroll-controller";
import {
  evaluateTailScroll,
  initialTailScrollState,
  type TailScrollState,
} from "./tail-scroll-machine";
import {
  dedupeVirtualItems,
  duplicateValues,
  duplicateVirtualIndexes,
} from "./virtual-items";

const VIRTUALIZE_THRESHOLD = 80;
const BOTTOM_FOLLOW_THRESHOLD_PX = 2;
const VIRTUAL_OVERSCAN = 24;
const VIRTUAL_ROW_GAP = 6;
const VIRTUAL_INITIAL_VIEWPORT_HEIGHT_PX = 600;
const TOOL_OUTPUT_COLLAPSE_LINES = 14;
const TOOL_OUTPUT_PREVIEW_LINES = 10;

function uiDebugEnabled() {
  try {
    if (globalThis.localStorage?.getItem("natalia.debug.ui") === "1")
      return true;
    const href = globalThis.location?.href;
    if (!href) return false;
    return new URL(href).searchParams.get("nataliaDebugUi") === "1";
  } catch {
    return false;
  }
}

declare global {
  interface Window {
    _nataliaCodeBlocks?: string[];
  }
}

export interface TranscriptHandle {
  /** Scroll to the last row when virtualized, or directly to the end otherwise. */
  scrollToBottom(options?: { behavior?: ScrollBehavior }): void;
  scrollToIndex(
    index: number,
    options?: {
      align?: "start" | "center" | "end" | "auto";
      behavior?: ScrollBehavior;
    },
  ): void;
  /** Force TanStack Virtual to re-measure mounted rows. */
  measure(): void;
  /** Whether new data currently follows the tail. */
  isFollowing(): boolean;
  /** Immediately leave tail-follow mode without changing the scroll offset. */
  breakFollow(): void;
}

export interface TranscriptProps {
  messages: Message[];
  emptyTitle?: string;
  emptyHint?: string;
  assistantName?: string;
  assistantInitial?: string;
  scrollRef?: (el: HTMLDivElement | undefined) => void;
  /** Observation-only native scroll callback. Follow decisions live in kit. */
  onScroll?: (event: Event) => void;
  /** Notified when the shared tail-follow state changes. */
  onFollowChange?: (following: boolean) => void;
  /** Called when the reader is near the top so hosts can page older history. */
  onNearTop?: (scrollTop: number) => void;
  loadAttachmentUrl?: (attachment: Attachment) => Promise<string>;
  onFork?: (turnID: string) => void;
  onRollback?: (message: Message) => void;
  checkpointIDForMessage?: (message: Message) => string | undefined;
  /** Freeze row measurement while a host pane is being resized. */
  suspendVirtualization?: boolean;
  /** True while the initial history page is still loading. Tail init waits. */
  historyLoading?: boolean;
  /** True while an older-history page is in flight. */
  olderHistoryLoading?: boolean;
  /** Whether an older-history page exists (enables short-content auto-fill). */
  hasOlder?: boolean;
  /** Exposes scroll/measure methods so hosts do not write scrollTop directly. */
  apiRef?: (handle: TranscriptHandle | undefined) => void;
}

export function Transcript(props: TranscriptProps) {
  const [scrollEl, setScrollEl] = createSignal<HTMLDivElement>();
  const [scrollReady, setScrollReady] = createSignal(false);
  const virtualize = () => props.messages.length > VIRTUALIZE_THRESHOLD;
  let controller: TailScrollController | undefined;
  // dsh's useStableVirtualRowStructure keeps row identity/height stable across
  // renders. Message heights are dynamic, so cache by a content signature: a
  // measurement callback must not see a different estimate for the same row.
  const estimateCache = new Map<
    string,
    { signature: string; height: number }
  >();
  const messageSignature = (message: Message): string =>
    [
      message.id,
      message.role,
      message.content.length,
      message.thinking === true,
      message.attachments?.length ?? 0,
      (message.toolCalls ?? [])
        .map((call) => `${call.name}:${call.output?.length ?? 0}`)
        .join(","),
    ].join("|");
  const estimateStable = (index: number): number => {
    const message = props.messages[index];
    if (message === undefined) return 40;
    const signature = messageSignature(message);
    const cached = estimateCache.get(message.id);
    if (cached !== undefined && cached.signature === signature)
      return cached.height;
    // The virtualizer uses the deterministic fixed-height row model, so the
    // estimate is the rendered height and no DOM measurement is needed.
    const height = fixedRowHeight(message);
    estimateCache.set(message.id, { signature, height });
    if (estimateCache.size > 4096) {
      const oldest = estimateCache.keys().next().value;
      if (oldest !== undefined) estimateCache.delete(oldest);
    }
    return height;
  };

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return props.messages.length;
    },
    getScrollElement: () => scrollEl() ?? null,
    estimateSize: (index) => estimateStable(index),
    getItemKey: (index) => props.messages[index]?.id ?? index,
    anchorTo: "end",
    // Match deepseek-harness TrajectoryTable: anchorTo:"end" plus the same
    // 2px follow threshold lets TanStack compensate dynamic estimate→measure
    // deltas while the reader is pinned. Follow *ownership* still lives in
    // TailScrollController; without this end compensation a late measurement
    // of a large row above the fold silently leaves the scrollport above the
    // true bottom with no scroll event to correct it.
    scrollEndThreshold: BOTTOM_FOLLOW_THRESHOLD_PX,
    initialRect: {
      width: 0,
      height: VIRTUAL_INITIAL_VIEWPORT_HEIGHT_PX,
    },
    get useCachedMeasurements() {
      return props.suspendVirtualization === true;
    },
    gap: VIRTUAL_ROW_GAP,
    overscan: VIRTUAL_OVERSCAN,
    onChange: () => {
      // Tail-follow is owned by the transcript state machine below; a
      // measurement callback must not scroll on its own.
    },
  });
  let pendingScrollEl: HTMLDivElement | undefined;
  const setScrollRef = (el: HTMLDivElement | null) => {
    if (!el) {
      pendingScrollEl = undefined;
      setScrollEl(undefined);
      props.scrollRef?.(undefined);
      return;
    }
    pendingScrollEl = el;
    const commit = () => {
      if (pendingScrollEl !== el || !el.isConnected) return;
      pendingScrollEl = undefined;
      setScrollEl(el);
      props.scrollRef?.(el);
    };
    // Solid's compiled ref callback runs before the cloned node is inserted.
    // At that point a template clone can still have an ownerDocument whose
    // defaultView is null, so TanStack cannot attach its scroll observers.
    // Commit after insertion (microtask when possible, rAF as fallback).
    if (el.isConnected) {
      commit();
      return;
    }
    queueMicrotask(() => {
      if (el.isConnected) commit();
      else requestAnimationFrame(commit);
    });
  };

  const liveVirtualItems = () => virtualizer.getVirtualItems();
  const liveTotalSize = () => virtualizer.getTotalSize();

  // deepseek-harness TrajectoryTable state machine (pure, tested in
  // tail-scroll-machine.test.ts).
  let tailState: TailScrollState = initialTailScrollState();
  /**
   * The same near-top notification used by native scroll, exposed so a short
   * transcript with older pages can fill itself without a manual button.
   */
  const notifyNearTop = () => {
    if (
      props.onNearTop === undefined ||
      !tailState.initialized ||
      props.olderHistoryLoading === true
    )
      return;
    const el = scrollEl();
    if (el !== undefined) {
      const firstVirtual = liveVirtualItems()[0]?.index ?? 0;
      const visibleIndex =
        virtualize() && liveVirtualItems().length > 0 ? firstVirtual : 0;
      const visibleKey = props.messages[visibleIndex]?.id ?? null;
      const visibleRow =
        visibleKey === null
          ? null
          : el.querySelector<HTMLElement>(
              `[data-message-id="${CSS.escape(visibleKey)}"]`,
            );
      const containerRect = el.getBoundingClientRect();
      tailState = {
        ...tailState,
        olderAnchor: {
          startKey: tailState.lastStartKey,
          scrollHeight: el.scrollHeight,
          scrollTop: el.scrollTop,
          visibleKey,
          visibleTop:
            visibleRow === null
              ? 0
              : visibleRow.getBoundingClientRect().top - containerRect.top,
        },
      };
    }
    props.onNearTop(el?.scrollTop ?? 0);
  };
  let frozenVirtualItems: ReturnType<typeof virtualizer.getVirtualItems> = [];
  let frozenTotalSize = 0;
  createEffect(() => {
    if (props.suspendVirtualization) return;
    frozenVirtualItems = liveVirtualItems();
    frozenTotalSize = liveTotalSize();
  });
  const virtualItems = () =>
    dedupeVirtualItems(
      props.suspendVirtualization ? frozenVirtualItems : liveVirtualItems(),
    );
  const totalSize = () =>
    props.suspendVirtualization ? frozenTotalSize : liveTotalSize();
  // TanStack needs one paint to observe the scroll element. Until it has
  // produced a valid window, render the ordinary list so long histories are
  // never blank and switching sessions cannot leave stale indexes on screen.
  const useVirtual = () => {
    if (!virtualize()) return false;
    const items = virtualItems();
    if (items.length === 0) return false;
    if (
      !items.every(
        (item) =>
          item !== undefined && props.messages[item.index] !== undefined,
      )
    )
      return false;
    // A data change from a one-row live projection to a full hydrated history
    // can leave the cached virtual window covering only that one row even
    // though every index is technically valid. Treat an absurdly small window
    // as not-ready so the fallback list renders the real history while the
    // remeasure below rebuilds the virtualizer.
    const first = items[0]!.index;
    const last = items.at(-1)!.index;
    if (last - first + 1 < Math.min(props.messages.length, 2)) return false;
    return true;
  };
  let lastMessageCount = -1;
  createEffect(() => {
    const count = props.messages.length;
    if (count === lastMessageCount) return;
    const previous = lastMessageCount;
    lastMessageCount = count;
    if (previous < 0) return;
    // Count changes invalidate the cached window. Rebuild after the DOM has
    // taken the new count; otherwise the transcript can stay pinned to the
    // previous (possibly single-row) end window.
    requestAnimationFrame(() => {
      virtualizer.measure();
      controller?.notifyDataChanged();
    });
  });
  const topSpacer = () => {
    const first = virtualItems()[0];
    return first ? Math.max(0, first.start) : 0;
  };
  const bottomSpacer = () => {
    const items = virtualItems();
    const last = items.at(-1);
    return last ? Math.max(0, totalSize() - last.end) : 0;
  };

  controller = new TailScrollController({
    getScrollElement: () => scrollEl(),
    scrollToEnd: (options) => {
      if (virtualize() && liveVirtualItems().length > 0) {
        virtualizer.scrollToEnd({ behavior: options?.behavior ?? "auto" });
      } else {
        const el = scrollEl();
        if (el) el.scrollTop = el.scrollHeight;
      }
    },
    scrollToIndex: (index, options) => {
      if (props.messages.length === 0) return;
      const target = Math.max(0, Math.min(index, props.messages.length - 1));
      const el = scrollEl();
      if (el && virtualize() && liveVirtualItems().length > 0) {
        virtualizer.scrollToIndex(target, {
          align: options?.align ?? "auto",
          behavior: options?.behavior ?? "auto",
        });
        return;
      }
      const row = el?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(props.messages[target]?.id ?? "")}"]`,
      );
      if (el && row) {
        el.scrollTop +=
          row.getBoundingClientRect().top - el.getBoundingClientRect().top;
      }
    },
    distanceThreshold: 2,
    nearTopThreshold: 80,
    isPaused: () => props.suspendVirtualization === true,
    onFollowChange: (following) => props.onFollowChange?.(following),
    onNearTop: () => notifyNearTop(),
  });

  const scrollToBottom = (options?: { behavior?: ScrollBehavior }) => {
    controller?.scrollToBottom(options);
  };
  const scrollToIndex = (
    index: number,
    options?: {
      align?: "start" | "center" | "end" | "auto";
      behavior?: ScrollBehavior;
    },
  ) => {
    controller?.scrollToIndex(index, options);
  };
  const api: TranscriptHandle = {
    scrollToBottom,
    scrollToIndex,
    measure: () => virtualizer.measure(),
    isFollowing: () => controller?.isFollowing() ?? true,
    breakFollow: () => controller?.breakFollow(),
  };

  // deepseek-harness TrajectoryTable layout contract:
  // - historyLoading gates first initialization
  // - the first measured window owns one scroll-to-end
  // - later growth follows only while the reader is pinned
  // - a pending older anchor owns prepend restoration
  createEffect(() => {
    const el = scrollEl();
    if (el === undefined) return;
    const result = evaluateTailScroll(tailState, {
      count: props.messages.length,
      firstKey: props.messages[0]?.id ?? null,
      historyLoading: props.historyLoading === true,
      virtualize: virtualize(),
      virtualReady: useVirtual(),
    });
    tailState = result.state;
    if (!result.state.initialized) setScrollReady(false);
    const effect = result.effect;
    if (effect.type === "none") return;

    if (effect.type === "restore-anchor") {
      const anchor = effect.anchor;
      controller?.breakFollow();
      const visibleIndex =
        anchor.visibleKey === null
          ? -1
          : props.messages.findIndex(
              (message) => message.id === anchor.visibleKey,
            );
      if (virtualize() && visibleIndex >= 0 && liveVirtualItems().length > 0) {
        virtualizer.scrollToIndex(visibleIndex, { align: "start" });
        if (anchor.visibleKey !== null) {
          requestAnimationFrame(() => {
            const row = el.querySelector<HTMLElement>(
              `[data-message-id="${CSS.escape(anchor.visibleKey!)}"]`,
            );
            if (row !== null) {
              el.scrollTop +=
                row.getBoundingClientRect().top -
                el.getBoundingClientRect().top -
                anchor.visibleTop;
            }
          });
        }
      } else {
        el.scrollTop =
          anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
      }
      return;
    }

    if (effect.type === "measure-and-scroll-end") {
      virtualizer.measure();
      requestAnimationFrame(() => {
        controller?.scrollToBottom({ behavior: "auto" });
        setScrollReady(true);
      });
      return;
    }

    requestAnimationFrame(() => {
      controller?.scrollToBottom({ behavior: "auto" });
    });
  });

  createEffect(() => {
    const el = scrollEl();
    if (el === undefined) return;
    // Short transcripts never fire a scroll event, so a manual button used to
    // be the only path to older history. Match Natalia's scroll path and
    // auto-fill one page when the pane is not yet scrollable.
    void scrollReady();
    if (
      props.hasOlder !== true ||
      props.olderHistoryLoading === true ||
      !scrollReady() ||
      !tailState.initialized
    )
      return;
    const count = props.messages.length;
    if (count === 0) return;
    if (el.scrollHeight <= el.clientHeight + 80) {
      requestAnimationFrame(() => notifyNearTop());
    }
  });

  onMount(() => {
    props.apiRef?.(api);
    console.log(
      "[natalia-ui] transcript mounted",
      JSON.stringify({
        messages: props.messages.length,
        debug: uiDebugEnabled(),
        virtualizeThreshold: VIRTUALIZE_THRESHOLD,
      }),
    );
  });
  onCleanup(() => {
    controller?.dispose();
    props.apiRef?.(undefined);
  });

  let lastVirtualScrollEl: HTMLDivElement | undefined;
  let lastVirtualEnabled = false;
  createEffect(() => {
    const el = scrollEl();
    const enabled = props.messages.length > VIRTUALIZE_THRESHOLD;
    if (el === lastVirtualScrollEl && enabled === lastVirtualEnabled) return;
    lastVirtualScrollEl = el;
    lastVirtualEnabled = enabled;
    if (!el || !enabled) return;
    // Force the virtualizer to pick up the element even if the Solid option
    // proxy did not observe the ref signal, then rebuild measurements once.
    virtualizer._willUpdate();
    requestAnimationFrame(() => {
      if (enabled) virtualizer.measure();
    });
  });

  const handleScroll = (event: Event) => {
    const startedAt = performance.now();
    controller?.onScroll(event);
    tailState = {
      ...tailState,
      following: controller?.isFollowing() ?? true,
    };
    props.onScroll?.(event);
    if (!uiDebugEnabled()) return;
    const el = scrollEl();
    const mounted = useVirtual() ? virtualItems() : [];
    console.log("[natalia-ui] transcript scroll", {
      elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
      scrollTop: el?.scrollTop,
      clientHeight: el?.clientHeight,
      scrollHeight: el?.scrollHeight,
      mounted: mounted.length,
      firstMounted: mounted[0]?.index,
      lastMounted: mounted.at(-1)?.index,
    });
  };

  const handleWheel = (event: WheelEvent) => {
    if (Math.abs(event.deltaY) < 1) return;
    const el = scrollEl();
    if (el) {
      const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop <= 2;
      // Scrolling further down at the physical bottom is not a reason to
      // leave follow mode.
      if (atBottom && event.deltaY > 0) return;
    }
    controller?.onUserIntent();
  };

  const handleUserIntentStart = () => {
    controller?.onUserIntent();
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    controller?.onUserIntent();
  };

  const handleUserIntentEnd = () => {
    controller?.reconcile();
  };

  createEffect(() => {
    if (!uiDebugEnabled()) return;
    const mounted = useVirtual() ? virtualItems() : [];
    console.log(
      "[natalia-ui] transcript window",
      JSON.stringify({
        messages: props.messages.length,
        virtualized: virtualize(),
        virtualReady: useVirtual(),
        mounted: mounted.length,
        firstMounted: mounted[0]?.index,
        lastMounted: mounted.at(-1)?.index,
        totalSize: useVirtual() ? totalSize() : null,
      }),
    );
  });

  let lastVirtualReady: boolean | undefined;
  let lastVirtualMessages = -1;
  createEffect(() => {
    const ready = useVirtual();
    const messages = props.messages.length;
    if (ready === lastVirtualReady && messages === lastVirtualMessages) return;
    lastVirtualReady = ready;
    lastVirtualMessages = messages;
    const items = ready ? virtualItems() : [];
    console.log(
      "[natalia-ui] transcript virtualization",
      JSON.stringify({
        messages,
        virtualReady: ready,
        mounted: items.length,
        firstMounted: items[0]?.index,
        lastMounted: items.at(-1)?.index,
        totalSize: ready ? totalSize() : null,
      }),
    );
  });

  let lastDuplicateSignature = "";
  createEffect(() => {
    if (!uiDebugEnabled()) return;
    const duplicateMessageIDs = duplicateValues(
      props.messages.map((message) => message.id),
    );
    const duplicateIndexes = duplicateVirtualIndexes(virtualItems());
    if (duplicateMessageIDs.length === 0 && duplicateIndexes.length === 0) {
      lastDuplicateSignature = "";
      return;
    }
    const signature = JSON.stringify({
      duplicateMessageIDs,
      duplicateIndexes,
    });
    if (signature === lastDuplicateSignature) return;
    lastDuplicateSignature = signature;
    console.warn("[natalia-ui] duplicate transcript rows", signature);
  });

  let lastSuspended = false;
  createEffect(() => {
    const suspended = props.suspendVirtualization === true;
    if (lastSuspended && !suspended) {
      requestAnimationFrame(() => {
        if (props.suspendVirtualization) return;
        virtualizer.measure();
        controller?.notifyDataChanged();
      });
    }
    lastSuspended = suspended;
  });

  let lastLayoutSignature = "";
  createEffect(() => {
    const items = useVirtual() ? virtualItems() : [];
    if (!items.length) return;
    const signature = `${props.messages.length}:${items[0]?.index}:${items.at(-1)?.index}`;
    if (signature === lastLayoutSignature) return;
    lastLayoutSignature = signature;
    requestAnimationFrame(() => {
      const el = scrollEl();
      if (!el) return;
      const rows = [...el.querySelectorAll<HTMLElement>("[data-message-id]")];
      const container = el.getBoundingClientRect();
      const first = rows[0];
      const last = rows.at(-1);
      const rectOf = (row: HTMLElement | undefined) => {
        if (!row) return null;
        const rect = row.getBoundingClientRect();
        return {
          id: row.dataset.messageId,
          top: Math.round(rect.top - container.top),
          height: Math.round(rect.height),
        };
      };
      console.log("[natalia-ui] transcript layout", {
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        mounted: rows.length,
        topSpacer:
          el
            .querySelector<HTMLElement>('[data-virtual-spacer="top"]')
            ?.getBoundingClientRect().height ?? 0,
        bottomSpacer:
          el
            .querySelector<HTMLElement>('[data-virtual-spacer="bottom"]')
            ?.getBoundingClientRect().height ?? 0,
        first: rectOf(first),
        last: rectOf(last),
      });
    });
  });

  return (
    <div
      class="natalia-transcript"
      data-scroll-ready={
        scrollReady() ? "true" : props.messages.length === 0 ? "empty" : "false"
      }
      ref={setScrollRef}
      onScroll={handleScroll}
      onWheel={handleWheel}
      onTouchStart={handleUserIntentStart}
      onPointerDown={handlePointerDown}
      onPointerUp={handleUserIntentEnd}
      onPointerCancel={handleUserIntentEnd}
      onTouchEnd={handleUserIntentEnd}
      onTouchCancel={handleUserIntentEnd}
    >
      <div class="natalia-transcript-content">
        <Show
          when={props.messages.length > 0}
          fallback={
            <div class="natalia-transcript-empty">
              <div class="natalia-transcript-empty-icon">
                <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                  <path
                    d="M20 5C14.4772 5 10 9.47715 10 15V22C10 24.2091 8.20914 26 6 26H5C3.89543 26 3 26.8954 3 28V30C3 31.1046 3.89543 32 5 32H35C36.1046 32 37 31.1046 37 30V28C37 26.8954 36.1046 26 35 26H34C31.7909 26 30 24.2091 30 22V15C30 9.47715 25.5225 5 20 5Z"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                  />
                </svg>
              </div>
              <div class="natalia-transcript-empty-title">
                {props.emptyTitle ?? ""}
              </div>
              <div class="natalia-transcript-empty-hint">
                {props.emptyHint ?? ""}
              </div>
            </div>
          }
        >
          <Show
            when={useVirtual()}
            fallback={
              <For each={props.messages}>
                {(message) => (
                  <MessageGroup
                    message={message}
                    assistantName={props.assistantName}
                    assistantInitial={props.assistantInitial}
                    loadAttachmentUrl={props.loadAttachmentUrl}
                    onFork={props.onFork}
                    onRollback={props.onRollback}
                  />
                )}
              </For>
            }
          >
            <Show when={topSpacer() > 0}>
              <div
                aria-hidden="true"
                data-virtual-spacer="top"
                style={{ height: `${topSpacer()}px` }}
              />
            </Show>
            <For each={virtualItems()}>
              {(item) =>
                item === undefined ||
                props.messages[item.index] === undefined ? null : (
                  <MessageGroup
                    message={props.messages[item.index]!}
                    virtualIndex={item.index}
                    assistantName={props.assistantName}
                    assistantInitial={props.assistantInitial}
                    loadAttachmentUrl={props.loadAttachmentUrl}
                    onFork={props.onFork}
                    onRollback={props.onRollback}
                  />
                )
              }
            </For>
            <Show when={bottomSpacer() > 0}>
              <div
                aria-hidden="true"
                data-virtual-spacer="bottom"
                style={{ height: `${bottomSpacer()}px` }}
              />
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}

const MESSAGE_BASE_HEIGHT = 66;
const MESSAGE_LINE_HEIGHT = 21.5;
const THINKING_BLOCK_HEIGHT = 46;
const TOOL_CARD_BASE_HEIGHT = 48;
const TOOL_OUTPUT_LINE_HEIGHT = 19;
const ATTACHMENT_GAP = 8;

function wrappedLineCount(text: string, charsPerLine: number): number {
  if (text === "") return 0;
  let lines = 0;
  for (const rawLine of text.split("\n")) {
    lines += Math.max(1, Math.ceil(rawLine.length / charsPerLine));
  }
  return lines;
}

function estimatedTextHeight(
  text: string,
  charsPerLine: number,
  lineHeight: number,
): number {
  if (text === "") return 0;
  return wrappedLineCount(text, charsPerLine) * lineHeight;
}

function estimateMarkdownBodyHeight(text: string): number {
  let height = 0;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/u.test(line)) {
      height += 22;
      inFence = !inFence;
      continue;
    }
    // Fenced code has horizontal scrolling (`overflow-x: auto`) instead of
    // wrapping long lines, so do not inflate an unbroken 2000-character line
    // into dozens of estimated rows.
    height += inFence
      ? 19
      : Math.max(1, Math.ceil(line.length / 96)) * MESSAGE_LINE_HEIGHT;
  }
  return height;
}

function estimateAttachmentHeight(attachment: Attachment): number {
  const width = attachment.width ?? 160;
  const height = attachment.height ?? 120;
  const scale = Math.min(1, 240 / Math.max(width, height));
  return Math.max(48, Math.round(height * scale));
}

/**
 * Estimate a rich message group closely enough that the virtualizer does not
 * first discover a 5000px tool output while the reader is scrolling upward.
 * Measurements still refine the exact height, but the initial estimate must
 * account for tool output, thinking, markdown/code lines, and attachments.
 */
export function estimateMessageHeight(message: Message): number {
  let height = MESSAGE_BASE_HEIGHT;

  // Thinking replaces the ordinary body in MessageRow, so use its own block
  // metrics plus the thought text line count.
  if (message.thinking) {
    height +=
      THINKING_BLOCK_HEIGHT + estimateMarkdownBodyHeight(message.content);
  } else if (message.content !== "") {
    height += estimateMarkdownBodyHeight(message.content);
  }

  for (const toolCall of message.toolCalls ?? []) {
    const output = toolCall.output ?? toolCall.summary ?? "";
    const outputLines = wrappedLineCount(output, 110);
    const collapsible =
      outputLines > TOOL_OUTPUT_COLLAPSE_LINES || output.length > 2_000;
    height +=
      TOOL_CARD_BASE_HEIGHT +
      (collapsible
        ? 16 + TOOL_OUTPUT_PREVIEW_LINES * TOOL_OUTPUT_LINE_HEIGHT + 28
        : estimatedTextHeight(output, 110, TOOL_OUTPUT_LINE_HEIGHT));
  }

  for (const attachment of message.attachments ?? []) {
    height += estimateAttachmentHeight(attachment) + ATTACHMENT_GAP;
  }

  return Math.max(MESSAGE_BASE_HEIGHT, Math.ceil(height));
}

/**
 * DSH-style fixed-height row model (scroll Phase 5). Unlike the refining
 * `estimateMessageHeight`, this computes a deterministic, *bounded* height: the
 * markdown/code body is clamped to a fixed line budget and the total to a hard
 * ceiling, and large tool output is always collapsed to its preview. Because
 * the height depends only on clamped content, the rendered row matches it
 * exactly, so the virtualizer no longer needs to measure the DOM
 * (`measureElement`) to stay anchored.
 */
const MAX_MARKDOWN_BODY_LINES = 40;
const MAX_ROW_HEIGHT = 1200;

/** Wrapped line count of a body, capped at a fixed line budget. */
function clampedBodyLines(text: string, maxLines: number): number {
  let lines = 0;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/u.test(line)) {
      lines += 1;
      inFence = !inFence;
      if (lines >= maxLines) return maxLines;
      continue;
    }
    lines += inFence ? 1 : Math.max(1, Math.ceil(line.length / 96));
    if (lines >= maxLines) return maxLines;
  }
  return lines;
}

export function fixedRowHeight(message: Message): number {
  let height = MESSAGE_BASE_HEIGHT;
  const bodyLines = clampedBodyLines(message.content, MAX_MARKDOWN_BODY_LINES);
  if (message.thinking)
    height += THINKING_BLOCK_HEIGHT + bodyLines * MESSAGE_LINE_HEIGHT;
  else if (message.content !== "") height += bodyLines * MESSAGE_LINE_HEIGHT;
  for (const toolCall of message.toolCalls ?? []) {
    const output = toolCall.output ?? toolCall.summary ?? "";
    const outputLines = wrappedLineCount(output, 110);
    const collapsible =
      outputLines > TOOL_OUTPUT_COLLAPSE_LINES || output.length > 2_000;
    height +=
      TOOL_CARD_BASE_HEIGHT +
      (collapsible
        ? 16 + TOOL_OUTPUT_PREVIEW_LINES * TOOL_OUTPUT_LINE_HEIGHT + 28
        : outputLines * TOOL_OUTPUT_LINE_HEIGHT);
  }
  for (const attachment of message.attachments ?? [])
    height += estimateAttachmentHeight(attachment) + ATTACHMENT_GAP;
  return Math.max(
    MESSAGE_BASE_HEIGHT,
    Math.min(MAX_ROW_HEIGHT, Math.ceil(height)),
  );
}

function MessageGroup(props: {
  message: Message;
  virtualIndex?: number;
  assistantName?: string;
  assistantInitial?: string;
  loadAttachmentUrl?: (attachment: Attachment) => Promise<string>;
  onFork?: (turnID: string) => void;
  onRollback?: (message: Message) => void;
  rowRef?: (el: HTMLDivElement) => void;
  style?: JSX.CSSProperties;
}) {
  const setRowRef = (el: HTMLDivElement) => {
    // Solid can call the ref before dynamic data-* attributes are patched.
    // data-index is kept for diagnostics and tests; rows are no longer
    // DOM-measured (the fixed-height row model is the rendered height).
    if (props.virtualIndex !== undefined) {
      el.setAttribute("data-index", String(props.virtualIndex));
    }
    props.rowRef?.(el);
  };
  return (
    <div
      class="natalia-message-group"
      data-role={props.message.role}
      data-message-id={props.message.id}
      data-index={props.virtualIndex}
      ref={setRowRef}
      style={props.style}
    >
      <MessageRow
        message={props.message}
        assistantName={props.assistantName}
        assistantInitial={props.assistantInitial}
        loadAttachmentUrl={props.loadAttachmentUrl}
      />
      <Show when={props.message.role !== "system"}>
        <div class="natalia-message-group-actions">
          <button
            type="button"
            class="natalia-message-icon-btn"
            title="复制内容"
            onClick={() =>
              navigator.clipboard?.writeText(props.message.content)
            }
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect
                x="5.5"
                y="5.5"
                width="7"
                height="7"
                rx="1.5"
                stroke="currentColor"
                stroke-width="1.3"
              />
              <path
                d="M10.5 4.5H11.5A1.5 1.5 0 0 1 13 6V11"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
              />
            </svg>
            <span>复制</span>
          </button>
          <Show when={props.onFork && sessionTurnID(props.message.id)}>
            <button
              type="button"
              class="natalia-message-icon-btn"
              title="从此消息 Fork 会话"
              onClick={() => props.onFork?.(sessionTurnID(props.message.id)!)}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <circle
                  cx="5"
                  cy="4"
                  r="1.6"
                  stroke="currentColor"
                  stroke-width="1.2"
                />
                <circle
                  cx="5"
                  cy="12"
                  r="1.6"
                  stroke="currentColor"
                  stroke-width="1.2"
                />
                <circle
                  cx="11"
                  cy="12"
                  r="1.6"
                  stroke="currentColor"
                  stroke-width="1.2"
                />
                <path
                  d="M5 5.6V10.4M5 10.4H11"
                  stroke="currentColor"
                  stroke-width="1.2"
                  stroke-linecap="round"
                />
              </svg>
              <span>Fork</span>
            </button>
          </Show>
          <Show when={props.onRollback}>
            <button
              type="button"
              class="natalia-message-icon-btn"
              title="回滚到此处"
              onClick={() => props.onRollback?.(props.message)}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path
                  d="M6.5 3.5L3 7L6.5 10.5"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
                <path
                  d="M7 7H13"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                />
                <path
                  d="M11 4.5L13 7L11 9.5"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <span>回滚</span>
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
export interface MessageRowProps {
  message: Message;
  assistantName?: string;
  assistantInitial?: string;
  loadAttachmentUrl?: (attachment: Attachment) => Promise<string>;
}

function imageBox(attachment: Attachment) {
  const width = attachment.width ?? 160;
  const height = attachment.height ?? 120;
  const scale = Math.min(1, 240 / Math.max(width, height));
  return {
    width: Math.max(48, Math.round(width * scale)),
    height: Math.max(48, Math.round(height * scale)),
  };
}

function AttachmentImage(props: {
  attachment: Attachment;
  load?: (attachment: Attachment) => Promise<string>;
}) {
  const [src, setSrc] = createSignal("");
  const [status, setStatus] = createSignal<
    "idle" | "loading" | "loaded" | "error"
  >("idle");
  const [lightbox, setLightbox] = createSignal(false);
  const box = imageBox(props.attachment);
  const load = () => {
    const type = props.attachment.mediaType ?? "";
    if (!type.startsWith("image/") || !props.load) {
      setStatus("idle");
      return;
    }
    setStatus("loading");
    void props
      .load(props.attachment)
      .then((value) => {
        setSrc(value);
        setStatus("loaded");
      })
      .catch(() => setStatus("error"));
  };
  onMount(load);

  const placeholder = () => (
    <button
      type="button"
      class="natalia-message-attachment-placeholder"
      style={{
        width: `${box.width}px`,
        height: `${box.height}px`,
      }}
      title={
        status() === "error" ? "加载失败，点击重试" : props.attachment.name
      }
      onClick={() => {
        if (status() === "error") load();
      }}
    >
      <Show when={status() === "loading"}>加载中…</Show>
      <Show when={status() === "error"}>加载失败 · 重试</Show>
      <Show when={status() === "idle"}>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          class="natalia-message-attachment-icon"
        >
          <path
            d="M8.5 3.5L11.5 6.5L8.5 9.5M4.5 6.5H11.5"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span>{props.attachment.name}</span>
      </Show>
    </button>
  );

  return (
    <>
      <Show when={status() === "loaded" && src()} fallback={placeholder()}>
        <button
          type="button"
          class="natalia-message-image-button"
          onClick={() => setLightbox(true)}
        >
          <img
            class="natalia-message-image"
            src={src()}
            alt={props.attachment.name}
            width={box.width}
            height={box.height}
            loading="lazy"
          />
        </button>
      </Show>
      <Show when={lightbox()}>
        <div
          class="natalia-message-lightbox"
          style={{
            position: "fixed",
            inset: "0",
            "z-index": "80",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            padding: "24px",
            background: "rgba(0,0,0,0.78)",
            cursor: "zoom-out",
          }}
          onClick={() => setLightbox(false)}
        >
          <img
            src={src()}
            alt={props.attachment.name}
            style={{
              "max-width": "min(92vw, 1200px)",
              "max-height": "92vh",
              "object-fit": "contain",
            }}
          />
        </div>
      </Show>
    </>
  );
}

function sessionTurnID(messageID: string) {
  if (!messageID.startsWith("turn_")) return undefined;
  return messageID.replace(/:(?:user|assistant|thinking|system)$/u, "");
}

function ToolCallCard(props: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = createSignal(false);
  const output = () => props.toolCall.output ?? "";
  const outputLines = () => output().split("\n");
  const collapsible = () =>
    outputLines().length > TOOL_OUTPUT_COLLAPSE_LINES ||
    output().length > 2_000;
  const shownOutput = () => {
    if (!collapsible() || expanded()) return output();
    return outputLines().slice(0, TOOL_OUTPUT_PREVIEW_LINES).join("\n");
  };

  return (
    <div class="natalia-tool-card">
      <div class="natalia-tool-header">
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          style="color: var(--accent-primary); flex-shrink: 0;"
        >
          <path
            d="M7 1L3 5L7 9L11 5L7 1Z"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linejoin="round"
          />
        </svg>
        <span class="natalia-tool-name">{props.toolCall.name}</span>
        <Show when={props.toolCall.summary}>
          <span class="natalia-tool-summary">{props.toolCall.summary}</span>
        </Show>
        <span class="natalia-badge natalia-badge-default">
          {props.toolCall.status ?? "tool"}
        </span>
      </div>
      <Show when={output()}>
        <div
          class="natalia-tool-output"
          data-collapsed={collapsible() && !expanded() ? "true" : undefined}
        >
          <pre>{shownOutput()}</pre>
          <Show when={collapsible()}>
            <button
              type="button"
              class="natalia-tool-output-toggle"
              onClick={() => setExpanded(!expanded())}
            >
              {expanded() ? "收起" : `展开全部（${outputLines().length} 行）`}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/**
 * Compact row for a `<goal_round>` internal turn: the round number and the
 * objective at a glance, with the full injected prompt behind a disclosure.
 */
function GoalRoundBody(props: {
  goalRound: NonNullable<Message["goalRound"]>;
}) {
  const [expanded, setExpanded] = createSignal(false);
  const capLabel = () =>
    props.goalRound.maxGoalRounds === 0
      ? "∞"
      : String(props.goalRound.maxGoalRounds);
  return (
    <div class="natalia-goal-round" data-expanded={expanded() || undefined}>
      <button
        type="button"
        class="natalia-goal-round-header"
        title={props.goalRound.objective}
        onClick={() => setExpanded(!expanded())}
      >
        <span class="natalia-goal-round-badge">Goal</span>
        <span class="natalia-goal-round-title">
          Round {props.goalRound.round}/{capLabel()}
        </span>
        <Show when={props.goalRound.objective}>
          <span class="natalia-goal-round-objective">
            {props.goalRound.objective}
          </span>
        </Show>
        <span class="natalia-goal-round-toggle">
          {expanded() ? "收起" : "展开"}
        </span>
      </button>
      <Show when={expanded()}>
        <pre class="natalia-goal-round-detail">{props.goalRound.detail}</pre>
      </Show>
    </div>
  );
}

export function MessageRow(props: MessageRowProps) {
  const isUser = () => props.message.role === "user";
  const isSystem = () => props.message.role === "system";

  return (
    <article
      class="natalia-message"
      data-role={props.message.role}
      data-message-id={props.message.id}
    >
      <div class="natalia-message-header">
        <div class="natalia-message-avatar" data-role={props.message.role}>
          {isUser()
            ? "U"
            : props.message.goalRound
              ? "G"
              : isSystem()
                ? "S"
                : (props.assistantInitial ?? "N")}
        </div>
        <div class="natalia-message-meta">
          <span class="natalia-message-author">
            {isUser()
              ? "You"
              : props.message.goalRound
                ? "Goal"
                : isSystem()
                  ? "System"
                  : (props.assistantName ?? "Natalia")}
          </span>
          <span class="natalia-message-time">
            {props.message.timestamp ?? ""}
          </span>
        </div>
        <Show when={props.message.steering}>
          <span
            class="natalia-badge natalia-badge-steering"
            title="运行中注入当前轮"
          >
            已注入
          </span>
        </Show>
        <Show when={props.message.status}>
          <span
            class="natalia-badge"
            classList={{
              "natalia-badge-running": props.message.status === "running",
              "natalia-badge-success":
                props.message.status === "completed" ||
                props.message.status === "done",
              "natalia-badge-error":
                props.message.status === "error" ||
                props.message.status === "failed",
            }}
          >
            {props.message.status}
          </span>
        </Show>
      </div>

      <div class="natalia-message-body">
        <Show
          when={props.message.goalRound}
          fallback={
            <Show
              when={props.message.thinking}
              fallback={
                <Show
                  when={
                    props.message.content || !props.message.toolCalls?.length
                  }
                >
                  <Show
                    when={messageTextMode(props.message) === "plain"}
                    fallback={
                      <div
                        class="natalia-message-text"
                        innerHTML={formatContent(props.message.content)}
                      />
                    }
                  >
                    {/*
                      The ui-performance plan's P1: the streaming tail
                      renders PLAIN text — every delta used to re-parse the
                      whole prefix as markdown (O(n²) over the stream, and a
                      cache entry per prefix). `content.done` flips
                      `streaming` false and the full parse takes over.
                    */}
                    <div
                      class="natalia-message-text"
                      textContent={props.message.content}
                    />
                    <div class="natalia-streaming-indicator">
                      <div class="natalia-streaming-dot" />
                      <div class="natalia-streaming-dot" />
                      <div class="natalia-streaming-dot" />
                      <span class="natalia-streaming-label">正在思考...</span>
                    </div>
                  </Show>
                </Show>
              }
            >
              <div class="natalia-thinking-block">
                <span class="natalia-thinking-label">Thinking</span>
                <div
                  class="natalia-thinking-text"
                  {...(messageTextMode(props.message) === "plain"
                    ? { textContent: props.message.content }
                    : { innerHTML: formatContent(props.message.content) })}
                />
              </div>
            </Show>
          }
        >
          {(goalRound) => <GoalRoundBody goalRound={goalRound()} />}
        </Show>
      </div>

      <Show
        when={props.message.attachments && props.message.attachments.length > 0}
      >
        <div class="natalia-message-attachments">
          <For each={props.message.attachments ?? []}>
            {(attachment) => (
              <AttachmentImage
                attachment={attachment}
                load={props.loadAttachmentUrl}
              />
            )}
          </For>
        </div>
      </Show>

      <Show
        when={props.message.toolCalls && props.message.toolCalls.length > 0}
      >
        <div class="natalia-tool-calls">
          <For each={props.message.toolCalls}>
            {(toolCall) => <ToolCallCard toolCall={toolCall} />}
          </For>
        </div>
      </Show>

      <Show when={props.message.actions && props.message.actions.length > 0}>
        <div class="natalia-message-actions">
          <For each={props.message.actions}>
            {(action) => (
              <button
                type="button"
                class="natalia-action-btn"
                classList={{
                  "natalia-action-btn-primary": action.primary,
                  "natalia-action-btn-secondary": !action.primary,
                }}
                onClick={() => action.onClick()}
              >
                {action.label}
              </button>
            )}
          </For>
        </div>
      </Show>
    </article>
  );
}

const markdownCache = new Map<string, string>();
const MARKDOWN_CACHE_LIMIT = 512;

/**
 * The streaming-tail's render mode (the ui-performance plan's P1): a
 * streaming row renders PLAIN text — every delta used to re-parse the
 * whole prefix as markdown (O(n²) over the stream, a cache entry per
 * prefix) — and `content.done` flips `streaming` false so the full parse
 * takes over on the confirmed text. `textContent` cannot inject markup,
 * so the streaming half is also strictly safer than the parse half.
 */
export function messageTextMode(message: {
  streaming?: boolean;
}): "plain" | "markdown" {
  return message.streaming ? "plain" : "markdown";
}

function formatContent(text: string): string {
  const cached = markdownCache.get(text);
  if (cached !== undefined) return cached;
  const html = marked.parse(text, {
    gfm: true,
    breaks: true,
  }) as string;
  if (markdownCache.size >= MARKDOWN_CACHE_LIMIT) {
    const oldest = markdownCache.keys().next().value;
    if (oldest !== undefined) markdownCache.delete(oldest);
  }
  markdownCache.set(text, html);
  return html;
}

export function formatBashBlocks(
  text: string,
): { type: "bash" | "result" | "text"; content: string }[] {
  const blocks: { type: "bash" | "result" | "text"; content: string }[] = [];
  const regex = /Bash\s*\n```[\w]*\n([\s\S]*?)\n```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({ type: "bash", content: match[1].trim() });
  }
  const resultRegex = /结果:\s*\n```[\w]*\n([\s\S]*?)\n```/;
  const resultMatch = resultRegex.exec(text);
  if (resultMatch) {
    blocks.push({ type: "result", content: resultMatch[1].trim() });
  }
  return blocks;
}
