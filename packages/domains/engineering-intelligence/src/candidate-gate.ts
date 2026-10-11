/**
 * S9's candidate-gate payload: the request Nia is asked to answer, and the
 * mapping from her answer into the seven gates' seam.
 *
 * The G1 seam used to answer a static "unverified — the optimize path does
 * not run the suite". That is honest but it makes every gate report the
 * same thing forever. Nia's surface already allows verification-only shell
 * (test runners, typecheckers, linters, build checks — her persona says so
 * in as many words), so the seam's real answer is HER verdict.
 *
 * Two pure halves, so the wiring is a one-liner that cannot get either
 * wrong: what to ask her, and how her `VERDICT:` answer becomes a
 * `SuiteVerdict` the gate matrix consumes.
 */

import type { ParsedVerdict } from "./verdict";

/** What the gate asks her to check. */
export function buildGateRequest(input: {
  /** The candidate's name (which artifact is being gated). */
  candidate: string;
  /** The unified diff against the baseline, so she sees WHAT changed. */
  diff: string;
  /** The command that would run the suite, in her words. */
  suiteCommand: string;
}): string {
  return [
    "VERDICT REQUEST — candidate gate (not a plan audit, not a turn verdict).",
    `Candidate: ${input.candidate}`,
    `Suite: run \`${input.suiteCommand}\` and report its exit status.`,
    "",
    "The diff under review:",
    "```diff",
    input.diff.trim() || "(empty — the candidate is identical to the baseline)",
    "```",
    "",
    "Answer with your verdict, opening with VERDICT: on its own line, then:",
    "turn: n/a",
    "judgment: pass|fail",
    "reasons: the suite's exit status and, on failure, the first concrete failure",
  ].join("\n");
}

/**
 * Her verdict as the gate's suite answer.
 *
 * A judgment of `pass` is a passing suite; anything else is a failing one
 * and the detail carries her words verbatim — a gate that refuses must
 * name the reason, and the reason is hers, not a paraphrase.
 */
export function suiteVerdictFrom(verdict: ParsedVerdict | undefined): {
  ok: boolean;
  detail: string;
} {
  if (!verdict)
    return {
      ok: false,
      detail: "no verdict arrived — the gate is unverified, not passed",
    };
  const ok = verdict.judgment.trim().toLowerCase() === "pass";
  return {
    ok,
    detail: ok
      ? `Nia ran the suite: ${verdict.reasons || "passed"}`
      : `Nia ran the suite and it failed: ${verdict.reasons || verdict.judgment}`,
  };
}
