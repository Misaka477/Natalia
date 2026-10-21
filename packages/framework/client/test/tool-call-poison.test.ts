/**
 * A cancelled turn's unanswered tool call, end to end with the real client.
 *
 * This is the repro of the measured poison: the turn's assistant message
 * carried TWO parallel tool calls, the tool loop parked on the first one's
 * approval gate, the human cancelled, and the second call's result was never
 * journaled. The next turn's request then carried the dangling call and the
 * gateway answered `input_invalid` on every turn from that point on — the
 * session never recovered, because the same history replays.
 *
 * The repro pins the whole remedy: the cancel path closes the unanswered call,
 * AND a journal already written is healed at exec build, so a session poisoned
 * before the fix is sendable again.
 */
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolRegistry } from "@anthelia/tools";
import type { ProviderStreamRequest } from "@anthelia/runtime";
import { createRealRuntimeClient } from "../src";
import { recordTurnRequest } from "./e2e-harness";

function unpairedToolMessages(messages: ProviderStreamRequest["messages"]) {
  const openCalls = new Set<string>();
  const answered = new Set<string>();
  const problems: string[] = [];
  for (const message of messages) {
    const role = String(message.role);
    if (role === "assistant") {
      for (const call of message.toolCalls ?? []) openCalls.add(call.id);
      continue;
    }
    if (role === "tool") {
      const id = (message as { toolCallID?: string }).toolCallID;
      if (!id) problems.push("a tool result with no id");
      else if (!openCalls.has(id)) problems.push(`a result for ${id} with no call`);
      else answered.add(id);
    }
  }
  for (const id of openCalls)
    if (!answered.has(id)) problems.push(`a call ${id} with no result`);
  return problems;
}

async function poisonedTurn(
  requests: ProviderStreamRequest[],
  sessionID: string,
  root: string,
) {
  const tools = createToolRegistry([]);
  tools.set("write_file", {
    name: "write_file",
    description: "Write a file (approval-gated in this harness).",
    requiresApproval: true,
    parameters: { type: "object", properties: { path: { type: "string" } } },
    async execute() {
      return "written";
    },
  });
  let cancelled = false;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: sessionID as `ses_${string}`,
    tools,
    provider: {
      provider: "capture",
      model: "capture-model",
      async *stream(request: ProviderStreamRequest) {
        recordTurnRequest(requests, request);
        if (!request.messages.some((message) => message.role === "tool")) {
          // The poisoned turn's shape: TWO parallel calls, both gated. The
          // loop parks on the first gate, so the second never starts.
          yield {
            type: "tool_call",
            calls: [
              {
                id: "call_gated",
                name: "write_file",
                arguments: JSON.stringify({ path: "x.md" }),
              },
              {
                id: "call_never_ran",
                name: "write_file",
                arguments: JSON.stringify({ path: "z.md" }),
              },
            ],
          };
          yield { type: "done" };
          return;
        }
        yield { type: "content", text: "file created" };
        yield { type: "done" };
      },
    },
  });
  client.start((event) => {
    if (event.type === "approval.request" && !cancelled) {
      cancelled = true;
      client.cancel!("approval cancelled");
    }
  });
  await client.submitAndWait!("write then cancel");
  return client;
}

test("a cancelled turn's unanswered call is closed, and the next turn is sendable", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-poison-repro-"));
  const requests: ProviderStreamRequest[] = [];
  const client = await poisonedTurn(requests, "ses_poison_repro", root);
  try {
    // The cancel path closed the call the loop was parked on; the one that
    // never ran is closed by the recovery, journaled as a real event.
    await client.submitAndWait!("continue");
    const second = requests.at(-1)!;
    expect(
      unpairedToolMessages(second.messages),
      `roles: ${second.messages.map((m) => String(m.role)).join(",")}`,
    ).toEqual([]);
  } finally {
    await client.dispose?.();
  }
}, 60_000);

test("a session poisoned before the fix is healed at exec build", async () => {
  // The user's session: the journal already carries the dangling call, the
  // cancel path never closed it (the fix did not exist), and every turn since
  // has failed with input_invalid. Re-attaching (which rebuilds the exec and
  // its ledger) must make it sendable — the heal runs where the ledger is
  // restored from the journal.
  const root = await mkdtemp(join(tmpdir(), "natalia-poison-heal-"));
  const requests: ProviderStreamRequest[] = [];
  const client = await poisonedTurn(requests, "ses_poison_heal", root);
  try {
    // Detach and re-attach: the exec is dropped and rebuilt, which is where
    // the journal heal runs.
    await client.sessionAttach!("ses_poison_heal" as `ses_${string}`);
    await client.submitAndWait!("after re-attach");
    const last = requests.at(-1)!;
    expect(
      unpairedToolMessages(last.messages),
      `roles: ${last.messages.map((m) => String(m.role)).join(",")}`,
    ).toEqual([]);
  } finally {
    await client.dispose?.();
  }
}, 60_000);
