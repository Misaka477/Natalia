import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  externalWorkspaceChangeNode,
  toolCallNode,
  unattributedChangeNodes,
  verifyWorkGraphIntegrity,
  workspaceChangeEdge,
  workspaceChangeNode,
} from "../src/work-graph";

const ses = "ses_1" as never;

test("a well-formed graph is stable with no dangling edges or incomplete nodes", () => {
  const events: RuntimeEvent[] = [
    toolCallNode({
      turnID: "turn_1",
      callID: "call_1",
      toolName: "fs-write",
      status: "succeeded",
      sessionID: ses,
    }),
    workspaceChangeNode({
      turnID: "turn_1",
      path: "src/a.ts",
      toolName: "fs-write",
      sessionID: ses,
    }),
    workspaceChangeEdge({
      turnID: "turn_1",
      callID: "call_1",
      path: "src/a.ts",
    }),
  ];
  const report = verifyWorkGraphIntegrity(events);
  expect(report.nodeCount).toBe(2);
  expect(report.edgeCount).toBe(1);
  expect(report.danglingEdges).toEqual([]);
  expect(report.incompleteNodes).toEqual([]);
  expect(report.duplicateNodeIDs).toEqual([]);
  expect(report.stable).toBe(true);
});

test("an edge to a missing node is a dangling edge and the graph is not stable", () => {
  const events: RuntimeEvent[] = [
    workspaceChangeNode({
      turnID: "turn_1",
      path: "src/a.ts",
      toolName: "fs-write",
      sessionID: ses,
    }),
    // The tool_call node this edge points from was never recorded (the change
    // node it targets does exist).
    workspaceChangeEdge({
      turnID: "turn_1",
      callID: "call_missing",
      path: "src/a.ts",
    }),
  ];
  const report = verifyWorkGraphIntegrity(events);
  expect(report.danglingEdges).toHaveLength(1);
  expect(report.danglingEdges[0]).toMatchObject({ missing: "source" });
  expect(report.stable).toBe(false);
});

test("a node with no session correlation is incomplete, not silently attributed", () => {
  const events: RuntimeEvent[] = [
    {
      type: "workgraph.node_added",
      id: "wg:decision:x",
      nodeID: "wg:decision:x",
      kind: "decision",
      summary: "a decision with no session",
    } as RuntimeEvent,
  ];
  const report = verifyWorkGraphIntegrity(events);
  expect(report.incompleteNodes).toHaveLength(1);
  expect(report.incompleteNodes[0]).toMatchObject({
    nodeID: "wg:decision:x",
    kind: "decision",
  });
});

test("a re-emitted node id is a duplicate that breaks stability", () => {
  const node = toolCallNode({
    turnID: "turn_1",
    callID: "call_1",
    toolName: "fs-write",
    status: "succeeded",
    sessionID: ses,
  });
  const report = verifyWorkGraphIntegrity([node, node]);
  expect(report.duplicateNodeIDs).toEqual([node.nodeID]);
  expect(report.stable).toBe(false);
});

test("unattributedChangeNodes surfaces only external workspace changes with no turn", () => {
  const events: RuntimeEvent[] = [
    // Attributed change (has a turnID) — not unattributed.
    workspaceChangeNode({
      turnID: "turn_1",
      path: "src/a.ts",
      toolName: "fs-write",
      sessionID: ses,
    }),
    // External change (no turn identity) — the unattributed one.
    externalWorkspaceChangeNode({
      confirmedChangeID: "chg_1",
      path: "src/b.ts",
      sessionID: ses,
    }),
    externalWorkspaceChangeNode({
      confirmedChangeID: "chg_2",
      path: "src/c.ts",
      sessionID: ses,
    }),
  ];
  const unattributed = unattributedChangeNodes(events);
  expect(unattributed.map((node) => node.target)).toEqual([
    "src/b.ts",
    "src/c.ts",
  ]);
  expect(
    unattributed.every((node) => node.actor === "external" && !node.turnID),
  ).toBe(true);
});
