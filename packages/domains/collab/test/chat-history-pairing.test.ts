import { expect, test } from "bun:test";
import { chatProviderMessages } from "../src/chat-turn-common";
import type { HistoryChatRow } from "../src/chat-turn-common";
import type { ProviderMessage } from "@anthelia/runtime";

/**
 * The chat history's tool pairing — Navi's recurring gateway rejections.
 *
 * Her turns failed twice over, both from one place:
 *   "Duplicate value for 'tool_call_id' of 'call_00_...' in message[4]"
 *   "No tool output found for function call fc_00_..."
 *
 * The history rebuild paired a tool result with its call by tool NAME. One
 * message calling the same tool twice makes both results take the FIRST
 * call's id (the duplicate), and a call whose result never landed stays
 * unanswered (the orphan). Either one makes the gateway reject the whole turn.
 *
 * The provider call's id is the only key that identifies a call, so that is
 * what the pairing uses now. These tests run the REAL assembly.
 */

function row(
  over: Partial<HistoryChatRow> & { messageID: string },
): HistoryChatRow {
  return {
    role: "chat",
    text: "",
    ...over,
  } as HistoryChatRow;
}

test("two calls to the same tool keep their own ids (the duplicate)", () => {
  // Navi calling collab_chat twice in one message — the sweep measured exactly
  // this shape, and the gateway rejected the next turn over it.
  const history: HistoryChatRow[] = [
    row({ messageID: "m1", role: "chat", text: "", kind: "message" }),
    row({
      messageID: "m1",
      kind: "tool",
      text: "sent one",
      tool: { name: "collab_chat", result: "ok-1", toolCallID: "call_a" },
    }),
    row({
      messageID: "m1",
      kind: "tool",
      text: "sent two",
      tool: { name: "collab_chat", result: "ok-2", toolCallID: "call_b" },
    }),
  ];
  const byMessage = new Map([
    [
      "m1",
      [
        { id: "call_a", name: "collab_chat", arguments: "{}" },
        { id: "call_b", name: "collab_chat", arguments: "{}" },
      ],
    ],
  ]);
  const messages: ProviderMessage[] = chatProviderMessages(history, byMessage);
  const toolMessages = messages.filter((m) => m.role === "tool");
  expect(toolMessages).toHaveLength(2);
  // Each result carries ITS OWN call's id — the duplicate is gone.
  expect(toolMessages.map((m) => m.toolCallID)).toEqual(["call_a", "call_b"]);
  expect(toolMessages.map((m) => m.content)).toEqual(["ok-1", "ok-2"]);
  const assistant = messages.find((m) => m.role === "assistant");
  expect(assistant?.toolCalls?.map((c: { id: string }) => c.id)).toEqual([
    "call_a",
    "call_b",
  ]);
});

test("a call whose result never landed is answered, not orphaned", () => {
  const history: HistoryChatRow[] = [
    row({ messageID: "m1", role: "chat", text: "", kind: "message" }),
    row({
      messageID: "m1",
      kind: "tool",
      text: "one landed",
      tool: { name: "collab_chat", result: "ok", toolCallID: "call_a" },
    }),
  ];
  const byMessage = new Map([
    [
      "m1",
      [
        { id: "call_a", name: "collab_chat", arguments: "{}" },
        { id: "call_b", name: "collab_chat", arguments: "{}" },
      ],
    ],
  ]);
  const messages: ProviderMessage[] = chatProviderMessages(history, byMessage);
  const toolMessages = messages.filter((m) => m.role === "tool");
  expect(toolMessages).toHaveLength(2);
  expect(toolMessages[1]?.toolCallID).toBe("call_b");
  // The placeholder is honest about what is unknown.
  expect(toolMessages[1]?.content).toContain("was not recorded");
  expect(toolMessages[1]?.content).toContain("collab_chat");
});

test("a result with no call is dropped rather than paired by name", () => {
  // The mirror case: a tool row whose id matches no declared call. Pairing by
  // name would have attached it to whichever call shared the name.
  const history: HistoryChatRow[] = [
    row({ messageID: "m1", role: "chat", text: "", kind: "message" }),
    row({
      messageID: "m1",
      kind: "tool",
      text: "stray",
      tool: { name: "collab_chat", result: "ok", toolCallID: "call_zzz" },
    }),
  ];
  const byMessage = new Map([
    ["m1", [{ id: "call_a", name: "collab_chat", arguments: "{}" }]],
  ]);
  const messages: ProviderMessage[] = chatProviderMessages(history, byMessage);
  const toolMessages = messages.filter((m) => m.role === "tool");
  // The stray result is not smuggled in under a real call's id.
  expect(toolMessages.map((m) => m.toolCallID)).not.toContain("call_zzz");
  // And the real call still gets its honest answer.
  expect(toolMessages.map((m) => m.toolCallID)).toEqual(["call_a"]);
});

test("ctest is allowed — a CMake audit must be able to re-run the tests (F9)", async () => {
  // The 2026-10-10 sweep's F9: Nia's read-only shell refused `ctest`, so an
  // audit of a CMake project could not re-run the only test command it has.
  // An audit that cannot re-run what it audits is decoration.
  const { niaShellPolicyDenial } = await import("../src/nia-shell-policy");
  expect(
    await niaShellPolicyDenial("ctest --output-on-failure", "Nia"),
  ).toBeUndefined();
  expect(await niaShellPolicyDenial("ctest -R math", "Nia")).toBeUndefined();
  // The policy's purpose is intact: a mutating command is still refused.
  expect(await niaShellPolicyDenial("rm -rf build", "Nia")).toBeDefined();
});
