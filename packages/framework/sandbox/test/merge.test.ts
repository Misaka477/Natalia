import { expect, test } from "bun:test";
import { mergeConflictReason, mergeTexts } from "../src/merge";

/**
 * The three-way merge — git's most valuable behavior, on our own line diff.
 * A candidate that changed one region and a host that changed a DIFFERENT
 * region since the base both land; the same region changed differently is a
 * named conflict, never a silent overwrite.
 */

const text = (...lines: string[]) => lines.join("\n");

test("disjoint changes on both sides both land", () => {
  const base = text("a", "b", "c", "d", "e", "f", "g", "h");
  const ours = text("a", "b", "c", "d", "e", "f", "g", "H-HOST");
  const theirs = text("A-CAND", "b", "c", "d", "e", "f", "g", "h");
  const result = mergeTexts({ base, ours, theirs });
  expect(result.outcome).toBe("clean");
  if (result.outcome !== "clean") return;
  expect(result.lines).toEqual([
    "A-CAND",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "H-HOST",
  ]);
});

test("one side unchanged takes the other side's version", () => {
  const base = text("x", "y", "z");
  const result = mergeTexts({ base, ours: base, theirs: text("x", "Y", "z") });
  expect(result.outcome).toBe("clean");
  if (result.outcome !== "clean") return;
  expect(result.lines).toEqual(["x", "Y", "z"]);
});

test("identical changes on both sides are not a conflict", () => {
  const base = text("one", "two");
  const both = text("one", "TWO");
  const result = mergeTexts({ base, ours: both, theirs: both });
  expect(result.outcome).toBe("clean");
  if (result.outcome !== "clean") return;
  expect(result.lines).toEqual(["one", "TWO"]);
});

test("the same region changed differently is a named conflict", () => {
  const base = text("head", "middle", "tail");
  const ours = text("head", "HOST-MIDDLE", "tail");
  const theirs = text("head", "CANDIDATE-MIDDLE", "tail");
  const result = mergeTexts({ base, ours, theirs });
  expect(result.outcome).toBe("conflict");
  if (result.outcome !== "conflict") return;
  expect(result.conflicts).toHaveLength(1);
  expect(result.conflicts[0]!.ours).toEqual(["HOST-MIDDLE"]);
  expect(result.conflicts[0]!.theirs).toEqual(["CANDIDATE-MIDDLE"]);
  // The refusal names the base line range and BOTH spellings — a human
  // resolving it knows exactly what collided.
  const reason = mergeConflictReason(result.conflicts);
  expect(reason).toContain("HOST-MIDDLE");
  expect(reason).toContain("CANDIDATE-MIDDLE");
  expect(reason).toContain("lines 2-2");
});

test("a delete on one side against a modify on the other collides", () => {
  const base = text("keep", "doomed", "keep-too");
  const result = mergeTexts({
    base,
    ours: text("keep", "keep-too"),
    theirs: text("keep", "EDITED", "keep-too"),
  });
  expect(result.outcome).toBe("conflict");
});

test("both sides append different lines at the end: a conflict, not a silent pick", () => {
  const base = text("first");
  const result = mergeTexts({
    base,
    ours: text("first", "host-tail"),
    theirs: text("first", "candidate-tail"),
  });
  // Appends touch the same boundary region (the end of the base), so the
  // merge refuses rather than guessing an order — git's conflict markers
  // exist for exactly this.
  expect(result.outcome).toBe("conflict");
});

test("a clean merge of many regions keeps the untouched base between them", () => {
  const base = Array.from({ length: 20 }, (_, index) => `line-${index}`);
  const ours = [...base];
  ours[2] = "host-2";
  ours[17] = "host-17";
  const theirs = [...base];
  theirs[10] = "candidate-10";
  const result = mergeTexts({
    base: base.join("\n"),
    ours: ours.join("\n"),
    theirs: theirs.join("\n"),
  });
  expect(result.outcome).toBe("clean");
  if (result.outcome !== "clean") return;
  expect(result.lines).toHaveLength(20);
  expect(result.lines[2]).toBe("host-2");
  expect(result.lines[10]).toBe("candidate-10");
  expect(result.lines[17]).toBe("host-17");
  expect(result.lines[5]).toBe("line-5");
});

test("an empty base with both sides writing different content collides", () => {
  const result = mergeTexts({ base: "", ours: "host", theirs: "candidate" });
  expect(result.outcome).toBe("conflict");
});
