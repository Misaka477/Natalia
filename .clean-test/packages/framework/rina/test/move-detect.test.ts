import { expect, test } from "bun:test";
import {
  detectMoves,
  summarizeMoves,
  type IndexedSymbol,
} from "../src/move-detect";

/**
 * The object-store study's Phase C acceptance: "cross-file move
 * detection recognizes rename + move + modified". The three states,
 * singly and together — and the states that must NOT fire (a plain
 * reference is not a move; an unrelated symbol is not a rename; a
 * deletion is not a move). Lives beside the embedding it reuses (the
 * diff-wasm home was a cycle: rina's own deps reach diff-wasm).
 */

const symbol = (
  file: string,
  text: string,
  nodeKind = "identifier",
): IndexedSymbol => ({ file, nodeKind, text });

test("the acceptance's three states fire together: rename + move + modified", () => {
  const moves = detectMoves({
    before: [symbol("a.ts", "parseConfigV2")],
    after: [symbol("b.ts", "parseConfigV3")],
  });
  expect(moves).toHaveLength(1);
  expect(moves[0]).toMatchObject({
    from: "parseConfigV2",
    to: "parseConfigV3",
    fromFile: "a.ts",
    toFile: "b.ts",
    states: { renamed: true, moved: true, modified: true },
  });
  expect(summarizeMoves(moves)).toEqual({
    count: 1,
    renamed: 1,
    moved: 1,
    modified: 1,
  });
});

test("a pure rename (same file) and a pure move (same text) each fire their own state", () => {
  const renamed = detectMoves({
    before: [symbol("a.ts", "loadConfigOld")],
    after: [symbol("a.ts", "loadConfigNew")],
  });
  expect(renamed[0]!.states).toEqual({
    renamed: true,
    moved: false,
    modified: true,
  });

  const moved = detectMoves({
    before: [symbol("a.ts", "sharedHelper")],
    after: [symbol("b.ts", "sharedHelper")],
  });
  expect(moved).toHaveLength(1);
  expect(moved[0]!.states).toEqual({
    renamed: false,
    moved: true,
    modified: false,
  });
  expect(moved[0]!.similarity).toBe(1);
});

test("a plain reference is not a move, an unrelated symbol is not a rename", () => {
  // The symbol never left its file: nothing moved.
  expect(
    detectMoves({
      before: [symbol("a.ts", "stable")],
      after: [symbol("a.ts", "stable")],
    }),
  ).toEqual([]);
  // It left, but the destination's same-kind symbol is unrelated: a
  // deletion, not a move.
  expect(
    detectMoves({
      before: [symbol("a.ts", "goneNow")],
      after: [symbol("a.ts", "somethingElse")],
    }),
  ).toEqual([]);
});

test("a different kind is a different symbol (the kind rides the match)", () => {
  // Same text, different node kind: not the same symbol.
  expect(
    detectMoves({
      before: [symbol("a.ts", "Token", "type")],
      after: [symbol("b.ts", "Token", "identifier")],
    }),
  ).toEqual([]);
});

test("the greedy best-pair match uses each symbol once", () => {
  // Two disappeared symbols, one close destination: the best pair wins
  // and the second is a deletion.
  const moves = detectMoves({
    before: [
      symbol("a.ts", "handlerRequestV1"),
      symbol("a.ts", "handlerResponseV1"),
    ],
    after: [symbol("b.ts", "handlerRequestV2")],
  });
  expect(moves).toHaveLength(1);
  expect(moves[0]!.to).toBe("handlerRequestV2");
});
