/**
 * The three-way merge — the most valuable thing git does, rebuilt on our own
 * line diff.
 *
 * The snapshot backend's promotion could already REFUSE a host that moved
 * under a candidate (a named per-file conflict, before anything is written).
 * What it could not do is what git's merge does every day: when the
 * candidate changed one region of a file and the host changed a DIFFERENT
 * region since the base, both changes land. Refusing those cost a
 * re-run of work that never actually collided.
 *
 * The engine is our own: `diffLineOps` (the same LCS line diff the sandbox's
 * before/after views use) run twice — base→ours and base→theirs — then
 * combined region by region. A region one side touched takes that side; a
 * region both sides changed identically takes either; a region both sides
 * changed differently is a CONFLICT, named with its line range and both
 * spellings, so a human (or a model) can resolve it knowing exactly what
 * collided. No external binary, no fuzzy context matching: our diff, our
 * merge, our conflict report.
 */

import { diffLineOps, type DiffLineOp } from "./diff-ops";

export type MergeConflict = {
  /** 1-based line range in the base the collision sits at. */
  baseStart: number;
  baseEnd: number;
  /** The host's side of the collision. */
  ours: string[];
  /** The candidate's side of the collision. */
  theirs: string[];
};

export type MergeResult =
  | { outcome: "clean"; lines: string[] }
  | { outcome: "conflict"; conflicts: MergeConflict[] };

/** One side's edit script over the base, as base-indexed regions. */
type Edit = {
  /** Base line index the region starts at (0-based, inclusive). */
  start: number;
  /** Base line index the region ends at (exclusive). */
  end: number;
  /** The lines this side puts in the region's place. */
  lines: string[];
};

function editsFromOps(ops: readonly DiffLineOp[]): Edit[] {
  const edits: Edit[] = [];
  let baseIndex = 0;
  let current: Edit | undefined;
  for (const op of ops) {
    if (op.type === "equal") {
      current = undefined;
      baseIndex += 1;
      continue;
    }
    if (!current) {
      current = { start: baseIndex, end: baseIndex, lines: [] };
      edits.push(current);
    }
    if (op.type === "delete") {
      current.end = baseIndex + 1;
      baseIndex += 1;
    } else {
      current.lines.push(op.text);
    }
  }
  return edits;
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

export function mergeTexts(input: {
  base: string;
  /** The host's current content. */
  ours: string;
  /** The candidate's content. */
  theirs: string;
}): MergeResult {
  const baseLines = splitLines(input.base);
  const ours = editsFromOps(diffLineOps(baseLines, splitLines(input.ours)));
  const theirs = editsFromOps(diffLineOps(baseLines, splitLines(input.theirs)));

  const merged: string[] = [];
  const conflicts: MergeConflict[] = [];
  let cursor = 0; // the next base line not yet emitted
  let oursIndex = 0;
  let theirsIndex = 0;
  while (oursIndex < ours.length || theirsIndex < theirs.length) {
    const ourEdit = ours[oursIndex];
    const theirEdit = theirs[theirsIndex];
    if (!ourEdit) {
      // Only theirs remains: emit the untouched base up to it, then its lines.
      merged.push(
        ...baseLines.slice(cursor, theirEdit!.start),
        ...theirEdit!.lines,
      );
      cursor = theirEdit!.end;
      theirsIndex += 1;
      continue;
    }
    if (!theirEdit) {
      merged.push(...baseLines.slice(cursor, ourEdit.start), ...ourEdit.lines);
      cursor = ourEdit.end;
      oursIndex += 1;
      continue;
    }
    // Overlapping regions: one starts inside the other, OR both are pure
    // insertions at the SAME base position (zero-width at the same point —
    // an add/add, which git refuses with conflict markers rather than
    // guessing an order). Adjacent-but-disjoint edits stay disjoint.
    const insertAtSamePoint =
      ourEdit.start === ourEdit.end &&
      theirEdit.start === theirEdit.end &&
      ourEdit.start === theirEdit.start;
    const overlaps =
      insertAtSamePoint ||
      (ourEdit.start < theirEdit.end && theirEdit.start < ourEdit.end);
    if (overlaps) {
      const regionEnd = Math.max(ourEdit.end, theirEdit.end);
      merged.push(
        ...baseLines.slice(cursor, Math.min(ourEdit.start, theirEdit.start)),
      );
      if (sameLines(ourEdit.lines, theirEdit.lines)) {
        merged.push(...ourEdit.lines);
      } else {
        conflicts.push({
          baseStart: Math.min(ourEdit.start, theirEdit.start) + 1,
          baseEnd: regionEnd,
          ours: ourEdit.lines,
          theirs: theirEdit.lines,
        });
      }
      cursor = regionEnd;
      // The colliding pair is consumed first (a zero-width collision has
      // regionEnd == start, so a `start < regionEnd` loop alone would never
      // advance past it), then any further edit nested inside the region.
      oursIndex += 1;
      theirsIndex += 1;
      while (oursIndex < ours.length && ours[oursIndex]!.start < regionEnd)
        oursIndex += 1;
      while (
        theirsIndex < theirs.length &&
        theirs[theirsIndex]!.start < regionEnd
      )
        theirsIndex += 1;
      continue;
    }
    // Disjoint: the earlier region first, in base order.
    if (ourEdit.end <= theirEdit.start) {
      merged.push(...baseLines.slice(cursor, ourEdit.start), ...ourEdit.lines);
      cursor = ourEdit.end;
      oursIndex += 1;
      continue;
    }
    merged.push(
      ...baseLines.slice(cursor, theirEdit.start),
      ...theirEdit.lines,
    );
    cursor = theirEdit.end;
    theirsIndex += 1;
  }
  merged.push(...baseLines.slice(cursor));
  if (conflicts.length) return { outcome: "conflict", conflicts };
  return { outcome: "clean", lines: merged };
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

/** The refusal a conflict list produces: every collision, with both sides. */
export function mergeConflictReason(
  conflicts: readonly MergeConflict[],
): string {
  const lines = conflicts.map(
    (conflict) =>
      `lines ${conflict.baseStart}-${conflict.baseEnd}: ` +
      `the host has [${conflict.ours.join(" / ") || "(nothing)"}], ` +
      `the candidate has [${conflict.theirs.join(" / ") || "(nothing)"}]`,
  );
  return `${conflicts.length} region(s) changed on both sides since the base:\n${lines.join("\n")}`;
}
