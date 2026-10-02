import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeStructuredDiff } from "@anthelia/contracts";
import { DiffCache, ObjectStore } from "../src";

const structured: RuntimeStructuredDiff = {
  hunks: [
    {
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 2,
      lines: [
        { type: "context", text: "a", oldLineNumber: 1, newLineNumber: 1 },
        { type: "add", text: "b", oldLineNumber: null, newLineNumber: 2 },
      ],
    },
  ],
  additions: 1,
  deletions: 0,
};

async function openCache(maxEntries = 100) {
  const root = await mkdtemp(join(tmpdir(), "natalia-diff-cache-"));
  const objects = new ObjectStore(join(root, "objects"));
  const cache = new DiffCache(objects, "test-namespace", maxEntries);
  return { objects, cache };
}

test("DiffCache stores and returns structured diffs", async () => {
  const { cache } = await openCache();
  const oldText = "a\n";
  const newText = "a\nb\n";
  expect(await cache.get(oldText, newText)).toBeUndefined();
  await cache.set(oldText, newText, {
    additions: 1,
    deletions: 0,
    structured,
  });
  const hit = await cache.get(oldText, newText);
  expect(hit).toEqual({
    additions: 1,
    deletions: 0,
    structured,
  });
  expect(await cache.get("missing\n", "new-missing\n")).toBeUndefined();
});

test("DiffCache evicts the least recently used entries at max capacity", async () => {
  const { cache } = await openCache(2);
  await cache.set("one\n", "one-new\n", {
    additions: 1,
    deletions: 0,
    structured,
  });
  await cache.set("two\n", "two-new\n", {
    additions: 2,
    deletions: 0,
    structured,
  });
  await cache.set("three\n", "three-new\n", {
    additions: 3,
    deletions: 0,
    structured,
  });
  // The original implementation evicts asynchronously; give the async
  // deleteMeta call a moment to finish before asserting eviction.
  await Bun.sleep(20);
  expect(await cache.get("one\n", "one-new\n")).toBeUndefined();
  expect(await cache.get("two\n", "two-new\n")).toBeDefined();
  expect(await cache.get("three\n", "three-new\n")).toBeDefined();
});
