import { Show, createMemo, createSignal } from "solid-js";
import {
  buildWorkGraphFileNavigation,
  type WorkGraphState,
} from "@natalia/view-store";
import {
  flattenWorkGraphNodes,
  flattenWorkGraphTrees,
  toggleWorkGraphOverride,
  workGraphSectionRow,
  type WorkGraphRow,
} from "./work-graph-rows";
import { WorkGraphWindow } from "./WorkGraphWindow";

/**
 * The independent Work Graph navigator (WG5): start from a file path and read
 * the graph as "why did this change" (backward causal chain) beside "what does
 * this touch" (forward chain). Complements the causal `WorkGraphTree` forest
 * with a file-anchored adjacency view; a path with no node shows an explicit
 * "unknown provenance" instead of a fabricated cause.
 *
 * Both chains render through the same fixed-height virtual window as the causal
 * tree, so a deeply linked file never mounts an unbounded row list.
 */
export function WorkGraphGraph(props: { state: WorkGraphState }) {
  const [filePath, setFilePath] = createSignal("");
  const [overrides, setOverrides] = createSignal<ReadonlyMap<string, boolean>>(
    new Map<string, boolean>(),
  );
  const navigation = createMemo(() => {
    const path = filePath().trim();
    if (!path) return undefined;
    return buildWorkGraphFileNavigation(props.state, path);
  });
  const rows = createMemo<WorkGraphRow[]>(() => {
    const nav = navigation();
    if (!nav || !nav.matches.length) return [];
    return [
      workGraphSectionRow(
        "section:matches",
        `Graph nodes targeting ${nav.filePath}`,
        nav.matches.length,
        "inbound",
      ),
      ...flattenWorkGraphNodes(nav.matches, { idPrefix: "matches" }),
      workGraphSectionRow(
        "section:why",
        "Why changed (backward)",
        nav.whyChanged.length,
        "inbound",
      ),
      ...flattenWorkGraphTrees(nav.whyChanged, {
        overrides: overrides(),
        idPrefix: "why",
      }),
      workGraphSectionRow(
        "section:what",
        "What this touches (forward)",
        nav.whatChanged.length,
        "outbound",
      ),
      ...flattenWorkGraphTrees(nav.whatChanged, {
        overrides: overrides(),
        idPrefix: "what",
      }),
    ];
  });
  const toggleNode = (nodeID: string, expanded: boolean) => {
    setOverrides((current) =>
      toggleWorkGraphOverride(current, nodeID, expanded),
    );
  };
  return (
    <div class="wg-graph">
      <div class="wg-search">
        <input
          class="wg-search-input"
          type="search"
          placeholder="Navigate from a file path…"
          value={filePath()}
          onInput={(event) => setFilePath(event.currentTarget.value)}
        />
      </div>
      <Show when={navigation()}>
        {(nav) => (
          <Show
            when={nav().matches.length}
            fallback={
              <div class="neu-gov-empty">
                No graph node targets “{nav().filePath}” — unknown provenance.
              </div>
            }
          >
            <WorkGraphWindow
              rows={rows()}
              onToggleNode={toggleNode}
              empty={
                <div class="neu-gov-empty">
                  No graph node targets “{nav().filePath}” — unknown provenance.
                </div>
              }
            />
          </Show>
        )}
      </Show>
      <Show when={!navigation()}>
        <div class="neu-gov-empty">
          Enter a file path to navigate the causal graph from a change back to
          why it happened.
        </div>
      </Show>
    </div>
  );
}
