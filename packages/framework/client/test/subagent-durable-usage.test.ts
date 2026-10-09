import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { createRealRuntimeClient, waitForAsync } from "./real-runtime-harness";
import { useWorkspaceCleanup } from "./plugin-test-helpers";

useWorkspaceCleanup();

/**
 * R3's subagent half, end to end: the pane's bar and ring must behave like
 * the other three agents' — live AND across a restart.
 *
 * The live events a child publishes carry its `agentID`, which the event sink
 * keeps out of the parent's journal by design (that isolation is what the
 * current architecture bought), so nothing the child reported survived the
 * process: after a restart the pane read zeroes and the ring came up empty.
 * The record now carries both, persisted beside the step, and hydration
 * replays them on attach.
 */
test("a subagent's step carries the wall clock and its record the durable totals", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-subagent-durable-"));
  const events: RuntimeEvent[] = [];
  let childRequests = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        const isChild = request.messages.some((message) =>
          String(message.content).includes("delegated task"),
        );
        if (isChild) {
          childRequests += 1;
          yield { type: "content" as const, text: "child did the work" };
          yield {
            type: "usage" as const,
            inputTokens: 120,
            outputTokens: 24,
          };
          yield { type: "done" as const };
          return;
        }
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "spawn",
                name: "agent_spawn",
                arguments: JSON.stringify({
                  task: "delegated task",
                  description: "Do the delegated work",
                }),
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
    await client.submitAndWait!("delegate a task");
    await waitForAsync(
      async () =>
        events.some(
          (event) =>
            event.type === "subagent.update" && event.status === "completed",
        ),
      15_000,
    );

    // The child really ran a provider step.
    expect(childRequests).toBeGreaterThan(0);

    // The live step usage carries the measured wall clock (G2-7): without it
    // the pane's LLM / 首 token / tok/s segments were permanently blank.
    const childUsage = events.find(
      (event): event is Extract<RuntimeEvent, { type: "runtime.step_usage" }> =>
        event.type === "runtime.step_usage" &&
        "agentID" in event &&
        event.agentID !== undefined,
    );
    expect(childUsage).toBeDefined();
    expect(childUsage!.llmMs).toBeGreaterThanOrEqual(0);
    expect(childUsage!.ttftMs).toBeGreaterThanOrEqual(0);
    expect(childUsage!.decodeMs).toBeGreaterThanOrEqual(0);

    // The durable twin: the record carries the totals the run produced, which
    // is what a restart hydrates from.
    const subagents = await client.subagents?.();
    const child = subagents?.find((entry) => entry.id.includes("a1"));
    expect(child?.usage?.inputTokens).toBeGreaterThan(0);
    expect(child?.usage?.steps).toBeGreaterThan(0);
    // And the last context projection rode along.
    expect(child?.contextSnapshot?.usedTokens).toBeGreaterThan(0);
  } finally {
    await client.dispose?.();
  }
});
