import { expect, test } from "bun:test";
import {
  CHAT_OUTPUT_MAX_LINES,
  SINGLE_LINE_MAX_CHARS,
  clipLongLine,
  headTailCap,
  toolOutputHidden,
} from "../src/head-tail-cap";

/**
 * The output cap every tool card shares (S2).
 *
 * The ruling: every tool output is collapsed by default and opens by hand.
 * The shape is the reference implementation's — head slice, fold toggle
 * naming what is hidden, tail slice — and the rules pinned here are what
 * make "collapsed by default" mean the same thing for a read, a terminal, a
 * diff and a search.
 */

test("a short output hides nothing and shows no toggle", () => {
  // At or under the cap the whole output shows; there is nothing to fold.
  expect(toolOutputHidden("a\nb\nc")).toBe(0);
  expect(headTailCap(3, CHAT_OUTPUT_MAX_LINES, false).capped).toBe(false);
  expect(
    headTailCap(CHAT_OUTPUT_MAX_LINES, CHAT_OUTPUT_MAX_LINES, false).capped,
  ).toBe(false);
});

test("a long multi-line output hides everything past the cap", () => {
  // The whole-output bound: rows beyond the cap are what the toggle names.
  const text = Array.from({ length: 30 }, (_, index) => `line ${index}`).join(
    "\n",
  );
  expect(toolOutputHidden(text)).toBe(30 - CHAT_OUTPUT_MAX_LINES);
});

test("a long output splits head and tail around the toggle", () => {
  const cap = headTailCap(30, CHAT_OUTPUT_MAX_LINES, false);
  expect(cap.hidden).toBe(30 - CHAT_OUTPUT_MAX_LINES);
  expect(cap.capped).toBe(true);
  expect(cap.headLines).toBe(Math.ceil(CHAT_OUTPUT_MAX_LINES / 2));
  expect(cap.headLines + cap.tailLines).toBe(CHAT_OUTPUT_MAX_LINES);
});

test("expanding uncaps the same list without changing its rows", () => {
  const cap = headTailCap(30, CHAT_OUTPUT_MAX_LINES, true);
  expect(cap.capped).toBe(false);
  // The hidden count is still reported, so the collapse control knows.
  expect(cap.hidden).toBe(30 - CHAT_OUTPUT_MAX_LINES);
});

test("a single over-long line collapses on its own term (P0.2 kept)", () => {
  // The one-line JSON shape passes any line count, so it needs its own
  // bound — the 2026-10-07 rule, carried into the new cap.
  const oneLineJson = JSON.stringify({
    items: Array.from({ length: 12 }, (_, index) => ({
      path: `packages/some/deeply/nested/file-${index}.ts`,
      kind: "modify",
    })),
  });
  expect(oneLineJson.includes("\n")).toBe(false);
  expect(Array.from(oneLineJson).length).toBeGreaterThan(SINGLE_LINE_MAX_CHARS);
  expect(toolOutputHidden(oneLineJson)).toBe(1);
  // A single SHORT line does not.
  expect(toolOutputHidden(JSON.stringify({ id: "sb_1" }))).toBe(0);
});

test("the collapsed preview of a long line is bounded", () => {
  const clipped = clipLongLine("x".repeat(900));
  expect(Array.from(clipped).length).toBe(SINGLE_LINE_MAX_CHARS + 1);
  expect(clipped.endsWith("…")).toBe(true);
  // A line under the bound passes through untouched.
  expect(clipLongLine("short")).toBe("short");
});
