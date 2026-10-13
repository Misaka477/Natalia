import { expect, test } from "bun:test";
import { bounded } from "../src/chat-prompt";

/**
 * The audit surface's context budget (audit item 10) — the pure half.
 *
 * Nia's audit prompt carried the WHOLE work chain and measured ~1.59M
 * against a 1.05M window: the content itself is over, not a display bug.
 * Each block is bounded, and a block that cut SAYS how many rows it held
 * back — silent truncation is a lie, a counted truncation is a budget.
 *
 * The reply-required rows are never budgeted away: an unanswered sister
 * message is the turn's whole job (the composition lives in the live
 * context; this pins the arithmetic it composes with).
 */

test("a block keeps the newest rows and counts what it held back", () => {
  const rows = Array.from({ length: 9 }, (_, index) => `row ${index}`);
  const { kept, heldBack } = bounded(rows, 5);
  // The NEWEST five, not the oldest: the recent work is the live work.
  expect(kept).toEqual(["row 4", "row 5", "row 6", "row 7", "row 8"]);
  expect(heldBack).toBe(4);
});

test("a block under its limit holds nothing back", () => {
  const { kept, heldBack } = bounded(["a", "b"], 5);
  expect(kept).toEqual(["a", "b"]);
  expect(heldBack).toBe(0);
});

test("an exactly-full block holds nothing back", () => {
  const rows = ["a", "b", "c", "d", "e"];
  expect(bounded(rows, 5)).toEqual({ kept: rows, heldBack: 0 });
});

test("an empty block stays empty", () => {
  expect(bounded([], 5)).toEqual({ kept: [], heldBack: 0 });
});
