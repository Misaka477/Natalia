import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { consultRecords, consultSummary } from "../src/consult-ledger";

/**
 * The consult ledger's pins (the Navi advisor plan's block D): the
 * journal's raw consult material (main agent's question, Navi's
 * answer) paired into records, with open consults kept as facts and
 * unpaired answers ignored.
 */

function question(
  id: string,
  text: string,
  at: string,
  from: "main_agent" | "live_chat" = "main_agent",
): RuntimeEvent {
  return {
    type: "natalia.collab.message",
    sessionID: "ses_a",
    message: {
      id,
      threadID: `thread_${id}`,
      from,
      to: from === "main_agent" ? "live_chat" : "main_agent",
      kind: "question",
      text,
      expectsReply: true,
      at,
    },
  } as unknown as RuntimeEvent;
}

function answer(
  id: string,
  replyToID: string,
  text: string,
  at: string,
  advisorOutcome?: "advised" | "declined",
): RuntimeEvent {
  return {
    type: "navi.collab.message",
    sessionID: "ses_a",
    message: {
      id,
      threadID: `thread_${replyToID}`,
      from: "live_chat",
      to: "main_agent",
      kind: "answer",
      replyToID,
      text,
      expectsReply: false,
      ...(advisorOutcome ? { advisorOutcome } : {}),
      at,
    },
  } as unknown as RuntimeEvent;
}

test("a consult is paired into a record with its latency and previews", () => {
  const records = consultRecords([
    question(
      "collab:q:1",
      "Should I save the regex to /app?",
      "2026-09-26T10:00:00.000Z",
    ),
    answer(
      "collab:a:1",
      "collab:q:1",
      "/app needs root; write it to the workspace root instead.",
      "2026-09-26T10:00:12.000Z",
    ),
  ]);
  expect(records).toHaveLength(1);
  const [record] = records;
  expect(record!.outcome).toBe("answered");
  expect(record!.latencyMs).toBe(12_000);
  expect(record!.askedAt).toBe("2026-09-26T10:00:00.000Z");
  expect(record!.answeredAt).toBe("2026-09-26T10:00:12.000Z");
  expect(record!.questionPreview).toBe("Should I save the regex to /app?");
  expect(record!.answerPreview).toBe(
    "/app needs root; write it to the workspace root instead.",
  );
});

test("a decline is a first-class outcome, not a missing answer", () => {
  const records = consultRecords([
    question(
      "collab:q:1",
      "approve this architecture?",
      "2026-09-26T10:00:00.000Z",
    ),
    answer(
      "collab:a:1",
      "collab:q:1",
      "declining: product tradeoffs are outside my technical remit",
      "2026-09-26T10:00:08.000Z",
      "declined",
    ),
  ]);
  expect(records[0]!.outcome).toBe("declined");
  expect(records[0]!.latencyMs).toBe(8_000);
  expect(consultSummary(records)).toMatchObject({
    asked: 1,
    answered: 0,
    declined: 1,
    open: 0,
    avgLatencyMs: 8_000,
  });
});

test("an unanswered consult stays open — the unanswered ask is a fact", () => {
  const records = consultRecords([
    question("collab:q:1", "commit now?", "2026-09-26T10:00:00.000Z"),
  ]);
  expect(records).toHaveLength(1);
  expect(records[0]!.outcome).toBe("open");
  expect(records[0]!.latencyMs).toBeUndefined();
  expect(records[0]!.answeredAt).toBeUndefined();
});

test("an unpaired answer is not a consult (a torn journal)", () => {
  const records = consultRecords([
    answer(
      "collab:a:9",
      "collab:q:missing",
      "advice for a lost question",
      "2026-09-26T10:01:00.000Z",
    ),
  ]);
  expect(records).toEqual([]);
});

test("a second answer to the same consult does not rewrite the record", () => {
  const records = consultRecords([
    question("collab:q:1", "which approach?", "2026-09-26T10:00:00.000Z"),
    answer(
      "collab:a:1",
      "collab:q:1",
      "approach A",
      "2026-09-26T10:00:05.000Z",
    ),
    answer(
      "collab:a:2",
      "collab:q:1",
      "approach B",
      "2026-09-26T10:00:09.000Z",
    ),
  ]);
  expect(records).toHaveLength(1);
  expect(records[0]!.answerPreview).toBe("approach A");
  expect(records[0]!.latencyMs).toBe(5_000);
});

test("only the main agent's questions are consults", () => {
  // Navi asking a question (or her own suggestions) is the other
  // direction of collaboration, not the advisor path.
  const records = consultRecords([
    question(
      "collab:q:1",
      "what should I do next?",
      "2026-09-26T10:00:00.000Z",
      "live_chat",
    ),
  ]);
  expect(records).toEqual([]);
});

test("previews are bounded — a table row, never a transcript", () => {
  const records = consultRecords([
    question("collab:q:1", "x".repeat(300), "2026-09-26T10:00:00.000Z"),
    answer(
      "collab:a:1",
      "collab:q:1",
      "y".repeat(400),
      "2026-09-26T10:00:05.000Z",
    ),
  ]);
  expect(records[0]!.questionPreview.length).toBeLessThanOrEqual(81);
  expect(records[0]!.answerPreview!.length).toBeLessThanOrEqual(121);
  expect(records[0]!.questionPreview.endsWith("…")).toBe(true);
});

test("the summary counts the outcomes and the wait's spread", () => {
  const records = consultRecords([
    question("collab:q:1", "one?", "2026-09-26T10:00:00.000Z"),
    answer("collab:a:1", "collab:q:1", "yes", "2026-09-26T10:00:04.000Z"),
    question("collab:q:2", "two?", "2026-09-26T10:01:00.000Z"),
    answer("collab:a:2", "collab:q:2", "no", "2026-09-26T10:01:20.000Z"),
    question("collab:q:3", "three?", "2026-09-26T10:02:00.000Z"),
  ]);
  expect(consultSummary(records)).toEqual({
    asked: 3,
    answered: 2,
    declined: 0,
    open: 1,
    avgLatencyMs: 12_000,
    maxLatencyMs: 20_000,
  });
});

test("an empty journal is a zero summary", () => {
  expect(consultRecords([])).toEqual([]);
  expect(consultSummary([])).toEqual({
    asked: 0,
    answered: 0,
    declined: 0,
    open: 0,
  });
});
