/**
 * Discovery G-a — the capability curriculum (the Voyager curriculum's
 * minimal form): from the journal's completed/failed distribution, WHAT
 * CAPABILITY should grow next, answered as a growth proposal.
 *
 * The three rules from the study, as this module's shape:
 *
 *  1. **evidence-first** — every input is a journal fact: the completions
 *     (their `knownGaps` are the runtime's own admission of a gap), the
 *     plan task states (a `gap` is a declaration nothing backs), the
 *     run groups (the same-prompt success distribution — G-b's output).
 *     A curriculum invented from vibes is the thing this engine refuses.
 *  2. **proposal, never execution** — the output is a growth PROPOSAL.
 *     The study's approval policy: growth 默认不自授权 — the
 *     constitution decides which class may auto-apply, and the NGM
 *     proposal interface is where these land. This module decides
 *     nothing but WHAT to suggest and WHY.
 *  3. **the distribution, not the anecdote** — a gap mentioned once is
 *     an anecdote; the same gap across completions is a pattern. The
 *     threshold below is the line between them. (G-b's prompt-group
 *     distribution is the study's SEPARATE loop; no key joins a gap to
 *     a prompt group, so inventing one here would be a fabrication —
 *     both loops end at the same proposal interface instead.)
 */

/** One task's observable outcome, as the journal recorded it. */
export type TaskOutcome = {
  /** What the task was (its objective or label). */
  text: string;
  /** The runtime's own admission of a gap (the completion's knownGaps). */
  gaps?: readonly string[];
  /** A declared-but-unbacked plan task (the task-state projection). */
  unbacked?: boolean;
  /** The plan the task belongs to (for the proposal's provenance). */
  planID?: string;
};

export type GrowthSuggestionKind =
  /** The gap names a tool the runtime does not have. */
  | "tool"
  /** The gap names knowledge that should be a skill. */
  | "skill"
  /** The gap names a rule that should be a constitution rule. */
  | "rule"
  /** The gap names a policy the runs keep losing to. */
  | "policy";

export type GrowthSuggestion = {
  kind: GrowthSuggestionKind;
  /** The capability name or the gap text, normalized. */
  capability: string;
  /** How many independent observations named this gap. */
  observations: number;
  /** Where the evidence came from (task texts / plan ids). */
  sources: string[];
  reason: string;
};

export type GrowthCurriculum = {
  /** The suggestions, strongest first (observations, then prompt rate). */
  suggestions: GrowthSuggestion[];
  /** What was read to produce them (the proposal's provenance). */
  considered: {
    tasks: number;
    gaps: number;
  };
};

/** The line between an anecdote and a pattern. */
const MIN_OBSERVATIONS = 2;

/** The keywords that classify a gap's kind (the study's four classes). */
const KIND_KEYWORDS: Array<{
  kind: GrowthSuggestionKind;
  keywords: readonly string[];
}> = [
  { kind: "tool", keywords: ["tool", "command", "cli"] },
  { kind: "skill", keywords: ["skill", "knowledge", "documentation", "doc"] },
  { kind: "rule", keywords: ["rule", "constitution", "policy:rule"] },
  { kind: "policy", keywords: ["policy", "permission", "strategy"] },
];

/** The keyword that classifies one gap's text (the first family it names). */
export function classifyGap(text: string): GrowthSuggestionKind {
  const lower = text.toLowerCase();
  for (const entry of KIND_KEYWORDS)
    if (entry.keywords.some((keyword) => lower.includes(keyword)))
      return entry.kind;
  // No keyword matched: the gap names something concrete — treat it as
  // a tool gap, the most common recovery shape.
  return "tool";
  // No keyword matched: the gap names something concrete — treat it as
  // a tool gap, the most common recovery shape.
  return "tool";
}

/** Normalizing one gap for grouping (case + whitespace + trailing period). */
export function normalizeGap(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/[.。!！?？]+$/u, "")
    .trim();
}

/**
 * The curriculum's derivation: cluster the observed gaps, keep the
 * clusters that clear the pattern threshold, and answer each as one
 * growth suggestion (strongest first).
 */
export function deriveGrowthCurriculum(input: {
  tasks: readonly TaskOutcome[];
}): GrowthCurriculum {
  const clusters = new Map<
    string,
    {
      kind: GrowthSuggestionKind;
      observations: number;
      sources: Set<string>;
      texts: Set<string>;
    }
  >();
  let gapCount = 0;
  for (const task of input.tasks) {
    const gaps = [
      ...(task.gaps ?? []).map((text) => ({ text, from: task.text })),
      ...(task.unbacked
        ? [{ text: `unbacked plan task: ${task.text}`, from: task.text }]
        : []),
    ];
    for (const gap of gaps) {
      gapCount += 1;
      const key = normalizeGap(gap.text);
      if (!key) continue;
      const cluster = clusters.get(key) ?? {
        kind: classifyGap(gap.text),
        observations: 0,
        sources: new Set<string>(),
        texts: new Set<string>(),
      };
      cluster.observations += 1;
      if (task.text) cluster.sources.add(task.text);
      if (task.planID) cluster.sources.add(task.planID);
      cluster.texts.add(gap.text);
      clusters.set(key, cluster);
    }
  }
  const suggestions: GrowthSuggestion[] = [];
  for (const [key, cluster] of clusters) {
    // The pattern threshold: an anecdote is not a curriculum.
    if (cluster.observations < MIN_OBSERVATIONS) continue;
    suggestions.push({
      kind: cluster.kind,
      capability: key,
      observations: cluster.observations,
      sources: [...cluster.sources],
      reason: `the gap "${key}" appeared ${cluster.observations} times across completions`,
    });
  }
  suggestions.sort((left, right) => right.observations - left.observations);
  return {
    suggestions,
    considered: {
      tasks: input.tasks.length,
      gaps: gapCount,
    },
  };
}
