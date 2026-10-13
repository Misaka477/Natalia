import { expect, test } from "bun:test";
import { readFileTools } from "../src";

/**
 * The legacy TEXT envelope's header must never reach the reader as a line
 * of the file (audit ④): old durable events carry `TOTALLINES 204
 * TRUNCATED true` as the result's first line, the JSON parse of that
 * fails, and the whole value — header included — used to be numbered and
 * rendered as the page. The reader saw a line no source file contains.
 */

function present(value: string, args: Record<string, unknown> = {}) {
  const tool = readFileTools.find((entry) => entry.name === "read_file")!;
  return tool.output?.presentResult?.(
    { path: "a.ts", offset: 1, ...args },
    value,
  ) as
    | {
        content?: unknown;
        lines?: Array<{ number: number; text: string }>;
        totalLines?: unknown;
        truncated?: unknown;
        summary?: unknown;
        meta?: Array<[string, string]>;
      }
    | undefined;
}

test("the JSON envelope still parses as before", () => {
  const card = present(
    JSON.stringify({
      content: "line one\nline two",
      totalLines: 5,
      truncated: true,
    }),
  );
  expect(card?.lines).toEqual([
    { number: 1, text: "line one" },
    { number: 2, text: "line two" },
  ]);
  expect(card?.totalLines).toBe(5);
  expect(card?.truncated).toBe(true);
  expect(card?.summary).toBe("lines 1-2 of 5");
});

test("the legacy text header moves to the facts, not the body", () => {
  const card = present(
    "TOTALLINES 204 TRUNCATED true\nfirst real line\nsecond",
  );
  // The header is gone from the page; its facts live in the structured
  // fields the footer and the facets read.
  expect(card?.lines).toEqual([
    { number: 1, text: "first real line" },
    { number: 2, text: "second" },
  ]);
  expect(card?.totalLines).toBe(204);
  expect(card?.truncated).toBe(true);
  expect(card?.content).toBe("first real line\nsecond");
  expect(card?.summary).toBe("lines 1-2 of 204");
});

test("a non-envelope result still degrades to the raw text", () => {
  // The defensive shape, unchanged: a read whose result is plain text (no
  // header, no JSON) shows it, numbered from the read's own offset.
  const card = present("just text\nmore text");
  expect(card?.content).toBe("just text\nmore text");
  expect(card?.lines).toEqual([
    { number: 1, text: "just text" },
    { number: 2, text: "more text" },
  ]);
  expect(card?.totalLines).toBeUndefined();
});

test("a legacy header with no content leaves an empty page, not a header line", () => {
  const card = present("TOTALLINES 0 TRUNCATED false");
  expect(card?.lines).toEqual([]);
  expect(card?.content).toBe("");
  expect(card?.totalLines).toBe(0);
  expect(card?.truncated).toBeUndefined();
});
