import { expect, test } from "bun:test";
import { assistantAnswerFromPage } from "../src/turn-answer";

/**
 * One daemon turn's answer, located BY TURN. Every sample of every
 * candidate submits into the same session, so "the last assistant row"
 * is only right for the newest turn — and for a turn that answered
 * nothing it is the PREVIOUS sample's answer, scored as this one's. The
 * defect this module exists to prevent produced data that looked like a
 * weak candidate instead of like corruption.
 */

const assistantTurn = (turnID: string, text: string) => ({
  turnID,
  submitted: { id: turnID },
  rows: [
    { kind: "user", event: { type: "turn.input", text: "the task" } },
    { kind: "assistant", event: { type: "content.done", text } },
  ],
});

test("the turn's own answer is found by its id", () => {
  const page = {
    data: [
      assistantTurn("turn_a", "the first sample's answer"),
      assistantTurn("turn_b", "the second sample's answer"),
    ],
  };
  expect(assistantAnswerFromPage(page, "turn_a")).toEqual({
    ok: true,
    text: "the first sample's answer",
  });
  expect(assistantAnswerFromPage(page, "turn_b")).toEqual({
    ok: true,
    text: "the second sample's answer",
  });
});

test("a turn that answered nothing refuses — it never borrows the previous answer", () => {
  // The corruption this prevents: sample 2's turn died, the session's last
  // assistant row is still sample 1's answer. Returning it would score
  // sample 1's text as sample 2's.
  const page = {
    data: [
      assistantTurn("turn_a", "the first sample's answer"),
      {
        turnID: "turn_b",
        submitted: { id: "turn_b" },
        rows: [
          { kind: "user", event: { type: "turn.input", text: "the task" } },
        ],
      },
    ],
  };
  const answer = assistantAnswerFromPage(page, "turn_b");
  expect(answer.ok).toBe(false);
  if (!answer.ok)
    expect(answer.reason).toContain("turn_b produced no assistant");
});

test("an unknown turn id is a refusal, not the newest answer", () => {
  const page = { data: [assistantTurn("turn_a", "an answer")] };
  const answer = assistantAnswerFromPage(page, "turn_zzz");
  expect(answer.ok).toBe(false);
  if (!answer.ok)
    expect(answer.reason).toContain("no projection for turn turn_zzz");
});

test("without a turn id the newest turn is the answer (the single-turn call)", () => {
  const page = {
    data: [assistantTurn("turn_a", "older"), assistantTurn("turn_b", "newest")],
  };
  expect(assistantAnswerFromPage(page, undefined)).toEqual({
    ok: true,
    text: "newest",
  });
});

test("an empty or wrong-shaped page refuses instead of inventing an answer", () => {
  expect(assistantAnswerFromPage({}, "turn_a").ok).toBe(false);
  expect(assistantAnswerFromPage({ data: [] }, "turn_a").ok).toBe(false);
});
