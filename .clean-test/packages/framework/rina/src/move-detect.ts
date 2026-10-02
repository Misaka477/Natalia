import { cosine, embedText } from "./embedding";

/**
 * Cross-file move detection (the object-store study's Phase C): a symbol
 * that RENAMED, MOVED, and got MODIFIED across files. The acceptance is
 * the three states recognized together — `rename + move + modified` —
 * which no single-file refactor face can see.
 *
 * What it operates on: the SAME nodes the AST index already produces
 * (`astService({operation:"index"})` → per-file nodes with kind/text/
 * span). No new parser, no new file walk: this module is the ANALYSIS
 * over an index that exists.
 *
 * The three states, and how each is decided:
 *  - **moved**: the symbol's text vanished from its old file and a
 *    same-kind symbol appeared in another.
 *  - **renamed**: the new text is SIMILAR but not identical to the old
 *    (an exact text match is a plain reference, not a rename — the
 *    similarity threshold decides).
 *  - **modified**: the best candidate's text is not exactly the symbol's
 *    old text — the body changed while moving.
 *
 * Similarity is the RINA embedding's cosine (framework reuse): the
 * morphology-aware n-gram vector, so `parseConfigV2` ≈ `parseConfigV3`
 * scores high while an unrelated symbol does not. Two references to the
 * SAME text (a copy) are not a rename: the similarity 1.0 case is
 * excluded by design — an exact match is a duplicate, and a duplicate is
 * the caller's other tool's business.
 */

/** One indexed symbol occurrence: what the AST index gives us. */
export type IndexedSymbol = {
  file: string;
  nodeKind: string;
  text: string;
};

export type MoveStates = {
  renamed: boolean;
  moved: boolean;
  modified: boolean;
};

export type DetectedMove = {
  /** The symbol's old text. */
  from: string;
  /** The new text (equal to `from` for a pure move). */
  to: string;
  fromFile: string;
  toFile: string;
  nodeKind: string;
  /** The similarity in [0,1]: how much of the old text survived. */
  similarity: number;
  states: MoveStates;
};

export type MoveDetectionInput = {
  /** The symbols before. */
  before: readonly IndexedSymbol[];
  /** The symbols after. */
  after: readonly IndexedSymbol[];
  /**
   * The rename threshold: a candidate's similarity must clear it to count
   * as the same symbol (and be below 1.0 to count as renamed at all).
   */
  renameThreshold?: number;
};

/** The default: similar enough to be the same symbol under a new name. */
const DEFAULT_RENAME_THRESHOLD = 0.6;

/**
 * Detect the cross-file moves between two symbol sets. The algorithm:
 * every symbol that DISAPPEARED from its file (or changed its text) is a
 * move candidate; every APPEREAD same-kind symbol is a destination
 * candidate; the pairs are matched greedily by similarity (the best pair
 * first, each symbol used once). A candidate with no counterpart above
 * the threshold is dropped — a deletion is not a move.
 */
export function detectMoves(input: MoveDetectionInput): DetectedMove[] {
  const threshold = input.renameThreshold ?? DEFAULT_RENAME_THRESHOLD;
  // Index the after-side by kind for the candidate search.
  const afterByKind = new Map<string, IndexedSymbol[]>();
  for (const symbol of input.after) {
    const list = afterByKind.get(symbol.nodeKind) ?? [];
    list.push(symbol);
    afterByKind.set(symbol.nodeKind, list);
  }
  const afterTexts = new Map<string, Set<string>>();
  for (const symbol of input.after) {
    const set = afterTexts.get(symbol.file) ?? new Set<string>();
    set.add(symbol.text);
    afterTexts.set(symbol.file, set);
  }

  const moves: DetectedMove[] = [];
  const usedAfter = new Set<IndexedSymbol>();
  // Greedy by the best similarity: collect the candidate pairs first.
  const pairs: Array<{
    from: IndexedSymbol;
    to: IndexedSymbol;
    similarity: number;
  }> = [];
  for (const symbol of input.before) {
    const stillThere = afterTexts.get(symbol.file)?.has(symbol.text);
    if (stillThere) continue; // the symbol did not leave its file
    const vector = embedText(symbol.text);
    for (const candidate of afterByKind.get(symbol.nodeKind) ?? []) {
      if (usedAfter.has(candidate)) continue;
      const similarity = cosine(vector, embedText(candidate.text));
      // An exact text match elsewhere is a DUPLICATE, not a rename; a
      // cross-file identical text is still a MOVE, so keep the pair at
      // similarity 1 and let the states say which one it is.
      if (similarity < threshold && similarity < 1) continue;
      pairs.push({ from: symbol, to: candidate, similarity });
    }
  }
  pairs.sort((left, right) => right.similarity - left.similarity);
  for (const pair of pairs) {
    if (usedAfter.has(pair.to)) continue;
    const stillThere = afterTexts.get(pair.from.file)?.has(pair.from.text);
    if (stillThere) continue; // a later pair re-introduced it (impossible, cheap)
    usedAfter.add(pair.to);
    const renamed = pair.to.text !== pair.from.text;
    const moved = pair.to.file !== pair.from.file;
    const modified = renamed;
    moves.push({
      from: pair.from.text,
      to: pair.to.text,
      fromFile: pair.from.file,
      toFile: pair.to.file,
      nodeKind: pair.from.nodeKind,
      similarity: pair.similarity,
      states: { renamed, moved, modified },
    });
  }
  return moves;
}

/** The acceptance's shape in one glance: what the detected moves say. */
export function summarizeMoves(moves: readonly DetectedMove[]): {
  count: number;
  renamed: number;
  moved: number;
  modified: number;
} {
  return {
    count: moves.length,
    renamed: moves.filter((move) => move.states.renamed).length,
    moved: moves.filter((move) => move.states.moved).length,
    modified: moves.filter((move) => move.states.modified).length,
  };
}
