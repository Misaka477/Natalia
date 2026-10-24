import { For, Show, createMemo, createSignal } from "solid-js";
import type { WorkGraphState, WorkGraphNodeView } from "@natalia/view-store";
import wg from "../styles/work-graph.module.css";

type CanvasLane = 0 | 1 | 2;

type PositionedNode = {
  id: string;
  memberIDs: string[];
  count: number;
  kind: string;
  label: string;
  sublabel?: string;
  target?: string;
  failed?: boolean;
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

type TurnBandBg = {
  id: string;
  y: number;
  height: number;
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
 * Uses two layout optimizations to keep the canvas compact and readable:
 * 1. Smart Aggregation: within the same turn (or orphan group), repeated
 *    `tool_call` nodes with the same `(summary, status)` are collapsed into a
 *    single node carrying a `×N` badge (e.g. `run_shell · succeeded ×11`),
 *    eliminating long vertical stacks of identical tool calls.
 * 2. Turn-Aligned Horizontal Bands: each origin node (`turn` / `goal` / `plan`)
 *    defines a horizontal band, and the aggregated middle-lane tools and
 *    right-lane file targets caused by that origin are placed at the same
 *    vertical band offset so Bezier edges stay short and horizontal.
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

    const byNodeID = new Map<string, WorkGraphNodeView>();
    for (const n of candidateNodes) byNodeID.set(n.nodeID, n);

    const outMap = new Map<string, string[]>();
    for (const edge of allEdges) {
      if (!byNodeID.has(edge.sourceID) || !byNodeID.has(edge.targetID))
        continue;
      const list = outMap.get(edge.sourceID) ?? [];
      list.push(edge.targetID);
      outMap.set(edge.sourceID, list);
    }

    const origins = candidateNodes.filter((n) => laneForKind(n.kind) === 0);
    const placedRawIDs = new Set<string>();

    const NODE_W = 142;
    const NODE_H = 38;
    const ROW_GAP = 46;
    const BAND_GAP = 14;
    const TOP_PAD = 38;
    const LANE_X: [number, number, number] = [12, 176, 340];

    const positionedNodes: PositionedNode[] = [];
    const rawToClusterID = new Map<string, string>();
    const bands: TurnBandBg[] = [];

    function makeNode(
      rep: WorkGraphNodeView,
      members: WorkGraphNodeView[],
      lane: CanvasLane,
      y: number,
    ): PositionedNode {
      const clusterID = rep.nodeID;
      for (const m of members) {
        placedRawIDs.add(m.nodeID);
        rawToClusterID.set(m.nodeID, clusterID);
      }
      const rawLabel =
        rep.kind === "workspace_change" && rep.target
          ? (rep.target.split(/[\\/]/).pop() ?? rep.target)
          : rep.summary;
      const failed = rep.summary.includes("failed");
      return {
        id: clusterID,
        memberIDs: members.map((m) => m.nodeID),
        count: members.length,
        kind: rep.kind,
        label: rawLabel.slice(0, 21),
        sublabel:
          members.length > 1
            ? `${rep.summary} (×${members.length})`
            : (rep.target ?? rep.summary),
        ...(rep.target ? { target: rep.target } : {}),
        ...(failed ? { failed: true } : {}),
        lane,
        x: LANE_X[lane],
        y,
      };
    }

    function aggregateMiddleNodes(
      midNodes: WorkGraphNodeView[],
    ): Array<{ rep: WorkGraphNodeView; members: WorkGraphNodeView[] }> {
      const groups = new Map<
        string,
        { rep: WorkGraphNodeView; members: WorkGraphNodeView[] }
      >();
      for (const m of midNodes) {
        const key = `${m.kind}::${m.summary}`;
        const existing = groups.get(key);
        if (existing) {
          existing.members.push(m);
        } else {
          groups.set(key, { rep: m, members: [m] });
        }
      }
      return [...groups.values()];
    }

    let cursorY = TOP_PAD;
    let turnIndex = 0;

    // 1. Lay out each origin's horizontal band
    for (const origin of origins.slice(0, 25)) {
      turnIndex += 1;
      const bandStart = cursorY;

      const midList: WorkGraphNodeView[] = [];
      const targetSet = new Map<string, WorkGraphNodeView>();

      for (const childID of outMap.get(origin.nodeID) ?? []) {
        const child = byNodeID.get(childID);
        if (!child || placedRawIDs.has(child.nodeID)) continue;
        const lane = laneForKind(child.kind);
        if (lane === 1) {
          midList.push(child);
          for (const grandID of outMap.get(child.nodeID) ?? []) {
            const grand = byNodeID.get(grandID);
            if (
              grand &&
              laneForKind(grand.kind) === 2 &&
              !placedRawIDs.has(grand.nodeID)
            ) {
              targetSet.set(grand.nodeID, grand);
            }
          }
        } else if (lane === 2) {
          targetSet.set(child.nodeID, child);
        }
      }

      const midClusters = aggregateMiddleNodes(midList);
      const targetNodes = [...targetSet.values()];

      const originNode = makeNode(origin, [origin], 0, bandStart);
      if (origin.kind === "agent_action" && origin.summary === "turn") {
        originNode.label = `Turn #${turnIndex}`;
      }
      positionedNodes.push(originNode);

      midClusters.forEach((cluster, idx) => {
        positionedNodes.push(
          makeNode(cluster.rep, cluster.members, 1, bandStart + idx * ROW_GAP),
        );
      });

      targetNodes.forEach((target, idx) => {
        positionedNodes.push(
          makeNode(target, [target], 2, bandStart + idx * ROW_GAP),
        );
      });

      const bandRows = Math.max(1, midClusters.length, targetNodes.length);
      const bandHeight = bandRows * ROW_GAP - (ROW_GAP - NODE_H);
      bands.push({
        id: `band:${origin.nodeID}`,
        y: bandStart - 5,
        height: bandHeight + 10,
      });
      cursorY = bandStart + bandRows * ROW_GAP + BAND_GAP;
    }

    // 2. Lay out any remaining unplaced middle/target nodes in a trailing band
    const remainingMid = candidateNodes.filter(
      (n) => !placedRawIDs.has(n.nodeID) && laneForKind(n.kind) === 1,
    );
    const remainingTarget = candidateNodes.filter(
      (n) => !placedRawIDs.has(n.nodeID) && laneForKind(n.kind) === 2,
    );
    if (remainingMid.length > 0 || remainingTarget.length > 0) {
      const bandStart = cursorY;
      const midClusters = aggregateMiddleNodes(remainingMid.slice(0, 20));
      const targets = remainingTarget.slice(0, 20);
      midClusters.forEach((cluster, idx) => {
        positionedNodes.push(
          makeNode(cluster.rep, cluster.members, 1, bandStart + idx * ROW_GAP),
        );
      });
      targets.forEach((target, idx) => {
        positionedNodes.push(
          makeNode(target, [target], 2, bandStart + idx * ROW_GAP),
        );
      });
      const bandRows = Math.max(midClusters.length, targets.length, 1);
      cursorY = bandStart + bandRows * ROW_GAP + BAND_GAP;
    }

    // 3. Build deduplicated edges between positioned clusters
    const clusterByID = new Map<string, PositionedNode>();
    for (const p of positionedNodes) clusterByID.set(p.id, p);

    const positionedEdges: PositionedEdge[] = [];
    const seenEdgeKeys = new Set<string>();
    for (const edge of allEdges) {
      const srcClusterID = rawToClusterID.get(edge.sourceID);
      const dstClusterID = rawToClusterID.get(edge.targetID);
      if (!srcClusterID || !dstClusterID || srcClusterID === dstClusterID)
        continue;
      const edgeKey = `${srcClusterID}->${dstClusterID}`;
      if (seenEdgeKeys.has(edgeKey)) continue;
      seenEdgeKeys.add(edgeKey);

      const src = clusterByID.get(srcClusterID);
      const dst = clusterByID.get(dstClusterID);
      if (!src || !dst) continue;
      const x1 = src.lane <= dst.lane ? src.x + NODE_W : src.x;
      const y1 = src.y + NODE_H / 2;
      const x2 = src.lane <= dst.lane ? dst.x : dst.x + NODE_W;
      const y2 = dst.y + NODE_H / 2;
      positionedEdges.push({
        id: edgeKey,
        sourceID: srcClusterID,
        targetID: dstClusterID,
        kind: edge.kind,
        x1,
        y1,
        x2,
        y2,
      });
    }

    const height = Math.max(220, cursorY + 12);
    return {
      nodes: positionedNodes,
      edges: positionedEdges,
      bands,
      width: 494,
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
            <text x={layout().laneX[0]} y={20} class={wg.canvasLaneTitle}>
              {tr("gov.wgColOrigins", "Goals / Turns")}
            </text>
            <text x={layout().laneX[1]} y={20} class={wg.canvasLaneTitle}>
              {tr("gov.wgColActions", "Tools / Decisions")}
            </text>
            <text x={layout().laneX[2]} y={20} class={wg.canvasLaneTitle}>
              {tr("gov.wgColTargets", "Files / Validations")}
            </text>

            {/* Turn horizontal band backgrounds */}
            <For each={layout().bands}>
              {(band) => (
                <rect
                  x={6}
                  y={band.y}
                  width={layout().width - 12}
                  height={band.height}
                  rx={10}
                  ry={10}
                  class={wg.canvasBand}
                />
              )}
            </For>

            {/* Causal Bezier edges */}
            <For each={layout().edges}>
              {(edge) => {
                const highlighted = () => {
                  const set = activeSet();
                  if (!set) return true;
                  return set.has(edge.sourceID) && set.has(edge.targetID);
                };
                const dx = () =>
                  Math.max(28, Math.abs(edge.x2 - edge.x1) * 0.45);
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
                    data-failed={node.failed ? "true" : undefined}
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
                    <Show when={node.count > 1}>
                      <rect
                        x={layout().nodeW - 32}
                        y={4}
                        width={26}
                        height={13}
                        rx={6}
                        ry={6}
                        class={wg.canvasCountPill}
                      />
                      <text
                        x={layout().nodeW - 19}
                        y={13.5}
                        text-anchor="middle"
                        class={wg.canvasCountText}
                      >
                        ×{node.count}
                      </text>
                    </Show>
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
