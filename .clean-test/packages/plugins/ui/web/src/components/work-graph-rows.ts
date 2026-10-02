import type { WorkGraphTreeNode, WorkGraphNodeView } from "@natalia/view-store";

/**
 * The work-graph virtual-window row model.
 *
 * The causal forest is a recursive tree; a virtualizer needs one flat array of
 * fixed-height rows. Flattening also turns the collapse/expand interaction
 * into pure state (a collapsed id set) that the window can re-derive, instead
 * of a per-component `open` boolean buried in nested JSX.
 *
 * Row heights are fixed (DSH-style, see the unified scroll plan §3.1): a row is
 * always one line, so `WORK_GRAPH_ROW_HEIGHT` is both the estimate and the
 * rendered height and the virtualizer never DOM-measures rows.
 */

/** Rendered height of every work-graph row (one line: 12px × 1.5 + 2×2px). */
export const WORK_GRAPH_ROW_HEIGHT = 22;

/** Roots / unattributed rows loaded before a "load more" affordance appears. */
export const WORK_GRAPH_PAGE_SIZE = 50;

/** Below this row count the plain list renders (a window needs no virtualizer). */
export const WORK_GRAPH_VIRTUAL_THRESHOLD = 40;

export type WorkGraphSectionTone = "inbound" | "outbound" | "unattributed";

export type WorkGraphRow =
  | {
      id: string;
      kind: "section";
      title: string;
      count?: number;
      tone: WorkGraphSectionTone;
    }
  | {
      id: string;
      kind: "node";
      nodeID: string;
      nodeKind: string;
      summary: string;
      target?: string;
      via?: string;
      depth: number;
      expandable: boolean;
      expanded: boolean;
      unattributed?: boolean;
    };

export type FlattenTreeOptions = {
  /**
   * Explicit expand overrides by node id. A missing entry falls back to the
   * depth default, so toggling a deep node open (or a shallow one shut) is a
   * recorded decision rather than a fight with the default.
   */
  overrides?: ReadonlyMap<string, boolean>;
  /** Depth at and below which a node is expanded by default (matches the UI). */
  defaultExpandedDepth?: number;
  /** Section prefix for row ids so one node can appear in several sections. */
  idPrefix?: string;
};

/** Toggles one node's explicit expand state against the flattener default. */
export function toggleWorkGraphOverride(
  overrides: ReadonlyMap<string, boolean>,
  nodeID: string,
  expanded: boolean,
): ReadonlyMap<string, boolean> {
  const next = new Map(overrides);
  next.set(nodeID, expanded);
  return next;
}

/**
 * Flattens one causal forest (or navigation slice) into window rows. A node is
 * followed by its children only while expanded; collapsed nodes stay in the
 * list as a single leaf row so the reader can reopen the branch.
 */
export function flattenWorkGraphTrees(
  trees: readonly WorkGraphTreeNode[],
  options: FlattenTreeOptions = {},
): WorkGraphRow[] {
  const overrides = options.overrides;
  const defaultExpandedDepth = options.defaultExpandedDepth ?? 2;
  const idPrefix = options.idPrefix ?? "";
  const rows: WorkGraphRow[] = [];
  const walk = (tree: WorkGraphTreeNode, depth: number) => {
    const expandable = tree.children.length > 0;
    const override = overrides?.get(tree.node.nodeID);
    const expanded = expandable && (override ?? depth < defaultExpandedDepth);
    rows.push({
      id: `${idPrefix}#${rows.length}`,
      kind: "node",
      nodeID: tree.node.nodeID,
      nodeKind: tree.node.kind,
      summary: tree.node.summary,
      ...(tree.node.target ? { target: tree.node.target } : {}),
      ...(tree.via ? { via: tree.via } : {}),
      depth,
      expandable,
      expanded,
    });
    if (expanded) for (const child of tree.children) walk(child, depth + 1);
  };
  for (const tree of trees) walk(tree, 0);
  return rows;
}

/** Flattens flat node lists (unattributed changes, search matches) into rows. */
export function flattenWorkGraphNodes(
  nodes: readonly WorkGraphNodeView[],
  options: { idPrefix?: string; unattributed?: boolean } = {},
): WorkGraphRow[] {
  const idPrefix = options.idPrefix ?? "";
  return nodes.map((node, index) => ({
    id: `${idPrefix}#${index}`,
    kind: "node" as const,
    nodeID: node.nodeID,
    nodeKind: node.kind,
    summary: node.summary,
    ...(node.target ? { target: node.target } : {}),
    depth: 0,
    expandable: false,
    expanded: false,
    ...(options.unattributed ? { unattributed: true } : {}),
  }));
}

/** A section header row (always fixed height, like every other row). */
export function workGraphSectionRow(
  id: string,
  title: string,
  count: number,
  tone: WorkGraphSectionTone,
): WorkGraphRow {
  return { id, kind: "section", title, count, tone };
}

/**
 * One page of a long list: the first `pageSize` rows plus whether more remain.
 * Used for both forest roots and the unattributed section so a giant session
 * never mounts an unbounded window in one pass.
 */
export function paginateWorkGraphRows<T>(
  values: readonly T[],
  pageSize: number,
): { page: T[]; remaining: number } {
  if (pageSize <= 0) return { page: [...values], remaining: 0 };
  if (values.length <= pageSize) return { page: [...values], remaining: 0 };
  return {
    page: [...values].slice(0, pageSize),
    remaining: values.length - pageSize,
  };
}
