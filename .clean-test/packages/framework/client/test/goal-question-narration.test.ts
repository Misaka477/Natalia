import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  deliveredMailboxConstraints,
  lastAssistantNarration,
} from "@natalia/collab";

function contentDone(id: string, text: string): RuntimeEvent {
  return {
    type: "content.done",
    id,
    text,
    ...({} as Record<string, never>),
  } as RuntimeEvent;
}

test("lastAssistantNarration returns the latest assistant content.done text", () => {
  const events: RuntimeEvent[] = [
    contentDone("a", "first narration"),
    { type: "turn.finished", id: "t1", stopReason: "done" } as RuntimeEvent,
    contentDone("b", "  latest narration  "),
  ];
  // The most recent content.done wins, trimmed.
  expect(lastAssistantNarration(events)).toBe("latest narration");
});

test("lastAssistantNarration ignores non-assistant/empty turns", () => {
  // No content.done at all (a silent / tool-only turn) -> undefined.
  expect(
    lastAssistantNarration([
      { type: "turn.finished", id: "t1", stopReason: "done" } as RuntimeEvent,
    ]),
  ).toBeUndefined();
  // Whitespace-only content is not narration.
  expect(lastAssistantNarration([contentDone("a", "   ")])).toBeUndefined();
});

test("only delivered/acknowledged mailbox constraints are judged (EI §3.3)", () => {
  const base = {
    source: "user_via_live_chat" as const,
    priority: "normal" as const,
    text: "never push to main",
    deliveryPolicy: "next_safe_boundary" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const message = (intent: string, status: string, id: string) =>
    ({
      ...base,
      messageID: id,
      intent,
      status,
      safeSummary: `${intent}:${status}`,
    }) as never;
  const sentences = deliveredMailboxConstraints([
    message("constraint", "delivered", "m1"),
    message("constraint", "acknowledged", "m2"),
    // Not yet binding (queued), replaced (superseded), or a different intent.
    message("constraint", "queued", "m3"),
    message("constraint", "superseded", "m4"),
    message("clarification", "delivered", "m5"),
  ]);
  expect(sentences).toEqual([
    "constraint:delivered",
    "constraint:acknowledged",
  ]);
});
