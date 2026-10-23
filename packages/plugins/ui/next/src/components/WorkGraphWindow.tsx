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
import wg from "../styles/work-graph.module.css";

/** A section header row (fixed height, like every other row). */
function SectionRow(props: {
  row: Extract<WorkGraphRow, { kind: "section" }>;
  onToggleSection?: (sectionID: string) => void;
}) {
  return (
    <div
      class={`${wg.row} ${wg.rowSection}`}
      data-tone={props.row.tone}
      onClick={() => props.onToggleSection?.(props.row.id)}
      style={props.onToggleSection ? { cursor: "pointer" } : undefined}
    >
      <span class={wg.sectionTitle}>
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
  t?: (key: string, params?: Record<string, unknown>) => string;
  onToggleNode: (nodeID: string, expanded: boolean) => void;
  onOpenFile?: (path: string) => void;
}) {
  const kindLabel = () => {
    if (!props.t) return props.row.nodeKind;
    const key = `gov.wgKind.${props.row.nodeKind}`;
    const translated = props.t(key);
    return translated !== key ? translated : props.row.nodeKind;
  };
  const isFileNode = () =>
    props.row.nodeKind === "workspace_change" && Boolean(props.row.target);

  return (
    <button
      type="button"
      class={`${wg.row} ${wg.nodeRow}`}
      data-depth={props.row.depth}
      style={{
        "padding-left": `${4 + Math.min(props.row.depth, 12) * 14}px`,
      }}
      data-unattributed={props.row.unattributed ? "true" : undefined}
      disabled={!props.row.expandable && !isFileNode()}
      onClick={() => {
        if (props.row.expandable) {
          props.onToggleNode(props.row.nodeID, !props.row.expanded);
        } else if (isFileNode() && props.row.target) {
          props.onOpenFile?.(props.row.target);
        }
      }}
    >
      <span class={wg.twisty}>
        {props.row.expandable
          ? props.row.expanded
            ? "▾"
            : "▸"
          : props.row.unattributed
            ? "·"
            : "•"}
      </span>
      <span class={wg.kind} data-kind={props.row.nodeKind}>
        {kindLabel()}
      </span>
      <span class={wg.summary}>
        {isFileNode() ? props.row.target : props.row.summary}
      </span>
      <Show when={props.row.target && !isFileNode()}>
        <span class={wg.via}>{props.row.target}</span>
      </Show>
      <Show when={isFileNode()}>
        <span class={wg.via}>{props.row.summary} ↗</span>
      </Show>
      <Show when={props.row.via}>
        <span class={wg.via}>← {props.row.via}</span>
      </Show>
    </button>
  );
}

function WorkGraphRowView(props: {
  row: WorkGraphRow;
  t?: (key: string, params?: Record<string, unknown>) => string;
  onToggleNode: (nodeID: string, expanded: boolean) => void;
  onToggleSection?: (sectionID: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  return (
    <Show
      when={props.row.kind === "node" ? props.row : undefined}
      fallback={
        <SectionRow
          row={props.row as Extract<WorkGraphRow, { kind: "section" }>}
          onToggleSection={props.onToggleSection}
        />
      }
    >
      {(node) => (
        <NodeRow
          row={node()}
          t={props.t}
          onToggleNode={props.onToggleNode}
          onOpenFile={props.onOpenFile}
        />
      )}
    </Show>
  );
}

/**
 * The virtual window every work-graph view renders through.
 *
 * Mirrors the transcript's derived contract: one fixed row height, spacer
 * rows above/below the window instead of DOM measurement, and a plain-list
 * fallback both below the row threshold and while the first window is not yet
 * ready (so a fresh pane or a session switch is never blank).
 */
export function WorkGraphWindow(props: {
  rows: WorkGraphRow[];
  t?: (key: string, params?: Record<string, unknown>) => string;
  empty?: JSX.Element;
  onToggleNode: (nodeID: string, expanded: boolean) => void;
  onToggleSection?: (sectionID: string) => void;
  onOpenFile?: (path: string) => void;
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
    if (el.isConnected) {
      commit();
      return;
    }
    queueMicrotask(() => {
      if (el.isConnected) commit();
      else requestAnimationFrame(commit);
    });
  };

  let armedRowCount = -1;
  const fireNextPage = () => {
    if (!props.onNearBottom) return;
    const currentCount = props.rows.length;
    if (currentCount === armedRowCount) return;
    armedRowCount = currentCount;
    props.onNearBottom();
  };
  const autoAppend = createScrollAutoAppend({
    scrollEl,
    moreAvailable: () => Boolean(props.onNearBottom),
    rowCount: () => props.rows.length,
    append: fireNextPage,
  });

  createEffect(() => {
    const count = props.rows.length;
    const el = scrollEl();
    if (!el || count === 0) return;
    virtualizer.measure();
    queueMicrotask(() => autoAppend.check());
  });

  const virtualReady = () => {
    if (props.rows.length < WORK_GRAPH_VIRTUAL_THRESHOLD) return false;
    if (!scrollEl()) return false;
    return virtualizer.getVirtualItems().length > 0;
  };
  const virtualItems = () =>
    virtualReady() ? dedupeVirtualItems(virtualizer.getVirtualItems()) : [];
  const topPadding = () => virtualItems()[0]?.start ?? 0;
  const bottomPadding = () => {
    const items = virtualItems();
    const last = items[items.length - 1];
    if (!last) return 0;
    return Math.max(0, virtualizer.getTotalSize() - last.end);
  };

  return (
    <Show when={props.rows.length > 0} fallback={props.empty}>
      <div
        class={wg.scroll}
        ref={setScrollRef}
        onScroll={() => autoAppend.check()}
      >
        <Show
          when={virtualReady()}
          fallback={
            <For each={props.rows}>
              {(row) => (
                <WorkGraphRowView
                  row={row}
                  t={props.t}
                  onToggleNode={props.onToggleNode}
                  onToggleSection={props.onToggleSection}
                  onOpenFile={props.onOpenFile}
                />
              )}
            </For>
          }
        >
          <Show when={topPadding() > 0}>
            <div style={{ height: `${topPadding()}px` }} />
          </Show>
          <For each={virtualItems()}>
            {(item) => {
              const row = () => props.rows[item.index];
              return (
                <Show when={row()}>
                  {(current) => (
                    <WorkGraphRowView
                      row={current()}
                      t={props.t}
                      onToggleNode={props.onToggleNode}
                      onToggleSection={props.onToggleSection}
                      onOpenFile={props.onOpenFile}
                    />
                  )}
                </Show>
              );
            }}
          </For>
          <Show when={bottomPadding() > 0}>
            <div style={{ height: `${bottomPadding()}px` }} />
          </Show>
        </Show>
      </div>
    </Show>
  );
}
