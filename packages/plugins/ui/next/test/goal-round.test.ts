import { expect, test } from "bun:test";
import { parseGoalRoundPrompt } from "../src/goal-round";

test("parses a rendered goal-round prompt", () => {
  const prompt = [
    "<goal_round>",
    'Objective: "继续执行当前计划"',
    "Round: 2/256",
    "",
    "Continue working toward the objective...",
    "</goal_round>",
  ].join("\n");
  expect(parseGoalRoundPrompt(prompt)).toMatchObject({
    round: 2,
    maxGoalRounds: 256,
    objective: "继续执行当前计划",
    detail: prompt,
  });
});

test("treats a zero cap as unlimited", () => {
  const parsed = parseGoalRoundPrompt(
    ["<goal_round>", 'Objective: "ship it"', "Round: 7/unlimited"].join("\n"),
  );
  expect(parsed?.maxGoalRounds).toBe(0);
  expect(parsed?.round).toBe(7);
});

test("ignores ordinary turns and malformed prompts", () => {
  expect(parseGoalRoundPrompt("hello")).toBeUndefined();
  expect(parseGoalRoundPrompt("<goal_round>\nno round line")).toBeUndefined();
});
