import { expect, test } from "bun:test";
import {
  hasKeyedToolview,
  keyedToolviewLines,
  relativizePath,
  toolCallRow,
  parseAskTranscript,
  todoItemsFromBody,
  toolCallCard,
  toolRowLabel,
  type ToolBlockLike,
} from "../src/message";

/**
 * The bridge from a tool's self-projected card to the UI's card model.
 *
 * A tool declares its presentation in its `output` definition; the runtime
 * publishes it on the `tool.update` event's structured `card` slot (UI
 * refactor R0) — and, for events recorded before that slot existed, on the
 * legacy `metadata.call` / `metadata.render` blobs, which carry the same
 * shape. This is the last hop: the UI's `ToolCall.card`.
 *
 * The point of the whole chain is that the UI renders what the TOOL said,
 * not a guess from the tool's name — so these guards pin the decode's
 * fidelity and its fallbacks.
 */

/** A block carrying just what a card decodes from. */
function block(fields: Partial<ToolBlockLike>): ToolBlockLike {
  return {
    name: fields.name ?? "some_tool",
    status: fields.status ?? "succeeded",
    summary: fields.summary ?? "",
    ...fields,
  };
}

test("the structured card slot wins (R0)", () => {
  // A runtime since R0 publishes the tool's card as a first-class field of
  // the event; the kit reads it verbatim — no decoding, no drift possible.
  const card = toolCallCard(
    block({
      card: {
        kind: "read",
        title: "note.txt",
        summary: "1 lines",
        meta: [["totalLines", "1"]],
      },
      // The legacy blobs are ALSO present (the migration publishes both);
      // the structured slot is the later truth and must win.
      metadata: {
        render: {
          kind: "generic",
          title: "stale",
          summary: "stale",
        },
      },
    }),
  );
  expect(card).toEqual({
    kind: "read",
    title: "note.txt",
    summary: "1 lines",
    meta: [["totalLines", "1"]],
  });
});

test("a running call decodes from metadata.call", () => {
  const card = toolCallCard(
    block({
      name: "run_shell",
      status: "running",
      metadata: {
        call: {
          kind: "terminal",
          title: "ls packages/client",
          summary: "List the client modules",
        },
      },
    }),
  );
  expect(card).toEqual({
    kind: "terminal",
    title: "ls packages/client",
    summary: "List the client modules",
  });
});

test("a settled call decodes from metadata.render", () => {
  const card = toolCallCard(
    block({
      name: "run_shell",
      metadata: {
        render: {
          kind: "terminal",
          title: "ls packages/client",
          summary: "List the client modules",
          meta: [["exit", "0"]],
        },
      },
    }),
  );
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
  const card = toolCallCard(
    block({
      name: "run_shell",
      metadata: {
        call: { kind: "terminal", title: "stale", summary: "stale" },
        render: {
          kind: "terminal",
          title: "fresh",
          summary: "fresh",
          meta: [["exit", "0"]],
        },
      },
    }),
  );
  expect(card?.title).toBe("fresh");
  expect(card?.meta).toEqual([["exit", "0"]]);
});

test("an event with no card yields undefined, not a guess", () => {
  // The UI falls back to its generic row; it must not invent a title from
  // the tool name and pass it off as the tool's own words.
  expect(toolCallCard(block({}))).toBeUndefined();
  expect(toolCallCard(block({ metadata: {} }))).toBeUndefined();
  expect(
    toolCallCard(block({ metadata: { call: { title: "no kind" } } })),
  ).toBeUndefined();
});

test("a malformed intent is treated as absent", () => {
  expect(
    toolCallCard(block({ metadata: { call: "not an object" } })),
  ).toBeUndefined();
  expect(
    toolCallCard(
      block({ metadata: { call: { kind: 42, title: "x", summary: "y" } } }),
    ),
  ).toBeUndefined();
  // A kind outside the vocabulary is malformed, not a new kind: the row
  // renders the plain result rather than dispatching on a guess.
  expect(
    toolCallCard(
      block({
        metadata: { render: { kind: "hologram", title: "x", summary: "y" } },
      }),
    ),
  ).toBeUndefined();
  expect(
    toolCallCard(
      block({
        metadata: {
          render: { kind: "terminal", title: "ok", summary: "y", meta: "bad" },
        },
      }),
    ),
  ).toEqual({ kind: "terminal", title: "ok", summary: "y" });
});

test("the meta facets survive verbatim, pairs included", () => {
  // The exit pill, the read window badge and the truncation counter all
  // arrive as label:value pairs; a UI must not reshape them.
  const card = toolCallCard(
    block({
      name: "read_file",
      metadata: {
        render: {
          kind: "read",
          title: "Read a.ts",
          summary: "5 - 40",
          meta: [
            ["totalLines", "120"],
            ["truncated", "true"],
          ],
        },
      },
    }),
  );
  expect(card?.meta).toEqual([
    ["totalLines", "120"],
    ["truncated", "true"],
  ]);
});

test("an edit's marked hunk is what the card carries, marks included", () => {
  // The colored-line renderer keys off exactly these prefixes: a tool that
  // stops marking its hunk would silently render a diff as plain text, so the
  // marks are pinned here (the CSS is in a template literal and cannot be
  // unit-asserted; the contract it keys off CAN).
  const card = toolCallCard(
    block({
      name: "edit_file",
      metadata: {
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
      },
    }),
  );
  expect(card?.kind).toBe("diff");
  const body = card?.body ?? "";
  expect(body.split("\n").every((line) => /^[+-] /u.test(line))).toBe(true);
  // A create's hunk is all added lines, a delete's all removed: both must keep
  // their marks or the renderer's coloring would miss them.
  const created = toolCallCard(
    block({
      name: "write_file",
      metadata: {
        render: {
          kind: "diff",
          title: "b.txt",
          summary: "write",
          body: "+ new file",
        },
      },
    }),
  );
  expect(created?.body).toBe("+ new file");
  const deleted = toolCallCard(
    block({
      name: "edit_file",
      metadata: {
        render: {
          kind: "diff",
          title: "c.txt",
          summary: "edit",
          body: "- gone",
        },
      },
    }),
  );
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

test("the same block renders identically whether live or replayed (user 2026-10-07)", () => {
  // The ruling that ended the raw-JSON fight: a UI's presentation is a
  // FUNCTION OF THE DATA. A tool recorded today and replayed from the
  // journal tomorrow must read the same, so the row NEVER trusts the
  // event's stored summary — it derives from the result and from the
  // tool's own card. The historical smoke session is the proof case: its
  // events carry `summary: result.slice(0,200)` and no metadata at all.
  const raw = JSON.stringify({
    items: [
      { content: "盘点全部工具", status: "completed" },
      { content: "逐项测试", status: "pending" },
    ],
    total: 2,
    truncated: false,
  });
  // An OLD event: the stored summary is raw JSON, the metadata is empty.
  const oldEvent = {
    name: "todo_write",
    status: "succeeded",
    summary: raw.slice(0, 200),
    result: raw,
  };
  const oldRow = toolCallRow(oldEvent);
  expect(oldRow.summary).toBe("2 items");
  // And the body is the checklist, not the flatten — parsed from the
  // result, exactly as a live call's card would render.
  const lines = keyedToolviewLines(oldRow);
  expect(lines).toEqual([
    { line: "[x] 盘点全部工具", kind: "added" },
    {
      line: "[ ] 逐项测试",
      kind: "pending" === "completed" ? "added" : "plain",
    },
  ]);
  // A NEW event with the tool's own card renders the same way.
  const liveRow = toolCallRow({
    name: "todo_write",
    status: "succeeded",
    summary: "written",
    result: raw,
    card: {
      kind: "generic",
      title: "todo",
      summary: "written",
      body: raw,
      meta: [["total", "2"]],
    },
  });
  expect(liveRow.summary).toBe("written");
  expect(keyedToolviewLines(liveRow)).toEqual(lines);
});

test("ask_user's Q&A derives from the arguments and result, not the recorded card (user 2026-10-08)", () => {
  // The screenshot: five choices on one line. The cause was that the card's
  // body — a string composed when the event was RECORDED — was replayed
  // verbatim, so an event recorded before the per-line spelling (or none at
  // all) stayed cramped forever. The Q&A is now derived from the durable
  // halves: the call's arguments (question + choices) and the result (the
  // answers). Live and replayed render identically.
  const raw = JSON.stringify({
    answers: [["创建验证证据、完成卡和工程决策记录（Recommended）"]],
  });
  const row = toolCallRow({
    name: "ask_user",
    status: "succeeded",
    summary: raw.slice(0, 200),
    result: raw,
    argumentsRaw: JSON.stringify({
      question: "请选择允许范围",
      options: ["第一个选项", "第二个选项", "第三个选项"],
    }),
  });
  expect(keyedToolviewLines(row)).toEqual([
    { line: "Q: 请选择允许范围", kind: "question" },
    { line: "Options:", kind: "choices" },
    { line: "  · 第一个选项", kind: "choices" },
    { line: "  · 第二个选项", kind: "choices" },
    { line: "  · 第三个选项", kind: "choices" },
    {
      line: "A: 创建验证证据、完成卡和工程决策记录（Recommended）",
      kind: "answer",
    },
  ]);
  // An event with NO arguments at all still renders (the recorded body).
  expect(
    keyedToolviewLines({ name: "ask_user", output: "Q: old\nA: new" }),
  ).toEqual([
    { line: "Q: old", kind: "question" },
    { line: "A: new", kind: "answer" },
  ]);
});

test("ask_user's Q&A reads the card's structured fields first (R4)", () => {
  // The tool composes the Q&A from the arguments and the result (both of
  // which it already holds), so the kit reads the fields — and an event
  // recorded without them still derives the same shape from the durable
  // halves.
  const raw = JSON.stringify({ answers: [["第二个选项"]] });
  const row = toolCallRow({
    name: "ask_user",
    status: "succeeded",
    summary: "answered",
    result: raw,
    card: {
      kind: "generic",
      title: "请选择允许范围",
      summary: "answered",
      question: "请选择允许范围",
      options: ["第一个选项", "第二个选项"],
      answers: ["第二个选项"],
    },
  });
  expect(keyedToolviewLines(row)).toEqual([
    { line: "Q: 请选择允许范围", kind: "question" },
    { line: "Options:", kind: "choices" },
    { line: "  · 第一个选项", kind: "choices" },
    { line: "  · 第二个选项", kind: "choices" },
    { line: "A: 第二个选项", kind: "answer" },
  ]);
  // No answer recorded is a state, not a missing line.
  const unanswered = toolCallRow({
    name: "ask_user",
    status: "failed",
    summary: "failed",
    result: "",
    card: {
      kind: "generic",
      title: "q",
      summary: "failed",
      question: "q",
      options: [],
      answers: [],
    },
  });
  expect(keyedToolviewLines(unanswered)).toEqual([
    { line: "Q: q", kind: "question" },
    { line: "A: (no answer recorded)", kind: "answer" },
  ]);
});
