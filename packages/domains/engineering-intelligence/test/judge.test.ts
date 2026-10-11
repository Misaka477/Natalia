import { expect, test } from "bun:test";
import { buildJudgeRequest, dimensionsFrom } from "../src/judge";
import { parseVerdict } from "../src/verdict";

/**
 * S9's eval judge: Nia scores the three dimensions the cheap judge cannot
 * see. A dimension she does not score is reported UNJUDGED, never invented.
 */

const verdict = (reasons: string, judgment = "mixed") =>
  parseVerdict(
    [
      "VERDICT:",
      "turn: n/a",
      `judgment: ${judgment}`,
      `reasons: ${reasons}`,
    ].join("\n"),
  )!;

test("the request asks for the three numbers and names the payload", () => {
  const request = buildJudgeRequest({
    task: "fix the flaky test",
    answer: "I pinned the clock.",
    instruction: "Always record the rollback step.",
  });
  expect(request).toContain("eval judge");
  expect(request).toContain("correctness: did it do the task right?");
  expect(request).toContain("procedure: did it follow the instruction below?");
  // The instruction rides — procedure has no criterion without it (W1).
  expect(request).toContain("Always record the rollback step.");
  // No instruction in play: she is told to score procedure as n/a rather
  // than guessing.
  const bare = buildJudgeRequest({ task: "t", answer: "a" });
  expect(bare).toContain("score procedure as n/a");
});

test("her three scores become the three dimensions", () => {
  const parsed = dimensionsFrom(
    verdict(
      "correctness: 0.9 procedure: 0.5 conciseness: 0.8 — the answer missed one instruction step",
    ),
  );
  expect(parsed.dimensions).toEqual({
    correctness: 0.9,
    procedureFollowing: 0.5,
    conciseness: 0.8,
  });
  expect(parsed.unjudged).toEqual([]);
});

test("a dimension she declines stays UNJUDGED, never invented", () => {
  const parsed = dimensionsFrom(
    verdict("correctness: 0.9 procedure: n/a conciseness: 0.7"),
  );
  expect(parsed.dimensions.procedureFollowing).toBe(1);
  expect(parsed.unjudged).toEqual(["procedureFollowing"]);
  // And an unscored correctness is 0 — not 0.5 (the reference harness's
  // parse-failure default let a broken judge wave candidates through).
  const noScores = dimensionsFrom(verdict("I could not score this"));
  expect(noScores.dimensions.correctness).toBe(0);
  expect(noScores.unjudged).toEqual(["procedureFollowing", "conciseness"]);
  // No verdict at all is the same, not a pass.
  expect(dimensionsFrom(undefined).dimensions.correctness).toBe(0);
});

test("the judge request carries the rubric — she grades a criterion, not an impression", () => {
  // W2(a)'s judge-model half: without the rubric the request asks her to
  // score "did it do the task right" against her own reading; with it she
  // scores against a stated criterion. That is the difference between
  // judging and grading.
  const withRubric = buildJudgeRequest({
    task: "how should I handle a flaky test?",
    answer: "Re-run it in isolation.",
    expected_behavior: "re-runs in isolation, then pins the nondeterminism",
  });
  expect(withRubric).toContain("A good answer to this task should:");
  expect(withRubric).toContain(
    "re-runs in isolation, then pins the nondeterminism",
  );
  // And the rubric rides ABOVE the answer: a judge who reads the criterion
  // first is not anchored by the attempt.
  expect(withRubric.indexOf("A good answer")).toBeLessThan(
    withRubric.indexOf("Answer under judgment"),
  );
  // Absent, the request says nothing about a criterion (no invented one).
  const without = buildJudgeRequest({
    task: "how should I handle a flaky test?",
    answer: "Re-run it in isolation.",
  });
  expect(without).not.toContain("A good answer");
});
