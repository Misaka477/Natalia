import { expect, test } from "bun:test";
import { feedbackActions, rateableRow } from "../src/feedback-actions";

/**
 * L2's feedback entry as pure decisions (D6a): the thumbs belong on a
 * confirmed assistant ANSWER. A streaming tail has no answer yet, a
 * thinking row is not an answer, and a user's own message is not the
 * model's output. The click itself journals a `feedback.recorded` event
 * through the runtime's feedback face and never reaches the model — the
 * isolation is structural there; these rules only decide where the buttons
 * appear.
 */

test("only a confirmed assistant answer carries the thumbs", () => {
  expect(rateableRow({ role: "assistant", text: "the guards pass now" })).toBe(
    true,
  );
  // A streaming tail: the answer is still arriving.
  expect(
    rateableRow({ role: "assistant", text: "the guards…", streaming: true }),
  ).toBe(false);
  // A reasoning row: behind its own disclosure, never an answer.
  expect(
    rateableRow({ role: "assistant", text: "let me think", thinking: true }),
  ).toBe(false);
  // The user's own message is not the model's output.
  expect(rateableRow({ role: "user", text: "why is it red" })).toBe(false);
  expect(rateableRow({ role: "system", text: "a notice" })).toBe(false);
  // An empty assistant row has nothing to rate.
  expect(rateableRow({ role: "assistant", text: "   " })).toBe(false);
});

test("the two thumbs actions name the verdict, and a rated row says so", () => {
  const rated: string[] = [];
  const actions = feedbackActions({
    row: { role: "assistant", text: "done" },
    rate: (verdict) => rated.push(verdict),
  });
  expect(actions.map((action) => action.label)).toEqual(["👍", "👎"]);
  actions[0]!.onClick();
  actions[1]!.onClick();
  expect(rated).toEqual(["up", "down"]);

  // The row's own state: an already-recorded verdict is labeled, not offered
  // again as if nothing happened.
  const afterUp = feedbackActions({
    row: { role: "assistant", text: "done" },
    verdict: "up",
    rate: () => {},
  });
  expect(afterUp.map((action) => action.label)).toEqual(["👍 已记录", "👎"]);
});

test("a row that is not rateable gets no actions at all", () => {
  expect(
    feedbackActions({
      row: { role: "user", text: "hello" },
      rate: () => {},
    }),
  ).toEqual([]);
  expect(
    feedbackActions({
      row: { role: "assistant", text: "half a", streaming: true },
      rate: () => {},
    }),
  ).toEqual([]);
});
