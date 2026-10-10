import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { providerError } from "@anthelia/runtime";
import { createRealRuntimeClient, waitForAsync } from "./real-runtime-harness";
import { withRunnerTools } from "../src/runtime/initialize/subagent-runner";
import { subagentAssistantEntries } from "../src/runtime/initialize/subagent-support";
import {
  contextEntriesToProviderMessages,
  uniqueProviderToolCallIds,
} from "@anthelia/runtime";
import { ContextLedger } from "@anthelia/runtime";
import { useWorkspaceCleanup } from "./plugin-test-helpers";

useWorkspaceCleanup();

/**
 * T3-B7: a subagent's conversation is durable, and a continuation continues
 * it.
 *
 * The child's ledger used to be rebuilt from nothing on every run — system +
 * task, no history — so `agent_retry` opened a brand-new conversation and
 * `agent_resume` was dead code waiting for a `paused` status nothing ever
 * set. The durable checkpoint is written when a run ends (the one point every
 * run passes through) and restored when the next one starts, which is what
 * makes "continue the work" mean continue.
 */
test("a retried subagent continues its own conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-subagent-resume-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(join(root, "notes.txt"), "the widget factory has no guard\n");
  const events: RuntimeEvent[] = [];
  // Every provider request the CHILD makes, in order. The child's own system
  // prompt is the marker: the settlement notice the parent later receives
  // quotes the task text, which would fold the parent's requests in.
  const childRequests: string[] = [];
  let mainSteps = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        const isChild = request.messages.some((message) =>
          String(message.content).includes(
            "You are a focused Natalia TS/Bun subagent",
          ),
        );
        if (isChild) {
          childRequests.push(
            request.messages
              .map((message) => String(message.content))
              .join("\n"),
          );
          // Step 1 does real work — a tool call, whose result the loop appends
          // to the child's ledger. Step 2 (the request that already carries a
          // tool result) fails with a NON-retryable provider error: a plain
          // Error maps to `connection` and the retry service swallows it, so
          // the run would never reach the `failed` state a retry needs.
          if (request.messages.some((message) => message.role === "tool"))
            throw providerError({
              kind: "invalid_request",
              message: "the child's provider refused the follow-up step",
            });
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "child_read",
                name: "read_file",
                arguments: JSON.stringify({ path: "notes.txt" }),
              },
            ],
          };
          yield { type: "done" as const };
          return;
        }
        mainSteps += 1;
        if (mainSteps === 1) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "spawn",
                name: "agent_spawn",
                arguments: JSON.stringify({
                  task: "delegated task",
                  description: "Investigate the widget factory",
                }),
              },
            ],
          };
          yield { type: "done" as const };
          return;
        }
        if (mainSteps === 2) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "wait",
                name: "agent_wait",
                arguments: JSON.stringify({
                  ids: ["a1"],
                  until: "all_terminal",
                  timeoutMs: 15_000,
                }),
              },
            ],
          };
          yield { type: "done" as const };
          return;
        }
        if (mainSteps === 3) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "retry",
                name: "agent_retry",
                arguments: JSON.stringify({ id: "a1" }),
              },
            ],
          };
          yield { type: "done" as const };
          return;
        }
        yield { type: "content" as const, text: "parent complete" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event), { replay: "none" });
  try {
    await waitForAsync(async () =>
      events.some((event) => event.type === "session.ready"),
    );
    await client.submitAndWait!("delegate, wait, retry");
    // The first run fails at its second step …
    await waitForAsync(
      async () =>
        events.filter(
          (event) =>
            event.type === "subagent.update" && event.status === "failed",
        ).length >= 2,
      30_000,
    );
    expect(childRequests.length).toBeGreaterThanOrEqual(3);
    // The first run starts from its task …
    expect(childRequests[0]).toContain("delegated task");
    expect(childRequests[0]).not.toContain("unavailable or denied tool");
    // … its second step sees the tool result the first step produced …
    expect(childRequests[1]).toContain("unavailable or denied tool: read_file");
    // … and the RETRIED run's first request carries that same work: the
    // continuation resumed the durable ledger instead of starting from
    // system + task again.
    const continuation = childRequests[2]!;
    expect(continuation).toContain("unavailable or denied tool: read_file");
    expect(continuation).toContain("delegated task");
    expect(continuation.length).toBeGreaterThan(childRequests[0]!.length);
  } finally {
    await client.dispose?.();
  }
});

test("a sandboxed child's tool list carries one entry per name", () => {
  // F-A: every sandboxed child died on its first step with
  // "ProviderError: Tool names must be unique". The runner pushed its own
  // `sandbox_diff` (the self-scoped one) beside the host's `sandbox_diff`
  // instead of replacing it, so the provider refused the whole list.
  // `team_fanout` spawns sandboxed children — the whole team path was down —
  // while `agent_spawn` (a path that pushes nothing) worked.
  const source = readFileSync(
    join(
      import.meta.dir,
      "..",
      "src",
      "runtime",
      "initialize",
      "subagent-runner.ts",
    ),
    "utf8",
  );
  // The runner's own tools go through the displacement helper.
  expect(source).toContain("withRunnerTools(visibleTools, [");
  // And no bare push of a same-named tool survives next to it.
  expect(source).not.toContain("visibleTools.push(sandboxSelfDiffTool())");
  // The helper drops the host's same-named entries before appending.
  expect(source).toMatch(
    /visible\.filter\(\(tool\) => !names\.has\(tool\.name\)\)/u,
  );
});

test("the runner's own tools displace the host's, so no name repeats", () => {
  // F-A, measured: the sandboxed child's provider step failed with
  // `invalid_request (400): Tool names must be unique` and retried to
  // exhaustion — the whole run dead on its first step. `team_fanout` spawns
  // sandboxed children, so the team path was down while `agent_spawn` (which
  // pushes nothing) worked.
  const host = [
    { name: "read_file" },
    { name: "sandbox_diff" },
    { name: "write_file" },
  ];
  // The child's own diff tool carries the SAME name as the host's: a provider
  // handed both refuses the entire list.
  const self = [{ name: "sandbox_diff" }];
  const merged = withRunnerTools(host, self);
  const names = merged.map((tool) => tool.name);
  expect(names).toEqual(["read_file", "write_file", "sandbox_diff"]);
  expect(new Set(names).size).toBe(names.length);
  // The host's entry is the one displaced, and the runner's survives.
  expect(merged.at(-1)).toBe(self[0]);

  // More than one pushed tool, including a second collision.
  const both = withRunnerTools(host, [
    { name: "sandbox_diff" },
    { name: "send_to_parent" },
  ]);
  const bothNames = both.map((tool) => tool.name);
  expect(new Set(bothNames).size).toBe(bothNames.length);
  expect(bothNames).toContain("send_to_parent");
  expect(bothNames.filter((name) => name === "sandbox_diff")).toHaveLength(1);

  // Nothing pushed: the list is untouched, not copied pointlessly.
  expect(withRunnerTools(host, [])).toBe(host);
});

test("a subagent's ledger entries carry its thinking, so the replay fold rebuilds it", () => {
  // The reported shape: the subagent's assembly was incomplete against
  // Natalia's main chain. The shared replay fold
  // (`contextEntriesToProviderMessages`) rebuilds a provider message's
  // reasoning FROM the ledger entries; the main runner writes those fields
  // and the subagent wrote none — so from a subagent's second step onward
  // the provider was handed an assistant message with no thinking blocks,
  // and a resumed child replayed a history with the same hole.
  const runner = { agentId: "child" } as never;
  const entries = subagentAssistantEntries(
    runner,
    1,
    "working on it",
    [
      {
        id: "call_a",
        name: "read_file",
        arguments: "a.ts",
        thoughtSignature: "sig-a",
      },
      { id: "call_b", name: "write_file", arguments: "b.ts" },
    ],
    { content: "the child's thinking for this step" },
  );

  // The assistant turn is recorded, and the thinking rides the FIRST call of
  // the batch — the main path's placement, which the fold reads back.
  expect(entries[0]).toMatchObject({
    role: "assistant",
    content: "working on it",
  });
  expect(entries[1]).toMatchObject({
    role: "tool_call",
    pairID: "call_a",
    reasoningContent: "the child's thinking for this step",
    thoughtSignature: "sig-a",
  });
  // A per-call signature rides its own call, and the step's thinking is not
  // duplicated onto the second one.
  expect(entries[2]).toMatchObject({ pairID: "call_b" });
  expect(entries[2]).not.toHaveProperty("reasoningContent");
  expect(entries[2]).not.toHaveProperty("thoughtSignature");

  // And the round trip through the real fold rebuilds the provider message.
  // (The fold pairs a call with its result, so the step's results are part of
  // the same transaction the real runner writes.)
  const withResults = [
    ...entries,
    {
      id: "child:1:call_a:result",
      role: "tool_result" as const,
      content: "file contents",
      pairID: "call_a",
    },
    {
      id: "child:1:call_b:result",
      role: "tool_result" as const,
      content: "written",
      pairID: "call_b",
    },
  ];
  const messages = contextEntriesToProviderMessages(withResults);
  const assistant = messages.find(
    (message) =>
      message.role === "assistant" && message.toolCalls !== undefined,
  );
  expect(assistant).toBeDefined();
  expect(assistant!.reasoningContent).toBe(
    "the child's thinking for this step",
  );
  expect(assistant!.toolCalls?.[0]).toMatchObject({
    id: "call_a",
    name: "read_file",
    arguments: "a.ts",
    thoughtSignature: "sig-a",
  });
  expect(assistant!.toolCalls?.[1]).toMatchObject({
    id: "call_b",
    name: "write_file",
    arguments: "b.ts",
  });
});

test("duplicate tool_call ids in a subagent step do not lose a result on replay", () => {
  // The other half of an incomplete assembly: an OpenAI-compatible gateway
  // can emit one id on two streamed calls. Two ledger entries sharing a
  // `pairID` make the replay fold drop one of them, so a tool result
  // silently vanishes from the conversation the provider is shown next step.
  const { calls } = uniqueProviderToolCallIds([
    { id: "call_a", name: "read_file", arguments: "a.ts" },
    { id: "call_a", name: "write_file", arguments: "b.ts" },
  ]);
  expect(calls.map((call) => call.id)).toEqual(["call_a", "call_a#1"]);
  expect(new Set(calls.map((call) => call.id)).size).toBe(2);
});
