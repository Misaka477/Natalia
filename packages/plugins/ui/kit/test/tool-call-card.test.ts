import { expect, test } from "bun:test";
import { toolCallCard, toolRowLabel } from "../src/message";

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
