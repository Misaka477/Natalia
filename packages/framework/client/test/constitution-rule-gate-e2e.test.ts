import { expect, test } from "bun:test";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import type { ProviderStreamRequest } from "@anthelia/runtime";
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

test("the rule lifecycle answers active -> revoked -> removed through the tools (T-21)", async () => {
  const root = await officialPluginWorkspace("constitution-rule-lifecycle");
  const sessionID = "ses_rule_lifecycle" as SessionID;
  const results: string[] = [];
  let ruleID = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    provider: {
      provider: "rule-lifecycle",
      model: "rule-lifecycle-model",
      async *stream(request: ProviderStreamRequest) {
        const messages = (
          request as {
            messages: Array<{
              role: string;
              content: string;
              toolCallID?: string;
            }>;
          }
        ).messages;
        const last = messages
          .filter(
            (message) =>
              message.role === "tool" &&
              String(message.toolCallID ?? "").startsWith("call_rule"),
          )
          .at(-1);
        if (last) {
          const content = String(last.content ?? "");
          results.push(content);
          if (results.length === 1) {
            // The proposal landed: read its status back through rule_read.
            ruleID = (JSON.parse(content) as { ruleID: string }).ruleID;
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "call_rule",
                  name: "constitution_rule_read",
                  arguments: JSON.stringify({ ruleID }),
                },
              ],
            };
            yield { type: "done" as const };
            return;
          }
          if (results.length === 2) {
            // Active: propose the revoke through its own gate.
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "call_rule",
                  name: "constitution_rule_revoke",
                  arguments: JSON.stringify({
                    ruleID,
                    reason: "superseded by a tighter rule",
                  }),
                },
              ],
            };
            yield { type: "done" as const };
            return;
          }
          if (results.length === 3) {
            // Revoked: the read answers removed, with the tombstone's facts.
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "call_rule",
                  name: "constitution_rule_read",
                  arguments: JSON.stringify({ ruleID }),
                },
              ],
            };
            yield { type: "done" as const };
            return;
          }
          yield { type: "content" as const, text: "lifecycle complete" };
          yield { type: "done" as const };
          return;
        }
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_rule",
              name: "constitution_propose_rule",
              arguments: JSON.stringify({
                statement: "never force-push to main",
                enforcement: "deny",
                appliesTo: { commandPattern: "git push.*--force" },
              }),
            },
          ],
        };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => {
    if (
      event.type === "approval.request" &&
      (event.scope === "constitution_rule" ||
        event.scope === "constitution_rule_revoke")
    )
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.sessionAttach!(sessionID);
  await client.submitAndWait!("propose, read, revoke, read the rule");

  expect(results).toHaveLength(4);
  // 1. The proposal answers with a STATUS, not a bare flag: the rule is
  // active, and its provenance rides along.
  const proposed = JSON.parse(results[0]!) as {
    status: string;
    ruleID: string;
    rule: { source: string; approvedBy: string; enforcement: string };
  };
  expect(proposed.status).toBe("active");
  expect(ruleID).toBe(proposed.ruleID);
  expect(proposed.rule).toMatchObject({
    source: "agent_proposed",
    approvedBy: "user",
    enforcement: "deny",
  });
  // 2. rule_read agrees: active, the same fields.
  const read1 = JSON.parse(results[1]!) as {
    status: string;
    rule: { ruleID: string };
  };
  expect(read1.status).toBe("active");
  expect(read1.rule.ruleID).toBe(ruleID);
  // 3. The revoke lands the tombstone.
  const revoked = JSON.parse(results[2]!) as {
    status: string;
    ruleID: string;
    removedAt: string;
  };
  expect(revoked.status).toBe("removed");
  expect(revoked.ruleID).toBe(ruleID);
  expect(revoked.removedAt).toBeTruthy();
  // 4. The read after the revoke answers removed — the tombstone is durable,
  // not a vanished record.
  const read2 = JSON.parse(results[3]!) as {
    status: string;
    removedBy: string;
  };
  expect(read2.status).toBe("removed");
  expect(read2.removedBy).toBe("user");
  // The effective set no longer carries the rule.
  const rules = await client.constitutionRules!(sessionID);
  expect(rules.some((rule) => rule.ruleID === ruleID)).toBe(false);
  await client.dispose?.();
}, 30_000);

test("a protected rule refuses revocation before the gate, and a rejected revoke keeps the rule (T-21)", async () => {
  const root = await officialPluginWorkspace("constitution-rule-revoke-guards");
  const sessionID = "ses_rule_revoke_guards" as SessionID;
  const results: string[] = [];
  let draftRuleID = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    provider: {
      provider: "rule-revoke-guards",
      model: "rule-revoke-guards-model",
      async *stream(request: ProviderStreamRequest) {
        const messages = (
          request as {
            messages: Array<{
              role: string;
              content: string;
              toolCallID?: string;
            }>;
          }
        ).messages;
        const last = messages
          .filter(
            (message) =>
              message.role === "tool" &&
              String(message.toolCallID ?? "").startsWith("call_rule"),
          )
          .at(-1);
        if (last) {
          const content = String(last.content ?? "");
          results.push(content);
          if (results.length === 1) {
            // The proposal landed: its ruleID drives the revoke guards.
            draftRuleID = (JSON.parse(content) as { ruleID: string }).ruleID;
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "call_rule",
                  name: "constitution_rule_revoke",
                  arguments: JSON.stringify({ ruleID: "C-TERM-001" }),
                },
              ],
            };
            yield { type: "done" as const };
            return;
          }
          if (results.length === 2) {
            // An unknown ruleID: unknown, not a silent success.
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "call_rule",
                  name: "constitution_rule_revoke",
                  arguments: JSON.stringify({ ruleID: "P-NOPE" }),
                },
              ],
            };
            yield { type: "done" as const };
            return;
          }
          if (results.length === 3) {
            // The real (non-protected) rule, revoked but REJECTED at the gate.
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "call_rule",
                  name: "constitution_rule_revoke",
                  arguments: JSON.stringify({ ruleID: draftRuleID }),
                },
              ],
            };
            yield { type: "done" as const };
            return;
          }
          if (results.length === 4) {
            // The rejected revoke leaves the rule active.
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "call_rule",
                  name: "constitution_rule_read",
                  arguments: JSON.stringify({ ruleID: draftRuleID }),
                },
              ],
            };
            yield { type: "done" as const };
            return;
          }
          yield { type: "content" as const, text: "guards held" };
          yield { type: "done" as const };
          return;
        }
        // First: propose an ordinary (non-protected) rule and approve it.
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_rule",
              name: "constitution_propose_rule",
              arguments: JSON.stringify({
                statement: "never force-push to main",
                enforcement: "deny",
                appliesTo: { commandPattern: "git push.*--force" },
              }),
            },
          ],
        };
        yield { type: "done" as const };
      },
    },
  });
  let revokeApprovals = 0;
  client.start((event) => {
    if (
      event.type === "approval.request" &&
      event.scope === "constitution_rule"
    )
      client.respondApproval({ requestID: event.id, decision: "once" });
    // The revoke gate: reject, and count the asks.
    if (
      event.type === "approval.request" &&
      event.scope === "constitution_rule_revoke"
    ) {
      revokeApprovals += 1;
      client.respondApproval({ requestID: event.id, decision: "reject" });
    }
  });
  await client.sessionAttach!(sessionID);
  await client.submitAndWait!("exercise the revoke guards");

  expect(results).toHaveLength(5);
  // 1. The proposal landed active.
  expect(JSON.parse(results[0]!).status).toBe("active");
  // 2. Revoking a critical/high forbidden rule is refused by name — and no
  // approval was ever requested for it (the gate count below proves it).
  const refused = JSON.parse(results[1]!) as { status: string; reason: string };
  expect(refused.status).toBe("refused");
  expect(refused.reason).toContain("non-rollback");
  // 3. Unknown ruleID: unknown.
  expect(JSON.parse(results[2]!).status).toBe("unknown");
  // 4. The rejected revoke says rejected…
  const rejected = JSON.parse(results[3]!) as { status: string };
  expect(rejected.status).toBe("rejected");
  // 5. …and the rule is still active afterwards.
  expect(JSON.parse(results[4]!).status).toBe("active");
  // Exactly one revoke approval was asked (the draft rule); the protected and
  // unknown refusals never reached the gate.
  expect(revokeApprovals).toBe(1);
  await client.dispose?.();
}, 30_000);
