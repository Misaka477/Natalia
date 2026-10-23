import { For, Show, createMemo, createSignal } from "solid-js";
import type { WorkGraphState } from "@natalia/view-store";
import wg from "../styles/work-graph.module.css";

type CanvasLane = 0 | 1 | 2;

type PositionedNode = {
  id: string;
  kind: string;
  label: string;
  sublabel?: string;
  target?: string;
  lane: CanvasLane;
  x: number;
  y: number;
};

type PositionedEdge = {
  id: string;
  sourceID: string;
  targetID: string;
  kind: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

function laneForKind(kind: string): CanvasLane {
  if (kind === "goal" || kind === "plan" || kind === "agent_action") return 0;
  if (
    kind === "tool_call" ||
    kind === "decision" ||
    kind === "approval" ||
    kind === "constraint"
  )
    return 1;
  return 2;
}

/**
 * Interactive SVG Visual Node Canvas for the Work Graph (WG 2.0).
 *
 * Renders the session's causal nodes in three semantic lanes:
 * - Lane 0 (Left): Goals, Plans, and Conversation Turns
 * - Lane 1 (Middle): Tool Executions, Decisions, Approvals, and Guardrails
 * - Lane 2 (Right): Affected Workspace Files and Validations
 * Connected by cubic Bezier curves. Clicking any node highlights its backward
 * and forward causal lineage; clicking a file node opens it in the editor.
 */
export function WorkGraphGraph(props: {
  state: WorkGraphState;
  t?: (key: string, params?: Record<string, unknown>) => string;
}) {
  const tr = (key: string, fallback: string) =>
    props.t ? props.t(key) : fallback;
  const [selectedNodeID, setSelectedNodeID] = createSignal<
    string | undefined
  >();
  const [search, setSearch] = createSignal("");

  const layout = createMemo(() => {
    const allEdges = Object.values(props.state.workGraphEdges);
    const connectedIDs = new Set<string>();
    for (const edge of allEdges) {
      connectedIDs.add(edge.sourceID);
      connectedIDs.add(edge.targetID);
    }
    const needle = search().trim().toLowerCase();
    const candidateNodes = Object.values(props.state.workGraphNodes).filter(
      (node) => {
        if (node.kind === "checkpoint") return false;
        if (node.kind === "constraint" && node.actor === "runtime")
          return false;
        // Skip isolated external unattributed files unless explicitly searched
        if (
          node.kind === "workspace_change" &&
          !connectedIDs.has(node.nodeID) &&
          !needle
        ) {
          return false;
        }
        if (needle) {
          return [node.nodeID, node.summary, node.target]
            .filter(Boolean)
            .some((val) => String(val).toLowerCase().includes(needle));
        }
        return true;
      },
    );

    const laneBuckets: [
      typeof candidateNodes,
      typeof candidateNodes,
      typeof candidateNodes,
    ] = [[], [], []];
    for (const node of candidateNodes.slice(0, 60)) {
      laneBuckets[laneForKind(node.kind)].push(node);
    }

    const NODE_W = 136;
    const NODE_H = 38;
    const ROW_GAP = 52;
    const TOP_PAD = 42;
    const LANE_X: [number, number, number] = [14, 178, 342];

    const positionedNodes: PositionedNode[] = [];
    const byID = new Map<string, PositionedNode>();

    for (const lane of [0, 1, 2] as const) {
      const bucket = laneBuckets[lane];
      bucket.forEach((node, index) => {
        const x = LANE_X[lane];
        const y = TOP_PAD + index * ROW_GAP;
        const rawLabel =
          node.kind === "workspace_change" && node.target
            ? (node.target.split(/[\\/]/).pop() ?? node.target)
            : node.summary;
        const item: PositionedNode = {
          id: node.nodeID,
          kind: node.kind,
          label: rawLabel.slice(0, 22),
          sublabel: node.target ?? node.summary,
          ...(node.target ? { target: node.target } : {}),
          lane,
          x,
          y,
        };
        positionedNodes.push(item);
        byID.set(node.nodeID, item);
      });
    }

    const positionedEdges: PositionedEdge[] = [];
    for (const edge of allEdges) {
      const src = byID.get(edge.sourceID);
      const dst = byID.get(edge.targetID);
      if (!src || !dst) continue;
      const x1 = src.lane <= dst.lane ? src.x + NODE_W : src.x;
      const y1 = src.y + NODE_H / 2;
      const x2 = src.lane <= dst.lane ? dst.x : dst.x + NODE_W;
      const y2 = dst.y + NODE_H / 2;
      positionedEdges.push({
        id: edge.id,
        sourceID: edge.sourceID,
        targetID: edge.targetID,
        kind: edge.kind,
        x1,
        y1,
        x2,
        y2,
      });
    }

    const maxRows = Math.max(
      laneBuckets[0].length,
      laneBuckets[1].length,
      laneBuckets[2].length,
      1,
    );
    const height = Math.max(260, TOP_PAD + maxRows * ROW_GAP + 24);
    return {
      nodes: positionedNodes,
      edges: positionedEdges,
      width: 492,
      height,
      nodeW: NODE_W,
      nodeH: NODE_H,
      laneX: LANE_X,
    };
  });

  const activeSet = createMemo(() => {
    const focus = selectedNodeID();
    if (!focus) return undefined;
    const set = new Set<string>([focus]);
    const edges = layout().edges;
    // Walk up and down
    for (let pass = 0; pass < 4; pass++) {
      for (const edge of edges) {
        if (set.has(edge.sourceID)) set.add(edge.targetID);
        if (set.has(edge.targetID)) set.add(edge.sourceID);
      }
    }
    return set;
  });

  return (
    <div class={wg.graph}>
      <div class={wg.search}>
        <input
          class={wg.searchInput}
          type="search"
          placeholder={tr("gov.wgSearchPh", "Search file, tool or action…")}
          value={search()}
          onInput={(event) => setSearch(event.currentTarget.value)}
        />
        <Show when={selectedNodeID()}>
          <button
            type="button"
            class={wg.searchClear}
            onClick={() => setSelectedNodeID(undefined)}
          >
            {tr("common.close", "clear")}
          </button>
        </Show>
      </div>
      <div class={wg.canvasHint}>
        {tr(
          "gov.wgCanvasHint",
          "Click any node to highlight its causal chain; click a file node to open it in the editor.",
        )}
      </div>
      <Show
        when={layout().nodes.length > 0}
        fallback={
          <div class="neu-gov-empty">
            {tr(
              "gov.wgEmpty",
              "No work graph yet — tool calls and workspace changes record the causal chain here.",
            )}
          </div>
        }
      >
        <div class={wg.canvasWrap}>
          <svg
            class={wg.canvasSvg}
            viewBox={`0 0 ${layout().width} ${layout().height}`}
            style={{ height: `${layout().height}px` }}
          >
            {/* Lane headers */}
            <text x={layout().laneX[0]} y={22} class={wg.canvasLaneTitle}>
              {tr("gov.wgColOrigins", "Goals / Turns")}
            </text>
            <text x={layout().laneX[1]} y={22} class={wg.canvasLaneTitle}>
              {tr("gov.wgColActions", "Tools / Decisions")}
            </text>
            <text x={layout().laneX[2]} y={22} class={wg.canvasLaneTitle}>
              {tr("gov.wgColTargets", "Files / Validations")}
            </text>

            {/* Causal Bezier edges */}
            <For each={layout().edges}>
              {(edge) => {
                const highlighted = () => {
                  const set = activeSet();
                  if (!set) return true;
                  return set.has(edge.sourceID) && set.has(edge.targetID);
                };
                const dx = () =>
                  Math.max(36, Math.abs(edge.x2 - edge.x1) * 0.5);
                const d = () =>
                  `M ${edge.x1} ${edge.y1} C ${edge.x1 + dx()} ${edge.y1}, ${edge.x2 - dx()} ${edge.y2}, ${edge.x2} ${edge.y2}`;
                return (
                  <path
                    d={d()}
                    class={wg.canvasEdge}
                    data-active={highlighted()}
                  />
                );
              }}
            </For>

            {/* Nodes */}
            <For each={layout().nodes}>
              {(node) => {
                const isSelected = () => selectedNodeID() === node.id;
                const isHighlighted = () => {
                  const set = activeSet();
                  return !set || set.has(node.id);
                };
                const kindText = () => tr(`gov.wgKind.${node.kind}`, node.kind);
                return (
                  <g
                    class={wg.canvasNode}
                    data-kind={node.kind}
                    data-selected={isSelected()}
                    data-dim={!isHighlighted()}
                    transform={`translate(${node.x}, ${node.y})`}
                    onClick={() => {
                      setSelectedNodeID((prev) =>
                        prev === node.id ? undefined : node.id,
                      );
                      if (node.kind === "workspace_change" && node.target) {
                        window.dispatchEvent(
                          new CustomEvent("natalia:open-file", {
                            detail: { path: node.target, line: 1 },
                          }),
                        );
                      }
                    }}
                  >
                    <title>{node.sublabel}</title>
                    <rect
                      width={layout().nodeW}
                      height={layout().nodeH}
                      rx={8}
                      ry={8}
                      class={wg.canvasNodeRect}
                    />
                    <text x={8} y={14} class={wg.canvasNodeKind}>
                      {kindText()}
                    </text>
                    <text x={8} y={29} class={wg.canvasNodeLabel}>
                      {node.label}
                    </text>
                  </g>
                );
              }}
            </For>
          </svg>
        </div>
      </Show>
    </div>
  );
}
