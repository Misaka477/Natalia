/**
 * Trim a mux screen dump's tail: the viewport's blank rows (and the newlines
 * that end them) carry no information, and forwarding them walks the xterm's
 * caret to the bottom of the pane while the prompt sits on the first content
 * line — the "the terminal is broken" look. Every caller trims the view with
 * this before diffing, sends and stores the trimmed text both.
 */
export function trimScreenTail(text: string): string {
  return text.replace(/\n+$/, "");
}

/**
 * The screen-diff as an append for the panel's xterm. Both `previous` and
 * `current` must already be tail-trimmed (`trimScreenTail`), so the diff never
 * carries the blank rows:
 *   - a screen that extends what was sent appends the tail (the shell case);
 *   - a screen that SCROLLED keeps a common line region: emit only what
 *     follows it (a clear+rewrite on every command is the flicker the panel
 *     reported);
 *   - a screen with no common alignment (a TUI repainted in place) is the only
 *     case that earns the clear+rewrite, whose caret then follows the last
 *     line that has content — the mux view's own cursor coords are 0,0 on this
 *     host build, so they cannot be relied on.
 */
export function terminalOutputChunk(
  previous: string,
  current: string,
  viewRows?: number,
): string {
  if (current === previous) return "";
  if (current.startsWith(previous)) return current.slice(previous.length);
  const oldLines = previous === "" ? [] : previous.split("\n");
  const newLines = current.split("\n");
  let overlap = 0;
  for (
    let size = Math.min(oldLines.length, newLines.length);
    size > 0;
    size -= 1
  ) {
    let aligned = true;
    for (let index = 0; index < size; index += 1)
      if (oldLines[oldLines.length - size + index] !== newLines[index]) {
        aligned = false;
        break;
      }
    if (aligned) {
      overlap = size;
      break;
    }
  }
  if (overlap === 0 || overlap === newLines.length) {
    const content = [...newLines];
    while (content.length > 0 && content[content.length - 1]!.trim() === "")
      content.pop();
    const row = Math.max(1, content.length);
    const col = (content[row - 1]?.length ?? 0) + 1;
    // A real terminal paints the shell's first prompt at the BOTTOM of an
    // empty viewport — the shell scrolls only once it has filled it — while
    // the mux dump starts its content at row 1. Copying that verbatim puts
    // the prompt at the top (the "not like an integrated terminal" look), so
    // a paint pads the blank rows above the content.
    const pad =
      typeof viewRows === "number" && viewRows > row ? viewRows - row : 0;
    return `[H[2J${"\n".repeat(pad)}${current}[${row + pad};${col}H`;
  }
  return `\r\n${newLines.slice(overlap).join("\r\n")}`;
}
