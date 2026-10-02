import { expect, test } from "bun:test";
import {
  ContextLedger,
  contextEntriesToProviderMessages,
  type ProviderMessage,
} from "@anthelia/runtime";

/**
 * The chat streams' compaction round trip.
 *
 * A Navi/Nia turn writes its growing history into a per-stream ledger
 * (`compactChatBeforeProviderStep`) so the compact-and-reset step can rebuild
 * the request from the journal instead of from memory. That rebuild goes
 * through the SAME `contextEntriesToProviderMessages` the main channel uses, so
 * the tool pairing has to survive: the assistant entry carrying `toolCalls`
 * and the `role: "tool"` results, in order, with the ids intact.
 *
 * This is the chat-channel mirror of the main-channel pins. It is where a
 * pairing loss would silently turn the second step of a tool-calling turn into
 * a gateway 400 ("tool_calls.id and tool_calls.type are required").
 */
function ledgerFrom(messages: ProviderMessage[], id: string): ContextLedger {
  const ledger = new ContextLedger();
  for (const [index, message] of messages.entries()) {
    if (message.role === "system") continue;
    if (message.role === "assistant" && message.toolCalls?.length) {
      ledger.add({
        id: `${id}:${index}:assistant`,
        role: "assistant",
        content: message.content,
      });
      for (const call of message.toolCalls)
        ledger.add({
          id: `${id}:${index}:${call.id}:call`,
          role: "tool_call",
          content: `${call.name} ${call.arguments}`,
          pairID: call.id,
        });
      continue;
    }
    if (message.role === "tool" && message.toolCallID) {
      ledger.add({
        id: `${id}:${index}:${message.toolCallID}:result`,
        role: "tool_result",
        content: message.content,
        pairID: message.toolCallID,
      });
      continue;
    }
    ledger.add({
      id: `${id}:${index}:${message.role}`,
      role: message.role === "user" ? "user" : "assistant",
      content: message.content,
    });
  }
  return ledger;
}

test("a tool-calling chat turn survives its compaction round trip paired", () => {
  const original: ProviderMessage[] = [
    { role: "system", content: "persona" },
    { role: "user", content: "write the plan" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call_a", name: "plan_doc_write", arguments: '{"path":"p.md"}' },
      ],
    },
    { role: "tool", toolCallID: "call_a", content: '{"written":true}' },
    { role: "assistant", content: "documented" },
    { role: "user", content: "and again" },
  ];
  const ledger = ledgerFrom(original, "navi-chat:ses_1");
  const rebuilt = contextEntriesToProviderMessages(ledger.snapshot().entries);

  const roles = rebuilt.map((message) => message.role);
  expect(roles).toEqual(["user", "assistant", "tool", "assistant", "user"]);
  const assistant = rebuilt.find((message) => message.toolCalls?.length)!;
  expect(assistant.toolCalls?.map((call) => call.id)).toEqual(["call_a"]);
  const result = rebuilt.find((message) => message.role === "tool")!;
  expect(result.toolCallID).toBe("call_a");
  expect(String(result.content)).toContain("written");
});

test("an interrupted chat tool call (no result yet) does not survive as a dangling entry", () => {
  // A step that died between the provider's call and the tool's result would
  // leave a call with no pair. The rebuild must drop it rather than emit an
  // assistant entry the gateway will reject for missing the result.
  const original: ProviderMessage[] = [
    { role: "user", content: "write it" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call_b", name: "plan_doc_write", arguments: '{"path":"q.md"}' },
      ],
    },
  ];
  const rebuilt = contextEntriesToProviderMessages(
    ledgerFrom(original, "navi-chat:ses_2").snapshot().entries,
  );
  // The dangling CALL is what a gateway rejects, and it is gone: no message
  // carries a `toolCalls` entry, and no `role: "tool"` result appears either.
  expect(rebuilt.flatMap((message) => message.toolCalls ?? [])).toEqual([]);
  expect(rebuilt.filter((message) => message.role === "tool")).toEqual([]);
  // The tolerated residuum: the assistant row that announced the call survives
  // as empty text. A gateway accepts an empty assistant turn, so this is noise
  // rather than a protocol violation — but it is visible to the model, which is
  // why it is pinned here rather than left implicit.
  const assistant = rebuilt.find((message) => message.role === "assistant")!;
  expect(assistant.content).toBe("");
});
