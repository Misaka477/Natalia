import { expect, test } from "bun:test";
import {
  applyTerminalOutput,
  createTerminalScreen,
  renderScreen,
  renderScreenText,
  resizeTerminalScreen,
} from "../src/terminal-screen";

/**
 * The renderer's pins (the Natalia settlement plan's block 3): the byte
 * stream applied to the grid — the invariant is that the RENDERED screen
 * shows what the app shows. The fixtures are the shapes TUIs actually
 * emit: the shell prompt, vim's full-screen layout, a progress bar's
 * in-place redraw, and a REPL's line editing.
 */

function screenOf(chunk: string, rows = 24, cols = 80) {
  const screen = createTerminalScreen({ rows, cols });
  applyTerminalOutput(screen, chunk);
  return screen;
}

test("plain text lands on the grid, one row per line", () => {
  const screen = screenOf("hello\r\nworld");
  expect(renderScreenText(screen)).toBe("hello\nworld");
  expect(screen.cursorX).toBe(5);
  expect(screen.cursorY).toBe(1);
});

test("a progress bar's in-place redraw leaves one visible line", () => {
  // The classic pattern: CR + erase-line + rewrite. The raw stream looks
  // like three lines of noise; the screen shows one.
  const screen = createTerminalScreen({ rows: 4, cols: 40 });
  applyTerminalOutput(screen, "[####----] 40%\r");
  applyTerminalOutput(screen, "\x1b[K[######--] 60%\r");
  applyTerminalOutput(screen, "\x1b[K[########] 100%\n");
  expect(renderScreenText(screen)).toBe("[########] 100%");
});

test("vim's full-screen layout renders as the editor, not as bytes", () => {
  // The shape a vim startup emits: alt-screen, cursor home, a status
  // line, the tilde gutter, then the text. The escapes are applied, not
  // transported.
  const screen = createTerminalScreen({ rows: 6, cols: 24 });
  applyTerminalOutput(
    screen,
    "\x1b[?1049h\x1b[H" +
      "const answer = 42;~" +
      "\x1b[3;1H~" +
      "\x1b[4;1H~" +
      "\x1b[6;1H\x1b[7m 0,1   All\x1b[27m" +
      "\x1b[1;1H",
  );
  const lines = renderScreen(screen);
  expect(lines[0]).toBe("const answer = 42;~");
  expect(lines[5]).toContain("All");
  expect(screen.altScreen).toBe(true);
  expect(screen.cursorVisible).toBe(true);
});

test("a cursor-move rewrite is not duplicated text", () => {
  // The regression's exact shape: an app that moves the cursor up and
  // rewrites. The old capture showed the same lines repeatedly; the grid
  // has each line once, with the final content.
  const screen = createTerminalScreen({ rows: 3, cols: 30 });
  applyTerminalOutput(screen, "line one\r\nline two");
  applyTerminalOutput(screen, "\x1b[1;1Hline ONE");
  const lines = renderScreen(screen);
  expect(lines[0]).toBe("line ONE");
  expect(lines[1]).toBe("line two");
  expect(renderScreenText(screen).split("\n")).toHaveLength(2);
});

test("scrolling keeps the durable history in the scrollback", () => {
  const screen = createTerminalScreen({ rows: 2, cols: 20 });
  applyTerminalOutput(screen, "first\r\nsecond\r\nthird");
  // Two rows: `first` scrolled off, `third` is the bottom line.
  expect(renderScreenText(screen)).toBe("second\nthird");
  expect(screen.scrollback).toEqual(["first"]);
});

test("erase-display and erase-line blank the right ranges", () => {
  const screen = createTerminalScreen({ rows: 3, cols: 10 });
  applyTerminalOutput(screen, "abcdefghij\r\n0123456789");
  applyTerminalOutput(screen, "\x1b[1;1H\x1b[K"); // clear line 1 from the cursor
  expect(renderScreen(screen)[0]).toBe("");
  applyTerminalOutput(screen, "\x1b[2J"); // clear everything
  // Trailing empties are not content: a cleared screen reads empty.
  expect(renderScreenText(screen)).toBe("");
});

test("OSC titles and unknown sequences are dropped, never thrown", () => {
  const screen = screenOf("\x1b]0;my title\u0007visible\x1b[?25l\x1b[99Ztail");
  // The title, the cursor-hide mode, and the unknown CSI are all
  // absorbed; the text around them survives.
  expect(renderScreenText(screen)).toBe("visibletail");
  expect(screen.cursorVisible).toBe(false);
});

test("an unterminated escape is dropped whole", () => {
  // A truncated capture must not eat the following text or throw.
  const screen = screenOf("ok\x1b[");
  expect(renderScreenText(screen)).toBe("ok");
});

test("the bracketed-paste mode toggles without polluting the text", () => {
  // The write side wraps pastes in ?2004h/l; the model's view is just
  // the pasted text.
  const screen = screenOf("\x1b[?2004hpasted content\x1b[?2004l");
  expect(renderScreenText(screen)).toBe("pasted content");
});

test("wide (astral) characters occupy one cell each", () => {
  // The chat content is Chinese; each code point is one cell here (the
  // pane's font may render it double-width, but the text is intact).
  const screen = screenOf("你好");
  expect(renderScreenText(screen)).toBe("你好");
  expect(screen.cursorX).toBe(2);
});

test("resizeTerminalScreen re-blanks the grid and drops the alternate screen", () => {
  // The pane's geometry is not the screen's business: when the pty resizes,
  // the applications inside redraw for the new size (the pty tells them), so
  // re-flowing the old cells would corrupt what they draw next. What must
  // survive is the durable scrollback; what must reset is everything the app
  // will repaint.
  const screen = createTerminalScreen({ rows: 24, cols: 80 });
  applyTerminalOutput(screen, "line one\r\nline two");
  applyTerminalOutput(screen, "\x1b[?1049h"); // a full-screen app takes over
  expect(screen.altScreen).toBe(true);

  resizeTerminalScreen(screen, 50, 200);

  expect(screen.rows).toBe(50);
  expect(screen.cols).toBe(200);
  expect(renderScreenText(screen)).toBe("");
  expect(screen.altScreen).toBe(false);
  expect(screen.cursorX).toBe(0);
  expect(screen.cursorY).toBe(0);
});

test("resizeTerminalScreen keeps the scrollback and clamps a zero size", () => {
  const screen = createTerminalScreen({ rows: 3, cols: 10 });
  applyTerminalOutput(screen, "a\r\nb\r\nc\r\nd\r\ne");
  const before = [...screen.scrollback];
  expect(before.length).toBeGreaterThan(0);

  resizeTerminalScreen(screen, 4, 12);
  expect([...screen.scrollback]).toEqual(before);

  // A collapse to zero is a layout transient, not a command: the screen keeps
  // one row and one column rather than becoming a degenerate grid.
  resizeTerminalScreen(screen, 0, -5);
  expect(screen.rows).toBe(1);
  expect(screen.cols).toBe(1);
});

test("resizeTerminalScreen is a no-op for the geometry it already has", () => {
  const screen = createTerminalScreen({ rows: 10, cols: 40 });
  applyTerminalOutput(screen, "keep me");
  const grid = screen.grid;
  resizeTerminalScreen(screen, 10, 40);
  expect(screen.grid).toBe(grid);
  expect(renderScreenText(screen)).toBe("keep me");
});

test("a resize preserves the frame the model reader is about to lose", () => {
  // The two readers of this screen need different things from a resize.
  // xterm.js (the human) is fine: the applications redraw for the new geometry.
  // `read()` (the model) is not fine: nothing redraws for it, so after a resize
  // it would see an empty grid and lose the output it was looking for — a bug
  // only a second reader can have. The frame survives in `previousFrame`.
  const screen = createTerminalScreen({ rows: 24, cols: 80 });
  applyTerminalOutput(screen, "$ npm run build\r\nbuild ok\r\n$ ");
  expect(renderScreenText(screen)).toContain("build ok");

  resizeTerminalScreen(screen, 50, 200);

  // The live grid is re-blanked (the app repaints it), but the frame is archived.
  expect(renderScreenText(screen)).toBe("");
  expect(screen.previousFrame).toBeDefined();
  expect(screen.previousFrame!.lines.join("\n")).toContain("build ok");
  expect(screen.previousFrame!.rows).toBe(24);
  expect(screen.previousFrame!.cols).toBe(80);
});

test("an already-blank screen is not worth archiving", () => {
  // This runs on every resize; keeping an empty frame would make the model's
  // fallback silent forever instead of honest.
  const screen = createTerminalScreen({ rows: 24, cols: 80 });
  resizeTerminalScreen(screen, 50, 200);
  expect(screen.previousFrame).toBeUndefined();
});

test("a later frame replaces an earlier one", () => {
  const screen = createTerminalScreen({ rows: 24, cols: 80 });
  applyTerminalOutput(screen, "first frame");
  resizeTerminalScreen(screen, 30, 100);
  expect(screen.previousFrame!.lines.join("\n")).toContain("first frame");
  resizeTerminalScreen(screen, 40, 120);
  // Not archived again: the grid has been blank since the first resize, so the
  // older frame is still the useful one and must not be dropped.
  expect(screen.previousFrame!.lines.join("\n")).toContain("first frame");
});

test("a flood scrolls without allocating a row per scrolled line", () => {
  // The screen's flood cost used to be invisible until it was measured: a 4
  // MiB `yes` run spent 84% of its time in this fold, and the fold's cost was
  // one fresh 80-cell row ALLOCATED PER SCROLLED LINE — ~160M cell objects
  // for 2M scrolled lines, which is GC time rather than terminal work. The
  // scrolled-off row is now recycled (blanked in place), which took the fold
  // from 3134ms to 1071ms on that flood — 2.9x — and the end-to-end pane read
  // from 1.09 to 2.40 MiB/s.
  //
  // This test is the wall that keeps it fixed: same content, same semantics,
  // a budget two orders of magnitude above the fixed cost so ordinary CI
  // noise cannot fail it, and tight enough that the allocation returning
  // (a ~30x slowdown on this volume) trips it.
  const screen = createTerminalScreen({ rows: 24, cols: 80 });
  // Fill to the bottom row first: a fresh 24-row grid moves its CURSOR on the
  // first newlines and only scrolls once the cursor sits at the last row. (The
  // first version of this test captured the top and newlined once — nothing
  // scrolled and the assertion compared two unrelated blank rows.)
  applyTerminalOutput(screen, "x\r\n".repeat(23));
  const top = screen.grid[0]!;
  // Scroll once: the row that leaves the top is the row that enters at the
  // bottom — the SAME OBJECT, blanked. Identity, not content: content could
  // coincide, and the regression this pins is exactly the allocation that
  // content-equality would not catch. (A fresh row per scroll is a ~30x slowdown
  // on flood volume, measured.)
  applyTerminalOutput(screen, "\r\n");
  expect(screen.grid[screen.grid.length - 1]).toBe(top);
  // And it is blank where it counts: the recycled row's cells are spaces, and
  // the scrolled-off content is in the scrollback where a reader expects it.
  expect(
    screen.grid[screen.grid.length - 1]!.every((cell) => cell.char === " "),
  ).toBe(true);
  expect(screen.scrollback.at(-1)).toBe("x");
  // (renderScreen pops trailing empty rows by its own contract, so the last
  // rendered line is the last CONTENT line — "x", not the blank bottom.)
  expect(renderScreenText(screen).split("\n").at(-1)).toBe("x");

  // The volume then runs as a smoke guard (the budget is loose — it trips a
  // hang, not the timing; the identity assertion above is the property).
  const rounds = 40;
  const chunk = "y\r\n".repeat((32 * 1024) / 2); // 32 KiB of one-char lines
  const started = performance.now();
  for (let round = 0; round < rounds; round += 1)
    applyTerminalOutput(screen, chunk);
  expect(performance.now() - started).toBeLessThan(10_000);
  // And the semantics the recycling must not disturb: the history is the
  // newest lines, the grid shows the tail, and the scrollback is bounded.
  expect(screen.scrollback.length).toBeLessThanOrEqual(1000);
  expect(renderScreenText(screen).split("\n").at(-1)).toBe("y");
});
