import { expect, test } from "bun:test";
import { messageTextMode, resetMessageTextModes } from "../src/transcript";

/**
 * The ui-performance plan's P1, as a pure decision: a streaming row
 * renders PLAIN text (every delta used to re-parse the whole prefix as
 * markdown — O(n²) over the stream, a cache entry per prefix), and
 * `content.done` flips `streaming` false so the full parse takes over on
 * the confirmed text. The DOM halves follow the mode by construction
 * (`textContent` for plain, the parse for markdown).
 */

test("the streaming tail is plain; the confirmed text is markdown", () => {
  expect(messageTextMode({ streaming: true })).toBe("plain");
  expect(messageTextMode({ streaming: false })).toBe("markdown");
  // An absent flag (a non-streaming message) parses — the default is the
  // rich render, never the degraded one.
  expect(messageTextMode({})).toBe("markdown");
});

test("a confirmed row never flips back to plain (P3.1)", () => {
  // The flicker the user saw: mid-stream events emptied the pending tail
  // (a status update, a re-activation), the row parsed as markdown, and
  // the next delta flipped it back to raw — over and over until done.
  // The latch makes the transition one-way.
  resetMessageTextModes();
  const row = { id: "msg_flicker", streaming: true };
  expect(messageTextMode(row)).toBe("plain");
  // The stream ends: the row parses.
  expect(messageTextMode({ id: "msg_flicker", streaming: false })).toBe(
    "markdown",
  );
  // A mid-stream-style flag flip can no longer degrade it.
  expect(messageTextMode({ id: "msg_flicker", streaming: true })).toBe(
    "markdown",
  );
  expect(messageTextMode({ id: "msg_flicker", streaming: false })).toBe(
    "markdown",
  );
  // Other rows are unaffected (the latch is per id).
  expect(messageTextMode({ id: "msg_other", streaming: true })).toBe("plain");
  resetMessageTextModes();
});

test("a message with no id keeps the flag's plain answer", () => {
  // The latch needs an identity; an anonymous row follows the flag exactly
  // as before (the existing contract's test covers the flag itself).
  resetMessageTextModes();
  expect(messageTextMode({ streaming: true })).toBe("plain");
  expect(messageTextMode({ streaming: false })).toBe("markdown");
  resetMessageTextModes();
});
