import { expect, test } from "bun:test";
import { projectEvents } from "@natalia/view-store";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import { createRealRuntimeClient } from "../src";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();

const sessionID = "ses_rung_durable" as SessionID;

/**
 * The rung a session chose reaches a client that folds the durable events.
 *
 * A second IN-PROCESS client is not a restart: the session store is a
 * process-wide singleton, so it shares the first client's live state (measured —
 * its exec still resolves the deployment default while the stream carries the
 * chosen rung). So this test folds what a restarting client actually has — the
 * durable event stream — and requires BOTH halves of the rung to survive it.
 *
 * The pair is what the control renders (`app-neu`'s `sessionRungFromProjection`),
 * and only half of it used to be recorded: `session.permission.mode` carried the
 * approval mode, while the sandbox half lived in a prose notice and in the
 * live-only `session.snapshot`.
 */
test("the durable stream carries both axes, and folds to the pair the control renders", async () => {
  const root = await officialPluginWorkspace("rung-durable");
  const writer = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "ask",
  });
  const seen: RuntimeEvent[] = [];
  writer.start((event) => seen.push(event));
  await writer.sessionAttach!(sessionID);
  const moved = await writer.setSandboxRung?.({
    sessionID,
    mode: "workspace-write",
    approval: "auto",
  });
  expect(moved).toBeDefined();
  await writer.dispose?.();

  const state = projectEvents(seen);
  expect(state.permissionMode).toBe("auto");
  expect(state.permissionConfinement).toBe("workspace-write");
}, 120_000);
