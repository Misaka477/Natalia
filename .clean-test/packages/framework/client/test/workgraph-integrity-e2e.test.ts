import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionID } from "@anthelia/contracts";
import { createRealRuntimeClient } from "../src";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();
import { createScriptedProvider } from "./e2e-harness";

const SESSION = "ses_e2e_workgraph_integrity" as SessionID;

test("Phase 3 E2E: work graph integrity reports a stable graph and unattributed changes", async () => {
  const root = await officialPluginWorkspace("workgraph-integrity-e2e");
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [{ text: "standby" }],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start(() => undefined);
  await client.sessionAttach!(SESSION);

  // A decision node in the graph (well-formed, with session correlation).
  await client.recordDecision!({ decision: "append runtime context" }, SESSION);

  // 1. Integrity: the graph rebuilt from the journal is stable.
  const integrity = await client.workGraphIntegrity!(SESSION);
  expect(integrity.nodeCount).toBeGreaterThan(0);
  expect(integrity.stable).toBe(true);
  expect(integrity.danglingEdges).toEqual([]);
  expect(integrity.duplicateNodeIDs).toEqual([]);
  // Every node the runtime wrote carries session correlation.
  expect(integrity.incompleteNodes).toEqual([]);

  // 2. Unattributed changes: none yet (nothing external reconciled).
  const before = await client.unattributedChanges!(SESSION);
  expect(before).toEqual([]);

  await client.dispose?.();
}, 30_000);

test("Phase 3 E2E: an external workspace change surfaces through the unattributedChanges read surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-wg-unattributed-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.sessionAttach!(SESSION);
  await client.submitAndWait!("hello");

  // An external edit no tool claimed.
  await writeFile(join(root, "external-note.txt"), "written outside\n");
  await Bun.sleep(400);
  // The reconcile discovers it and graphs it as an isolated external node.
  await client.confirmedWorkspaceChanges!(SESSION);
  await Bun.sleep(200);

  // The read surface returns the unattributed change for diagnosis.
  const unattributed = await client.unattributedChanges!(SESSION);
  expect(
    unattributed.some((change) => change.path === "external-note.txt"),
  ).toBe(true);
  // The graph stays stable: the external node carries session correlation (so
  // it is not "incomplete") and no dangling edge points at it.
  const integrity = await client.workGraphIntegrity!(SESSION);
  expect(integrity.stable).toBe(true);
  expect(integrity.danglingEdges).toEqual([]);
  await client.dispose?.();
}, 30_000);
