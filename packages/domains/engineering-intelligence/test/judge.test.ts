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
