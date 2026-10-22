import { For, Show, createMemo, createSignal } from "solid-js";
import {
  buildWorkGraphForest,
  buildWorkGraphNavigation,
  selectUnattributedWorkGraphNodes,
} from "@natalia/view-store";
import type { WorkGraphState } from "@natalia/view-store";
import {
  WORK_GRAPH_PAGE_SIZE,
  flattenWorkGraphNodes,
  flattenWorkGraphTrees,
  paginateWorkGraphRows,
  toggleWorkGraphOverride,
  workGraphSectionRow,
  type WorkGraphRow,
} from "./work-graph-rows";
import { WorkGraphWindow } from "./WorkGraphWindow";

/**
 * The Work Graph as a collapsible causal forest (EI Phase 3 / WG3): the whole
 * session graph as forward causal trees rooted at nodes with no inbound edge,
 * plus the unattributed workspace changes surfaced explicitly (never silently
 * attributed). Session-scoped: reads the active session's projection, so
 * switching sessions switches the graph.
 *
 * The forest is flattened into fixed-height rows and rendered through the
 * shared virtual window (`WorkGraphWindow`) — one implementation with the
 * transcript, no per-row DOM measurement. Paging is scroll-driven: reaching
 * the end of the window appends the next page (unified-scroll plan §9), so a
 * long session never mounts an unbounded list and the reader never clicks a
 * "load more" button.
 */
export function WorkGraphTree(props: { state: WorkGraphState }) {
  const forest = createMemo(() => buildWorkGraphForest(props.state));
  const unattributed = createMemo(() =>
    selectUnattributedWorkGraphNodes(props.state),
  );
  // Expand state is explicit: an override map the flattener re-derives rows
  // from. A node with no override keeps the depth<2 default (unchanged UX).
  const [overrides, setOverrides] = createSignal<ReadonlyMap<string, boolean>>(
    new Map<string, boolean>(),
  );
  const [visibleRoots, setVisibleRoots] = createSignal(WORK_GRAPH_PAGE_SIZE);
  const [visibleUnattributed, setVisibleUnattributed] =
    createSignal(WORK_GRAPH_PAGE_SIZE);
  const [query, setQuery] = createSignal("");
  const [focusID, setFocusID] = createSignal<string | undefined>();
  const matches = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) return [];
    return Object.values(props.state.workGraphNodes)
      .filter((node) =>
        [node.nodeID, node.summary, node.target]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle)),
      )
      .slice(0, 8);
  });
  const navigation = createMemo(() => {
    const id = focusID();
    return id ? buildWorkGraphNavigation(props.state, id) : undefined;
  });
  const unattributedPage = createMemo(() =>
    paginateWorkGraphRows(unattributed(), visibleUnattributed()),
  );
  const unattributedRows = createMemo<WorkGraphRow[]>(() =>
    unattributed().length
      ? [
          workGraphSectionRow(
            "section:unattributed",
            "Unattributed changes (no causal edge — needs explanation)",
            unattributed().length,
            "unattributed",
          ),
          ...flattenWorkGraphNodes(unattributedPage().page, {
            idPrefix: "unattributed",
            unattributed: true,
          }),
        ]
      : [],
  );
  const navigationRows = createMemo<WorkGraphRow[]>(() => {
    const nav = navigation();
    if (!nav) return [];
    return [
      workGraphSectionRow(
        "section:why",
        `Why changed (backward) · ${nav.focus?.summary ?? ""}`,
        nav.backward.length,
        "inbound",
      ),
      ...flattenWorkGraphTrees(nav.backward, {
        overrides: overrides(),
        idPrefix: "why",
      }),
      workGraphSectionRow(
        "section:what",
        "What changed (forward)",
        nav.forward.length,
        "outbound",
      ),
      ...flattenWorkGraphTrees(nav.forward, {
        overrides: overrides(),
        idPrefix: "what",
      }),
    ];
  });
  const forestPage = createMemo(() =>
    paginateWorkGraphRows(forest(), visibleRoots()),
  );
  const forestRows = createMemo<WorkGraphRow[]>(() =>
    flattenWorkGraphTrees(forestPage().page, {
      overrides: overrides(),
      idPrefix: "forest",
    }),
  );
  const rows = createMemo<WorkGraphRow[]>(() =>
    navigation() ? navigationRows() : [...unattributedRows(), ...forestRows()],
  );
  const toggleNode = (nodeID: string, expanded: boolean) => {
    setOverrides((current) =>
      toggleWorkGraphOverride(current, nodeID, expanded),
    );
  };
  // Scroll-driven paging: one scroll gesture appends one page (unattributed
  // rows first, then forest roots); the row-count guard in the window stops a
  // page from re-firing before it actually grows.
  const appendNextPage = () => {
    if (navigation()) return;
    if (unattributedPage().remaining > 0) {
      setVisibleUnattributed((count) => count + WORK_GRAPH_PAGE_SIZE);
      return;
    }
    if (forestPage().remaining > 0)
      setVisibleRoots((count) => count + WORK_GRAPH_PAGE_SIZE);
  };

  return (
    <div class="wg-tree">
      <div class="wg-search">
        <input
          class="wg-search-input"
          type="search"
          placeholder="Search path / node / summary…"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <Show when={focusID()}>
          <button
            type="button"
            class="wg-search-clear"
            onClick={() => {
              setFocusID(undefined);
              setQuery("");
            }}
          >
            clear
          </button>
        </Show>
      </div>
      <Show when={matches().length}>
        <div class="wg-search-results">
          <For each={matches()}>
            {(node) => (
              <button
                type="button"
                class="wg-search-result"
                onClick={() => {
                  setFocusID(node.nodeID);
                  setQuery(node.target ?? node.summary);
                }}
              >
                <span class="wg-kind" data-kind={node.kind}>
                  {node.kind}
                </span>
                <span class="wg-summary">{node.summary}</span>
                <Show when={node.target}>
                  <span class="wg-via">{node.target}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <WorkGraphWindow
        rows={rows()}
        onToggleNode={toggleNode}
        onNearBottom={appendNextPage}
        empty={
          <div class="neu-gov-empty">
            No work graph yet — tool calls and workspace changes record the
            causal chain here.
          </div>
        }
      />
    </div>
  );
}
