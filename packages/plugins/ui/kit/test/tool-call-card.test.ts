import { expect, test } from "bun:test";
import { toolCallCard } from "../src/message";

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
