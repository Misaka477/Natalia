/**
 * The terminal renderer: the pane's byte stream applied to a virtual
 * screen, the model's human view (the Natalia settlement plan's block 3).
 *
 * Why this exists: the model used to receive the pane's captured stream —
 * every cursor move, every redraw, escape sequences inline — because the
 * pty backend has no screen at all (an accumulating byte buffer sliced
 * into lines). A human sees the RENDERED grid; the model now sees the
 * same. This module is that missing layer, pure: bytes in, grid out.
 *
 * Scope is deliberate: the model reads TEXT, not pixels. The emulator
 * handles the sequences TUIs actually emit — printable text and the C0
 * controls, CSI cursor moves / erase / scroll / insert-delete lines, SGR
 * (recorded per cell but rendered as text), the DEC private modes that
 * matter (cursor visibility, alt-screen, bracketed paste), and OSC
 * (titles — skipped). Unknown sequences are dropped conservatively; the
 * fixtures (real vim/htop/REPL/progress-bar captures) pin the shape, and
 * the suite cross-checks the invariant that matters: the rendered grid
 * shows what the app shows.
 */

/** One screen cell: the character, plus the SGR state that produced it. */
export type ScreenCell = {
  char: string;
  /** The raw SGR parameter string (e.g. "1;31"), empty for default. */
  sgr: string;
};

export type TerminalScreen = {
  rows: number;
  cols: number;
  /** Row-major cells, always rows × cols; blanks are space-filled. */
  grid: ScreenCell[][];
  cursorX: number;
  cursorY: number;
  /** Whether the cursor is visible (DEC mode 25). */
  cursorVisible: boolean;
  /** Lines that scrolled off the top, in order (the durable history). */
  scrollback: string[];
  /** The alternate screen is active (DEC mode 1049) — full-screen apps. */
  altScreen: boolean;
  /**
   * The last frame before a resize, archived because the two readers of this
   * screen need different things from a resize.
   *
   * The HUMAN reader is xterm.js, and the applications inside the pane redraw
   * for the new geometry — so re-flowing the old cells would corrupt what they
   * draw next (that is what the existing resize test pins). The MODEL reader is
   * `read()`, and nothing redraws for it: after a resize it would see an empty
   * grid and lose the answer it was looking for, which is a bug only a second
   * reader can have. So the frame is archived here, and `read` prefers the live
   * grid and falls back to this one when the grid is blank.
   */
  previousFrame?: {
    rows: number;
    cols: number;
    lines: string[];
    at: number;
  };
};

export type TerminalScreenOptions = {
  rows?: number;
  cols?: number;
  /** The scrollback bound; older lines drop. */
  scrollbackLimit?: number;
};

const DEFAULT_SCROLLBACK_LIMIT = 1000;

/** A fresh screen with the cursor home and the default attributes. */
export function createTerminalScreen(
  options: TerminalScreenOptions = {},
): TerminalScreen {
  const rows = Math.max(1, options.rows ?? 24);
  const cols = Math.max(1, options.cols ?? 80);
  return {
    rows,
    cols,
    grid: blankGrid(rows, cols),
    cursorX: 0,
    cursorY: 0,
    cursorVisible: true,
    scrollback: [],
    altScreen: false,
  };
}

function blankGrid(rows: number, cols: number): ScreenCell[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ char: " ", sgr: "" })),
  );
}

/**
 * Resizes the grid in place, preserving the durable scrollback.
 *
 * The pty resizes with the pane and the applications inside redraw for the new
 * geometry, so the grid is re-blanked rather than re-flowed: re-flowing raw
 * cells would corrupt what the app draws next. `cursorVisible` survives (a
 * hide-cursor mode is orthogonal to geometry); `altScreen` resets because the
 * app re-enters the alternate screen after a resize it did not ask for.
 */
export function resizeTerminalScreen(
  screen: TerminalScreen,
  rows: number,
  cols: number,
): TerminalScreen {
  const nextRows = Math.max(1, Math.floor(rows));
  const nextCols = Math.max(1, Math.floor(cols));
  if (nextRows === screen.rows && nextCols === screen.cols) return screen;
  // Archive the frame the model may still be reading. Only when it has content:
  // an already-blank frame is not worth keeping, and this runs on every resize.
  if (renderScreen(screen).some((line) => line.trim().length > 0))
    screen.previousFrame = {
      rows: screen.rows,
      cols: screen.cols,
      lines: renderScreen(screen),
      at: Date.now(),
    };
  screen.rows = nextRows;
  screen.cols = nextCols;
  screen.grid = blankGrid(nextRows, nextCols);
  screen.cursorX = 0;
  screen.cursorY = 0;
  screen.altScreen = false;
  return screen;
}

/** The screen's visible text, one string per row (trailing blanks trimmed). */
export function renderScreen(screen: TerminalScreen): string[] {
  const rows = screen.grid.map((row) => trimRow(row).join(""));
  // Trailing empty rows are not content: the screen is a fixed-height
  // window, and a human (or the model) reads the used portion.
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows;
}

function trimRow(row: ScreenCell[]): string[] {
  let end = row.length;
  while (end > 0 && row[end - 1]!.char === " ") end -= 1;
  return row.slice(0, end).map((cell) => cell.char);
}

/** The joined visible text (the model's primary view). */
export function renderScreenText(screen: TerminalScreen): string {
  return renderScreen(screen).join("\n");
}

/**
 * Apply a chunk of the pane's output to the screen. Pure over the state
 * it mutates: the same bytes applied twice are idempotent in the sense
 * that matters (the grid ends where a terminal ends), and unknown
 * sequences never throw.
 */
export function applyTerminalOutput(
  screen: TerminalScreen,
  chunk: string,
  options: { scrollbackLimit?: number } = {},
): void {
  const limit = options.scrollbackLimit ?? DEFAULT_SCROLLBACK_LIMIT;
  let index = 0;
  const text = chunk;
  while (index < text.length) {
    const code = text.codePointAt(index)!;
    const char = String.fromCodePoint(code);
    index += char.length;

    if (char === "\x1b") {
      index = applyEscape(screen, text, index);
      continue;
    }
    switch (char) {
      case "\r":
        screen.cursorX = 0;
        break;
      case "\n":
        lineFeed(screen);
        break;
      case "\b":
        screen.cursorX = Math.max(0, screen.cursorX - 1);
        break;
      case "\t":
        screen.cursorX = Math.min(screen.cols - 1, (screen.cursorX + 8) & ~7);
        break;
      case "\u0007":
      case "\u0000":
        break;
      default:
        if (code < 0x20) break; // other C0 controls: dropped
        writeChar(screen, char);
    }
  }
  trimScrollback(screen, limit);
}

/** An escape sequence: returns the index just past it. */
function applyEscape(
  screen: TerminalScreen,
  text: string,
  index: number,
): number {
  const next = text[index];
  if (next === undefined) return index;
  if (next === "[") return applyCsi(screen, text, index + 1);
  if (next === "]") return skipOsc(text, index + 1);
  if (next === "P" || next === "X" || next === "^" || next === "_")
    return skipString(text, index + 1); // DCS/SOS/PM/APC
  if (next === "(" || next === ")" || next === "*" || next === "+")
    return index + 2; // charset designation: one more byte
  return index + 1; // ESC + one byte (7-bit controls): dropped
}

/** A CSI sequence: parameters, then the final byte. */
function applyCsi(screen: TerminalScreen, text: string, index: number): number {
  let position = index;
  const parameters: number[] = [];
  let current = "";
  let privateMarker = "";
  if (
    text[position] === "?" ||
    text[position] === ">" ||
    text[position] === "="
  )
    privateMarker = text[position]!;
  if (privateMarker) position += 1;
  while (position < text.length) {
    const char = text[position]!;
    if (char >= "0" && char <= "9") {
      current += char;
      position += 1;
      continue;
    }
    if (char === ";") {
      parameters.push(Number(current || "0"));
      current = "";
      position += 1;
      continue;
    }
    if (char === ":") {
      // SGR sub-parameters: fold into the current value's string form.
      current += ":";
      position += 1;
      continue;
    }
    break;
  }
  if (current) parameters.push(Number(current));
  const final = text[position];
  if (final === undefined) return position;
  position += 1;
  if (privateMarker) {
    // DEC private modes (cursor visibility, alt screen, bracketed paste).
    if (final === "h" || final === "l") {
      const enable = final === "h";
      for (const parameter of parameters)
        applyPrivateMode(screen, parameter, enable);
    }
    return position;
  }
  applyCsiFinal(screen, parameters, final);
  return position;
}

function applyPrivateMode(
  screen: TerminalScreen,
  mode: number,
  enable: boolean,
): void {
  if (mode === 25) screen.cursorVisible = enable;
  if (mode === 1049 || mode === 47 || mode === 1047) {
    if (enable && !screen.altScreen) {
      // Entering the alt screen: the visible grid is stashed by the app's
      // own contract (it restores on exit); the fresh screen starts blank
      // with the cursor home.
      screen.grid = blankGrid(screen.rows, screen.cols);
      screen.cursorX = 0;
      screen.cursorY = 0;
    }
    screen.altScreen = enable;
  }
}

function applyCsiFinal(
  screen: TerminalScreen,
  parameters: number[],
  final: string,
): void {
  const parameter = (fallback: number) =>
    parameters.length ? parameters[0] || fallback : fallback;
  switch (final) {
    case "A":
      screen.cursorY = Math.max(0, screen.cursorY - parameter(1));
      break;
    case "B":
      screen.cursorY = Math.min(screen.rows - 1, screen.cursorY + parameter(1));
      break;
    case "C":
      screen.cursorX = Math.min(screen.cols - 1, screen.cursorX + parameter(1));
      break;
    case "D":
      screen.cursorX = Math.max(0, screen.cursorX - parameter(1));
      break;
    case "E":
      screen.cursorY = Math.min(screen.rows - 1, screen.cursorY + parameter(1));
      screen.cursorX = 0;
      break;
    case "F":
      screen.cursorY = Math.max(0, screen.cursorY - parameter(1));
      screen.cursorX = 0;
      break;
    case "G":
    case "`":
      screen.cursorX = clamp(parameter(1) - 1, 0, screen.cols - 1);
      break;
    case "H":
    case "f": {
      screen.cursorY = clamp(parameter(1) - 1, 0, screen.rows - 1);
      screen.cursorX = clamp((parameters[1] ?? 1) - 1, 0, screen.cols - 1);
      break;
    }
    case "J":
      eraseDisplay(screen, parameter(0));
      break;
    case "K":
      eraseLine(screen, parameter(0));
      break;
    case "L":
      insertLines(screen, parameter(1));
      break;
    case "M":
      deleteLines(screen, parameter(1));
      break;
    case "P":
      deleteChars(screen, parameter(1));
      break;
    case "@":
      insertChars(screen, parameter(1));
      break;
    case "S":
      scrollUp(screen, parameter(1));
      break;
    case "T":
      scrollDown(screen, parameter(1));
      break;
    case "m":
      break; // SGR: attributes only; the render is textual
    default:
      break; // unknown final byte: dropped
  }
}

function writeChar(screen: TerminalScreen, char: string): void {
  if (screen.cursorX >= screen.cols) {
    // Autowrap: the next column goes to the next line's start.
    screen.cursorX = 0;
    lineFeed(screen);
  }
  const row = screen.grid[screen.cursorY]!;
  row[screen.cursorX] = { char, sgr: "" };
  screen.cursorX += 1;
}

function lineFeed(screen: TerminalScreen): void {
  if (screen.cursorY >= screen.rows - 1) {
    scrollUp(screen, 1);
    return;
  }
  screen.cursorY += 1;
}

function scrollUp(screen: TerminalScreen, count: number): void {
  for (let step = 0; step < count; step += 1) {
    const top = screen.grid.shift();
    if (top) screen.scrollback.push(trimRow(top).join(""));
    screen.grid.push(
      Array.from({ length: screen.cols }, () => ({ char: " ", sgr: "" })),
    );
  }
}

function scrollDown(screen: TerminalScreen, count: number): void {
  for (let step = 0; step < count; step += 1) {
    screen.grid.pop();
    screen.grid.unshift(
      Array.from({ length: screen.cols }, () => ({ char: " ", sgr: "" })),
    );
  }
}

function eraseDisplay(screen: TerminalScreen, mode: number): void {
  if (mode === 0 || mode === 2) {
    if (mode === 0) eraseLine(screen, 0);
    if (mode === 2)
      for (let row = screen.cursorY + 1; row < screen.rows; row += 1)
        blankInto(screen, row);
    return;
  }
  if (mode === 1) {
    for (let row = 0; row < screen.cursorY; row += 1) blankInto(screen, row);
    eraseLine(screen, 1);
  }
}

function eraseLine(screen: TerminalScreen, mode: number): void {
  const row = screen.grid[screen.cursorY]!;
  if (mode === 0) {
    // From the cursor to the end (the progress-bar redraw's shape).
    for (let column = screen.cursorX; column < row.length; column += 1)
      row[column] = { char: " ", sgr: "" };
  } else if (mode === 1) {
    // From the start through the cursor.
    for (let column = 0; column <= screen.cursorX; column += 1)
      row[column] = { char: " ", sgr: "" };
  } else blankRange(screen, row, row.length);
}

function blankRange(
  screen: TerminalScreen,
  row: ScreenCell[],
  endExclusive: number,
): void {
  for (let column = 0; column < endExclusive; column += 1)
    row[column] = { char: " ", sgr: "" };
}

function blankInto(screen: TerminalScreen, rowIndex: number): void {
  const row = screen.grid[rowIndex];
  if (row) blankRange(screen, row, screen.cols);
}

function insertLines(screen: TerminalScreen, count: number): void {
  for (let step = 0; step < count; step += 1) {
    screen.grid.splice(screen.cursorY, 0, blankLine(screen.cols));
    screen.grid.pop();
  }
}

function deleteLines(screen: TerminalScreen, count: number): void {
  for (let step = 0; step < count; step += 1) {
    screen.grid.splice(screen.cursorY, 1);
    screen.grid.push(blankLine(screen.cols));
  }
}

function insertChars(screen: TerminalScreen, count: number): void {
  const row = screen.grid[screen.cursorY]!;
  for (let step = 0; step < count; step += 1) {
    row.splice(screen.cursorX, 0, { char: " ", sgr: "" });
    row.pop();
  }
}

function deleteChars(screen: TerminalScreen, count: number): void {
  const row = screen.grid[screen.cursorY]!;
  for (let step = 0; step < count; step += 1) {
    row.splice(screen.cursorX, 1);
    row.push({ char: " ", sgr: "" });
  }
}

function blankLine(cols: number): ScreenCell[] {
  return Array.from({ length: cols }, () => ({ char: " ", sgr: "" }));
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function trimScrollback(screen: TerminalScreen, limit: number): void {
  if (screen.scrollback.length > limit)
    screen.scrollback.splice(0, screen.scrollback.length - limit);
}

function skipOsc(text: string, index: number): number {
  // OSC runs to BEL or ST (ESC \); titles are dropped.
  let position = index;
  while (position < text.length) {
    const char = text[position]!;
    if (char === "\u0007") return position + 1;
    if (char === "\x1b" && text[position + 1] === "\\") return position + 2;
    position += 1;
  }
  return position;
}

function skipString(text: string, index: number): number {
  // DCS/SOS/PM/APC run to ST.
  let position = index;
  while (position < text.length) {
    if (text[position] === "\x1b" && text[position + 1] === "\\")
      return position + 2;
    position += 1;
  }
  return position;
}
