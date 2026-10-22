/**
 * Parsing for the compact transcript row that represents a `<goal_round>`
 * internal turn. Kept dependency-free so it is easy to unit test.
 */
export type GoalRoundView = {
  round: number;
  maxGoalRounds: number;
  objective: string;
  detail: string;
};

/** Returns undefined for any text that is not a rendered goal-round prompt. */
export function parseGoalRoundPrompt(text: string): GoalRoundView | undefined {
  if (!text.startsWith("<goal_round>")) return undefined;
  const roundMatch = /^Round:\s*(\d+)\/(\d+|unlimited)\s*$/mu.exec(text);
  if (!roundMatch) return undefined;
  const objectiveMatch = /^Objective:\s*(.+?)\s*$/mu.exec(text);
  let objective = "";
  if (objectiveMatch) {
    const raw = objectiveMatch[1]!;
    try {
      const parsed = JSON.parse(raw) as unknown;
      objective = typeof parsed === "string" ? parsed : raw;
    } catch {
      objective = raw.replace(/^"|"$/gu, "");
    }
  }
  return {
    round: Number(roundMatch[1]),
    maxGoalRounds: roundMatch[2] === "unlimited" ? 0 : Number(roundMatch[2]),
    objective,
    detail: text,
  };
}
