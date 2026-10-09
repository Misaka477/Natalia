import { expect, test } from "bun:test";
import { terminalToolFamily, terminalTools } from "../src";

/**
 * The terminal family's cards (UI refactor R3).
 *
 * The contract the fourteen tools share:
 *
 *   1. every tool declares `presentationMeta` — the ONE decode of the pane
 *      record — and the card is composed from those facts, so the result
 *      string is never parsed a second time;
 *   2. the structured fields the `ToolCard` union declares for a kind are
 *      what the card carries (a read's `content`, a search's `matches`, a
 *      terminal's `command`/`output`/`exitCode`);
 *   3. a result that is not the envelope degrades the card, never throws.
 *
 * The poison test is the mutation proof for (1).
 */

const tools = new Map(terminalTools().map((tool) => [tool.name, tool]));

function outputOf(name: string) {
  const output = tools.get(name)?.output;
  if (!output?.presentCall || !output.presentResult || !output.presentationMeta)
    throw new Error(`${name} must declare the full projection`);
  return output;
}

test("every terminal tool declares presentationMeta (R3)", () => {
  // P2-19: interactive_terminal_cleanup joined the family, so exited panes
  // stop accumulating forever.
  expect(tools.size).toBe(15);
  for (const [name, tool] of tools) {
    expect(
      typeof tool.output?.presentationMeta,
      `${name} needs presentationMeta`,
    ).toBe("function");
  }
});

test("a read's served window is the read card's content", () => {
  const value = JSON.stringify({
    id: "t1",
    text: "line one\nline two",
    truncated: false,
    totalLines: 40,
    window: { startLine: 5, endLine: 6, lineCount: 2 },
    cursorX: 3,
    cursorY: 7,
  });
  const meta = outputOf("interactive_terminal_read").presentationMeta!(
    { id: "t1" },
    value,
  );
  const card = outputOf("interactive_terminal_read").presentResult!(
    { id: "t1" },
    value,
    meta,
  );
  expect(card).toMatchObject({
    kind: "read",
    title: "t1",
    summary: "lines 5-6 of 40",
    content: "line one\nline two",
    meta: [
      ["lines", "40"],
      ["cursor", "3,7"],
    ],
  });
});

test("a scrollback search's hits are the search card's matches", () => {
  const value = JSON.stringify({
    id: "t1",
    matches: [
      { line: 12, text: "the renderer" },
      { line: 40, text: "renderer again" },
    ],
    truncated: true,
    nextCursor: { startLine: 41 },
  });
  const meta = outputOf("interactive_terminal_search").presentationMeta!(
    { id: "t1", query: "renderer" },
    value,
  );
  const card = outputOf("interactive_terminal_search").presentResult!(
    { id: "t1", query: "renderer" },
    value,
    meta,
  );
  expect(card).toMatchObject({
    kind: "search",
    title: "t1",
    summary: "2 matches · more",
    query: "renderer",
    matches: [
      { path: "t1", line: 12, text: "the renderer" },
      { path: "t1", line: 40, text: "renderer again" },
    ],
    truncated: true,
    nextCursor: "41",
  });
});

test("the last command's card carries the command and its exit", () => {
  const value = JSON.stringify({
    id: "t1",
    commandLine: "bun test",
    exitCode: 3,
  });
  const meta = outputOf("interactive_terminal_last_command").presentationMeta!(
    { id: "t1" },
    value,
  );
  const card = outputOf("interactive_terminal_last_command").presentResult!(
    { id: "t1" },
    value,
    meta,
  );
  expect(card).toMatchObject({
    kind: "terminal",
    title: "bun test",
    summary: "exit 3",
    command: "bun test",
    exitCode: 3,
    meta: [["exit", "3"]],
  });
});

test("a snapshot's screen is the terminal card's output", () => {
  const value = JSON.stringify({
    id: "t1",
    screen: "$ ls\npackage.json",
    rows: 24,
    cols: 80,
  });
  const meta = outputOf("interactive_terminal_snapshot").presentationMeta!(
    { id: "t1" },
    value,
  );
  const card = outputOf("interactive_terminal_snapshot").presentResult!(
    { id: "t1" },
    value,
    meta,
  );
  expect(card).toMatchObject({
    kind: "terminal",
    title: "t1",
    output: "$ ls\npackage.json",
    meta: [["screen", "24x80"]],
  });
});

test("the card is composed from the FACTS, not a second parse (poison)", () => {
  // The runtime computes the facts once and hands them over. A presenter
  // that parses `value` again reads POISON here and loses the facts.
  const readMeta = outputOf("interactive_terminal_read").presentationMeta!(
    { id: "t1" },
    JSON.stringify({ id: "t1", text: "kept", totalLines: 7 }),
  );
  expect(
    outputOf("interactive_terminal_read").presentResult!(
      { id: "t1" },
      "POISON",
      readMeta,
    ),
  ).toMatchObject({ kind: "read", title: "t1", summary: "read" });
  const startMeta = outputOf("interactive_terminal_start").presentationMeta!(
    { id: "t1", command: "bun dev" },
    JSON.stringify({ id: "t1", status: "running", pid: 4242, cwd: "/w" }),
  );
  expect(
    outputOf("interactive_terminal_start").presentResult!(
      { id: "t1", command: "bun dev" },
      "POISON",
      startMeta,
    ),
  ).toMatchObject({
    kind: "terminal",
    title: "t1",
    summary: "running",
    command: "bun dev",
    cwd: "/w",
    meta: [["pid", "4242"]],
  });
});

test("a result that is not the envelope degrades the card", () => {
  // A prose error leaves no facts; the row reads its call verb.
  expect(
    outputOf("interactive_terminal_stop").presentResult!(
      { id: "t1" },
      "pane is gone",
    ),
  ).toMatchObject({ kind: "terminal", title: "t1", summary: "stopped" });
  expect(
    outputOf("interactive_terminal_list").presentResult!({}, "not a listing"),
  ).toMatchObject({ summary: "0 listed · 0 running" });
});
