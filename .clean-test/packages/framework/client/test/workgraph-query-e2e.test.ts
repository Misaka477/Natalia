import { expect, test } from "bun:test";
import type { SessionID } from "@anthelia/contracts";
import type { ProviderStreamRequest } from "@anthelia/runtime";
import { createRealRuntimeClient } from "../src";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();

const SESSION = "ses_e2e_workgraph_query" as SessionID;

type GraphResult = {
  total: number;
  truncated: boolean;
  nodes: Array<{ kind: string }>;
  nextCursor?: string;
};

test("Phase 3 E2E: work_graph_query filters by nodeKind and reports truncation", async () => {
  const root = await officialPluginWorkspace("workgraph-query-e2e");
  const results: string[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
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
        ).messages
          .filter(
            (message) =>
              message.role === "tool" &&
              String(message.toolCallID ?? "").startsWith("call_graph"),
          )
          .at(-1);
        if (toolResult) {
          results.push(String(toolResult.content ?? ""));
          if (results.length === 1) {
            // nodeKind filter — only decision nodes.
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "call_graph",
                  name: "work_graph_query",
                  arguments: JSON.stringify({
                    nodeKind: "decision",
                    limit: 50,
                  }),
                },
              ],
            };
            yield { type: "done" as const };
            return;
          }
          if (results.length === 2) {
            // Two precise queries at once — a usage error.
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "call_graph",
                  name: "work_graph_query",
                  arguments: JSON.stringify({
                    path: "plans/x.md",
                    findingID: "DF-1",
                  }),
                },
              ],
            };
            yield { type: "done" as const };
            return;
          }
          if (results.length === 3) {
            // Invalid cursor — a usage error.
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "call_graph",
                  name: "work_graph_query",
                  arguments: JSON.stringify({ cursor: "not-a-number" }),
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
        // First: a limit-1 query over the whole graph -> truncated + nextCursor.
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
  await client.sessionAttach!(SESSION);
  // A decision node in the graph.
  await client.recordDecision!({ decision: "append runtime context" }, SESSION);
  await client.submitAndWait!("query the graph");

  expect(results.length).toBeGreaterThanOrEqual(4);

  // 1. limit 1 over a multi-node graph -> truncated + nextCursor.
  const whole = JSON.parse(results[0]!) as GraphResult;
  expect(whole.total).toBeGreaterThan(1);
  expect(whole.nodes).toHaveLength(1);
  expect(whole.truncated).toBe(true);
  expect(whole.nextCursor).toBe("1");

  // 2. nodeKind filter -> only decision nodes.
  const decisions = JSON.parse(results[1]!) as GraphResult;
  expect(decisions.nodes.length).toBeGreaterThan(0);
  expect(decisions.nodes.every((node) => node.kind === "decision")).toBe(true);

  // 3. Two precise queries -> usage error string (not a JSON result).
  expect(results[2]).toContain("fill exactly one precise query");

  // 4. Invalid cursor -> usage error string.
  expect(results[3]).toContain("invalid cursor");

  await client.dispose?.();
}, 30_000);

test("Phase 3 E2E: work_graph_query returns an empty (not error) result for a non-matching query", async () => {
  const root = await officialPluginWorkspace("workgraph-query-empty");
  const results: string[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
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
        const graphResult = messages
          .filter(
            (message) =>
              message.role === "tool" &&
              String(message.toolCallID ?? "").startsWith("call_graph"),
          )
          .at(-1);
        if (graphResult) {
          results.push(String(graphResult.content ?? ""));
          if (results.length === 1) {
            // A findingID precise query with no matching chain.
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "call_graph",
                  name: "work_graph_query",
                  arguments: JSON.stringify({ findingID: "DF-nonexistent" }),
                },
              ],
            };
            yield { type: "done" as const };
            return;
          }
          yield { type: "content" as const, text: "queried" };
          yield { type: "done" as const };
          return;
        }
        // First: a nodeKind with no nodes in this session.
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_graph",
              name: "work_graph_query",
              arguments: JSON.stringify({ nodeKind: "goal" }),
            },
          ],
        };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.sessionAttach!(SESSION);
  await client.submitAndWait!("query the graph");

  expect(results.length).toBeGreaterThanOrEqual(2);
  // A non-matching nodeKind filter is a success with an empty result, not an
  // error string.
  const byKind = JSON.parse(results[0]!) as GraphResult;
  expect(byKind).toMatchObject({ total: 0, truncated: false, nodes: [] });
  // A findingID precise query with no matching chain is likewise empty success.
  const byFinding = JSON.parse(results[1]!) as GraphResult;
  expect(byFinding).toMatchObject({ total: 0, truncated: false, nodes: [] });
  await client.dispose?.();
}, 30_000);

test("Phase 3 E2E: an unfiltered work_graph_query defaults to the active plan's chain", async () => {
  const root = await officialPluginWorkspace("workgraph-query-active-plan");
  const sessionID = "ses_e2e_wgq_active" as SessionID;
  const results: string[] = [];
  let planID = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
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
        ).messages
          .filter(
            (message) =>
              message.role === "tool" &&
              String(message.toolCallID ?? "").startsWith("call_graph"),
          )
          .at(-1);
        if (toolResult) {
          results.push(String(toolResult.content ?? ""));
          if (results.length === 1) {
            // Then: the decision node by kind (proves it exists in the graph).
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "call_graph",
                  name: "work_graph_query",
                  arguments: JSON.stringify({ nodeKind: "decision" }),
                },
              ],
            };
            yield { type: "done" as const };
            return;
          }
          yield { type: "content" as const, text: "queried" };
          yield { type: "done" as const };
          return;
        }
        // First: no args -> should default to the ACTIVE plan's chain, not the
        // whole session graph.
        yield {
          type: "tool_call" as const,
          calls: [
            { id: "call_graph", name: "work_graph_query", arguments: "{}" },
          ],
        };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.sessionAttach!(sessionID);
  await client.planDocWrite!({
    path: "plans/wgq-active.md",
    content: "# Active plan\n\n- one step\n",
    title: "Active plan",
  });
  const marked = await client.planDocMark!({
    path: "plans/wgq-active.md",
    title: "Active plan",
  });
  planID = marked.planID;
  await client.planDocActivate!(planID);
  // A plain decision: its work-graph node carries no planID, so it is NOT part
  // of the active plan's chain.
  await client.recordDecision!(
    { decision: "an unrelated session-scoped choice" },
    sessionID,
  );
  await client.submitAndWait!("query the graph");

  const unfiltered = JSON.parse(results[0]!) as GraphResult;
  const byKind = JSON.parse(results[1]!) as GraphResult;
  // The decision node exists in the session graph...
  expect(byKind.nodes.some((node) => node.kind === "decision")).toBe(true);
  // ...but the unfiltered query defaults to the active plan and excludes it.
  expect(unfiltered.nodes.some((node) => node.kind === "decision")).toBe(false);
  await client.dispose?.();
}, 30_000);
