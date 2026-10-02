import type { RuntimeEvent } from "@anthelia/contracts";
import { normalizeGap } from "./growth";

/**
 * Discovery G-d — the repeated correction pattern: "人类在 mailbox/审批
 * 拒绝里的反复模式 → 建议固化为 constitution 规则或技能". The study's
 * approval policy rides the answer: a suggestion is a SUGGESTION (the
 * growth 默认不自授权 line), and its destination (a constitution rule
 * versus a skill) is named, not applied.
 *
 * The three sources, all safe-text by construction:
 *  - `mailbox.queued` with `source: "user_via_live_chat"` — the human's
 *    own messages, read through their `safeSummary` (the body-isolation
 *    seam: the journal keeps the body, this never reads it);
 *  - `completion.human_validation` — the human's validation note on a
 *    completion card (their own words, safe by definition);
 *  - `decision.recorded`'s rejected alternatives — the审批拒绝's
 *    `rejectedReason` (the machine's record of a human refusal).
 *
 * The clustering is the curriculum's (growth.ts): the same normalization
 * and the same pattern threshold — an anecdote corrected once is noise,
 * the same correction repeated is a rule the human keeps writing by
 * hand. The destination is the classifier the curriculum already has
 * (rule/skill/tool/policy keywords).
 */

/** One correction the journal carries, in its safe form. */
export type Correction = {
  /** The safe text (a summary or the human's own validation note). */
  text: string;
  /** Which source it came from (the suggestion's provenance). */
  source: "mailbox" | "human_validation" | "rejected_alternative";
};

export type CorrectionSuggestion = {
  capability: string;
  observations: number;
  /** The destination the study names (the classification's kinds). */
  destination: "rule" | "skill" | "tool" | "policy";
  sources: Correction["source"][];
  reason: string;
};

export type CorrectionReport = {
  suggestions: CorrectionSuggestion[];
  considered: { corrections: number };
};

/** The line between an anecdote and a pattern (the curriculum's). */
const MIN_OBSERVATIONS = 2;

/**
 * The destination G-d names. The keyword families are the curriculum
 * classifier's (one vocabulary, two modules) but the DEFAULT differs,
 * and deliberately: an unmapped GAP most names a missing tool, while a
 * repeated CORRECTION most names a behavioral constraint — a
 * constitution rule. A shared function with a shared default would
 * misfile half the corrections.
 */
export function correctionDestination(
  text: string,
): "rule" | "skill" | "tool" | "policy" {
  const lower = text.toLowerCase();
  const says = (...words: string[]) =>
    words.some((word) => lower.includes(word));
  if (says("skill", "knowledge", "documentation", "doc")) return "skill";
  if (says("policy", "permission", "strategy")) return "policy";
  if (says("tool", "command", "cli")) return "tool";
  // A repeated behavioral constraint the journal keeps catching is a
  // rule the human keeps writing by hand.
  return "rule";
}

/** Every correction the journal carries, in its safe form. */
export function readCorrections(events: readonly RuntimeEvent[]): Correction[] {
  const corrections: Correction[] = [];
  for (const event of events) {
    if (
      event.type === "mailbox.queued" &&
      event.source === "user_via_live_chat"
    ) {
      const text = event.safeSummary?.trim();
      if (text) corrections.push({ text, source: "mailbox" });
      continue;
    }
    if (event.type === "completion.human_validation") {
      const text = event.validation?.trim();
      if (text) corrections.push({ text, source: "human_validation" });
      continue;
    }
    if (event.type === "decision.recorded") {
      for (const alternative of event.alternatives ?? []) {
        const text = alternative.rejectedReason?.trim();
        if (text) corrections.push({ text, source: "rejected_alternative" });
      }
    }
  }
  return corrections;
}

/**
 * The pattern derivation: cluster the corrections, keep the repeated
 * ones, answer each as one suggestion naming its destination. The
 * study's two destinations are the classifier's rule/skill kinds; the
 * other kinds ride along when the text names them.
 */
export function deriveCorrectionPatterns(
  corrections: readonly Correction[],
): CorrectionReport {
  const clusters = new Map<
    string,
    { count: number; sources: Set<Correction["source"]> }
  >();
  for (const correction of corrections) {
    const key = normalizeGap(correction.text);
    if (!key) continue;
    const cluster = clusters.get(key) ?? {
      count: 0,
      sources: new Set<Correction["source"]>(),
    };
    cluster.count += 1;
    cluster.sources.add(correction.source);
    clusters.set(key, cluster);
  }
  const suggestions: CorrectionSuggestion[] = [];
  for (const [key, cluster] of clusters) {
    if (cluster.count < MIN_OBSERVATIONS) continue;
    suggestions.push({
      capability: key,
      observations: cluster.count,
      destination: correctionDestination(key),
      sources: [...cluster.sources],
      reason: `the correction "${key}" recurred ${cluster.count} times — consider固化 as ${
        correctionDestination(key) === "rule"
          ? "a constitution rule"
          : correctionDestination(key) === "skill"
            ? "a skill"
            : correctionDestination(key) === "policy"
              ? "a policy"
              : "a tool"
      }`,
    });
  }
  suggestions.sort((left, right) => right.observations - left.observations);
  return { suggestions, considered: { corrections: corrections.length } };
}
