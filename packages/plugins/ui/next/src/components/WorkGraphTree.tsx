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
import wg from "../styles/work-graph.module.css";
import { WorkGraphWindow } from "./WorkGraphWindow";

export type WorkGraphFilter = "all" | "plan" | "action" | "file" | "rule";

/**
 * The Work Graph as a collapsible causal forest (WG 2.0):
 * 1. The session's causal forest comes FIRST (never buried beneath external
 *    unattributed file noise).
 * 2. Category filter pills let the user focus on Goals/Plans, Tools/Actions,
 *    File Changes, or Approvals/Rules, and hide routine checkpoint noise by
 *    default unless toggled on.
 * 3. External unattributed workspace changes are placed in a collapsed
 *    bottom section that expands on click — never flooding the top or shifting
 *    rows during scroll pagination.
 */
export function WorkGraphTree(props: {
  state: WorkGraphState;
  t?: (key: string, params?: Record<string, unknown>) => string;
}) {
  const tr = (
    key: string,
    fallback: string,
    params?: Record<string, unknown>,
  ) => (props.t ? props.t(key, params) : fallback);

  const [filter, setFilter] = createSignal<WorkGraphFilter>("all");
  const [showCheckpoints, setShowCheckpoints] = createSignal(false);
  const [unattributedExpanded, setUnattributedExpanded] = createSignal(false);

  const rawForest = createMemo(() => buildWorkGraphForest(props.state));
  const forest = createMemo(() => {
    const f = filter();
    const keepCp = showCheckpoints();
    const matchKind = (kind: string) => {
      if (!keepCp && kind === "checkpoint") return false;
      if (f === "all") return true;
      if (f === "plan")
        return kind === "goal" || kind === "plan" || kind === "decision";
      if (f === "action")
        return kind === "agent_action" || kind === "tool_call";
      if (f === "file")
        return kind === "workspace_change" || kind === "validation";
      if (f === "rule") return kind === "approval" || kind === "constraint";
      return true;
    };
    const filterTree = (
      nodes: ReturnType<typeof rawForest>,
    ): ReturnType<typeof rawForest> => {
      const out: ReturnType<typeof rawForest> = [];
      for (const item of nodes) {
        const children = filterTree(item.children);
        if (matchKind(item.node.kind) || children.length > 0) {
          out.push({ ...item, children });
        }
      }
      return out;
    };
    return filterTree(rawForest());
  });

  const unattributed = createMemo(() =>
    selectUnattributedWorkGraphNodes(props.state),
  );
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

  const forestPage = createMemo(() =>
    paginateWorkGraphRows(forest(), visibleRoots()),
  );
  const forestRows = createMemo<WorkGraphRow[]>(() => {
    const flattened = flattenWorkGraphTrees(forestPage().page, {
      overrides: overrides(),
      idPrefix: "forest",
    });
    if (!flattened.length) return [];
    return [
      workGraphSectionRow(
        "section:causal",
        tr("gov.wgCausalSection", "Session Causal Chain"),
        forest().length,
        "inbound",
      ),
      ...flattened,
    ];
  });

  const unattributedPage = createMemo(() =>
    paginateWorkGraphRows(unattributed(), visibleUnattributed()),
  );
  const unattributedRows = createMemo<WorkGraphRow[]>(() => {
    const total = unattributed().length;
    if (!total) return [];
    const arrow = unattributedExpanded() ? "▾" : "▸";
    const header = workGraphSectionRow(
      "section:unattributed",
      `${arrow} ${tr("gov.wgUnattributedToggle", `External unattributed file changes (${total})`, { count: total })}`,
      total,
      "unattributed",
    );
    if (!unattributedExpanded()) return [header];
    return [
      header,
      ...flattenWorkGraphNodes(unattributedPage().page, {
        idPrefix: "unattributed",
        unattributed: true,
      }),
    ];
  });

  const navigationRows = createMemo<WorkGraphRow[]>(() => {
    const nav = navigation();
    if (!nav) return [];
    return [
      workGraphSectionRow(
        "section:why",
        tr(
          "gov.wgWhySection",
          `Why changed (backward) · ${nav.focus?.summary ?? ""}`,
          { summary: nav.focus?.summary ?? "" },
        ),
        nav.backward.length,
        "inbound",
      ),
      ...flattenWorkGraphTrees(nav.backward, {
        overrides: overrides(),
        idPrefix: "why",
      }),
      workGraphSectionRow(
        "section:what",
        tr("gov.wgWhatSection", "What changed (forward)"),
        nav.forward.length,
        "outbound",
      ),
      ...flattenWorkGraphTrees(nav.forward, {
        overrides: overrides(),
        idPrefix: "what",
      }),
    ];
  });

  // Causal forest FIRST, collapsed unattributed section at the bottom!
  const rows = createMemo<WorkGraphRow[]>(() =>
    navigation() ? navigationRows() : [...forestRows(), ...unattributedRows()],
  );

  const toggleNode = (nodeID: string, expanded: boolean) => {
    setOverrides((current) =>
      toggleWorkGraphOverride(current, nodeID, expanded),
    );
  };

  const toggleSection = (sectionID: string) => {
    if (sectionID === "section:unattributed") {
      setUnattributedExpanded((v) => !v);
    }
  };

  const openFile = (path: string) => {
    window.dispatchEvent(
      new CustomEvent("natalia:open-file", {
        detail: { path, line: 1 },
      }),
    );
  };

  const appendNextPage = () => {
    if (navigation()) return;
    if (forestPage().remaining > 0) {
      setVisibleRoots((count) => count + WORK_GRAPH_PAGE_SIZE);
      return;
    }
    if (unattributedExpanded() && unattributedPage().remaining > 0) {
      setVisibleUnattributed((count) => count + WORK_GRAPH_PAGE_SIZE);
    }
  };

  return (
    <div class={wg.tree}>
      <div class={wg.search}>
        <input
          class={wg.searchInput}
          type="search"
          placeholder={tr("gov.wgSearchPh", "Search file, tool or action…")}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <Show when={focusID()}>
          <button
            type="button"
            class={wg.searchClear}
            onClick={() => {
              setFocusID(undefined);
              setQuery("");
            }}
          >
            {tr("common.close", "clear")}
          </button>
        </Show>
      </div>
      <div class={wg.filterBar}>
        <button
          type="button"
          class={wg.filterPill}
          data-active={filter() === "all"}
          onClick={() => setFilter("all")}
        >
          {tr("gov.wgFilterAll", "All")}
        </button>
        <button
          type="button"
          class={wg.filterPill}
          data-active={filter() === "plan"}
          onClick={() => setFilter("plan")}
        >
          {tr("gov.wgFilterPlan", "Goals & Plans")}
        </button>
        <button
          type="button"
          class={wg.filterPill}
          data-active={filter() === "action"}
          onClick={() => setFilter("action")}
        >
          {tr("gov.wgFilterAction", "Tools & Actions")}
        </button>
        <button
          type="button"
          class={wg.filterPill}
          data-active={filter() === "file"}
          onClick={() => setFilter("file")}
        >
          {tr("gov.wgFilterFile", "File Changes")}
        </button>
        <button
          type="button"
          class={wg.filterPill}
          data-active={filter() === "rule"}
          onClick={() => setFilter("rule")}
        >
          {tr("gov.wgFilterRule", "Approvals & Rules")}
        </button>
        <button
          type="button"
          class={wg.filterPill}
          data-active={showCheckpoints()}
          onClick={() => setShowCheckpoints((v) => !v)}
        >
          {tr("gov.wgShowCheckpoints", "Checkpoints")}
        </button>
      </div>
      <Show when={matches().length}>
        <div class={wg.searchResults}>
          <For each={matches()}>
            {(node) => (
              <button
                type="button"
                class={wg.searchResult}
                onClick={() => {
                  setFocusID(node.nodeID);
                  setQuery(node.target ?? node.summary);
                }}
              >
                <span class={wg.kind} data-kind={node.kind}>
                  {tr(`gov.wgKind.${node.kind}`, node.kind)}
                </span>
                <span class={wg.summary}>{node.summary}</span>
                <Show when={node.target}>
                  <span class={wg.via}>{node.target}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <WorkGraphWindow
        rows={rows()}
        t={props.t}
        onToggleNode={toggleNode}
        onToggleSection={toggleSection}
        onOpenFile={openFile}
        onNearBottom={appendNextPage}
        empty={
          <div class="neu-gov-empty">
            {tr(
              "gov.wgEmpty",
              "No work graph yet — tool calls and workspace changes record the causal chain here.",
            )}
          </div>
        }
      />
    </div>
  );
}
