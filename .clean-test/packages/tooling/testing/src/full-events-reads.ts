/**
 * The RINA study's acceptance #1, machine-checked: "no surface reads
 * exec.session.events in full; ensureSessionFullEvents() serves only
 * explicit history retrieval and the index-rebuild fallback."
 *
 * The inventory (the study's taxonomy made countable) lives in the
 * companion literal: every file that references the array, its class
 * (how its content reads are sanctioned) and an exact count of
 * CONTENT reads — a new one without an inventory edit goes red, which
 * is the point: the acceptance surface changes only deliberately.
 *
 * What counts as a content read: the array referenced with a following
 * use that consumes its CONTENTS — a fold/project/iteration/.some/
 * .filter/.find/.spread/.[i]/argument-pass. What does NOT: `.length`
 * (metadata), an assignment, `?? []` (an empty-default reference),
 * comments/doc lines. The filter is line-level (a trailing-comment
 * heuristic), and the companion inventory's tests keep filter and table
 * in step.
 *
 * WHICH references: the live execution's array under any of its spellings
 * — `exec.session.events`, an identifier alias (`target.session.events`),
 * a Session-suffixed alias (`chatSession.events`, the `exec?.session`
 * local), with or without optional chaining. The BARE `session.events`
 * form is deliberately NOT matched: it cannot tell the live array from
 * any `SessionRecord` parameter (the session package's own projections
 * read those legitimately); the one live-array bare alias found at
 * rollout was de-aliased at its source instead of widening past the
 * ambiguity. A future alias the pattern misses is exactly what the
 * companion inventory's real-tree anchor is for.
 */

export type FullReadClass =
  /** An explicit-history face: the same function calls ensure/complete
   * upstream (the study's sanctioned class). */
  | "explicit-history"
  /** State-first with a resident-tail fallback (the boundary's own
   * documented degradation shape). */
  | "state-first"
  /** The paged/mechanism readers (store.history / event-window /
   * facts seeding) — the completion machinery itself. */
  | "paged-mechanism"
  /** A change-signal/revision derived from what is resident (a
   * revision key, a wake gate) — its own consistency class. */
  | "derivation"
  /** A direct fold with no state-first twin: named debt, counted,
   * frozen — each entry says WHY it stands as it does. */
  | "fold-direct";

export function countFullContentReads(text: string): number {
  let count = 0;
  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/**"))
      continue;
    // a trailing-comment heuristic: cut at // that is not inside a string
    // (the array name never appears in our string literals)
    const code = line.replace(/\/\/.*$/u, "");
    // the live execution's array under any spelling: direct, identifier
    // alias, Session-suffixed alias, optional chaining on either seam.
    const pattern = /\w+\??\.session\.events|\w+Session\??\.events/gu;
    for (const match of code.matchAll(pattern)) {
      const after = code.slice(match.index + match[0].length);
      if (/^\s*\.length\b/u.test(after)) continue; // metadata
      if (/^\s*=/u.test(after) && !/===|!==|==|!=/u.test(after)) continue; // assignment
      if (/^\s*\?\?\s*\[\]/u.test(after)) continue; // empty-default reference
      if (/^\s*:\s*(RuntimeEvent|Readonly)/u.test(after)) continue; // a type position
      count += 1;
    }
  }
  return count;
}
