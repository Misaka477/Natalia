import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import type {
  ProviderStreamRequest,
  StreamingProvider,
} from "@anthelia/runtime";
import { createRealRuntimeClient } from "../src";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();
import {
  projectedRuntimeNotices,
  projectedWorkContracts,
} from "@anthelia/session";
import { createScriptedProvider } from "./e2e-harness";

/** A provider whose first step proposes the contract, then settles. */
function proposeProvider(
  getProposal: () => {
    planID: string;
    scope?: string[];
    verification?: string[];
    constraints?: string[];
  } | null,
  settle: (result: string) => Array<
    | {
        type: "tool_call";
        calls: Array<{ id: string; name: string; arguments: string }>;
      }
    | { type: "content"; text: string }
    | { type: "done" }
  >,
): StreamingProvider {
  return {
    provider: "plan-propose",
    model: "plan-propose-model",
    async *stream(request: ProviderStreamRequest) {
      const proposal = getProposal();
      const toolResult = (
        request as {
          messages: Array<{
            role: string;
            content: string;
            toolCallID?: string;
          }>;
        }
      ).messages.find(
        (message) =>
          message.role === "tool" && message.toolCallID === "call_propose",
      );
      if (proposal && !toolResult) {
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_propose",
              name: "plan_propose",
              arguments: JSON.stringify(proposal),
            },
          ],
        };
        yield { type: "done" as const };
        return;
      }
      if (toolResult) {
        for (const chunk of settle(String(toolResult.content ?? "")))
          yield chunk;
        return;
      }
      yield { type: "content" as const, text: "ok" };
      yield { type: "done" as const };
    },
  };
}

test("plan_propose drafts, gates on the user, and lands the accepted contract", async () => {
  const root = await officialPluginWorkspace("plan-contract-accept");
  const events: RuntimeEvent[] = [];
  let planID = "";
  let settled = false;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plan_contract",
    permissionMode: "ask",
    provider: proposeProvider(
      () => ({
        planID,
        scope: ["packages/framework/runtime/src"],
        verification: ["bun test packages/framework/runtime"],
        constraints: ["no new runtime dependency"],
      }),
      (result) => {
        settled = true;
        expect(result).toContain('"accepted":true');
        return [{ type: "content" as const, text: "contract accepted" }];
      },
    ),
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request" && event.scope === "work_contract")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.sessionAttach!("ses_plan_contract" as SessionID);
  await client.planDocWrite!({
    path: "plans/contract-plan.md",
    content: "# Contract plan\n\n- concrete steps\n",
    title: "Contract plan",
  });
  const marked = await client.planDocMark!({
    path: "plans/contract-plan.md",
    title: "Contract plan",
  });
  planID = marked.planID;
  await client.planDocActivate!(marked.planID);

  await client.submitAndWait!("propose the contract for the plan");
  expect(settled).toBe(true);
  const drafted = events.filter(
    (event) => event.type === "work_contract.drafted",
  );
  const accepted = events.filter(
    (event) => event.type === "work_contract.accepted",
  );
  expect(drafted).toHaveLength(1);
  expect(accepted).toHaveLength(1);
  expect(drafted[0]).toMatchObject({
    type: "work_contract.drafted",
    planID,
    scope: ["packages/framework/runtime/src"],
    source: "model",
  });
  expect(accepted[0]).toMatchObject({
    type: "work_contract.accepted",
    planID,
    acceptedBy: "user",
    constraints: ["no new runtime dependency"],
  });
  // The projection reports the contract as current.
  expect(projectedWorkContracts(events)).toEqual([
    {
      planID,
      version: 1,
      scope: ["packages/framework/runtime/src"],
      verification: ["bun test packages/framework/runtime"],
      constraints: ["no new runtime dependency"],
      status: "current",
      acceptedBy: "user",
      acceptedAt: expect.any(String) as unknown as string,
    },
  ]);
  await client.dispose?.();
}, 30_000);

test("plan_propose rejects placeholder fields and re-proposes after feedback", async () => {
  const root = await officialPluginWorkspace("plan-contract-placeholder");
  const events: RuntimeEvent[] = [];
  let planID = "";
  let proposed = 0;
  let settled = false;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plan_contract_ph",
    permissionMode: "ask",
    provider: {
      provider: "plan-propose-retry",
      model: "plan-propose-retry-model",
      async *stream(request: ProviderStreamRequest) {
        const proposeResult = (
          request as {
            messages: Array<{
              role: string;
              content: string;
              toolCallID?: string;
            }>;
          }
        ).messages
          .filter(
            (message) =>
              message.role === "tool" &&
              String(message.toolCallID ?? "").startsWith("call_propose"),
          )
          .at(-1);
        if (!proposeResult) {
          proposed += 1;
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_propose",
                name: "plan_propose",
                arguments: JSON.stringify(
                  proposed === 1
                    ? { planID, scope: ["all"] }
                    : { planID, scope: ["packages/framework/runtime/src"] },
                ),
              },
            ],
          };
          yield { type: "done" as const };
          return;
        }
        const result = String(proposeResult.content ?? "");
        if (proposed === 1) {
          // The placeholder draft was refused before the journal and before
          // the gate; the model re-proposes with concrete fields.
          expect(result).toContain('"accepted":false');
          expect(result).toContain("placeholder");
          proposed = 2;
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_propose",
                name: "plan_propose",
                arguments: JSON.stringify({
                  planID,
                  scope: ["packages/framework/runtime/src"],
                }),
              },
            ],
          };
          yield { type: "done" as const };
          return;
        }
        settled = true;
        expect(result).toContain('"accepted":true');
        yield { type: "content" as const, text: "second attempt accepted" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request" && event.scope === "work_contract")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.sessionAttach!("ses_plan_contract_ph" as SessionID);
  await client.planDocWrite!({
    path: "plans/ph-plan.md",
    content: "# Placeholder plan\n",
    title: "Placeholder plan",
  });
  const marked = await client.planDocMark!({
    path: "plans/ph-plan.md",
    title: "Placeholder plan",
  });
  planID = marked.planID;
  await client.planDocActivate!(marked.planID);

  await client.submitAndWait!("propose the contract");
  expect(settled).toBe(true);
  // The placeholder draft never reached the journal; the re-proposal landed
  // and was accepted.
  expect(
    events.filter((event) => event.type === "work_contract.drafted"),
  ).toHaveLength(1);
  expect(
    events.filter((event) => event.type === "work_contract.accepted"),
  ).toHaveLength(1);
  await client.dispose?.();
}, 30_000);

test("plan_propose returns the rejection feedback without landing a contract", async () => {
  const root = await officialPluginWorkspace("plan-contract-reject");
  const events: RuntimeEvent[] = [];
  let planID = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plan_contract_reject",
    permissionMode: "ask",
    provider: proposeProvider(
      () => ({
        planID,
        scope: ["packages/framework/runtime/src"],
      }),
      (result) => {
        expect(result).toContain('"accepted":false');
        expect(result).toContain("rejected");
        return [{ type: "content" as const, text: "re-propose later" }];
      },
    ),
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request" && event.scope === "work_contract")
      client.respondApproval({
        requestID: event.id,
        decision: "reject",
        feedback: "add the constraints",
      });
  });
  await client.sessionAttach!("ses_plan_contract_reject" as SessionID);
  await client.planDocWrite!({
    path: "plans/reject-plan.md",
    content: "# Reject plan\n",
    title: "Reject plan",
  });
  const marked = await client.planDocMark!({
    path: "plans/reject-plan.md",
    title: "Reject plan",
  });
  planID = marked.planID;
  await client.planDocActivate!(marked.planID);

  await client.submitAndWait!("propose the contract");
  // The draft stays for re-proposal; nothing is accepted.
  expect(
    events.filter((event) => event.type === "work_contract.drafted"),
  ).toHaveLength(1);
  expect(
    events.filter((event) => event.type === "work_contract.accepted"),
  ).toHaveLength(0);
  await client.dispose?.();
}, 30_000);

test("A1 E2E: a plan edit marks the draft stale in work_contract_read (re-propose required)", async () => {
  const root = await officialPluginWorkspace("plan-contract-stale");
  const events: RuntimeEvent[] = [];
  const readResults: string[] = [];
  let planID = "";
  let toolCalls = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plan_contract_stale",
    permissionMode: "ask",
    provider: {
      provider: "plan-contract-stale",
      model: "plan-contract-stale-model",
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
        // After a tool call (the last message is its result), capture the read
        // result and end the turn (one tool call per turn keeps the plan edit
        // between reads deterministic).
        const lastMessage = messages.at(-1);
        if (lastMessage?.role === "tool") {
          const readResult = messages
            .filter(
              (message) =>
                message.role === "tool" &&
                String(message.toolCallID ?? "").startsWith("call_read"),
            )
            .at(-1);
          if (readResult) readResults.push(String(readResult.content ?? ""));
          yield { type: "content" as const, text: "done" };
          yield { type: "done" as const };
          return;
        }
        // First tool call proposes (the gate is rejected, so a draft stays);
        // later tool calls read the contract.
        toolCalls += 1;
        if (toolCalls === 1)
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_propose",
                name: "plan_propose",
                arguments: JSON.stringify({ planID, scope: ["packages/a"] }),
              },
            ],
          };
        else
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_read",
                name: "work_contract_read",
                arguments: JSON.stringify({ planID }),
              },
            ],
          };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request" && event.scope === "work_contract")
      client.respondApproval({
        requestID: event.id,
        decision: "reject",
        feedback: "not yet",
      });
  });
  await client.sessionAttach!("ses_plan_contract_stale" as SessionID);
  await client.planDocWrite!({
    path: "plans/stale-plan.md",
    content: "# Stale plan\n",
    title: "Stale plan",
  });
  const marked = await client.planDocMark!({
    path: "plans/stale-plan.md",
    title: "Stale plan",
  });
  planID = marked.planID;
  await client.planDocActivate!(marked.planID);

  // 1. Propose (rejected) -> a draft bound to plan revision 1.
  await client.submitAndWait!("propose the contract");
  // 2. Read: the draft is current for its revision (not stale).
  await client.submitAndWait!("read the contract");
  expect(readResults).toHaveLength(1);
  const before = JSON.parse(readResults[0]!);
  expect(before).toMatchObject({ planID, status: "draft", version: 1 });
  expect(before.stale).toBeUndefined();

  // 3. Edit the plan document -> revision bumps, plan.doc.updated published.
  await client.planDocWrite!({
    path: "plans/stale-plan.md",
    content: "# Stale plan\n\n- a new step\n",
    title: "Stale plan",
  });

  // 4. Read again: the draft extracted from revision 1 is now stale.
  await client.submitAndWait!("read the contract again");
  expect(readResults).toHaveLength(2);
  const after = JSON.parse(readResults[1]!);
  expect(after).toMatchObject({
    planID,
    status: "draft",
    version: 1,
    stale: true,
  });
  await client.dispose?.();
}, 30_000);

test("work_contract_read reports none for a known plan and an error for an unknown planID", async () => {
  const root = await officialPluginWorkspace("plan-contract-read");
  const results: string[] = [];
  let planID = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plan_contract_read",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request: ProviderStreamRequest) {
        const toolResults = (
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
            String(message.toolCallID ?? "").startsWith("call_read"),
        );
        if (toolResults.length === 0) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_read",
                name: "work_contract_read",
                arguments: JSON.stringify({ planID }),
              },
            ],
          };
          yield { type: "done" as const };
          return;
        }
        results.push(String(toolResults.at(-1)?.content ?? ""));
        if (toolResults.length === 1) {
          // An unknown planID is an error, distinct from a real "none".
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_read",
                name: "work_contract_read",
                arguments: JSON.stringify({ planID: "plan:missing" }),
              },
            ],
          };
          yield { type: "done" as const };
          return;
        }
        yield { type: "content" as const, text: "read done" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.sessionAttach!("ses_plan_contract_read" as SessionID);
  await client.planDocWrite!({
    path: "plans/read-none.md",
    content: "# Read none\n",
    title: "Read none",
  });
  const marked = await client.planDocMark!({
    path: "plans/read-none.md",
    title: "Read none",
  });
  planID = marked.planID;
  await client.submitAndWait!("check the contract");
  // A known plan with no proposal is a legitimate "none".
  expect(results[0]).toContain('"status":"none"');
  // An unknown planID is an error string, not "none" (EI §3.9).
  expect(results[1]).toContain("unknown planID");
  await client.dispose?.();
}, 30_000);

test("the handoff refuses without an accepted contract (Navi mailbox_send path)", async () => {
  const root = await officialPluginWorkspace("plan-contract-handoff");
  const events: RuntimeEvent[] = [];
  let streamCalls = 0;
  let planID = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plan_contract_handoff",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        streamCalls += 1;
        if (streamCalls === 1) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_handoff",
                name: "mailbox_send",
                arguments: JSON.stringify({
                  intent: "next_plan_handoff",
                  text: "plan ready",
                  relatedPlanID: planID,
                }),
              },
            ],
          };
          return;
        }
        yield { type: "content" as const, text: "cannot hand off" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!("ses_plan_contract_handoff" as SessionID);
  await client.planDocWrite!({
    path: "plans/handoff-plan.md",
    content: "# Handoff plan\n",
    title: "Handoff plan",
  });
  const marked = await client.planDocMark!({
    path: "plans/handoff-plan.md",
    title: "Handoff plan",
  });
  planID = marked.planID;
  await client.planDocActivate!(marked.planID);

  // Navi tries to hand off the plan without any accepted contract.
  await client.naviChat!.submit({ text: "hand off the plan" });
  const toolUses = events.filter(
    (event) =>
      event.type === "navi.chat.tool.used" && event.toolName === "mailbox_send",
  );
  expect(toolUses).toHaveLength(1);
  const handoffResult = String(
    (toolUses[0] as { result?: string }).result ?? "",
  );
  expect(handoffResult).toContain("no accepted work contract");
  expect(handoffResult).toContain("plan_propose");
  // Nothing was queued.
  expect(
    events.filter(
      (event) =>
        event.type === "mailbox.queued" && event.intent === "next_plan_handoff",
    ),
  ).toHaveLength(0);
  await client.dispose?.();
}, 30_000);

test("plan_doc_mark records createdBy by source", async () => {
  const root = await officialPluginWorkspace("plan-contract-createdby");
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plan_contract_createdby",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "content" as const, text: "ok" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.sessionAttach!("ses_plan_contract_createdby" as SessionID);
  await client.planDocWrite!({
    path: "plans/createdby.md",
    content: "# CreatedBy plan\n",
    title: "CreatedBy plan",
  });
  const marked = await client.planDocMark!({
    path: "plans/createdby.md",
    title: "CreatedBy plan",
    createdBy: "main_agent",
  });
  const list = await client.planDocList!();
  const record = list.find((plan) => plan.planID === marked.planID);
  expect(record?.createdBy).toBe("main_agent");
  await client.dispose?.();
}, 30_000);

test("work_graph_query resolves a plan path and paginates the graph", async () => {
  const root = await officialPluginWorkspace("plan-contract-graph");
  const results: string[] = [];
  let streamCalls = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plan_contract_graph",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request: ProviderStreamRequest) {
        streamCalls += 1;
        const graphToolResult = (
          request as {
            messages: Array<{
              role: string;
              content: string;
              toolCallID?: string;
            }>;
          }
        ).messages
          .filter(
            (message) =>
              message.role === "tool" &&
              String(message.toolCallID ?? "").startsWith("call_graph"),
          )
          .at(-1);
        if (graphToolResult) {
          results.push(String(graphToolResult.content ?? ""));
          if (streamCalls <= 2) {
            // Query by plan document path — resolves to the planID.
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "call_graph",
                  name: "work_graph_query",
                  arguments: JSON.stringify({
                    path: "plans/graph-plan.md",
                    limit: 1,
                  }),
                },
              ],
            };
            yield { type: "done" as const };
            return;
          }
          yield { type: "content" as const, text: "graph queried" };
          yield { type: "done" as const };
          return;
        }
        // First: query the whole graph (no filter) to establish the cursor.
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_graph",
              name: "work_graph_query",
              arguments: JSON.stringify({ limit: 1 }),
            },
          ],
        };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.sessionAttach!("ses_plan_contract_graph" as SessionID);
  await client.planDocWrite!({
    path: "plans/graph-plan.md",
    content: "# Graph plan\n",
    title: "Graph plan",
  });
  await client.planDocMark!({
    path: "plans/graph-plan.md",
    title: "Graph plan",
  });
  await client.submitAndWait!("query the graph");
  expect(results.length).toBeGreaterThanOrEqual(2);
  const first = JSON.parse(results[0]!) as {
    total: number;
    nodes: Array<{ kind: string }>;
    nextCursor?: string;
  };
  const second = JSON.parse(results[1]!) as {
    planID: string;
    total: number;
    nodes: Array<{ kind: string }>;
  };
  // The unfiltered query is well-formed and paginates.
  expect(Array.isArray(first.nodes)).toBe(true);
  // The path query resolves to the marked plan's planID. No node references
  // the planID yet (B7 adds plan-linked node provenance), so the filter
  // honestly returns zero matches with the planID echoed.
  expect(second.planID.startsWith("plan_graph-plan")).toBe(true);
  expect(second.total).toBe(0);
  await client.dispose?.();
}, 30_000);

test("record_validation runs a command and writes evidence", async () => {
  const root = await officialPluginWorkspace("plan-contract-validation");
  // EI E2: the recorded evidence stamps the workspace repository refs. A seed
  // commit gives this temp workspace a HEAD; without git the refs stay absent.
  const git = (args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  await writeFile(join(root, "refs-seed.txt"), "seed");
  git(["add", "refs-seed.txt"]);
  const committed = git(["commit", "-q", "-m", "seed"]).success;
  const gitHead = committed
    ? git(["rev-parse", "HEAD"]).stdout.toString().trim()
    : undefined;
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plan_contract_validation",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request: ProviderStreamRequest) {
        const toolResult = (
          request as {
            messages: Array<{
              role: string;
              content: string;
              toolCallID?: string;
            }>;
          }
        ).messages.find(
          (message) =>
            message.role === "tool" && message.toolCallID === "call_validate",
        );
        if (toolResult) {
          yield { type: "content" as const, text: "validated" };
          yield { type: "done" as const };
          return;
        }
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_validate",
              name: "record_validation",
              arguments: JSON.stringify({
                taskID: "plan:1:s1",
                objective: "the runtime package typechecks",
                command: "true",
              }),
            },
          ],
        };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!("ses_plan_contract_validation" as SessionID);
  await client.submitAndWait!("validate");
  const evidence = events.filter((event) => event.type === "evidence.recorded");
  expect(evidence).toHaveLength(1);
  expect(evidence[0]).toMatchObject({
    type: "evidence.recorded",
    taskID: "plan:1:s1",
    objective: "the runtime package typechecks",
    status: "validated",
  });
  if (gitHead !== undefined) {
    expect(evidence[0]).toMatchObject({ commit: gitHead });
  }
  await client.dispose?.();
}, 30_000);

test("record_completion and record_decision write durable journal facts", async () => {
  const root = await officialPluginWorkspace("plan-contract-records");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plan_contract_records",
    permissionMode: "auto",
    // The completion trigger wakes Nia in parallel; per-agent cursors keep
    // that wake from consuming the Main Agent's next scripted step.
    provider: createScriptedProvider({
      main: [
        {
          tool: {
            name: "record_completion",
            arguments: {
              taskID: "plan:1:s1",
              objective: "split the system prompt",
              changeSummary: "static persona and dynamic runtime context",
            },
          },
        },
        {
          tool: {
            name: "record_decision",
            arguments: {
              decision: "runtime context is appended, not injected",
              rationale: ["keeps the cacheable prefix stable"],
            },
          },
        },
        { text: "recorded" },
      ],
      nia: [{ text: "audit wake observed" }],
      navi: [{ text: "standby" }],
    }),
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!("ses_plan_contract_records" as SessionID);
  await client.submitAndWait!("record it");
  expect(
    events.filter((event) => event.type === "completion.recorded"),
  ).toHaveLength(1);
  expect(
    events.filter((event) => event.type === "decision.recorded"),
  ).toHaveLength(1);
  const completion = events.find(
    (event) => event.type === "completion.recorded",
  );
  expect(completion).toMatchObject({
    type: "completion.recorded",
    taskID: "plan:1:s1",
    changeSummary: "static persona and dynamic runtime context",
  });
  await client.dispose?.();
}, 30_000);

test("audit_report writes an evidence record for every round (EI §8.1)", async () => {
  const root = await officialPluginWorkspace("plan-contract-audit-evidence");
  const events: RuntimeEvent[] = [];
  let planID = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plan_contract_audit",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        const toolResult =
          // The Nia turn's messages carry the audit_report tool result.
          (
            arguments[0] as {
              messages: Array<{
                role: string;
                content: string;
                toolCallID?: string;
              }>;
            }
          ).messages.find(
            (message) =>
              message.role === "tool" && message.toolCallID === "call_audit",
          );
        if (toolResult) {
          yield { type: "content" as const, text: "audit reported" };
          yield { type: "done" as const };
          return;
        }
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_audit",
              name: "audit_report",
              arguments: JSON.stringify({ planID, verdict: "passed" }),
            },
          ],
        };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!("ses_plan_contract_audit" as SessionID);
  await client.planDocWrite!({
    path: "plans/audit-plan.md",
    content: "# Audit plan\n",
    title: "Audit plan",
  });
  const marked = await client.planDocMark!({
    path: "plans/audit-plan.md",
    title: "Audit plan",
  });
  planID = marked.planID;
  await client.planDocActivate!(marked.planID);
  await client.niaChat!.submit({ text: "audit the plan" });
  const evidence = events.filter((event) => event.type === "evidence.recorded");
  expect(evidence).toHaveLength(1);
  expect(evidence[0]).toMatchObject({
    type: "evidence.recorded",
    taskID: planID,
    status: "validated",
  });
  const auditEvidence = evidence[0] as {
    objective: string;
    validations: Array<{ command: string; result: string }>;
  };
  expect(auditEvidence.objective).toContain("Nia audit round 1");
  expect(auditEvidence.validations[0]).toMatchObject({ result: "passed" });
  await client.dispose?.();
}, 30_000);

test("a config reload emits a context.instructions notice with a monotonic revision", async () => {
  const root = await officialPluginWorkspace("plan-contract-reload");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plan_contract_reload",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "content" as const, text: "ok" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!("ses_plan_contract_reload" as SessionID);
  await client.reloadConfig!();
  const notices = events.filter(
    (event) => event.type === "context.instructions",
  );
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({
    type: "context.instructions",
    kind: "config_reload",
    revision: 1,
  });
  // A second reload raises the revision; history is never mutated.
  await client.reloadConfig!();
  const second = events.filter(
    (event) => event.type === "context.instructions",
  );
  expect(second).toHaveLength(2);
  expect(second[1]).toMatchObject({ revision: 2 });
  // The projection reports the latest revision per kind.
  expect(
    projectedRuntimeNotices(second).map((notice) => ({
      kind: notice.kind,
      revision: notice.revision,
    })),
  ).toEqual([{ kind: "config_reload", revision: 2 }]);
  // The notices contract answers with the same projected view.
  const contractNotices = await client.notices!();
  expect(contractNotices).toEqual([
    {
      noticeID: second[1]!.id,
      kind: "config_reload",
      revision: 2,
      at: second[1]!.at,
      summary: second[1]!.summary,
    },
  ]);
  await client.dispose?.();
}, 30_000);

test("the project documents inject as a user-tier runtime context block (ADR D2 / EI §8.5)", async () => {
  const root = await officialPluginWorkspace("plan-contract-project-docs");
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plan_contract_docs",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request: ProviderStreamRequest) {
        requests.push(request);
        yield { type: "content" as const, text: "ok" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.sessionAttach!("ses_plan_contract_docs" as SessionID);
  await writeFile(
    join(root, "AGENTS.md"),
    "# Agents\n\n- run bun test before finishing\n",
  );
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "constitution.md"),
    "# Constitution\n\n- never commit secrets\n",
  );
  await client.submitAndWait!("follow the project instructions");
  const seen = (requests[0]?.messages ?? [])
    .map((message) => message.content)
    .join("\n");
  // The project documents arrive as a user-tier runtime context block, never
  // in the static system prompt.
  expect(seen).toContain('<runtime_context source="project" authority="user"');
  expect(seen).toContain("run bun test before finishing");
  expect(seen).toContain("never commit secrets");
  const system = requests[0]?.messages.find(
    (message) => message.role === "system",
  );
  // The document正文 never enters the static system prompt (the authority
  // model only names AGENTS.md as a tier, it does not carry its content).
  expect(system?.content).not.toContain("run bun test before finishing");
  expect(system?.content).not.toContain("never commit secrets");
  await client.dispose?.();
}, 30_000);

test("a project document edit changes the block hash and re-injects (EI §8.5)", async () => {
  const root = await officialPluginWorkspace("plan-contract-doc-change");
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plan_contract_doc_change",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request: ProviderStreamRequest) {
        requests.push(request);
        yield { type: "content" as const, text: "ok" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.sessionAttach!("ses_plan_contract_doc_change" as SessionID);
  await writeFile(join(root, "AGENTS.md"), "- original rule\n");
  await client.submitAndWait!("first");
  const firstHash = /hash="([^"]+)"/u.exec(
    (requests[0]?.messages ?? []).map((message) => message.content).join("\n"),
  )?.[1];
  expect(firstHash).toBeTruthy();
  expect(
    (requests[0]?.messages ?? []).map((m) => m.content).join("\n"),
  ).toContain("original rule");
  // The document edit is detected by hash; the new block carries the new
  // content and a new hash — appended, never mutating the earlier message.
  await writeFile(join(root, "AGENTS.md"), "- updated rule\n");
  await client.submitAndWait!("second");
  const secondSeen = (requests[1]?.messages ?? [])
    .map((message) => message.content)
    .join("\n");
  expect(secondSeen).toContain("updated rule");
  const secondHash = /hash="([^"]+)"/u.exec(secondSeen)?.[1];
  expect(secondHash).not.toBe(firstHash);
  await client.dispose?.();
}, 30_000);

test("constitution_propose_rule validates and gates on the user (EI §3.8 P-1.c)", async () => {
  const root = await officialPluginWorkspace("plan-contract-rule-propose");
  const events: RuntimeEvent[] = [];
  let streamCalls = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plan_contract_rule",
    permissionMode: "ask",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request: ProviderStreamRequest) {
        streamCalls += 1;
        const toolResult = (
          request as {
            messages: Array<{
              role: string;
              content: string;
              toolCallID?: string;
            }>;
          }
        ).messages
          .filter(
            (message) =>
              message.role === "tool" &&
              String(message.toolCallID ?? "").startsWith("call_rule"),
          )
          .at(-1);
        if (toolResult) {
          if (streamCalls === 2) {
            // The first (unanchored deny) proposal was refused before the
            // gate; re-propose with a structured anchor.
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "call_rule",
                  name: "constitution_propose_rule",
                  arguments: JSON.stringify({
                    statement: "never force push",
                    enforcement: "deny",
                    appliesTo: {
                      tools: ["run_shell"],
                      commandPattern: "git push.*--force",
                    },
                    scope: "project",
                  }),
                },
              ],
            };
            yield { type: "done" as const };
            return;
          }
          yield { type: "content" as const, text: "rule proposed" };
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
                statement: "never force push",
                enforcement: "deny",
              }),
            },
          ],
        };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => {
    events.push(event);
    if (
      event.type === "approval.request" &&
      event.scope === "constitution_rule"
    )
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.sessionAttach!("ses_plan_contract_rule" as SessionID);
  await client.submitAndWait!("propose a rule");
  const added = events.filter(
    (event) =>
      event.type === "constitution.rule_added" &&
      (event as { source?: string }).source === "agent_proposed",
  );
  // Only the approved proposal lands; the seeded rules are not agent-proposed.
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({
    type: "constitution.rule_added",
    source: "agent_proposed",
    enforcement: "deny",
    scope: "project",
  });
  expect(
    (added[0] as { appliesTo?: { commandPattern?: string } }).appliesTo
      ?.commandPattern,
  ).toBe("git push.*--force");
  await client.dispose?.();
}, 30_000);

test("the read surfaces paginate with a cursor (B6)", async () => {
  const root = await officialPluginWorkspace("plan-contract-pagination");
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plan_contract_pagination",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request: ProviderStreamRequest) {
        const toolResult = (
          request as {
            messages: Array<{
              role: string;
              content: string;
              toolCallID?: string;
            }>;
          }
        ).messages.find(
          (message) =>
            message.role === "tool" && message.toolCallID === "call_record",
        );
        if (toolResult) {
          yield { type: "content" as const, text: "recorded" };
          yield { type: "done" as const };
          return;
        }
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_record",
              name: "record_completion",
              arguments: JSON.stringify({
                taskID: "plan:1:s1",
                objective: "first slice",
                changeSummary: "done",
              }),
            },
          ],
        };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.sessionAttach!("ses_plan_contract_pagination" as SessionID);
  await client.submitAndWait!("record a completion");
  // A single record: the first page carries it, an offset past it is empty.
  const page = await client.completions?.({ limit: 1 });
  expect(page).toMatchObject({ returned: 1, total: 1, truncated: false });
  expect(page?.items).toHaveLength(1);
  const empty = await client.completions?.({ limit: 1, cursor: "5" });
  expect(empty).toMatchObject({ returned: 0, total: 1, truncated: false });
  expect(empty?.items).toEqual([]);
  // The unfiltered read returns the whole set as one untruncated page.
  const all = await client.completions?.();
  expect(all).toMatchObject({ returned: 1, total: 1, truncated: false });
  expect(all?.items).toHaveLength(1);
  await client.dispose?.();
}, 30_000);
