/**
 * The quality gate on a subagent's final answer.
 *
 * The parent receives only the subagent's final text, so a one-word answer
 * leaves it with nothing to act on and no way to tell that from a complete one.
 * Rather than accept it, the gate gives the subagent one more turn and names
 * what is missing, because a model told only to say "more" restates the same
 * sentence at greater length.
 */

import type { ContextLedger } from "@anthelia/runtime";
import type { ProviderToolCall } from "@anthelia/runtime";

/** What the gate needs to run one more provider step. */
export type ResultStepRunner = (step: number) => Promise<{
  output: string;
  calls: ProviderToolCall[];
}>;

export interface EnsureUsableResultInput {
  ledger: ContextLedger;
  /** Status setter on the record, so the extra turn is visible as activity. */
  setStatus: (status: string) => void;
  step: number;
  output: string;
  /** Shortest acceptable answer; `0` or less disables the gate. */
  minChars: number;
  runStep: ResultStepRunner;
}

/**
 * The prompt used when a subagent's final answer is too short to be useful.
 *
 * It names what is missing rather than asking for "more", because a model told
 * only that will usually restate the same sentence at greater length.
 */
export const RESULT_TOO_BRIEF_PROMPT = [
  "Your previous response was too brief to be useful to the agent that delegated this task.",
  "Provide a more comprehensive summary that includes:",
  "1. Specific technical details and implementations.",
  "2. Detailed findings and analysis.",
  "3. All important information the parent agent should know.",
  "Do not repeat what you already said; add the detail that is missing.",
].join("\n");

/** Whether an answer is short enough to be worth one more turn. */
export function resultNeedsExpansion(
  output: string,
  minChars: number,
): boolean {
  if (minChars <= 0) return false;
  return output.trim().length < minChars;
}

/**
 * Give a subagent whose final answer is too short one more turn.
 *
 * At most once, and it may use one step beyond the nominal cap: a result nobody
 * can act on is worse than one extra step, and the step budget bounds the work
 * rather than the right to a usable answer.
 *
 * Returns the replacement answer, or the original when the gate does not apply
 * or the extra turn failed the same bar. A second one-liner is not an
 * improvement, and the parent can retry instead.
 */
export async function ensureUsableResult(
  input: EnsureUsableResultInput,
): Promise<string> {
  if (!resultNeedsExpansion(input.output, input.minChars)) return input.output;
  input.setStatus("running");
  // The ask has to reach the model as a real turn, so it joins the ledger rather
  // than being passed beside it.
  input.ledger.add({
    id: `result-too-brief:${input.step + 1}`,
    role: "user",
    content: RESULT_TOO_BRIEF_PROMPT,
  });
  const extra = await input.runStep(input.step + 1);
  const candidate = extra.output.trim();
  // The replacement has to clear the same bar as the original, not merely beat
  // it: a padded version of the same one-liner would hide the failure instead of
  // reporting it, and the parent can retry.
  return resultNeedsExpansion(candidate, input.minChars)
    ? input.output
    : candidate;
}
