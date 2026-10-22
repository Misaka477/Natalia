import { expect, test } from "bun:test";
import {
  collapseDuplicateTranscriptRows,
  dedupeTranscriptRowsById,
  stableRows,
  type RowSignature,
} from "../src/stable-rows";

type Row = { id: string; text: string };
type Cache = Map<string, { signature: RowSignature; value: Row }>;

const row = (id: string, signature: RowSignature, text: string) => ({
  id,
  signature,
  create: (): Row => ({ id, text }),
});

test("reuses the row object while its signature is unchanged", () => {
  const cache: Cache = new Map();
  const first = stableRows(cache, [row("a", ["a", "hi"], "hi")]);
  const second = stableRows(cache, [row("a", ["a", "hi"], "hi")]);
  expect(second[0]).toBe(first[0]);
});

test("rebuilds only the row whose signature changed", () => {
  const cache: Cache = new Map();
  const first = stableRows(cache, [
    row("a", ["a"], "a1"),
    row("b", ["b"], "b1"),
  ]);
  const second = stableRows(cache, [
    row("a", ["a"], "a1"),
    row("b", ["b2"], "b2"),
  ]);
  expect(second[0]).toBe(first[0]);
  expect(second[1]).not.toBe(first[1]);
});

test("prunes rows that are no longer visible", () => {
  const cache: Cache = new Map();
  stableRows(cache, [row("gone", ["g"], "")]);
  expect(cache.has("gone")).toBe(true);
  stableRows(cache, []);
  expect(cache.has("gone")).toBe(false);
});

test("collapses duplicate assistant and thinking rows within one turn", () => {
  const rows = [
    { id: "turn_a:thinking", role: "thinking", content: "same thought" },
    {
      id: "turn_a:thinking:segment:1",
      role: "thinking",
      content: "same thought",
    },
    { id: "turn_a:assistant", role: "assistant", content: "same answer" },
    {
      id: "turn_a:assistant:segment:1",
      role: "assistant",
      content: "same answer",
    },
    { id: "turn_a:tool:1", role: "assistant", content: "", toolCalls: [{}] },
    { id: "turn_a:tool:2", role: "assistant", content: "", toolCalls: [{}] },
    { id: "turn_b:assistant", role: "assistant", content: "same answer" },
  ];
  expect(collapseDuplicateTranscriptRows(rows).map((row) => row.id)).toEqual([
    "turn_a:thinking",
    "turn_a:assistant",
    "turn_a:tool:1",
    "turn_a:tool:2",
    "turn_b:assistant",
  ]);
});

test("dedupes transcript rows by id before rendering", () => {
  const rows = [
    { id: "a", role: "user", content: "one" },
    { id: "a", role: "user", content: "one" },
    { id: "b", role: "assistant", content: "two" },
  ];
  expect(dedupeTranscriptRowsById(rows).map((row) => row.id)).toEqual([
    "a",
    "b",
  ]);
});
