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

test("generic is the one kind whose text is flattened", () => {
  // An envelope tool's result is its own document, and reading it (the
  // flatten) is the kit's job for exactly this kind: a record array reads
  // one record per line, never inlined onto the key.
  const envelope = JSON.stringify({
    items: [{ id: "a" }, { id: "b" }],
    total: 2,
  });
  const card: ToolCard = {
    kind: "generic",
    title: "todo",
    summary: "written",
    body: envelope,
  };
  const lines = CARD_RENDERERS.generic(card, toolCall());
  expect(lines.map((entry) => entry.line)).toEqual([
    "items:",
    "  · id=a",
    "  · id=b",
    "total: 2",
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
