import { expect, test } from "bun:test";
import { messageTextMode } from "../src/transcript";

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
