import { expect, test } from "bun:test";
import {
  hasKeyedToolview,
  relativizePath,
  relativizePath,
  parseAskTranscript,
  todoItemsFromBody,
  toolCallCard,
  toolRowLabel,
} from "../src/message";

/**
 * The bridge from a tool's self-projected card to the UI's card model.
 *
 * A tool declares its presentation in its `output` definition; the runtime
 * persists it on the `tool.update` event's metadata (`metadata.call` while
 * running, `metadata.render` once settled); `ui-model` decodes it as a
 * `ToolRenderIntent`. This is the last hop: the UI's `ToolCall.card`.
 *
 * The point of the whole chain is that the UI renders what the TOOL said,
 * not a guess from the tool's name — so these guards pin the decode's
 * fidelity and its two fallbacks.
 */

test("a running call decodes from metadata.call", () => {
  const card = toolCallCard({
    call: {
      kind: "terminal",
      title: "ls packages/client",
      summary: "List the client modules",
    },
  });
  expect(card).toEqual({
    kind: "terminal",
    title: "ls packages/client",
    summary: "List the client modules",
  });
});

test("a settled call decodes from metadata.render", () => {
  const card = toolCallCard({
    render: {
      kind: "terminal",
      title: "ls packages/client",
      summary: "List the client modules",
      meta: [["exit", "0"]],
    },
  });
  expect(card).toEqual({
    kind: "terminal",
    title: "ls packages/client",
    summary: "List the client modules",
    meta: [["exit", "0"]],
  });
});

test("the result slot wins over the call slot when both are present", () => {
  // A settled event carries both: the running card and the result card. The
  // result is the later truth, so it is the one a UI shows.
  const card = toolCallCard({
    call: { kind: "terminal", title: "stale", summary: "stale" },
    render: {
      kind: "terminal",
      title: "fresh",
      summary: "fresh",
      meta: [["exit", "0"]],
    },
  });
  expect(card?.title).toBe("fresh");
  expect(card?.meta).toEqual([["exit", "0"]]);
});

test("a tool that declared no card yields undefined, not a guess", () => {
  // The UI falls back to its generic row; it must not invent a title from
  // the tool name and pass it off as the tool's own words.
  expect(toolCallCard(undefined)).toBeUndefined();
  expect(toolCallCard({})).toBeUndefined();
  expect(toolCallCard({ call: { title: "no kind" } })).toBeUndefined();
});

test("a malformed intent is treated as absent", () => {
  expect(toolCallCard({ call: "not an object" })).toBeUndefined();
  expect(
    toolCallCard({ call: { kind: 42, title: "x", summary: "y" } }),
  ).toBeUndefined();
  expect(
    toolCallCard({
      render: { kind: "terminal", title: "ok", summary: "y", meta: "bad" },
    }),
  ).toEqual({ kind: "terminal", title: "ok", summary: "y" });
});

test("the meta facets survive verbatim, pairs included", () => {
  // The exit pill, the read window badge and the truncation counter all
  // arrive as label:value pairs; a UI must not reshape them.
  const card = toolCallCard({
    render: {
      kind: "read",
      title: "Read a.ts",
      summary: "5 - 40",
      meta: [
        ["totalLines", "120"],
        ["truncated", "true"],
      ],
    },
  });
  expect(card?.meta).toEqual([
    ["totalLines", "120"],
    ["truncated", "true"],
  ]);
});

test("an edit's marked hunk is what the card carries, marks included", () => {
  // The colored-line renderer keys off exactly these prefixes: a tool that
  // stops marking its hunk would silently render a diff as plain text, so the
  // marks are pinned here (the CSS is in a template literal and cannot be
  // unit-asserted; the contract it keys off CAN be).
  const card = toolCallCard({
    render: {
      kind: "diff",
      title: "a.txt",
      summary: "edit",
      body: "- one\n- two\n+ one\n+ three",
      meta: [
        ["removed", "2"],
        ["added", "2"],
      ],
    },
  });
  expect(card?.kind).toBe("diff");
  const body = card?.body ?? "";
  expect(body.split("\n").every((line) => /^[+-] /u.test(line))).toBe(true);
  // A create's hunk is all added lines, a delete's all removed: both must keep
  // their marks or the renderer's coloring would miss them.
  const created = toolCallCard({
    render: {
      kind: "diff",
      title: "b.txt",
      summary: "write",
      body: "+ new file",
    },
  });
  expect(created?.body).toBe("+ new file");
  const deleted = toolCallCard({
    render: { kind: "diff", title: "c.txt", summary: "edit", body: "- gone" },
  });
  expect(deleted?.body).toBe("- gone");
});

test("toolRowLabel gives every tool its family label", () => {
  // The collapsed row reads `<Label> · <the sentence the model wrote>`, the
  // shape dsh's rows use (`Bash · Verify all three families in dist`). Without
  // this table the row leads with the raw command, which is what our rows did.
  expect(toolRowLabel("run_shell")).toBe("Bash");
  expect(toolRowLabel("read_file")).toBe("Read");
  expect(toolRowLabel("read_media_file")).toBe("Read");
  expect(toolRowLabel("image_read")).toBe("Read");
  expect(toolRowLabel("write_file")).toBe("Write");
  expect(toolRowLabel("edit_file")).toBe("Edit");
  expect(toolRowLabel("apply_edits")).toBe("Edit");
  expect(toolRowLabel("glob")).toBe("Glob");
  expect(toolRowLabel("grep")).toBe("Grep");
  expect(toolRowLabel("web_fetch")).toBe("Fetch");
  expect(toolRowLabel("web_search")).toBe("Search");
  expect(toolRowLabel("todo_read")).toBe("Todo");
  expect(toolRowLabel("agent_spawn")).toBe("Agent");
  expect(toolRowLabel("process_start")).toBe("Process");
  // An unclassified tool keeps its own name: the honest answer, not "other".
  expect(toolRowLabel("some_new_tool")).toBe("some_new_tool");
});

test("the keyed toolview table names exactly the keyed tools (P2.1)", () => {
  // A keyed hit REPLACES the generic card (dsh's ToolCallTree dispatch);
  // every other name falls through to the generic card.
  expect(hasKeyedToolview("ask_user")).toBe(true);
  expect(hasKeyedToolview("todo_read")).toBe(true);
  expect(hasKeyedToolview("todo_write")).toBe(true);
  // A tool nobody has keyed falls through — the honest default.
  expect(hasKeyedToolview("run_shell")).toBe(false);
  expect(hasKeyedToolview("read_file")).toBe(false);
});

test("the Q&A transcript parses into its three line kinds (P2.2)", () => {
  const lines = parseAskTranscript(
    [
      "Q: which database wins?",
      "Options: sqlite (Recommended) · postgres",
      "A: sqlite",
    ].join(String.fromCharCode(10)),
  );
  expect(lines.map((line) => line.kind)).toEqual([
    "question",
    "choices",
    "answer",
  ]);
  expect(lines.map((line) => line.text)).toEqual([
    "Q: which database wins?",
    "Options: sqlite (Recommended) · postgres",
    "A: sqlite",
  ]);
  // A body that is not the transcript still shows its lines (as plain).
  const fallback = parseAskTranscript("some raw result text");
  expect(fallback).toEqual([{ text: "some raw result text", kind: "plain" }]);
});

test("the todo checklist decodes the shared envelope (P2.3)", () => {
  const items = todoItemsFromBody(
    JSON.stringify({
      items: [
        { content: "write the parser", status: "completed" },
        { content: "add tests", status: "in_progress" },
      ],
      total: 2,
      truncated: false,
    }),
  );
  expect(items).toEqual([
    { content: "write the parser", status: "completed" },
    { content: "add tests", status: "in_progress" },
  ]);
  // A prose result has no checklist, not a crash.
  expect(todoItemsFromBody("no items")).toEqual([]);
});
test("a path title is relativized for the row (P3.3)", () => {
  // dsh's relativizeToCwd + abbreviateHomePath: the row shows the short
  // form, the full path stays in the card's body. The home fold uses the
  // environment's real HOME, so the cases are built from it.
  const home = process.env.HOME ?? "";
  const cwd = "/repo/workspace";
  expect(relativizePath("/repo/workspace/src/main.ts", cwd)).toBe(
    "src/main.ts",
  );
  // The cwd itself becomes "." rather than an empty fragment.
  expect(relativizePath(cwd, cwd)).toBe(".");
  // A path under neither passes through.
  expect(relativizePath("/var/log/syslog", cwd)).toBe("/var/log/syslog");
  if (home && home !== cwd) {
    // Home folds to ~ (checked against the real home).
    expect(relativizePath(`${home}/notes.md`, cwd)).toBe("~/notes.md");
    // The home itself folds to "~".
    expect(relativizePath(home, cwd)).toBe("~");
    // No cwd: only the home fold applies.
    expect(relativizePath(`${home}/project/src/main.ts`)).toBe(
      "~/project/src/main.ts",
    );
  }
});
