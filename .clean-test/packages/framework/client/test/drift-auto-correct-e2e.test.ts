import { expect, test } from "bun:test";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import type { ProviderStreamRequest } from "@anthelia/runtime";
import { createRealRuntimeClient } from "../src";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();

const SESSION = "ses_e2e_drift_auto_correct" as SessionID;

/**
 * EI §3.4 auto-correction: a target_drift finding is closed as `corrected` when
 * a contract revision absorbs its flagged path — the reference frame moved to
 * meet the work, so the finding's premise is gone (same as an approved detour).
 */
test("Phase 2 E2E: a contract revision auto-corrects an absorbed target_drift finding", async () => {
  const root = await officialPluginWorkspace("drift-e2e-auto-correct");
  const events: RuntimeEvent[] = [];
  let planID = "";
  let phase = 1;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
    permissionMode: "ask",
    provider: {
      provider: "drift-auto-correct",
      model: "drift-auto-correct-model",
      async *stream(request: ProviderStreamRequest) {
        const proposeResults = (
          request as {
            messages: Array<{
              role: string;
              content: string;
              toolCallID?: string;
            }>;
          }
        ).messages.filter(
          (message) =>
            message.role === "tool" &&
            String(message.toolCallID ?? "").startsWith("call_propose"),
        );
        const propose = (scope: string[]) => ({
          type: "tool_call" as const,
          calls: [
            {
              id: "call_propose",
              name: "plan_propose",
              arguments: JSON.stringify({ planID, scope }),
            },
          ],
        });
        if (proposeResults.length === 0) {
          yield propose(["packages/a"]);
          yield { type: "done" as const };
          return;
        }
        if (phase === 2 && proposeResults.length === 1) {
          // Turn 2: extend the contract to absorb packages/b.
          yield propose(["packages/a", "packages/b"]);
          yield { type: "done" as const };
          return;
        }
        yield { type: "content" as const, text: "contract set" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request" && event.scope === "work_contract")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.sessionAttach!(SESSION);
  await client.planDocWrite!({
    path: "plans/drift-auto-correct.md",
    content: "# Drift auto-correct\n\n- one concrete step\n",
    title: "Drift auto-correct",
  });
  const marked = await client.planDocMark!({
    path: "plans/drift-auto-correct.md",
    title: "Drift auto-correct",
  });
  planID = marked.planID;
  await client.planDocActivate!(planID);

  // Turn 1: accept the initial contract (scope = packages/a).
  await client.submitAndWait!("propose the contract");

  // Open a target_drift finding: a change outside the committed scope.
  const opened = await client.evaluateDrift!(
    {
      objective: "work on packages/a",
      currentActivity: "modify:packages/b/x.ts",
      changes: [{ path: "packages/b/x.ts", action: "modified" }],
    },
    SESSION,
  );
  expect(opened.opened).toBeGreaterThan(0);
  const before = await client.driftFindings!({ sessionID: SESSION });
  const targetDrift = before.items.find(
    (finding) =>
      finding.status === "open" &&
      finding.evidence.some((entry) => entry.startsWith("outside_target:")),
  )!;
  expect(targetDrift).toBeDefined();
  expect(targetDrift.status).toBe("open");

  // Turn 2: extend the contract to absorb packages/b -> auto-correction.
  phase = 2;
  await client.submitAndWait!("extend the contract to include packages/b");

  const after = await client.driftFindings!({ sessionID: SESSION });
  const corrected = after.items.find(
    (finding) => finding.findingID === targetDrift.findingID,
  )!;
  expect(corrected.status).toBe("corrected");
  // The correction is a durable fact, not a UI-only toggle.
  expect(
    events.some(
      (event) =>
        event.type === "drift.finding_updated" &&
        event.findingID === targetDrift.findingID &&
        event.status === "corrected",
    ),
  ).toBe(true);
  await client.dispose?.();
}, 30_000);
