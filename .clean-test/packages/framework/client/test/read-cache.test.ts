import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCacheFabric,
  L1_CACHE_KINDS,
  READ_CACHE_TOOL_KINDS,
  type CacheFabric,
} from "@anthelia/rina";
import {
  executeWithReadCache,
  stableCacheKey,
} from "../src/runtime/tool-execution/read-cache";

/**
 * The pipeline wrap (RINA study's L1 insertion): the classification decides
 * who is cached, the fabric decides hit/miss, and without a fabric every
 * tool runs — caching may save work, it may never become a correctness
 * dependency.
 */

function counting() {
  let runs = 0;
  return {
    execute: async () => {
      runs += 1;
      return "content";
    },
    executions: () => runs,
  };
}

function fabric() {
  const instance = createCacheFabric();
  for (const kind of L1_CACHE_KINDS) instance.registerKind(kind);
  return instance;
}

test("the key is stable across property order at every depth", () => {
  expect(stableCacheKey({ b: 1, a: [{ y: 2, x: 3 }] })).toBe(
    stableCacheKey({ a: [{ x: 3, y: 2 }], b: 1 }),
  );
  expect(stableCacheKey({ path: "/a" })).not.toBe(
    stableCacheKey({ path: "/b" }),
  );
});

test("a classified tool executes once; repeats serve from the fabric", async () => {
  const cache = fabric();
  const work = counting();
  // A real file: fs-read evidence is the file's own stat, so the key must
  // describe something that exists — same as production, where the tool
  // just read it.
  const dir = mkdtempSync(join(tmpdir(), "read-cache-"));
  const path = join(dir, "index.ts");
  writeFileSync(path, "content");
  const parsed = { path };
  const first = await executeWithReadCache({
    fabric: cache,
    toolName: "read_file",
    parsed,
    execute: work.execute,
  });
  const second = await executeWithReadCache({
    fabric: cache,
    toolName: "read_file",
    // Equal inputs in a different property order must share the key.
    parsed: { path },
    execute: work.execute,
  });
  expect(first).toBe("content");
  expect(second).toBe("content");
  expect(work.executions()).toBe(1);
  const metrics = cache.metrics("tool.fs-read")["tool.fs-read"];
  expect(metrics.misses).toBe(1);
  expect(metrics.hits).toBe(1);
});

test("unclassified tools and a missing fabric always execute", async () => {
  const cache = fabric();
  const work = counting();
  // run_shell is on no list: every call runs (and it is the opaque writer
  // that flushes trees, not a candidate for caching).
  expect(
    await executeWithReadCache({
      fabric: cache,
      toolName: "run_shell",
      parsed: { command: "echo hi" },
      execute: work.execute,
    }),
  ).toBe("content");
  expect(work.executions()).toBe(1);
  // No fabric provided (tests, partial runtimes): still runs.
  expect(
    await executeWithReadCache({
      fabric: undefined,
      toolName: "read_file",
      parsed: { path: "x" },
      execute: work.execute,
    }),
  ).toBe("content");
  expect(work.executions()).toBe(2);
});

test("the classification list matches the study's split", () => {
  // fs-read/glob/search are cacheable; shell/web/ask/todo/process are not —
  // the wrap consults exactly READ_CACHE_TOOL_KINDS, so absence is the rule.
  expect({ ...READ_CACHE_TOOL_KINDS }).toEqual({
    read_file: "tool.fs-read",
    glob: "tool.glob",
    grep: "tool.search",
  });
  expect(READ_CACHE_TOOL_KINDS.run_shell).toBeUndefined();
  expect(READ_CACHE_TOOL_KINDS.run_natalia_ask).toBeUndefined();
});

const scratch = mkdtempSync(join(tmpdir(), "read-cache-cleanup-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
