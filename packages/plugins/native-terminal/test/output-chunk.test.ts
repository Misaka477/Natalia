import { expect, test } from "bun:test";
import { terminalOutputChunk, trimScreenTail } from "../src/output-chunk";

test("a screen that grows appends only its tail", () => {
  // The shell case: the prompt line is already on screen and a command's
  // output arrives under it. Appending is what keeps the pane from flickering.
  const previous = "prompt$ \n";
  const current = "prompt$ \necho one\none\n";
  expect(terminalOutputChunk(previous, current)).toBe("echo one\none\n");
});

test("a screen that scrolled emits only the new region", () => {
  // Once the 24 rows are full, the next line scrolls the top one away. The
  // new text no longer starts with the old one, but the last rows align: the
  // chunk is the new tail after a newline, NOT a clear+rewrite of the screen.
  const oldLines = Array.from({ length: 24 }, (_, i) => `line ${i}`);
  const previous = oldLines.join("\n");
  const newLines = [...oldLines.slice(1), "line 24", "line 25"];
  const current = newLines.join("\n");
  const chunk = terminalOutputChunk(previous, current);
  expect(chunk).toBe("\r\nline 24\r\nline 25");
});

test("a screen with no alignment clears and homes the caret", () => {
  // A TUI that repainted in place: nothing aligns, so the honest update is a
  // repaint, and the caret follows the last line that has content (the mux
  // view's own cursor coords are 0,0 on the Windows host build).
  const previous = "alpha\nbeta\n";
  const current = "alpha CHANGED\nbeta\n\n\n\n";
  const chunk = terminalOutputChunk(previous, current);
  expect(chunk.startsWith("[H[2J")).toBe(true);
  // Last content line is "beta" (4 chars) -> caret at row 2, col 5.
  expect(chunk.endsWith("[2;5H")).toBe(true);
});

test("an unchanged screen emits nothing", () => {
  expect(terminalOutputChunk("same\n", "same\n")).toBe("");
});

test("the dump tail's blank rows are trimmed before anything is sent", () => {
  // The mux dump ends with the viewport's blank rows; forwarding their
  // newlines walks the caret to the bottom of the pane.
  const dumped = "prompt$ \n\n\n\n\n";
  expect(trimScreenTail(dumped)).toBe("prompt$ ");
  expect(terminalOutputChunk("", trimScreenTail(dumped))).toContain("prompt$ ");
  // ...and the emitted paint does not end in newlines: the caret stays with
  // the prompt rather than blinking at the bottom of the pane.
  const paint = terminalOutputChunk("", trimScreenTail(dumped));
  expect(paint.endsWith("prompt$ \n")).toBe(false);
});
