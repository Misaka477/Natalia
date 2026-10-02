import type { RuntimeEvent } from "@anthelia/contracts";

/**
 * The consult ledger — the advisor pattern's measurement spine (the
 * Navi advisor plan's block D).
 *
 * The raw material already exists: the main agent asks Navi through
 * `collab_ask` (a collaboration message of kind "question" from
 * main_agent) and Navi answers with `collab_answer` (kind "answer",
 * replying to the question). This fold pairs the two into consult
 * records and folds those into the distribution the advisor policy
 * will eventually be tuned on: how often the main agent consults, how
 * long it waits, and how many asks never get answered.
 *
 * The outcome vocabulary is what the journal can express: `open` (asked,
 * never answered), `declined` (the advisor refused — out of remit — and
 * the advisor contract's second discipline made that a first-class
 * outcome), and `answered` (anything else). The applied-or-ignored leg
 * stays v2: it has no measurable producer yet, and a field with no
 * writer is the half-wired shape this house refuses.
 *
 * Previews, never bodies: the journal keeps every entry for the audit
 * trail; a report carries bounded previews so a consult's content can
 * be eyeballed without pasting a conversation into a table.
 */

export type ConsultOutcome = "open" | "answered" | "declined";

export type ConsultRecord = {
  questionID: string;
  threadID: string;
  sessionID?: string;
  askedAt: string;
  answeredAt?: string;
  /** Asked → answered, in milliseconds; undefined while open. */
  latencyMs?: number;
  outcome: ConsultOutcome;
  questionPreview: string;
  answerPreview?: string;
};

export type ConsultSummary = {
  asked: number;
  answered: number;
  declined: number;
  open: number;
  /** Minutes between ask and answer, over the answered ones. */
  avgLatencyMs?: number;
  maxLatencyMs?: number;
};

/** Preview bounds — a table row, never a transcript. */
const QUESTION_PREVIEW_CHARS = 80;
const ANSWER_PREVIEW_CHARS = 120;

/** The collaboration message events, in the namespaced shape the journal carries. */
type CollabMessageEvent = Extract<
  RuntimeEvent,
  { type: `${string}.collab.message` }
>;

function collabMessages(
  events: readonly RuntimeEvent[],
): Array<{ sessionID?: string; message: CollabMessageEvent["message"] }> {
  const rows: Array<{
    sessionID?: string;
    message: CollabMessageEvent["message"];
  }> = [];
  for (const event of events) {
    if (!event.type.endsWith(".collab.message")) continue;
    rows.push({
      sessionID: (event as { sessionID?: string }).sessionID,
      message: (event as CollabMessageEvent).message,
    });
  }
  return rows;
}

function preview(text: string, bound: number): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > bound ? `${compact.slice(0, bound)}…` : compact;
}

/**
 * Pairs the journal's consult questions with their answers, in journal
 * order. A question whose answer never appears stays `open` — an
 * unanswered consult is a fact (the advisor was asked and never
 * answered), not a gap to hide. Answers without a question (a torn
 * journal) are ignored: an unpaired answer is not a consult.
 */
export function consultRecords(
  events: readonly RuntimeEvent[],
): ConsultRecord[] {
  const byQuestion = new Map<string, ConsultRecord>();
  const order: ConsultRecord[] = [];
  for (const { sessionID, message } of collabMessages(events)) {
    if (message.kind === "question" && message.from === "main_agent") {
      const record: ConsultRecord = {
        questionID: message.id,
        threadID: message.threadID,
        ...(sessionID ? { sessionID } : {}),
        askedAt: message.at,
        outcome: "open",
        questionPreview: preview(message.text, QUESTION_PREVIEW_CHARS),
      };
      byQuestion.set(message.id, record);
      order.push(record);
      continue;
    }
    if (message.kind === "answer" && message.replyToID) {
      const record = byQuestion.get(message.replyToID);
      if (!record || record.outcome !== "open") continue;
      record.outcome =
        message.advisorOutcome === "declined" ? "declined" : "answered";
      record.answeredAt = message.at;
      record.latencyMs = Math.max(
        0,
        Date.parse(message.at) - Date.parse(record.askedAt),
      );
      record.answerPreview = preview(message.text, ANSWER_PREVIEW_CHARS);
    }
  }
  return order;
}

/** The distribution: counts by outcome plus the wait's spread. */
export function consultSummary(
  records: readonly ConsultRecord[],
): ConsultSummary {
  const answered = records.filter((record) => record.outcome === "answered");
  const declined = records.filter((record) => record.outcome === "declined");
  // The wait happened for declined consults too — the latency spread is
  // over every consult that got any answer, not only the advised ones.
  const latencies = records
    .map((record) => record.latencyMs)
    .filter((latency): latency is number => latency !== undefined);
  return {
    asked: records.length,
    answered: answered.length,
    declined: declined.length,
    open: records.length - answered.length - declined.length,
    ...(latencies.length
      ? {
          avgLatencyMs: Math.round(
            latencies.reduce((sum, latency) => sum + latency, 0) /
              latencies.length,
          ),
          maxLatencyMs: Math.max(...latencies),
        }
      : {}),
  };
}
