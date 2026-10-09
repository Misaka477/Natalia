import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { providerError } from "@anthelia/runtime";
import { createRealRuntimeClient, waitForAsync } from "./real-runtime-harness";
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
