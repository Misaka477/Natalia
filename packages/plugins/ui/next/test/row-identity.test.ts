/**
 * A row's identity answers "is this still the same row", never "what does it
 * say now".
 *
 * Measured defect this pins: the transcript's row cache keys rows by a
 * signature, and the signature carried the row's CONTENT (`msg.text`,
 * `tool.argumentsRaw`, `tool.result`, `tool.card`…). Every streaming delta
 * therefore produced a new row object, `<For>` keyed by element identity
 * rebuilt the row's DOM, and the reader saw the action row (copy / fork /
 * rollback) flicker under the cursor — with clicks landing between two deltas
 * hitting a node that no longer existed (the fold toggle and the image preview
 * "sometimes did nothing") and `data-message-id` leaving the document while the
 * scroll code was looking for it.
 *
 * The fix keeps the row object and reads its moving parts through
 * `contentLive` / `live`. These tests pin both halves: the signatures must not
 * carry content, and a live-text row must survive the dedupe pass that reads
 * `content` (which is now an empty placeholder).
 */
import { expect, test } from "bun:test";
import {
  collapseDuplicateTranscriptRows,
  stableRows,
  type RowSignature,
  type StableRow,
} from "../src/stable-rows";

const app = await Bun.file(
  new URL("../src/app-neu.tsx", import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/u,
    "$1",
  ),
).text();

/** The text-row signature block, as written in `mainMessages`. */
function textRowSignature(): string {
  const anchor = app.indexOf("        // The signature answers identity only:");
  expect(anchor).toBeGreaterThan(0);
  const at = app.indexOf("signature: [", anchor);
  expect(at).toBeGreaterThan(anchor);
  return app.slice(at, app.indexOf("]", at));
}

/** The tool-row signature block, as written in `mainMessages`. */
function toolRowSignature(): string {
  const anchor = app.indexOf(
    "            // Identity only. The arguments, the result",
  );
  expect(anchor).toBeGreaterThan(0);
  const at = app.indexOf("signature: [", anchor);
  expect(at).toBeGreaterThan(anchor);
  return app.slice(at, app.indexOf("]", at));
}

test("the text row's signature carries no content field", () => {
  const body = textRowSignature();
  for (const field of ["msg.text", "msg.pendingText", "content"])
    expect(
      body,
      `${field} must not be part of the row's identity`,
    ).not.toContain(field);
  // It still carries what a row IS.
  expect(body).toContain("isLast");
  expect(body).toContain("attachments");
});

test("the tool row's signature carries no streaming field", () => {
  const body = toolRowSignature();
  for (const field of [
    "tool.result",
    "tool.summary",
    "tool.argumentsRaw",
    "tool.card",
    "tool.meta",
    "tool.metadata",
  ])
    expect(
      body,
      `${field} must not be part of the row's identity`,
    ).not.toContain(field);
  expect(body).toContain("tool.name");
  expect(body).toContain("status");
});

test("a row whose text streams keeps its object identity across updates", () => {
  // The cache stands in for the projection: same id, same signature, different
  // live text on every frame.
  let text = "a";
  type LiveRow = { id: string; content: string; contentLive(): string };
  const cache = new Map<string, { signature: RowSignature; value: LiveRow }>();
  const build = (): LiveRow[] =>
    stableRows<LiveRow>(cache, [
      {
        id: "turn_1:1",
        signature: ["assistant"],
        create: () => ({
          id: "turn_1:1",
          content: "",
          contentLive: () => text,
        }),
      } satisfies StableRow<LiveRow>,
    ]);
  const first = build()[0]!;
  text = "ab";
  const second = build()[0]!;
  expect(second).toBe(first);
  expect(second.contentLive()).toBe("ab");
});

test("dedupe keeps two streaming rows whose live text differs", () => {
  const rows = [
    { id: "turn_1:a", role: "assistant", content: "", live: "same" },
    { id: "turn_1:b", role: "assistant", content: "", live: "same" },
  ].map((row) => ({ ...row, contentLive: () => row.live }));
  // Two rows with identical live text still collapse (the replay race the pass
  // exists for)…
  expect(collapseDuplicateTranscriptRows(rows)).toHaveLength(1);
  // …but two rows whose live text differs must BOTH survive: with the empty
  // placeholder read instead, every streaming row collapsed together.
  const differing = rows.map((row, index) => ({
    ...row,
    contentLive: () => `text-${index}`,
  }));
  expect(collapseDuplicateTranscriptRows(differing)).toHaveLength(2);
});
