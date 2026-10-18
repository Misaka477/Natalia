/**
 * Whether two greens are the same green — stated, never implied.
 *
 * The third ruler says a green is data with a scope, not a boolean, and the part
 * of that which keeps getting skipped is TIME: "it passed yesterday" is a claim
 * about two different runs, and the two runs are comparable only if the same
 * checks ran on the same tree in the same environment. Any of those three
 * differing makes the comparison meaningless, and saying nothing is how "still
 * green" becomes a story.
 *
 * So this module's whole job is to answer, in words: comparable / not comparable
 * and why / cannot say. There is deliberately no `score` and no single boolean
 * returned on its own: a caller that wants the boolean must also carry the reason.
 */
import type { AssayEvidenceInput } from "./assay-runs";

export type AssayComparison = {
  /** True only when nothing differs AND nothing is unknown. */
  comparable: boolean;
  /** Facts that differ between the two records. */
  differences: string[];
  /**
   * Facts neither record carries, which makes comparability unknowable. A
   * missing commit is the common case: an old record from before the field
   * existed cannot be called "the same tree".
   */
  unknown: string[];
  /** One sentence, always filled: what a reader needs to hear. */
  why: string;
};

function commandSet(record: AssayEvidenceInput): string[] {
  return [
    ...new Set((record.validations ?? []).map((entry) => entry.command.trim())),
  ].sort();
}

function describeSet(values: readonly string[]): string {
  return values.length === 0 ? "(nothing)" : values.join(", ");
}

/**
 * Compare a later run against an earlier one for the same task.
 *
 * "Same check set" is the command set, not the class set: two different commands
 * that both earn `validation:test` are two different measurements, and treating
 * them as one is exactly how a green silently changes meaning.
 */
export function compareAssayRuns(input: {
  previous: AssayEvidenceInput;
  current: AssayEvidenceInput;
}): AssayComparison {
  const differences: string[] = [];
  const unknown: string[] = [];
  const before = commandSet(input.previous);
  const after = commandSet(input.current);
  const added = after.filter((command) => !before.includes(command));
  const removed = before.filter((command) => !after.includes(command));
  if (added.length > 0)
    differences.push(`the later run also ran ${describeSet(added)}`);
  if (removed.length > 0)
    differences.push(`the later run no longer runs ${describeSet(removed)}`);

  if (input.previous.commit && input.current.commit) {
    if (input.previous.commit !== input.current.commit)
      differences.push(
        `different trees: ${input.previous.commit} then ${input.current.commit}`,
      );
  } else if (!input.previous.commit && !input.current.commit)
    unknown.push("neither record carries a commit");
  else
    unknown.push(
      `only the ${input.previous.commit ? "earlier" : "later"} record carries a commit`,
    );

  if (input.previous.environment && input.current.environment) {
    if (input.previous.environment !== input.current.environment)
      differences.push(
        `different environments: ${input.previous.environment} then ${input.current.environment}`,
      );
  } else if (!input.previous.environment && !input.current.environment)
    unknown.push("neither record carries an environment");
  else
    unknown.push(
      `only the ${input.previous.environment ? "earlier" : "later"} record carries an environment`,
    );

  const why = reasonsSentence(differences, unknown);
  return {
    comparable: differences.length === 0 && unknown.length === 0,
    differences,
    unknown,
    why,
  };
}

function reasonsSentence(
  differences: readonly string[],
  unknown: readonly string[],
): string {
  if (differences.length === 0 && unknown.length === 0)
    return "the same checks ran on the same tree in the same environment";
  const parts: string[] = [];
  if (differences.length > 0)
    parts.push(`not comparable: ${differences.join("; ")}`);
  if (unknown.length > 0)
    parts.push(`cannot say it is comparable: ${unknown.join("; ")}`);
  return parts.join(". ");
}
