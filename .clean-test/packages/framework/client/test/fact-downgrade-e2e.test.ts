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
 * EI Phase 1 "降档≠丢失": the hot fact state bounds terminal entries to the most
 * recent N, but a read reconstructs the complete set from the durable store.
 */
test("terminal facts are downgraded in hot memory yet still read in full", async () => {
  const root = await officialPluginWorkspace("fact-downgrade-e2e");
  const sessionID = "ses_fact_downgrade" as SessionID;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [{ text: "standby" }],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start(() => undefined);
  await client.sessionAttach!(sessionID);

  // 300 decisions (> the 200 terminal cap) written durably.
  for (let i = 0; i < 300; i += 1)
    await client.recordDecision!({ decision: `decision ${i}` }, sessionID);

  const page = await client.decisionRecords!({
    sessionID,
    scope: "session",
  });
  // All 300 are readable even though the hot state keeps only the recent 200
  // — the read reconstructs from the durable store.
  expect(page.total).toBe(300);
  expect(page.items).toHaveLength(300);
  // The oldest decision (evicted from hot memory) is still served.
  expect(page.items.some((d) => d.decision === "decision 0")).toBe(true);
  await client.dispose?.();
}, 60_000);
