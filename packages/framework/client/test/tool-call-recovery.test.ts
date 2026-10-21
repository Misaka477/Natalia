/**
 * A tool call the journal recorded but never answered is closed with a
 * synthetic result.
 *
 * The poison, measured on this host: a cancelled turn left an approval-gated
 * pair of parallel tool calls with one result missing (the gate settled the
 * call the loop was parked on; the second never started), and every later
 * request assembled from that journal carried the dangling call — the gateway
 * answered `input_invalid` on EVERY turn from the first occurrence onward and
 * the session never recovered, because the same history replays every time.
 * The user's diagnosis was exact: not the model, the message assembly — we
 * were sending a history the wire format forbids.
 *
 * The repair follows the deepseek harness's `ToolCallRecovery` /
 * `openTurnClosers` (devref/deepseek-harness): close the unanswered calls with
 * synthetic results that say the outcome is unknown and state the retry test,
 * so the model neither loses the call nor retries a side effect blindly. The
 * cancel path closes its own calls after the abort unwinds; attach closes any
 * journal that was already written.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  healLedgerToolCalls,
  recoverUnansweredToolCalls,
  syntheticToolUpdate,
  unansweredToolCalls,
} from "../src/runtime/tool-call-recovery";

const repoRoot = join(import.meta.dir, "..", "..", "..", "..");

/** The journal's tail exactly as the poisoned turn left it. */
function poisonedEvents(): RuntimeEvent[] {
  return [
    {
      type: "content.done",
      id: "turn_713552a847df42eb93db6f604a41d15b:content.done:27",
      contentParts: [
        {
          type: "tool_call",
          id: "chatcmpl-tool-a9acc632e01e62c4",
          name: "record_validation",
          arguments: "{}",
        },
        {
          type: "tool_call",
          id: "chatcmpl-tool-808352bbb62bcce9",
          name: "record_validation",
          arguments: "{}",
        },
      ],
    } as unknown as RuntimeEvent,
    {
      type: "tool.update",
      id: "turn_713552a847df42eb93db6f604a41d15b:chatcmpl-tool-a9acc632e01e62c4:tool.update",
      name: "record_validation",
      callID: "chatcmpl-tool-a9acc632e01e62c4",
      status: "failed",
      summary: "denied",
      result: "denied",
    } as unknown as RuntimeEvent,
  ];
}

test("a call with no result is found, and pairing is by call id not by name", () => {
  // Two calls to the SAME tool, one answered: pairing by name would call the
  // journal balanced and lose the dangling one — which is the gateway's own
  // rejection rule (duplicate/missing tool_call_id).
  const unanswered = unansweredToolCalls(poisonedEvents());
  expect(unanswered.map((call) => call.callID)).toEqual([
    "chatcmpl-tool-808352bbb62bcce9",
  ]);
  expect(unanswered[0]!.name).toBe("record_validation");
  expect(unanswered[0]!.turnID).toBe("turn_713552a847df42eb93db6f604a41d15b");
  // A balanced journal yields nothing.
  const balanced: RuntimeEvent[] = [
    ...poisonedEvents(),
    {
      type: "tool.update",
      callID: "chatcmpl-tool-808352bbb62bcce9",
      status: "succeeded",
    } as unknown as RuntimeEvent,
  ];
  expect(unansweredToolCalls(balanced)).toEqual([]);
});

test("the synthetic result states the outcome is unknown and the retry test", () => {
  const [call] = unansweredToolCalls(poisonedEvents());
  const event = syntheticToolUpdate(call!, "2026-10-21T15:00:00.000Z") as {
    type: string;
    status?: string;
    result?: string;
    callID?: string;
    id?: string;
  };
  expect(event.type).toBe("tool.update");
  expect(event.status).toBe("failed");
  expect(event.callID).toBe("chatcmpl-tool-808352bbb62bcce9");
  // The row id pairs the call to its turn, the way the runtime's own updates do.
  expect(event.id).toBe(
    "turn_713552a847df42eb93db6f604a41d15b:chatcmpl-tool-808352bbb62bcce9",
  );
  // No fabricated success, no silent drop: the model is told what is not known
  // and how to decide about a retry.
  expect(event.result).toContain("never answered");
  expect(event.result).toContain("outcome is unknown");
  expect(event.result).toContain("read-only or idempotent");
  expect(event.result).toContain("Do not retry blindly");
});

test("recovery publishes one event per unanswered call and is idempotent", () => {
  const published: RuntimeEvent[] = [];
  const healed = recoverUnansweredToolCalls(
    { session: { events: poisonedEvents() } },
    (event) => published.push(event),
  );
  expect(healed).toHaveLength(1);
  expect(published).toHaveLength(1);
  // Idempotent: once the journal carries the synthetic result, a second pass
  // finds nothing — attach runs on every session switch.
  const after = [...poisonedEvents(), published[0]!];
  const second = recoverUnansweredToolCalls(
    { session: { events: after } },
    (event) => published.push(event),
  );
  expect(second).toEqual([]);
  expect(published).toHaveLength(1);
});

test("the restored ledger is healed, not only the journal events", () => {
  // The definitive scan. A context epoch or checkpoint snapshot can carry the
  // dangling call INSIDE it, where the journal-event scan cannot see it — and
  // the ledger is what the provider request is assembled from. A fake ledger
  // with the restored shape (a tool_call entry whose pairID no tool_result
  // shares) must gain the result.
  const added: Array<{
    id: string;
    role: string;
    pairID: string;
    content: string;
  }> = [];
  const fakeLedger = {
    snapshot: () => ({
      entries: [
        {
          id: "restore:turn_poison:call_dangling:tool.update:call",
          role: "tool_call",
          pairID: "call_dangling",
          content: "record_validation {}",
        },
        {
          id: "restore:turn_poison:call_answered:tool.update:call",
          role: "tool_call",
          pairID: "call_answered",
          content: "record_validation {}",
        },
        {
          id: "restore:turn_poison:call_answered:tool.update:result",
          role: "tool_result",
          pairID: "call_answered",
          content: "ok",
        },
      ],
    }),
    add: (entry: {
      id: string;
      role: "tool_result";
      pairID: string;
      content: string;
    }) => {
      added.push(entry);
    },
  };
  const healed = healLedgerToolCalls(fakeLedger);
  expect(healed.map((call) => call.callID)).toEqual(["call_dangling"]);
  expect(healed[0]!.turnID).toBe("turn_poison");
  expect(healed[0]!.name).toBe("record_validation");
  expect(added).toHaveLength(1);
  expect(added[0]!.role).toBe("tool_result");
  expect(added[0]!.pairID).toBe("call_dangling");
  expect(added[0]!.content).toContain("never answered");
  // An answered call gains nothing: the pairing is by pairID, so a second
  // result for the same call would be its own gateway rejection.
  expect(added.every((entry) => entry.pairID === "call_dangling")).toBe(true);
});

test("the exec build heals the ledger after the restore, not before", () => {
  // The heal for journals written before the cancel path closed its own
  // calls — the user's session included. It runs where the FULL journal is
  // loaded and the ledger restored from it, so the ledger this exec carries
  // is balanced and the journal is healed durably in one move. Source-level
  // because the placement is an ordering property: the synthetic events must
  // reach the restore, not follow it.
  const ensure = readFileSync(
    join(
      repoRoot,
      "packages/framework/client/src/runtime/session-execution/index.ts",
    ),
    "utf8",
  );
  const restoreAt = ensure.indexOf("contextLedgerFactory.restore(execContext");
  expect(restoreAt).toBeGreaterThan(0);
  const healAt = ensure.indexOf("unansweredToolCalls(runtimeRestoreEvents)");
  expect(healAt).toBeGreaterThan(0);
  expect(healAt).toBeLessThan(restoreAt);
  // And the heal is durable, not in-memory only: the next load must find the
  // journal already balanced.
  expect(ensure).toContain("sessionStore.appendEvents(loaded, healedEvents)");
  // Matched on the operands, because prettier wraps the call.
  expect(ensure).toMatch(/runtimeRestoreEvents\.push\(\.\.\.healedEvents\)/u);
});

test("the cancel path closes the calls after the abort unwinds, not before", () => {
  // The order is the fix: the approval gate publishes its own result during
  // the abort, so a synthesis before that would duplicate the gated call's
  // result. After `interrupt()`, what remains unanswered is exactly what never
  // ran. Source-level because the sequencing lives in the coordinator's
  // unwind, which no unit harness reproduces deterministically.
  const core = readFileSync(
    join(
      repoRoot,
      "packages/framework/client/src/runtime/session-execution/core.ts",
    ),
    "utf8",
  );
  const interruptAt = core.indexOf("await coordinator.interrupt()");
  const recoverAt = core.indexOf("recoverUnansweredToolCalls(cancelledExec");
  expect(interruptAt).toBeGreaterThan(0);
  expect(recoverAt).toBeGreaterThan(interruptAt);
  // And the turn.cancelled publish still precedes both.
  const cancelledAt = core.indexOf('type: "turn.cancelled"');
  expect(cancelledAt).toBeGreaterThan(0);
  expect(cancelledAt).toBeLessThan(interruptAt);
});
