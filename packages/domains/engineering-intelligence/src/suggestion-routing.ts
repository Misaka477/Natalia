/**
 * The reflection→proposal bridge (step 6's first entry): a self-review's
 * growth suggestions become a staged generation candidate when they name
 * a surface the generation machine can actually change.
 *
 * The mapping is deliberately MECHANICAL and deliberately PARTIAL. A
 * suggestion is the model's own prose ("I reached for a ripgrep tool and
 * it did not exist"); the generation candidate is a structured config
 * patch. Translating one into the other in general is a mutator's job —
 * and the mutator was deleted with A5 on purpose. What survives is the
 * case that needs no judgment: the aspiration names a capability that
 * maps to a plugin sitting in the catalog, disabled. Enabling it is not
 * a guess, it is the wish spelled in the catalog's own vocabulary.
 *
 * Everything else (a missing tool, a policy row, a code change) routes
 * the way it always did: the growth fact journals it, the class policy
 * names its approval, and the human or the model's next turn carries it
 * to `propose_generation`. A bridge that invented patches for those
 * would be the mutator wearing a different hat.
 */

import type { GrowthDestination } from "./growth-promotion";

/** A suggestion as the review's growth fact carries it. */
export type RoutableSuggestion = {
  kind: "tool" | "skill" | "rule" | "policy";
  capability: string;
  reason: string;
};

/** The catalog row the bridge reads. */
export type RoutableCatalogEntry = { id: string; enabled: boolean };

/**
 * The comparison is TOKEN overlap, not string containment: a capability is
 * prose ("ripgrep search", "a content search") and a catalog id is kebab
 * ("natalia-tool-search"). One side's WORDS appearing in the other's is
 * the match — a word under three letters ("a", "of") is noise that would
 * make everything match everything.
 */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 3);
}

function sharesToken(left: string, right: string): boolean {
  const rightTokens = new Set(tokens(right));
  return tokens(left).some((token) => rightTokens.has(token));
}

/**
 * The overrides a review's suggestions imply, or undefined when none of
 * them names a mechanical surface change. Only DISABLED plugins are
 * offered: enabling an enabled plugin is a no-op, and a candidate that
 * changes nothing is noise in the journal.
 */
export function pluginOverridesForSuggestions(input: {
  suggestions: readonly RoutableSuggestion[];
  catalog: readonly RoutableCatalogEntry[];
}):
  | { plugins: Array<{ id: string; enabled: boolean }>; note: string }
  | undefined {
  const plugins: Array<{ id: string; enabled: boolean }> = [];
  const reasons: string[] = [];
  for (const suggestion of input.suggestions) {
    if (suggestion.kind !== "tool") continue; // skills route to the writer
    const entry = input.catalog.find(
      (candidate) =>
        sharesToken(suggestion.capability, candidate.id) ||
        sharesToken(suggestion.reason, candidate.id),
    );
    if (!entry || entry.enabled) continue;
    // The reason rides even when the plugin is already listed: two
    // phrasings of one wish are two pieces of evidence for it.
    reasons.push(`${suggestion.capability}: ${suggestion.reason}`);
    if (plugins.some((row) => row.id === entry.id)) continue;
    plugins.push({ id: entry.id, enabled: true });
  }
  if (!plugins.length) return undefined;
  return {
    plugins,
    // The note is the model's own words: a candidate whose provenance is
    // a paraphrase is a candidate nobody can audit.
    note: `self-review wished for: ${reasons.join("; ")}`,
  };
}

/**
 * The destination a suggestion routes to, for the class policy. Kept
 * beside the bridge so the two answers cannot drift: a "tool" wish is a
 * generation-surface question, everything else keeps its existing route.
 */
export function suggestionDestination(
  suggestion: RoutableSuggestion,
): GrowthDestination {
  if (suggestion.kind === "skill") return "skill";
  if (suggestion.kind === "policy" || suggestion.kind === "rule")
    return "policy";
  return "generation";
}
