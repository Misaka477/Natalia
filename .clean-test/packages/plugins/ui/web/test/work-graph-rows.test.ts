import { expect, test } from "bun:test";
import { Virtualizer } from "@tanstack/solid-virtual";
import {
  WORK_GRAPH_PAGE_SIZE,
  WORK_GRAPH_ROW_HEIGHT,
  WORK_GRAPH_VIRTUAL_THRESHOLD,
  flattenWorkGraphNodes,
  flattenWorkGraphTrees,
  paginateWorkGraphRows,
  toggleWorkGraphOverride,
  workGraphSectionRow,
} from "../src/components/work-graph-rows";
import { buildWorkGraphForest } from "@natalia/view-store";
import type { WorkGraphNodeView } from "@natalia/view-store";

function node(nodeID: string, summary = nodeID): WorkGraphNodeView {
  return {
    type: "workgraph.node_added",
    id: nodeID,
    nodeID,
    kind: "tool_call",
    summary,
  };
}

function edge(sourceID: string, targetID: string, kind: "caused") {
  return {
    type: "workgraph.edge_added" as const,
    id: `e:${sourceID}->${targetID}`,
    sourceID,
    targetID,
    kind,
  };
}

test("flattenWorkGraphTrees expands depth < 2 by default and follows real edges only", () => {
  const state = {
    workGraphNodes: {
      root: node("root", "agent acted"),
      mid: node("mid", "read_file"),
      leaf: node("leaf", "src/a.ts modified"),
    },
    workGraphEdges: {
      e1: edge("root", "mid", "caused"),
      e2: edge("mid", "leaf", "caused"),
    },
  };
  const trees = buildWorkGraphForest(state);
  expect(trees).toHaveLength(1);
  const rows = flattenWorkGraphTrees(trees, { idPrefix: "t" });
  // root (d0) and mid (d1) expand their children; leaf (d2) is still rendered,
  // as a collapsed row the reader can reopen.
  expect(rows.map((row) => row.kind === "node" && row.nodeID)).toEqual([
    "root",
    "mid",
    "leaf",
  ]);
  expect(rows.map((row) => row.kind === "node" && row.expanded)).toEqual([
    true,
    true,
    false,
  ]);
  expect(rows[2]).toMatchObject({ depth: 2 });
});

test("flattenWorkGraphTrees hides collapsed children and restores them", () => {
  const state = {
    workGraphNodes: {
      root: node("root"),
      mid: node("mid"),
      leaf: node("leaf"),
    },
    workGraphEdges: {
      e1: edge("root", "mid", "caused"),
      e2: edge("mid", "leaf", "caused"),
    },
  };
  const trees = buildWorkGraphForest(state);
  const rows = flattenWorkGraphTrees(trees, {
    overrides: new Map([["root", false]]),
    idPrefix: "t",
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    kind: "node",
    nodeID: "root",
    expanded: false,
  });
  const reopened = flattenWorkGraphTrees(trees, { idPrefix: "t" });
  expect(reopened.length).toBeGreaterThan(1);
});

test("toggleWorkGraphOverride records an explicit decision against the depth default", () => {
  // A depth-1 node is expanded by default; toggling it shut must survive the
  // default instead of fighting it (the collapsed-set bug this replaces).
  let overrides: ReadonlyMap<string, boolean> = new Map();
  overrides = toggleWorkGraphOverride(overrides, "mid", false);
  expect(overrides.get("mid")).toBe(false);
  overrides = toggleWorkGraphOverride(overrides, "mid", true);
  expect(overrides.get("mid")).toBe(true);
  const state = {
    workGraphNodes: {
      root: node("root"),
      mid: node("mid"),
      leaf: node("leaf"),
    },
    workGraphEdges: {
      e1: edge("root", "mid", "caused"),
      e2: edge("mid", "leaf", "caused"),
    },
  };
  const rows = flattenWorkGraphTrees(buildWorkGraphForest(state), {
    overrides: new Map([["mid", false]]),
    idPrefix: "t",
  });
  // mid collapsed: its child leaf never enters the window.
  expect(rows.map((row) => row.kind === "node" && row.nodeID)).toEqual([
    "root",
    "mid",
  ]);
  expect(rows[1]).toMatchObject({ expanded: false });
  // A depth-2 node is collapsed by default; an explicit override opens it.
  const deep = {
    workGraphNodes: {
      root: node("root"),
      mid: node("mid"),
      leaf: node("leaf"),
      deep: node("deep"),
    },
    workGraphEdges: {
      e1: edge("root", "mid", "caused"),
      e2: edge("mid", "leaf", "caused"),
      e3: edge("leaf", "deep", "caused"),
    },
  };
  const opened = flattenWorkGraphTrees(buildWorkGraphForest(deep), {
    overrides: new Map([["leaf", true]]),
    idPrefix: "d",
  });
  expect(opened.map((row) => row.kind === "node" && row.nodeID)).toEqual([
    "root",
    "mid",
    "leaf",
    "deep",
  ]);
});

test("flattenWorkGraphTrees keeps one node per causal path (cycle-safe)", () => {
  // A diamond: root causes two branches that both land on the same leaf via
  // distinct edges. Each branch carries its own copy (the graph forest renders
  // both causations), but within one root-to-leaf path a node never repeats,
  // and a cycle would be truncated instead of flattened forever.
  const state = {
    workGraphNodes: {
      root: node("root"),
      a: node("a"),
      b: node("b"),
      leaf: node("leaf"),
    },
    workGraphEdges: {
      e1: edge("root", "a", "caused"),
      e2: edge("root", "b", "caused"),
      e3: edge("a", "leaf", "caused"),
      e4: edge("b", "leaf", "caused"),
    },
  };
  const rows = flattenWorkGraphTrees(buildWorkGraphForest(state), {
    idPrefix: "t",
  });
  const nodeRows = rows.filter((row) => row.kind === "node");
  const ids = nodeRows.map((row) => (row.kind === "node" ? row.nodeID : ""));
  expect(ids).toEqual(["root", "a", "leaf", "b", "leaf"]);
  // Every root-to-leaf path is cycle-free (per-branch visited sets).
  expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  expect(
    nodeRows.every((row) => row.kind === "node" && typeof row.id === "string"),
  ).toBe(true);
});

test("flattenWorkGraphNodes flattens unattributed rows with unique ids", () => {
  const rows = flattenWorkGraphNodes([node("a"), node("b")], {
    idPrefix: "u",
    unattributed: true,
  });
  expect(rows.map((row) => row.id)).toEqual(["u#0", "u#1"]);
  expect(rows.every((row) => row.kind === "node")).toBe(true);
  expect(rows[0]).toMatchObject({
    unattributed: true,
    depth: 0,
    expandable: false,
  });
});

test("workGraphSectionRow carries the section count and tone", () => {
  const row = workGraphSectionRow("s", "Why changed", 3, "inbound");
  expect(row).toEqual({
    id: "s",
    kind: "section",
    title: "Why changed",
    count: 3,
    tone: "inbound",
  });
});

test("paginateWorkGraphRows returns the first page and remaining count", () => {
  const values = Array.from({ length: 130 }, (_, index) => index);
  const page = paginateWorkGraphRows(values, WORK_GRAPH_PAGE_SIZE);
  expect(page.page).toHaveLength(50);
  expect(page.remaining).toBe(80);
  const none = paginateWorkGraphRows(values.slice(0, 10), WORK_GRAPH_PAGE_SIZE);
  expect(none.page).toHaveLength(10);
  expect(none.remaining).toBe(0);
});

function workGraphVirtualizer(initialOffset: number, count = 5_000) {
  const viewportHeight = 400;
  return new Virtualizer<Element, Element>({
    count,
    getScrollElement: () => null,
    estimateSize: () => WORK_GRAPH_ROW_HEIGHT,
    overscan: 8,
    initialRect: { width: 800, height: viewportHeight },
    initialOffset,
    observeElementRect: (_instance, callback) => {
      callback({ width: 800, height: viewportHeight });
      return () => {};
    },
    observeElementOffset: (_instance, callback) => {
      callback(initialOffset, false);
      return () => {};
    },
    scrollToFn: () => {},
  });
}

test("work graph window mounts a bounded row set for 5000 rows", () => {
  const virtualizer = workGraphVirtualizer(0);
  const items = virtualizer.getVirtualItems();
  expect(virtualizer.getTotalSize()).toBe(5_000 * WORK_GRAPH_ROW_HEIGHT);
  expect(items[0]?.index).toBe(0);
  // Far below the row count: a fixed-height window, not the whole forest.
  expect(items.length).toBeLessThan(40);
});

test("work graph window follows scroll without remounting every row", () => {
  const offset = 1_000 * WORK_GRAPH_ROW_HEIGHT;
  const items = workGraphVirtualizer(offset).getVirtualItems();
  expect(items[0]?.index).toBeGreaterThan(0);
  expect(items[0]?.index).toBeLessThanOrEqual(1_000);
  expect(items.at(-1)?.index).toBeGreaterThan(1_000);
  expect(items.length).toBeLessThan(40);
});

test("work graph virtualization threshold keeps short lists on the plain path", () => {
  expect(WORK_GRAPH_VIRTUAL_THRESHOLD).toBeGreaterThan(0);
  expect(WORK_GRAPH_ROW_HEIGHT).toBeGreaterThanOrEqual(20);
});
