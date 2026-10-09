import { expect, test } from "bun:test";
import { CARD_RENDERERS } from "../src/transcript";
import type { ToolCall } from "../src/message";
import type { ToolCard } from "../src/message";

/**
 * What each renderer draws from a card's own data (UI refactor R1).
 *
 * The structured fields the `ToolCard` union declares for a kind are what
 * the renderer consumes — a terminal's `output` is the process's own text,
 * drawn verbatim, NOT the flatten's reading of it. The migration order is
 * structured field → legacy body → raw result, so a card from any era
 * renders.
 */

const toolCall = (output?: string): ToolCall => ({
  name: "some_tool",
  output,
  status: "succeeded",
});

test("a terminal's structured output is drawn verbatim", () => {
  // process_output returns a dump that may itself be JSON. The old path ran
  // it through the flatten and turned a file's contents into `key: value`
  // lines; the structured field is the tool's own text.
  const dump = '{"level":"info","msg":"listening"}\n{"level":"warn"}';
  const card: ToolCard = {
    kind: "terminal",
    title: "proc_abc",
    summary: "read",
    output: dump,
  };
  expect(CARD_RENDERERS.terminal(card, toolCall())).toEqual([
    { line: '{"level":"info","msg":"listening"}', kind: "plain" },
    { line: '{"level":"warn"}', kind: "plain" },
  ]);
});

test("a terminal without the field falls back to its body, then the result", () => {
  const legacy: ToolCard = {
    kind: "terminal",
    title: "ls",
    summary: "list",
    body: "a.ts\nb.ts",
  };
  expect(CARD_RENDERERS.terminal(legacy, toolCall("RAW"))).toEqual([
    { line: "a.ts", kind: "plain" },
    { line: "b.ts", kind: "plain" },
  ]);
  const bare: ToolCard = { kind: "terminal", title: "ls", summary: "list" };
  expect(CARD_RENDERERS.terminal(bare, toolCall("RAW"))).toEqual([
    { line: "RAW", kind: "plain" },
  ]);
});

test("generic draws its body — the tool-side reading — verbatim (R6)", () => {
  // R6: the flatten is no longer the kit's job for ANY kind. The body a
  // generic card carries IS the reading (the tool-side flatten, or the
  // runtime's default projection since R5.5), so the renderer draws it and
  // parses nothing. The reading's shape is pinned where it is produced —
  // `toolResultBody` in the contracts leaf.
  const reading = ["items:", "  · id=a", "  · id=b", "total: 2"].join("\n");
  const card: ToolCard = {
    kind: "generic",
    title: "todo",
    summary: "written",
    body: reading,
  };
  expect(
    CARD_RENDERERS.generic(card, toolCall()).map((entry) => entry.line),
  ).toEqual(["items:", "  · id=a", "  · id=b", "total: 2"]);
  // A card with no body falls back to the row's own output, still verbatim.
  const bare: ToolCard = { kind: "generic", title: "todo", summary: "written" };
  expect(CARD_RENDERERS.generic(bare, toolCall("RAW"))).toEqual([
    { line: "RAW", kind: "plain" },
  ]);
});

test("a diff's marks become color; the other kinds draw their text plain", () => {
  const diff: ToolCard = {
    kind: "diff",
    title: "a.txt",
    summary: "edit",
    body: "- old\n+ new",
  };
  expect(CARD_RENDERERS.diff(diff, toolCall())).toEqual([
    { line: "- old", kind: "removed" },
    { line: "+ new", kind: "added" },
  ]);
  for (const kind of ["read", "search", "web"] as const) {
    const card = {
      kind,
      title: "t",
      summary: "s",
      body: "one\ntwo",
    } as ToolCard;
    expect(CARD_RENDERERS[kind](card, toolCall())).toEqual([
      { line: "one", kind: "plain" },
      { line: "two", kind: "plain" },
    ]);
  }
});

test("a read's page is the file's own lines, verbatim", () => {
  // A JSON file read as content is a JSON file — the flatten's `key: value`
  // lines were the 2026-10-07 verdict, and this is where they end.
  const card: ToolCard = {
    kind: "read",
    title: "package.json",
    summary: "lines 1-3 of 3",
    content: '{\n  "name": "natalia"\n}',
    totalLines: 3,
    // The reference implementation's shape: the window's lines each keep
    // the FILE's line number, and the renderer draws them as a gutter.
    lines: [
      { number: 1, text: "{" },
      { number: 2, text: '  "name": "natalia"' },
      { number: 3, text: "}" },
    ],
  };
  expect(CARD_RENDERERS.read(card, toolCall())).toEqual([
    { line: "1: {", kind: "plain" },
    { line: '2:   "name": "natalia"', kind: "plain" },
    { line: "3: }", kind: "plain" },
  ]);
  // A card without the numbered lines (an older event, a flat content)
  // still renders its page — the gutter is an upgrade, not a gate.
  const flat: ToolCard = {
    kind: "read",
    title: "package.json",
    summary: "3 lines",
    content: "a\nb",
  };
  expect(CARD_RENDERERS.read(flat, toolCall())).toEqual([
    { line: "a", kind: "plain" },
    { line: "b", kind: "plain" },
  ]);
});

test("a content search's hits are grouped by file, with line numbers", () => {
  // The SearchMatchesResultView: where the hit lives, not a count.
  const card: ToolCard = {
    kind: "search",
    title: "renderer",
    summary: "3 matches",
    matches: [
      { path: "a.ts", line: 12, text: "the renderer" },
      { path: "a.ts", line: 40, text: "renderer again" },
      { path: "b.ts", line: 3, text: "a renderer" },
    ],
  };
  expect(CARD_RENDERERS.search(card, toolCall())).toEqual([
    { line: "a.ts", kind: "plain" },
    { line: "  12: the renderer", kind: "plain" },
    { line: "  40: renderer again", kind: "plain" },
    { line: "b.ts", kind: "plain" },
    { line: "  3: a renderer", kind: "plain" },
  ]);
});

test("a path search's listing is one line per path", () => {
  const card: ToolCard = {
    kind: "search",
    title: "Glob **/*.ts",
    summary: "2 matches",
    paths: ["a.ts", "b/c.ts"],
  };
  expect(CARD_RENDERERS.search(card, toolCall())).toEqual([
    { line: "a.ts", kind: "plain" },
    { line: "b/c.ts", kind: "plain" },
  ]);
  // A search with neither field (an old card) still shows its own text.
  const legacy: ToolCard = {
    kind: "search",
    title: "renderer",
    summary: "3 matches",
    body: "a.ts\n  12: the renderer",
  };
  expect(CARD_RENDERERS.search(legacy, toolCall())).toEqual([
    { line: "a.ts", kind: "plain" },
    { line: "  12: the renderer", kind: "plain" },
  ]);
});

test("a checklist is card data: the rows are drawn, not parsed (S4)", () => {
  // The 2026-10-08 ruling: the todo checklist used to be a name-keyed
  // special case parsing an envelope body. It is now a card field, drawn
  // the way a diff's marks are.
  const card: ToolCard = {
    kind: "generic",
    title: "todos",
    summary: "3 items · 1 done",
    checklist: [
      { text: "Read the reference", done: true },
      { text: "Ship the checklist card", done: false },
    ],
  };
  expect(CARD_RENDERERS.generic(card, toolCall())).toEqual([
    { line: "[x] Read the reference", kind: "added" },
    { line: "[ ] Ship the checklist card", kind: "plain" },
  ]);
  // A card without the field still draws its body — the field is an
  // upgrade, not a gate (replay of older events keeps working).
  const plain: ToolCard = { kind: "generic", title: "todos", body: "a\nb" };
  expect(CARD_RENDERERS.generic(plain, toolCall())).toEqual([
    { line: "a", kind: "plain" },
    { line: "b", kind: "plain" },
  ]);
});

test("a diff's hunks are drawn with the file's own line numbers (S5)", () => {
  // The structured hunks win over the mark text: a reader sees WHERE each
  // change sits, which is the whole point of a real hunk.
  const card: ToolCard = {
    kind: "diff",
    title: "a.txt",
    summary: "edit",
    body: " -one\n +two",
    hunks: [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 1,
        lines: [
          {
            type: "delete",
            text: "one",
            oldLineNumber: 1,
            newLineNumber: null,
          },
          { type: "add", text: "two", oldLineNumber: null, newLineNumber: 1 },
        ],
      },
    ],
  };
  expect(CARD_RENDERERS.diff(card, toolCall())).toEqual([
    { line: "- 1: one", kind: "removed" },
    { line: "+ 1: two", kind: "added" },
  ]);
  // A batch with several hunks labels each one, so a reader can tell the
  // files (or the regions) apart.
  const batch: ToolCard = {
    kind: "diff",
    title: "apply_edits: 2 edits",
    hunks: [
      {
        oldStart: 10,
        oldCount: 1,
        newStart: 10,
        newCount: 1,
        lines: [
          { type: "add", text: "x", oldLineNumber: null, newLineNumber: 10 },
        ],
      },
      {
        oldStart: 40,
        oldCount: 1,
        newStart: 41,
        newCount: 1,
        lines: [
          { type: "add", text: "y", oldLineNumber: null, newLineNumber: 41 },
        ],
      },
    ],
  };
  expect(CARD_RENDERERS.diff(batch, toolCall())).toEqual([
    { line: "@@ -10 +10 @@", kind: "plain" },
    { line: "+ 10: x", kind: "added" },
    { line: "@@ -40 +41 @@", kind: "plain" },
    { line: "+ 41: y", kind: "added" },
  ]);
});

test("a card field that changed meaning falls back instead of throwing (2026-10-10 live crash)", () => {
  // The live transcript threw `e.lines.map is not a function`: `read.lines`
  // was a line COUNT before it became the numbered rows, and a durable
  // journal replays the old shape. Truthiness is not narrowing — a number is
  // truthy — so every structured field goes through an array check and a
  // stale shape falls back to the text it still carries.
  const staleRead = {
    kind: "read",
    title: "a.txt",
    // The R2 shape: a count, not rows.
    lines: 3,
    content: "one\ntwo\nthree",
  } as unknown as ToolCard;
  expect(CARD_RENDERERS.read(staleRead, toolCall())).toEqual([
    { line: "one", kind: "plain" },
    { line: "two", kind: "plain" },
    { line: "three", kind: "plain" },
  ]);
  const staleSearch = {
    kind: "search",
    title: "q",
    // A count where the hits belong.
    matches: 7,
    body: "a.txt:1: hit",
  } as unknown as ToolCard;
  expect(CARD_RENDERERS.search(staleSearch, toolCall())).toEqual([
    { line: "a.txt:1: hit", kind: "plain" },
  ]);
  const staleGeneric = {
    kind: "generic",
    title: "todos",
    // A count where the checklist rows belong.
    checklist: 3,
    body: "one\ntwo\nthree",
  } as unknown as ToolCard;
  expect(CARD_RENDERERS.generic(staleGeneric, toolCall())).toEqual([
    { line: "one", kind: "plain" },
    { line: "two", kind: "plain" },
    { line: "three", kind: "plain" },
  ]);
  const staleDiff = {
    kind: "diff",
    title: "a.txt",
    // A count where the hunks belong.
    hunks: 1,
    // The mark convention is `+ `/`- ` (a leading space), which is what the
    // write family's markPatch emits.
    body: "+ old\n- new",
  } as unknown as ToolCard;
  expect(CARD_RENDERERS.diff(staleDiff, toolCall())).toEqual([
    { line: "+ old", kind: "added" },
    { line: "- new", kind: "removed" },
  ]);
  // An EMPTY array is also not rows: the text fallback still applies.
  const empty = {
    kind: "read",
    title: "a.txt",
    lines: [],
    content: "fallback",
  } as unknown as ToolCard;
  expect(CARD_RENDERERS.read(empty, toolCall())).toEqual([
    { line: "fallback", kind: "plain" },
  ]);
});
