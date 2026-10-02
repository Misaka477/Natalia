import { expect, test } from "bun:test";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import {
  collaborationTools,
  consultRecords,
  consultSummary,
  createCollaborationService,
  expireSessionConsults,
  pendingConsultSession,
  resolveConsult,
  waitForConsult,
} from "../src";

/**
 * The synchronous consult line (the Navi advisor plan's block A):
 * `collab_ask` waits (bounded) for the advisor's answer and returns it
 * as the tool result; the answer's send resolves the wait; a timeout or
 * the turn's abort answers `unavailable` — never a hang.
 */

const sessionID = "ses_consult_bridge" as SessionID;

test("an answer resolves the pending consult with its advice", async () => {
  const waiting = waitForConsult("collab:q:bridge", { sessionID });
  expect(pendingConsultSession("collab:q:bridge")).toBe(sessionID);
  expect(
    resolveConsult(
      "collab:q:bridge",
      "use the workspace root",
      "2026-09-26T10:00:12.000Z",
    ),
  ).toBe(true);
  expect(await waiting).toEqual({
    state: "answered",
    advice: "use the workspace root",
    answeredAt: "2026-09-26T10:00:12.000Z",
  });
  // The pending entry is always cleaned up — no leak, no double resolve.
  expect(pendingConsultSession("collab:q:bridge")).toBeUndefined();
  expect(resolveConsult("collab:q:bridge", "late", "t")).toBe(false);
});

test("a timeout answers unavailable and cleans up", async () => {
  const reply = await waitForConsult("collab:q:timeout", { timeoutMs: 10 });
  expect(reply.state).toBe("unavailable");
  expect((reply as { reason: string }).reason).toContain("10ms");
  expect(pendingConsultSession("collab:q:timeout")).toBeUndefined();
});

test("the turn's abort answers unavailable", async () => {
  const controller = new AbortController();
  const waiting = waitForConsult("collab:q:abort", {
    timeoutMs: 60_000,
    signal: controller.signal,
  });
  controller.abort();
  expect(await waiting).toEqual({
    state: "unavailable",
    reason: "the turn was cancelled",
  });
});

test("an answer send resolves a pending consult through the service", async () => {
  // The wiring's choke point: BOTH agents' sends flow through the
  // service, so an answer from Navi resolves the main agent's wait
  // without the two sides sharing anything but the channel.
  const events: RuntimeEvent[] = [];
  let sequence = 0;
  const service = createCollaborationService({
    events: (candidate) => (candidate === sessionID ? events : undefined),
    publish: (_sessionID, event) => events.push(event),
    nextSequence: () => ++sequence,
    maxAutoRounds: () => 3,
    now: () => new Date("2026-09-26T10:00:00.000Z"),
  });
  const question = await service.send({
    sessionID,
    kind: "question",
    from: "main_agent",
    text: "should I commit now?",
  });
  const waiting = waitForConsult(question.message.id, { sessionID });
  await service.send({
    sessionID,
    kind: "answer",
    from: "live_chat",
    replyToID: question.message.id,
    text: "yes, after the tests pass",
  });
  expect(await waiting).toEqual({
    state: "answered",
    advice: "yes, after the tests pass",
    answeredAt: "2026-09-26T10:00:00.000Z",
  });
});

/** The ask tool with the service's real send wired. */
function askToolHarness() {
  const events: RuntimeEvent[] = [];
  let sequence = 0;
  const service = createCollaborationService({
    events: (candidate) => (candidate === sessionID ? events : undefined),
    publish: (_sessionID, event) => events.push(event),
    nextSequence: () => ++sequence,
    maxAutoRounds: () => 3,
    now: () => new Date("2026-09-26T10:00:00.000Z"),
  });
  const wakes: Array<{ kind?: string; messageID?: string }> = [];
  const tools = collaborationTools({
    events: (candidate) => (candidate === sessionID ? events : undefined),
    publish: (_sessionID, event) => events.push(event),
    redact: (text) => text,
    nextMailboxSequence: () => ++sequence,
    requestWake: (_sessionID, request) => wakes.push(request ?? {}),
    maxAutoRounds: () => 3,
    service,
  });
  const ask = tools.find((tool) => tool.name === "collab_ask")!;
  return { ask, wakes };
}

test("a declined answer's outcome survives the send into the ledger", async () => {
  // The passthrough's pin: collab_answer's declined flag travels through
  // the service's send into the published message, where the ledger's
  // fold reads it. A decline with no machine-readable carrier is a
  // declined nobody can count.
  const events: RuntimeEvent[] = [];
  let sequence = 0;
  const service = createCollaborationService({
    events: (candidate) => (candidate === sessionID ? events : undefined),
    publish: (_sessionID, event) => events.push(event),
    nextSequence: () => ++sequence,
    maxAutoRounds: () => 3,
    now: () => new Date("2026-09-26T10:00:00.000Z"),
  });
  const question = await service.send({
    sessionID,
    kind: "question",
    from: "main_agent",
    text: "approve this architecture?",
  });
  await service.send({
    sessionID,
    kind: "answer",
    from: "live_chat",
    replyToID: question.message.id,
    text: "declining: product tradeoffs are outside my remit",
    advisorOutcome: "declined",
  });
  const records = consultRecords(events);
  expect(records).toHaveLength(1);
  expect(records[0]!.outcome).toBe("declined");
  expect(consultSummary(records)).toMatchObject({
    asked: 1,
    answered: 0,
    declined: 1,
    open: 0,
  });
});

test("collab_ask returns the advisor's answer as its tool result", async () => {
  const { ask, wakes } = askToolHarness();
  const pending = ask.execute({ question: "which approach wins?" }, {
    sessionID,
  } as never) as Promise<string>;
  // The ask registers its wait and wakes Navi; the wake carries the
  // question's message id the wait is keyed by.
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(wakes[0]?.kind).toBe("question");
  const questionID = wakes[0]!.messageID!;
  expect(questionID).toBeDefined();
  resolveConsult(questionID, "approach A", "2026-09-26T10:00:09.000Z");
  const result = JSON.parse(await pending) as {
    consult: string;
    advice?: string;
  };
  expect(result.consult).toBe("answered");
  expect(result.advice).toBe("approach A");
});

test("the advisor's turn ending settles its session's consults unavailable", async () => {
  // The truncated-id flow's shape: navi's turn ran and never answered.
  // Waiting the full timeout would stall the main turn for minutes after
  // the advisor is gone — the turn's end settles it instead.
  const waiting = waitForConsult("collab:q:expire", {
    sessionID: "ses_gone",
  });
  const other = waitForConsult("collab:q:keep", {
    sessionID: "ses_other",
  });
  expect(expireSessionConsults("ses_gone", "turn ended")).toBe(1);
  expect(await waiting).toEqual({
    state: "unavailable",
    reason: "turn ended",
  });
  // Another session's consults are untouched.
  expect(pendingConsultSession("collab:q:keep")).toBe("ses_other");
  resolveConsult("collab:q:keep", "kept", "t");
  expect((await other).state).toBe("answered");
});

test("collab_ask reports unavailable when the turn is cancelled", async () => {
  const { ask } = askToolHarness();
  const controller = new AbortController();
  const pending = ask.execute({ question: "stuck on a recurring error" }, {
    sessionID,
    signal: controller.signal,
  } as never) as Promise<string>;
  controller.abort();
  const result = JSON.parse(await pending) as {
    consult: string;
    reason?: string;
  };
  expect(result.consult).toBe("unavailable");
  expect(result.reason).toContain("cancelled");
});
