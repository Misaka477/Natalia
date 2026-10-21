/**
 * A tool call the journal recorded but never answered, and the remedy.
 *
 * A turn that ends with unanswered tool calls poisons the session for good:
 * the provider request assembled from the journal then carries an assistant
 * message whose tool_calls have no matching results, and every
 * OpenAI-compatible gateway rejects it — measured on this host as
 * `input_invalid` on EVERY turn from the first occurrence onward, the session
 * never recovering, because the same history replays every time. The origin
 * was a cancelled turn: two parallel tool calls, one approval-gated, the human
 * cancelled — the running call got its result, the gated one never did.
 *
 * The remedy is the deepseek harness's (devref/deepseek-harness,
 * `ToolCallRecovery` / `openTurnClosers`): synthesize the missing results so
 * the history is balanced, and say plainly what happened. The model must not
 * silently lose a call it made — that is how a re-run does the side effect
 * twice — so the wording states the outcome is unknown and gives the retry
 * test rather than pretending the call succeeded or was never made.
 */
import type { RuntimeEvent } from "@anthelia/contracts";

/** One assistant tool request the journal carries with no recorded result. */
export type UnansweredToolCall = {
  callID: string;
  turnID: string;
  name: string;
};

/**
 * Every tool call in `events` with no matching `tool.update`.
 *
 * Matched on the provider call id, which is the only thing that pairs a result
 * with its call (pairing by tool NAME collides the moment one message calls the
 * same tool twice — which is exactly the poisoned turn here).
 */
export function unansweredToolCalls(
  events: readonly RuntimeEvent[],
): UnansweredToolCall[] {
  const calls = new Map<string, UnansweredToolCall>();
  const answered = new Set<string>();
  for (const event of events) {
    if (event.type === "content.done") {
      const parts = (event as { contentParts?: unknown }).contentParts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts as Array<{
        type?: string;
        id?: string;
        name?: string;
      }>) {
        if (part.type === "tool_call" && part.id)
          calls.set(part.id, {
            callID: part.id,
            turnID:
              String((event as { id?: string }).id ?? "").split(":")[0] ?? "",
            name: part.name ?? "",
          });
      }
      continue;
    }
    if (event.type === "tool.update") {
      const callID = (event as { callID?: string }).callID;
      if (callID) answered.add(callID);
    }
  }
  return [...calls.values()].filter((call) => !answered.has(call.callID));
}

/**
 * The model-visible text of a synthetic result: the outcome is unknown, and
 * the retry test is stated rather than assumed.
 */
const RECOVERY_TEXT =
  "This tool call was never answered: its turn ended before the result was recorded, so its outcome is unknown. Retry only if the operation is read-only or idempotent; if it may have side effects, verify the external state or ask the human before retrying. Do not retry blindly.";

/**
 * The synthetic `tool.update` that closes one unanswered call.
 *
 * `status: "failed"` with the reason in the text: the call did not succeed —
 * that much is known — and the model is told the rest is not.
 */
export function syntheticToolUpdate(
  call: UnansweredToolCall,
  at: string,
): RuntimeEvent {
  return {
    type: "tool.update",
    id: `${call.turnID}:${call.callID}`,
    name: call.name,
    callID: call.callID,
    status: "failed",
    summary: RECOVERY_TEXT,
    result: RECOVERY_TEXT,
    endedAt: Date.now(),
    at,
  } as unknown as RuntimeEvent;
}

/**
/**
 * Close every tool call a restored ledger carries with no result.
 *
 * The ledger is what the provider request is assembled from, and a context
 * epoch or checkpoint snapshot can carry the dangling call INSIDE it — where
 * the journal-event scan cannot see it. So the definitive scan is the
 * ledger's own, over BOTH places a call can live there:
 *
 *   - an assistant entry's `contentParts`: the assistant message the journal
 *     recorded carried the call, and `contextEntriesToProviderMessages` turns
 *     those parts into the request's assistant `toolCalls` — the field the
 *     gateway's pairing rule is about (measured: the poisoned turn's dangling
 *     call lived here, not in a tool_call entry), and
 *   - a `tool_call` entry the restore folded from a call marker.
 *
 * Both pair on the provider call id, the same id the gateway rejects on.
 * Returns the calls it closed, so the caller can heal the journal durably.
 */
export function healLedgerToolCalls(ledger: {
  snapshot(): {
    entries: Array<{
      id: string;
      role: string;
      pairID?: string;
      content: string;
      contentParts?: Array<{ type?: string; id?: string; name?: string }>;
    }>;
  };
  add(entry: {
    id: string;
    role: "tool_result";
    pairID: string;
    content: string;
  }): void;
}): UnansweredToolCall[] {
  const entries = ledger.snapshot().entries;
  const answered = new Set(
    entries
      .filter((entry) => entry.role === "tool_result")
      .map((entry) => entry.pairID ?? ""),
  );
  const healed: UnansweredToolCall[] = [];
  /** The turn an entry belongs to, from either restore id shape. */
  const turnOf = (id: string) =>
    id.split(":").find((part) => part.startsWith("turn_")) ?? "";
  const close = (callID: string, turnID: string, name: string) => {
    answered.add(callID);
    healed.push({ callID, turnID, name });
    ledger.add({
      id: `recovered:${turnID}:${callID}`,
      role: "tool_result",
      pairID: callID,
      content: RECOVERY_TEXT,
    });
  };
  for (const entry of entries) {
    // An assistant entry's content parts: the recorded call the request's
    // assistant message will carry.
    if (entry.role === "assistant" && entry.contentParts?.length) {
      for (const part of entry.contentParts) {
        if (part.type !== "tool_call" || !part.id) continue;
        if (answered.has(part.id)) continue;
        close(part.id, turnOf(entry.id), part.name ?? "");
      }
      continue;
    }
    // A tool_call entry the restore folded from a call marker.
    if (entry.role === "tool_call" && entry.pairID) {
      if (answered.has(entry.pairID)) continue;
      close(entry.pairID, turnOf(entry.id), entry.content.split(" ")[0] ?? "");
    }
  }
  return healed;
}
/**
 * Publish a synthetic result for every unanswered call in the session's
 * journal. Idempotent: a journal already balanced yields nothing.
 */
export function recoverUnansweredToolCalls(
  exec: { session: { events: readonly RuntimeEvent[] } },
  publish: (event: RuntimeEvent) => void,
): UnansweredToolCall[] {
  const unanswered = unansweredToolCalls(exec.session.events);
  const at = new Date().toISOString();
  for (const call of unanswered) publish(syntheticToolUpdate(call, at));
  return unanswered;
}
