import { expect, test } from "bun:test";
import type { SessionID } from "@anthelia/contracts";
import { createRealRuntimeClient } from "../src";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();
import { createScriptedProvider } from "./e2e-harness";

/**
 * EI Phase 3: the governance panel's Work Graph tab must show a session's
 * durable graph, not only the nodes produced after the UI attached. The web
 * shell deliberately does not replay the full event log on attach
 * (apps/web/src/runtime-rpc.ts), so the panel now folds the `workGraphNodes` RPC
 * — this proves that read surface returns history for a reattached session.
 */
test("workGraphNodes folds durable history for a reattached session", async () => {
  const root = await officialPluginWorkspace("workgraph-rpc-recovery");
  const sessionID = "ses_workgraph_recovery" as SessionID;
  const provider = () =>
    createScriptedProvider({
      main: [{ text: "standby" }],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    });

  // First runtime: record a decision, which lands a durable work-graph node.
  const first = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    provider: provider(),
  });
  first.start(() => undefined);
  await first.sessionAttach!(sessionID);
  const recorded = await first.recordDecision!(
    {
      decision: "append runtime context instead of mutating the system prompt",
      rationale: ["keeps the cacheable prefix stable"],
    },
    sessionID,
  );
  expect(recorded.recorded).toBe(true);
  const liveNodes = await first.workGraphNodes!({ sessionID });
  expect(liveNodes.some((node) => node.kind === "decision")).toBe(true);
  await first.dispose?.();

  // Second runtime (a fresh web load / runtime restart): the session journal is
  // durable, so the read surface must still return the node even though a fresh
  // in-memory projection starts empty.
  const second = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    provider: provider(),
  });
  second.start(() => undefined);
  await second.sessionAttach!(sessionID);
  const recoveredNodes = await second.workGraphNodes!({ sessionID });
  expect(recoveredNodes.some((node) => node.kind === "decision")).toBe(true);
  // The read surface and the projection agree on the recovered node id.
  const decisionNode = recoveredNodes.find((node) => node.kind === "decision")!;
  expect(decisionNode.nodeID).toStartWith("wg:decision:");
  await second.dispose?.();
}, 30_000);
