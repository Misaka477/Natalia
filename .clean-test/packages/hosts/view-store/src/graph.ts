import type {
  AppState,
  SessionUsageStats,
  SessionUsageView,
  WorkGraphEdgeView,
  WorkGraphNodeView,
} from "./state";
import type { WorkGraphEdgeKind } from "@anthelia/contracts";
import { cacheHitRate, totalInputTokens } from "@anthelia/contracts";

export type WorkGraphSlice = {
  focusID: string;
  nodes: WorkGraphNodeView[];
  edges: WorkGraphEdgeView[];
  unattributed: WorkGraphNodeView[];
};

/**
 * A pre-assembled causal-tree node — the unit a future Work Graph UI renders
 * without re-deriving parent/child edges itself. `children` are already linked
 * through real edges (never text-similarity guesses); `via` names the causal
 * verb so a UI can label the branch ("modified", "validated_by", …). A cycle or
 * a depth cap truncates a branch to `{ node, children: [] }` — the graph is
 * never flattened into an infinite tree.
 */
export type WorkGraphTreeNode = {
  node: WorkGraphNodeView;
  via?: WorkGraphEdgeKind;
  children: WorkGraphTreeNode[];
};

/**
 * The bidirectional-navigation payload for one focus node (the data interface a
 * Web/Desktop UI consumes; the TUI-oriented original plan is superseded):
 *
 * - `forward`: the causal tree the focus causes/produces
 *   (goal/plan → steps → actions → diff → validations → checkpoint).
 * - `backward`: the causal tree that leads into the focus
 *   (file change → action → plan step → goal/constraint → rollback point) —
 *   the "why changed" direction.
 * - `unattributed`: workspace changes with no inbound edge. Per the graph
 *   invariants these are surfaced, never silently attributed.
 */
export type WorkGraphNavigation = {
  focus?: WorkGraphNodeView;
  forward: WorkGraphTreeNode[];
  backward: WorkGraphTreeNode[];
  unattributed: WorkGraphNodeView[];
};

const DEFAULT_MAX_DEPTH = 8;

function edgeDirection(
  edge: WorkGraphEdgeView,
  nodeID: string,
): "out" | "in" | undefined {
  if (edge.sourceID === nodeID) return "out";
  if (edge.targetID === nodeID) return "in";
  return undefined;
}

/** Builds one branch of the causal tree, guarding against cycles and depth. */
function buildBranch(
  nodes: Record<string, WorkGraphNodeView>,
  edges: WorkGraphEdgeView[],
  nodeID: string,
  via: WorkGraphEdgeKind | undefined,
  /** "out" follows source→target (what this node causes); "in" the reverse. */
  follow: "out" | "in",
  depth: number,
  maxDepth: number,
  visited: Set<string>,
): WorkGraphTreeNode | undefined {
  const node = nodes[nodeID];
  if (!node) return undefined;
  if (depth >= maxDepth || visited.has(nodeID))
    return { node, ...(via ? { via } : {}), children: [] };
  visited.add(nodeID);
  const children: WorkGraphTreeNode[] = [];
  for (const edge of edges) {
    const direction = edgeDirection(edge, nodeID);
    if (!direction) continue;
    // For a forward ("out") branch, follow edges leaving this node; for a
    // backward ("in") branch, follow edges entering it.
    if (follow === "out" && direction !== "out") continue;
    if (follow === "in" && direction !== "in") continue;
    const childID = follow === "out" ? edge.targetID : edge.sourceID;
    const child = buildBranch(
      nodes,
      edges,
      childID,
      edge.kind,
      follow,
      depth + 1,
      maxDepth,
      visited,
    );
    if (child) children.push(child);
  }
  return { node, ...(via ? { via } : {}), children };
}

/**
 * The whole graph as a forest of forward causal trees rooted at nodes with no
 * inbound edge (goals, plans, decisions, approvals, root actions). A Web UI
 * renders this directly as a collapsible tree; it never has to assemble edges.
 */
/**
 * The two work-graph fields every builder needs. Narrower than `AppState` so a
 * caller can feed a graph assembled from the RPC read surface (the governance
 * panel's history backfill) without fabricating the rest of the state.
 */
export type WorkGraphState = Pick<
  AppState,
  "workGraphNodes" | "workGraphEdges"
>;

export function buildWorkGraphForest(
  state: WorkGraphState,
  maxDepth = DEFAULT_MAX_DEPTH,
): WorkGraphTreeNode[] {
  const nodes = state.workGraphNodes;
  const edges = Object.values(state.workGraphEdges);
  const hasInbound = new Set(edges.map((edge) => edge.targetID));
  const roots = Object.values(nodes).filter(
    (node) =>
      !hasInbound.has(node.nodeID) &&
      // Runtime self-protection constraints (release-scope rules, actor
      // "runtime") are background facts, not the user's causal chain — keep
      // them out of the default forest roots. They still surface as children
      // when a tool call is actually constrained by them.
      !(node.kind === "constraint" && node.actor === "runtime"),
  );
  const forest: WorkGraphTreeNode[] = [];
  for (const root of roots) {
    const tree = buildBranch(
      nodes,
      edges,
      root.nodeID,
      undefined,
      "out",
      0,
      maxDepth,
      new Set(),
    );
    if (tree) forest.push(tree);
  }
  return forest;
}

/**
 * The bidirectional navigation for one focus (a file change, a plan, a goal…).
 * `forward` walks what the focus causes; `backward` walks what leads into it —
 * together the two directions the graph exists to answer ("what does this
 * touch" / "why did this change").
 */
export function buildWorkGraphNavigation(
  state: WorkGraphState,
  focusID?: string,
  maxDepth = DEFAULT_MAX_DEPTH,
): WorkGraphNavigation {
  const nodes = state.workGraphNodes;
  const edges = Object.values(state.workGraphEdges);
  const focus = focusID ? nodes[focusID] : undefined;
  const forward = focus
    ? (buildBranch(
        nodes,
        edges,
        focus.nodeID,
        undefined,
        "out",
        0,
        maxDepth,
        new Set(),
      )?.children ?? [])
    : [];
  const backward = focus
    ? (buildBranch(
        nodes,
        edges,
        focus.nodeID,
        undefined,
        "in",
        0,
        maxDepth,
        new Set(),
      )?.children ?? [])
    : [];
  return {
    ...(focus ? { focus } : {}),
    forward,
    backward,
    unattributed: selectUnattributedWorkGraphNodes(state),
  };
}

/**
 * The independent graph-navigation entry point (WG5): start from a file path
 * and answer "why did this change" (backward causal chain) and "what does this
 * touch" (forward chain), unioned across every graph node whose target is that
 * file. A path with no matching node returns empty slices rather than a
 * fabricated cause, matching the forest's missing-edge invariant.
 */
export type WorkGraphFileNavigation = {
  filePath: string;
  /** Every graph node whose target is the file (usually one workspace_change). */
  matches: WorkGraphNodeView[];
  /** Deduped backward "why changed" branches across all matching nodes. */
  whyChanged: WorkGraphTreeNode[];
  /** Deduped forward "what this touches" branches across all matching nodes. */
  whatChanged: WorkGraphTreeNode[];
};

export function buildWorkGraphFileNavigation(
  state: WorkGraphState,
  filePath: string,
): WorkGraphFileNavigation {
  const needle = filePath.trim();
  const matches = needle
    ? Object.values(state.workGraphNodes).filter((node) => {
        const target = node.target;
        if (!target) return false;
        return (
          target === needle ||
          target.endsWith(`/${needle}`) ||
          target.endsWith(needle)
        );
      })
    : [];
  const whyChanged: WorkGraphTreeNode[] = [];
  const whatChanged: WorkGraphTreeNode[] = [];
  const seenWhy = new Set<string>();
  const seenWhat = new Set<string>();
  for (const match of matches) {
    const nav = buildWorkGraphNavigation(state, match.nodeID);
    for (const node of nav.backward)
      if (!seenWhy.has(node.node.nodeID)) {
        seenWhy.add(node.node.nodeID);
        whyChanged.push(node);
      }
    for (const node of nav.forward)
      if (!seenWhat.has(node.node.nodeID)) {
        seenWhat.add(node.node.nodeID);
        whatChanged.push(node);
      }
  }
  return { filePath, matches, whyChanged, whatChanged };
}

/** The causal slice for one plan (its committed scope, via the planID
 * provenance on nodes) plus every edge between those nodes. */
export function selectWorkGraphByPlan(
  state: AppState,
  planID: string,
): { planID: string; nodes: WorkGraphNodeView[]; edges: WorkGraphEdgeView[] } {
  const nodes = Object.values(state.workGraphNodes).filter(
    (node) => node.planID === planID,
  );
  const ids = new Set(nodes.map((node) => node.nodeID));
  const edges = Object.values(state.workGraphEdges).filter(
    (edge) => ids.has(edge.sourceID) && ids.has(edge.targetID),
  );
  return { planID, nodes, edges };
}

/**
 * A bounded neighbourhood around one node for an external graph navigator.
 * Depth 0 is the focus only; each increment walks one edge hop.
 */
export function selectWorkGraphNeighborhood(
  state: AppState,
  focusID: string,
  depth = 1,
): WorkGraphSlice {
  const hops = Math.max(0, Math.min(depth, 4));
  const included = new Set<string>();
  if (state.workGraphNodes[focusID]) included.add(focusID);
  let frontier = new Set(included);
  for (let hop = 0; hop < hops; hop += 1) {
    const next = new Set<string>();
    for (const edge of Object.values(state.workGraphEdges)) {
      if (frontier.has(edge.sourceID) && state.workGraphNodes[edge.targetID])
        next.add(edge.targetID);
      if (frontier.has(edge.targetID) && state.workGraphNodes[edge.sourceID])
        next.add(edge.sourceID);
    }
    for (const id of next) included.add(id);
    frontier = next;
  }
  const nodes = [...included]
    .map((id) => state.workGraphNodes[id])
    .filter((node): node is WorkGraphNodeView => Boolean(node));
  const edges = Object.values(state.workGraphEdges).filter(
    (edge) => included.has(edge.sourceID) && included.has(edge.targetID),
  );
  return {
    focusID,
    nodes,
    edges,
    unattributed: selectUnattributedWorkGraphNodes(state),
  };
}

/**
 * Workspace changes with no inbound edge remain unattributed so a navigator can
 * mark unknown provenance instead of inventing a cause.
 */
export function selectUnattributedWorkGraphNodes(
  state: WorkGraphState,
): WorkGraphNodeView[] {
  const inbound = new Set(
    Object.values(state.workGraphEdges).map((edge) => edge.targetID),
  );
  return Object.values(state.workGraphNodes).filter(
    (node) => node.kind === "workspace_change" && !inbound.has(node.nodeID),
  );
}

/**
 * Derives the display figures from the raw session usage sums (the dashboard's
 * data interface): total input including cache traffic, cache hit rate, average
 * first-token latency, and decode throughput. Pure — never mutates the state,
 * so any UI (or a future TUI) computes the same figures from the same sums.
 *
 * The two cache figures come from the shared `@anthelia/contracts` helpers so a
 * session bar and the provider trace can never report different rates for the
 * same tokens.
 */
export function deriveSessionUsageView(
  stats: SessionUsageStats,
): SessionUsageView {
  return {
    ...stats,
    totalInputTokens: totalInputTokens(stats),
    cacheHitRate: cacheHitRate(stats),
    avgTtftMs: stats.ttftSteps > 0 ? stats.ttftMs / stats.ttftSteps : 0,
    tokensPerSecond:
      stats.decodeMs > 0 ? (stats.outputTokens / stats.decodeMs) * 1000 : 0,
  };
}
