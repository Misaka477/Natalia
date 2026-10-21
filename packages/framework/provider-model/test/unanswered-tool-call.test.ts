/**
 * An assistant message whose content parts carry a tool call the journal
 * never answered is closed before the request goes out.
 *
 * The poison, measured on this host: a cancelled turn left one of two parallel
 * tool calls unanswered, and every request assembled from that session
 * afterwards carried the assistant's `toolCalls` with one result missing —
 * `input_invalid` on every turn from the first occurrence on, the session never
 * recovering. The call rides the assistant message's content parts (the adapter
 * turns them into the request's assistant toolCalls), which the tool_call/tool_result
 * ENTRY transaction below never sees.
 *
 * The repair is at the request projection boundary — the deepseek harness's
 * `ToolCallRecovery` does the same before its requests reach a provider.
 */
import { expect, test } from "bun:test";
import type { ContextEntry } from "@anthelia/runtime";
import { contextEntriesToProviderMessages } from "@anthelia/runtime";

/** The restored ledger's shape for the poisoned turn. */
function poisonedEntries(): ContextEntry[] {
  return [
    {
      id: "turn_poison:user",
      role: "user",
      content: "write the files",
    },
    {
      // The assistant message as the restore folds it: the content parts carry
      // BOTH calls the model made.
      id: "turn_poison:assistant",
      role: "assistant",
      content: "",
      contentParts: [
        { type: "text", text: "writing both" },
        {
          type: "tool_call",
          id: "call_gated",
          name: "write_file",
          arguments: '{"path":"x.md"}',
        },
        {
          type: "tool_call",
          id: "call_never_ran",
          name: "write_file",
          arguments: '{"path":"z.md"}',
        },
      ],
    },
    // The call the loop was parked on: its call marker and its result, as the
    // restore folds a tool.update pair. The second call has NEITHER — it never
    // ran — so it exists only in the assistant's content parts.
    {
      id: "restore:turn_poison:call_gated:tool.update:call",
      role: "tool_call",
      pairID: "call_gated",
      content: 'write_file {"path":"x.md"}',
    },
    {
      id: "restore:turn_poison:call_gated:tool.update:result",
      role: "tool_result",
      pairID: "call_gated",
      content: "written",
    },
  ] as unknown as ContextEntry[];
}

test("an unanswered call in the assistant's content parts gets a result", () => {
  const messages = contextEntriesToProviderMessages(poisonedEntries());
  const toolMessages = messages.filter((message) => message.role === "tool");
  // Both calls are answered: the recorded one with its real result, the
  // dangling one with the synthetic recovery text.
  expect(toolMessages.map((message) => message.toolCallID).sort()).toEqual([
    "call_gated",
    "call_never_ran",
  ]);
  const synthetic = toolMessages.find(
    (message) => message.toolCallID === "call_never_ran",
  )!;
  expect(String(synthetic.content)).toContain("never answered");
  expect(String(synthetic.content)).toContain("outcome is unknown");
  expect(String(synthetic.content)).toContain("Do not retry blindly");
  // No fabricated success: the recorded result is untouched.
  expect(
    String(
      toolMessages.find((message) => message.toolCallID === "call_gated")!
        .content,
    ),
  ).toBe("written");
});

test("an assistant message's tool calls are capped, and its excess results dropped", async () => {
  // The measured poison: the Fourier turn's model emitted 115 parallel tool
  // calls in ONE message, and every turn in that session has failed since —
  // StepFun answers `input_invalid` at 90 calls and accepts 85, and the
  // journal cannot be edited. The request boundary trims to what the gateway
  // accepts; the excess calls AND their results go together, so the pairing
  // the gateway checks stays intact.
  const many = Array.from({ length: 100 }, (_, i) => ({
    type: "tool_call",
    id: `call_${i}`,
    name: "write_file",
    arguments: "{}",
  }));
  const entries = [
    { id: "t:user", role: "user", content: "go" },
    { id: "t:assistant", role: "assistant", content: "", contentParts: many },
    // The restore's shape: a call marker and its result per call, which the
    // transaction path attaches to the assistant message as its toolCalls.
    ...many.flatMap((call, i) => [
      {
        id: `restore:t:${call.id}:tool.update:call`,
        role: "tool_call",
        pairID: call.id,
        content: `write_file {}`,
      },
      {
        id: `restore:t:${call.id}:tool.update:result`,
        role: "tool_result",
        pairID: call.id,
        content: `result ${i}`,
      },
    ]),
  ] as unknown as ContextEntry[];
  const messages = contextEntriesToProviderMessages(entries);
  const assistant = messages.find((m) => m.role === "assistant")!;
  expect(assistant.toolCalls!.length).toBeLessThanOrEqual(80);
  const toolMessages = messages.filter((m) => m.role === "tool");
  // The results match the kept calls exactly — no orphan results.
  expect(toolMessages.length).toBe(assistant.toolCalls!.length);
  const keptIDs = new Set(assistant.toolCalls!.map((c) => c.id));
  for (const message of toolMessages)
    expect(keptIDs.has(message.toolCallID!)).toBe(true);
  // The content parts are trimmed too: the pairing check reads them, and a
  // result kept for a call the wire no longer carries is its own rejection.
  const parts = (assistant as { contentParts?: Array<{ type?: string }> })
    .contentParts!;
  expect(parts.filter((p) => p.type === "tool_call").length).toBe(
    assistant.toolCalls!.length,
  );
});

test("a balanced history is passed through unchanged", () => {
  const entries = poisonedEntries();
  entries.push(
    {
      id: "restore:turn_poison:call_never_ran:tool.update:call",
      role: "tool_call",
      pairID: "call_never_ran",
      content: 'write_file {"path":"z.md"}',
    },
    {
      id: "restore:turn_poison:call_never_ran:tool.update:result",
      role: "tool_result",
      pairID: "call_never_ran",
      content: "written too",
    },
  );
  const messages = contextEntriesToProviderMessages(
    entries as unknown as ContextEntry[],
  );
  const toolMessages = messages.filter((message) => message.role === "tool");
  expect(toolMessages).toHaveLength(2);
  expect(
    String(
      toolMessages.find((message) => message.toolCallID === "call_never_ran")!
        .content,
    ),
  ).toBe("written too");
});
