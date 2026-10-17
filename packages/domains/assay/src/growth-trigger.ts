import type { GrowthSuggestion } from "./growth";
import type { RunGroup } from "./run-scorer";
import type { CorrectionSuggestion } from "./corrections";

/**
 * The growth branch's trigger face (the user's directive's last item —
 * the study's "G-d + 触发面"). The four growth systems each answer their
 * own view; the trigger is the judgment that ASSEMBLES them into one
 * answer: which growth signal deserves the human's attention now.
 *
 * The study's policy is the shape: growth 默认不自授权 — the trigger
 * NEVER applies anything; it names each triggered signal with its
 * evidence and its destination class, so the human (or the constitution's
 * approval policy) decides. The trigger's questions:
 *
 *  1. does the same prompt keep failing? (G-b's distribution)
 *  2. do the external tasks show a systematic gap? (G-c's joins)
 *  3. does the human keep writing the same correction? (G-d's clusters)
 *  4. does the curriculum name a capability nothing else explains?
 *     (G-a's repeated gaps — the fallback carrier)
 *
 * Each rule's threshold is a named constant below — the policy of THIS
 * module, not a fact of nature, and an operator tunes it deliberately.
 */

/** A prompt's success rate at or below this triggers (percent). */
const MIN_PROMPT_SUCCESS_RATE = 50;
/** A joined task's rate this far below its baseline triggers (points). */
const MIN_BASELINE_GAP = 20;
/** A correction cluster this large triggers. */
const MIN_CORRECTION_OBSERVATIONS = 3;

export type TriggerClass =
  /** A new skill (the study's auto-applyable class). */
  | "skill"
  /** A constitution/policy change (the human's class). */
  | "rule"
  /** A policy row change (the human's class). */
  | "policy"
  /** A kernel-generation change (the human + verification's class). */
  | "generation";

export type GrowthTrigger = {
  /** Which rule fired (the trigger's own provenance). */
  rule:
    | "prompt_success"
    | "benchmark_gap"
    | "correction_pattern"
    | "capability_gap";
  /** The destination class the study's approval policy names. */
  class: TriggerClass;
  /** The human-facing subject. */
  capability: string;
  /** The evidence that fired it (numbers, verbatim from the source). */
  evidence: Record<string, number | string>;
  reason: string;
};

export type GrowthTriggerInput = {
  /** G-b's per-prompt distributions (same prompt, many runs). */
  runGroups?: readonly RunGroup[];
  /** G-c's per-task comparison (our runs beside the baseline). */
  joins?: ReadonlyArray<{
    externalTaskID: string;
    baselineSuccessRate: number;
    ourRuns: number;
    ourSuccessRate: number;
  }>;
  /** G-d's correction patterns. */
  corrections?: readonly CorrectionSuggestion[];
  /** G-a's curriculum suggestions (the fallback carrier). */
  curriculum?: readonly GrowthSuggestion[];
};

/**
 * The trigger's rules, in the study's priority: the failing prompt, the
 * systematic benchmark gap, the repeated correction, then the
 * curriculum's capability gap. Every rule answers its evidence with the
 * source's own numbers — a trigger without its numbers is an assertion.
 */
export function deriveGrowthTriggers(
  input: GrowthTriggerInput,
): GrowthTrigger[] {
  const triggers: GrowthTrigger[] = [];
  for (const group of input.runGroups ?? []) {
    if (group.runs < 2) continue; // one run is not a distribution
    if (group.successRate > MIN_PROMPT_SUCCESS_RATE) continue;
    triggers.push({
      rule: "prompt_success",
      class: "skill",
      capability: group.promptKey,
      evidence: {
        runs: group.runs,
        successes: group.successes,
        successRate: group.successRate,
        threshold: MIN_PROMPT_SUCCESS_RATE,
      },
      reason: `the prompt's ${group.successes}/${group.runs} runs succeeded (${group.successRate}%), at or below the ${MIN_PROMPT_SUCCESS_RATE}% line`,
    });
  }
  for (const join of input.joins ?? []) {
    const gap = Math.round(
      (join.baselineSuccessRate - join.ourSuccessRate) * 100,
    );
    if (gap < MIN_BASELINE_GAP) continue;
    triggers.push({
      rule: "benchmark_gap",
      class: "skill",
      capability: join.externalTaskID,
      evidence: {
        ourRuns: join.ourRuns,
        ourSuccessRate: Math.round(join.ourSuccessRate * 100),
        baselineSuccessRate: Math.round(join.baselineSuccessRate * 100),
        gap,
        margin: MIN_BASELINE_GAP,
      },
      reason: `the task's baseline succeeds ${Math.round(join.baselineSuccessRate * 100)}%, our runs ${Math.round(join.ourSuccessRate * 100)}% (${gap} points below)`,
    });
  }
  for (const correction of input.corrections ?? []) {
    if (correction.observations < MIN_CORRECTION_OBSERVATIONS) continue;
    triggers.push({
      rule: "correction_pattern",
      class: correction.destination === "tool" ? "policy" : "rule",
      capability: correction.capability,
      evidence: {
        observations: correction.observations,
        threshold: MIN_CORRECTION_OBSERVATIONS,
      },
      reason: `the correction "${correction.capability}" recurred ${correction.observations} times — the human keeps writing it`,
    });
  }
  for (const suggestion of input.curriculum ?? []) {
    triggers.push({
      rule: "capability_gap",
      class: suggestion.kind === "rule" ? "rule" : "skill",
      capability: suggestion.capability,
      evidence: {
        observations: suggestion.observations,
      },
      reason: suggestion.reason,
    });
  }
  return triggers;
}
