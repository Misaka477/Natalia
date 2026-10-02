import { expect, test } from "bun:test";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import { createRealRuntimeClient } from "../src";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();
import { createScriptedProvider } from "./e2e-harness";

/**
 * EI §3.7.1/§3.7.2: a rule-class change is confirmed per item by the human —
 * `auto` permission mode must NOT auto-grant it and must NOT offer
 * "Allow … for session". Only an explicit per-item Allow lands the rule.
 */
test("a proposed constitution rule still gates in auto mode (no auto-grant)", async () => {
  const root = await officialPluginWorkspace("constitution-rule-gate-auto");
  const sessionID = "ses_rule_gate_auto" as SessionID;
  const events: RuntimeEvent[] = [];
  let approvals = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [
        {
          tool: () => ({
            name: "constitution_propose_rule",
            arguments: {
              statement: "never run rm -rf on the repo root",
              enforcement: "deny",
              appliesTo: { commandPattern: "rm -rf" },
            },
          }),
        },
        { text: "rule proposed" },
      ],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start((event) => {
    events.push(event);
    if (
      event.type === "approval.request" &&
      event.scope === "constitution_rule"
    ) {
      approvals += 1;
      client.respondApproval({ requestID: event.id, decision: "once" });
    }
  });
  await client.sessionAttach!(sessionID);
  await client.submitAndWait!("propose a rule");

  const approval = events.find(
    (event): event is Extract<RuntimeEvent, { type: "approval.request" }> =>
      event.type === "approval.request" && event.scope === "constitution_rule",
  );
  expect(approval).toBeDefined();
  expect(approvals).toBe(1);
  expect(approval!.allowSession).toBe(false);
  const rules = await client.constitutionRules!(sessionID);
  const proposed = rules.find((rule) => rule.source === "agent_proposed");
  expect(proposed).toMatchObject({
    enforcement: "deny",
    source: "agent_proposed",
    // EI §3.7.5 provenance: the rule is agent-proposed and user-approved.
    proposedBy: "agent",
    approvedBy: "user",
  });
  await client.dispose?.();
}, 30_000);

test("a rejected constitution rule never lands", async () => {
  const root = await officialPluginWorkspace("constitution-rule-gate-reject");
  const sessionID = "ses_rule_gate_reject" as SessionID;
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [
        {
          tool: () => ({
            name: "constitution_propose_rule",
            arguments: {
              statement: "never run tests",
              enforcement: "deny",
              appliesTo: { tools: ["run_tests"] },
            },
          }),
        },
        { text: "rule rejected" },
      ],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start((event) => {
    events.push(event);
    if (
      event.type === "approval.request" &&
      event.scope === "constitution_rule"
    )
      client.respondApproval({ requestID: event.id, decision: "reject" });
  });
  await client.sessionAttach!(sessionID);
  await client.submitAndWait!("propose a rule");

  const rules = await client.constitutionRules!(sessionID);
  expect(rules.some((rule) => rule.source === "agent_proposed")).toBe(false);
  await client.dispose?.();
}, 30_000);
