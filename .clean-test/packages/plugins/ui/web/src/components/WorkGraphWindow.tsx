import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { dedupeVirtualItems } from "@natalia/ui-kit";
import { createScrollAutoAppend } from "../auto-append";
import {
  WORK_GRAPH_ROW_HEIGHT,
  WORK_GRAPH_VIRTUAL_THRESHOLD,
  type WorkGraphRow,
} from "./work-graph-rows";

/** A section header row (fixed height, like every other row). */
function SectionRow(props: {
  row: Extract<WorkGraphRow, { kind: "section" }>;
}) {
  return (
    <div class="wg-row wg-row-section" data-tone={props.row.tone}>
      <span class="wg-section-title">
        {props.row.title}
        <Show when={props.row.count !== undefined}> · {props.row.count}</Show>
      </span>
    </div>
  );
}

/**
 * One tree/navigation node row: expandable while it has children. Depth becomes
 * a padding indent because the flattened window no longer nests JSX.
 */
function NodeRow(props: {
  row: Extract<WorkGraphRow, { kind: "node" }>;
  onToggleNode: (nodeID: string, expanded: boolean) => void;
}) {
  return (
    <button
      type="button"
      class="wg-row wg-node-row"
      data-depth={props.row.depth}
      style={{
        "padding-left": `${4 + Math.min(props.row.depth, 12) * 14}px`,
      }}
      data-unattributed={props.row.unattributed ? "true" : undefined}
      disabled={!props.row.expandable}
      onClick={() =>
        props.row.expandable &&
        props.onToggleNode(props.row.nodeID, !props.row.expanded)
      }
    >
      <span class="wg-twisty">
        {props.row.expandable
          ? props.row.expanded
            ? "▾"
            : "▸"
          : props.row.unattributed
            ? "⚠"
            : "•"}
      </span>
      <span class="wg-kind" data-kind={props.row.nodeKind}>
        {props.row.nodeKind}
      </span>
      <span class="wg-summary">{props.row.summary}</span>
      <Show when={props.row.target}>
        <span class="wg-via">{props.row.target}</span>
      </Show>
      <Show when={props.row.via}>
        <span class="wg-via">← {props.row.via}</span>
      </Show>
    </button>
  );
}

function WorkGraphRowView(props: {
  row: WorkGraphRow;
  onToggleNode: (nodeID: string, expanded: boolean) => void;
}) {
  return (
    <Show
      when={props.row.kind === "node" ? props.row : undefined}
      fallback={
        <SectionRow
          row={props.row as Extract<WorkGraphRow, { kind: "section" }>}
        />
      }
    >
      {(node) => <NodeRow row={node()} onToggleNode={props.onToggleNode} />}
    </Show>
  );
}

/**
 * The virtual window every work-graph view renders through.
 *
 * Mirrors the transcript's DSH-derived contract: one fixed row height, spacer
 * rows above/below the window instead of DOM measurement, and a plain-list
 * fallback both below the row threshold and while the first window is not yet
 * ready (so a fresh pane or a session switch is never blank).
 */
export function WorkGraphWindow(props: {
  rows: WorkGraphRow[];
  empty?: JSX.Element;
  onToggleNode: (nodeID: string, expanded: boolean) => void;
  /**
   * Called when the window is scrolled near the end (or the page cannot fill
   * the scrollport): the owner appends the next page. No button is offered —
   * pagination is scroll-driven (unified-scroll plan §9).
   */
  onNearBottom?: () => void;
}) {
  const [scrollEl, setScrollEl] = createSignal<HTMLDivElement>();
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return props.rows.length;
    },
    getScrollElement: () => scrollEl() ?? null,
    estimateSize: () => WORK_GRAPH_ROW_HEIGHT,
    getItemKey: (index) => props.rows[index]?.id ?? index,
    overscan: 8,
    initialRect: { width: 0, height: 320 },
    onChange: () => {
      // Row positions come from the fixed model; there is no measurement pass.
    },
  });

  let pendingScrollEl: HTMLDivElement | undefined;
  const setScrollRef = (el: HTMLDivElement | null) => {
    if (!el) {
      pendingScrollEl = undefined;
      setScrollEl(undefined);
      return;
    }
    pendingScrollEl = el;
    const commit = () => {
      if (pendingScrollEl !== el || !el.isConnected) return;
      pendingScrollEl = undefined;
      setScrollEl(el);
    };
    // Solid's compiled ref callback can run before the node is inserted; the
    // virtualizer needs a connected element to attach scroll observers.
    if (el.isConnected) {
      commit();
      return;
    }
    queueMicrotask(() => {
      if (el.isConnected) commit();
      else requestAnimationFrame(commit);
    });
  };

  // Scroll-driven pagination: near the end (or on a page too short to scroll)
  // the owner appends the next page; re-arming waits for the page to grow.
  const autoAppend = createScrollAutoAppend({
    scrollEl,
    moreAvailable: () => props.onNearBottom !== undefined,
    rowCount: () => props.rows.length,
    append: () => props.onNearBottom?.(),
  });
  const onScroll = () => autoAppend.check();
  // A newly replaced page (search cleared, session switched, collapsed) may be
  // shorter than the scrollport: extend it instead of leaving a dead end.
  createEffect(() => {
    props.rows.length;
    autoAppend.check();
  });

  const liveItems = () => virtualizer.getVirtualItems();
  const liveTotalSize = () => virtualizer.getTotalSize();
  const useVirtual = () => {
    if (props.rows.length <= WORK_GRAPH_VIRTUAL_THRESHOLD) return false;
    const items = dedupeVirtualItems(liveItems());
    if (items.length === 0) return false;
    return items.every(
      (item) => item !== undefined && props.rows[item.index] !== undefined,
    );
  };
  const topSpacer = () => {
    const first = liveItems()[0];
    return first ? Math.max(0, first.start) : 0;
  };
  const bottomSpacer = () => {
    const items = liveItems();
    const last = items.at(-1);
    return last ? Math.max(0, liveTotalSize() - last.end) : 0;
  };
  const windowRows = () =>
    useVirtual()
      ? dedupeVirtualItems(liveItems())
          .map((item) => props.rows[item.index])
          .filter((row): row is WorkGraphRow => row !== undefined)
      : [];

  return (
    <div class="wg-scroll" ref={setScrollRef} onScroll={onScroll}>
      <Show
        when={props.rows.length > 0}
        fallback={props.empty ?? <div class="neu-gov-empty" />}
      >
        <Show
          when={useVirtual()}
          fallback={
            <For each={props.rows}>
              {(row) => (
                <WorkGraphRowView row={row} onToggleNode={props.onToggleNode} />
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
          <For each={windowRows()}>
            {(row) => (
              <WorkGraphRowView row={row} onToggleNode={props.onToggleNode} />
            )}
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
  );
}
