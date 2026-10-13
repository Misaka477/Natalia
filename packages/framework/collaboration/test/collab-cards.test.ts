import { expect, test } from "bun:test";
import {
  collabAskOutput,
  collabChatOutput,
  collabInboxOutput,
  collabRespondOutput,
} from "../src/collab-cards";

/**
 * The main agent's four collab cards (presentation plan P1.1): the call
 * card names what the call IS, the result card the one-line state plus the
 * ids a reader scans. The audit ⑥ discipline applies verbatim — an internal
 * token never rides the card, so `collab_inbox`'s paging cursor shows up
 * nowhere on the reader's card while the model still pages with it.
 */

test("collab_respond: the call names the decision, the result confirms it", () => {
  const call = collabRespondOutput.presentCall!({
    messageID: "collab:suggestion:1",
    decision: "adopted",
  });
  expect(call).toMatchObject({
    kind: "generic",
    title: "suggestion",
    summary: "adopted",
  });
  const result = collabRespondOutput.presentResult!(
    {},
    JSON.stringify({ responded: true, decision: "adopted" }),
  );
  expect(result).toMatchObject({
    kind: "generic",
    title: "suggestion",
    summary: "responded",
    meta: [["decision", "adopted"]],
  });
});

test("collab_inbox: the counts ride, the cursor never does", () => {
  const call = collabInboxOutput.presentCall!({});
  expect(call).toMatchObject({ title: "inbox", summary: "read" });
  const result = collabInboxOutput.presentResult!(
    {},
    JSON.stringify({
      messages: [],
      returned: 8,
      total: 23,
      truncated: true,
      nextCursor: "eyJhbGciOiJIUzI1NiJ9",
    }),
  ) as { summary?: unknown; meta?: Array<[string, string]> };
  expect(result.summary).toBe("8 of 23 messages");
  expect(result.meta).toEqual([
    ["returned", "8"],
    ["total", "23"],
  ]);
  // The cursor is the MODEL's paging token; a reader must never see it.
  expect(JSON.stringify(result)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
});

test("collab_chat: send and reply read differently, the recipient rides", () => {
  const send = collabChatOutput.presentCall!({ text: "hi" });
  expect(send).toMatchObject({ title: "message", summary: "send" });
  const reply = collabChatOutput.presentCall!({
    text: "hi",
    messageID: "collab:chat:1",
  });
  expect(reply).toMatchObject({ summary: "reply" });
  const result = collabChatOutput.presentResult!(
    {},
    JSON.stringify({ sent: true, messageID: "collab:chat:9", to: "nia" }),
  );
  expect(result).toMatchObject({
    title: "message",
    summary: "sent",
    meta: [
      ["messageID", "collab:chat:9"],
      ["to", "nia"],
    ],
  });
});

test("collab_ask: the consult's own state is the summary", () => {
  const call = collabAskOutput.presentCall!({ question: "which db?" });
  expect(call).toMatchObject({ title: "question", summary: "ask" });
  const answered = collabAskOutput.presentResult!(
    {},
    JSON.stringify({ consult: "answered", advice: "use sqlite" }),
  );
  expect(answered).toMatchObject({ title: "advice", summary: "answered" });
  const timedOut = collabAskOutput.presentResult!(
    {},
    JSON.stringify({ consult: "timeout", reason: "no answer in budget" }),
  );
  expect(timedOut).toMatchObject({ summary: "timeout" });
});

test("a malformed result degrades to the summary, never throws", () => {
  // The collab discipline: a card that throws takes the transcript row down.
  for (const output of [
    collabRespondOutput,
    collabInboxOutput,
    collabChatOutput,
    collabAskOutput,
  ]) {
    const card = output.presentResult!({}, "not json");
    expect(card).toMatchObject({ kind: "generic" });
    expect((card as { meta?: unknown }).meta).toBeUndefined();
  }
});
