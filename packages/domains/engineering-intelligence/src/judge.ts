/**
 * S9's eval-judge payload: Nia as L3's judge (W12's dissolution point).
 *
 * The cheap judge scores keyword overlap against the recorded response —
 * coverage, and nothing else. Procedure following had no criterion until
 * W1 gave the judge the instruction; conciseness has never been measured
 * at all (it rides as a constant 1, which makes half the composite formula
 * dead weight). Nia reads the (task, answer) pair and scores all three,
 * which is what the reference harness's LLM-as-judge does at a price we
 * now pay through a sister we already have.
 *
 * Two pure halves, so the wiring is a one-liner: what to ask her, and how
 * her numbers become the dimensions. A dimension she does not score stays
 * UNJUDGED — an absent score is never invented.
 */

import type { ParsedVerdict } from "./verdict";

/** What the judge asks her to score. */
export function buildJudgeRequest(input: {
  /** The task the answer was for. */
  task: string;
  /** The answer under judgment. */
  answer: string;
  /** The instruction the answer was produced under (procedure's criterion). */
  instruction?: string;
  /**
   * W2(a): the RUBRIC — what a good answer to this task should contain or
   * do. Without it the judge scores against her own impression of "right";
   * with it she scores against a stated criterion, which is the whole
   * difference between judging and grading.
   */
  expected_behavior?: string;
}): string {
  return [
    "VERDICT REQUEST — eval judge (not a plan audit, not a candidate gate).",
    "Score this answer on three dimensions, 0.0 to 1.0 each:",
    "correctness: did it do the task right?",
    "procedure: did it follow the instruction below?",
    "conciseness: is it free of padding without omitting what matters?",
    "",
    `Task: ${input.task}`,
    ...(input.expected_behavior?.trim()
      ? ["A good answer to this task should:", input.expected_behavior]
      : []),
    ...(input.instruction
      ? ["Instruction the answer followed:", input.instruction]
      : ["(no instruction was in play — score procedure as n/a)"]),
    "Answer under judgment:",
    input.answer,
    "",
    "Answer with your verdict, opening with VERDICT: on its own line, then:",
    "turn: n/a",
    "judgment: good|mixed|bad",
    "correctness: <0.0-1.0>",
    "procedure: <0.0-1.0 or n/a>",
    "conciseness: <0.0-1.0>",
    "reasons: <the concrete evidence for each score>",
  ].join("\n");
}

/** A parsed score, or undefined when she declined to give one. */
function scoreOf(verdict: ParsedVerdict, field: string): number | undefined {
  // A field may start a line OR follow another field on the same line
  // ("correctness: 0.9 procedure: 0.5 ..."), so the anchor is any
  // whitespace — otherwise only the first score on a line is ever read.
  const match = new RegExp(
    `(?:^|\\s)${field}:\\s*([01](?:\\.\\d+)?|n/a)`,
    "iu",
  ).exec(verdict.reasons);
  if (!match) return undefined;
  if (match[1]!.toLowerCase() === "n/a") return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;
}

/**
 * Her verdict as fitness dimensions. The overall judgment is not one of
 * the three — it rides along as her summary. A dimension she did not score
 * is reported UNJUDGED rather than defaulted: an invented score is worse
 * than a missing one, because it silently moves the composite.
 */
export function dimensionsFrom(verdict: ParsedVerdict | undefined): {
  dimensions: {
    correctness: number;
    procedureFollowing: number;
    conciseness: number;
  };
  unjudged: Array<"procedureFollowing" | "conciseness">;
} {
  const correctness = verdict ? scoreOf(verdict, "correctness") : undefined;
  const procedure = verdict ? scoreOf(verdict, "procedure") : undefined;
  const conciseness = verdict ? scoreOf(verdict, "conciseness") : undefined;
  const unjudged: Array<"procedureFollowing" | "conciseness"> = [];
  if (procedure === undefined) unjudged.push("procedureFollowing");
  if (conciseness === undefined) unjudged.push("conciseness");
  return {
    // An unscored correctness is 0 — not 0.5 (the reference harness's
    // parse-failure default let a broken judge wave candidates through).
    dimensions: {
      correctness: correctness ?? 0,
      procedureFollowing: procedure ?? 1,
      conciseness: conciseness ?? 1,
    },
    unjudged,
  };
}
