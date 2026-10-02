import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCacheFabric,
  toolFsReadKind,
  toolGlobKind,
  toolSearchKind,
  L1_CACHE_KINDS,
  type CacheKindDefinition,
} from "../src/index";

/**
 * The fabric's discipline, tested by observing each law break:
 * a stale hit, an unbounded store, an unclassified kind, a guessed TTL —
 * every one must be impossible, not merely unlikely.
 */

let base = "";
let workspace = "";

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "rina-fabric-"));
  workspace = join(base, "workspace");
  mkdirSync(workspace, { recursive: true });
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A fabric with the L1 kinds and a deliberately small budget for LRU tests. */
function fabric(maxBytes?: number) {
  const instance = createCacheFabric(maxBytes ? { maxBytes } : {});
  for (const kind of L1_CACHE_KINDS) instance.registerKind(kind);
  return instance;
}

function file(name: string, content: string): { path: string; key: string } {
  const path = join(workspace, name);
  writeFileSync(path, content);
  return { path, key: JSON.stringify({ path }) };
}

test("the L1 classification is the explicit list", async () => {
  const instance = fabric();
  expect(instance.hasKind("tool.fs-read")).toBe(true);
  expect(instance.hasKind("tool.glob")).toBe(true);
  expect(instance.hasKind("tool.search")).toBe(true);
  // An unlisted kind does not exist for the fabric: compute throws rather
  // than silently running through (law 1 would be decorative otherwise).
  await expect(instance.compute("tool.web", "k", () => "v")).rejects.toThrow(
    /unknown cache kind/u,
  );
});

test("path-scoped kinds must carry evidence (registration enforces it)", () => {
  const instance = createCacheFabric();
  const captureOnly: CacheKindDefinition = {
    id: "bad.capture-only",
    deterministic: true,
    invalidation: "path",
    captureEvidence: (key) => ({ path: key }),
  };
  expect(() => instance.registerKind(captureOnly)).toThrow(
    /validate evidence/u,
  );
  const noEvidence: CacheKindDefinition = {
    id: "bad.no-evidence",
    deterministic: true,
    invalidation: "path",
  };
  expect(() => instance.registerKind(noEvidence)).toThrow(/written file/u);
  const partial: CacheKindDefinition = {
    id: "bad.validate-only",
    deterministic: true,
    invalidation: "tree",
    validEvidence: () => true,
  };
  expect(() => instance.registerKind(partial)).toThrow(/together/u);
  instance.registerKind(toolGlobKind);
  expect(() => instance.registerKind(toolGlobKind)).toThrow(/duplicate/u);
});

test("a miss computes once, a hit serves without computing", async () => {
  const instance = fabric();
  const { key } = file("a.txt", "alpha");
  let computed = 0;
  const compute = () => {
    computed += 1;
    return "alpha";
  };
  expect(await instance.compute("tool.fs-read", key, compute)).toBe("alpha");
  expect(await instance.compute("tool.fs-read", key, compute)).toBe("alpha");
  expect(computed).toBe(1);
  const metrics = instance.metrics("tool.fs-read")["tool.fs-read"];
  expect(metrics.misses).toBe(1);
  expect(metrics.hits).toBe(1);
  expect(metrics.bytesServed).toBe("alpha".length);
});

test("concurrent callers share one computation (single-flight)", async () => {
  const instance = fabric();
  const { key } = file("b.txt", "beta");
  let computed = 0;
  const compute = async () => {
    computed += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return "beta";
  };
  const [first, second] = await Promise.all([
    instance.compute("tool.fs-read", key, compute),
    instance.compute("tool.fs-read", key, compute),
  ]);
  expect(first).toBe("beta");
  expect(second).toBe("beta");
  expect(computed).toBe(1); // the subagent-re-reads case: one execution
});

test("evidence catches a write the hooks never saw (external writer)", async () => {
  const instance = fabric();
  const { path, key } = file("c.txt", "one");
  let computed = 0;
  const compute = () => {
    computed += 1;
    return computed === 1 ? "one" : "two";
  };
  expect(await instance.compute("tool.fs-read", key, compute)).toBe("one");
  // Change the file out-of-band and rewind mtime by a second: size and
  // mtimeNs still disagree with the capture, so the next call recomputes.
  writeFileSync(path, "two!");
  utimesSync(path, new Date(0), new Date(0));
  expect(await instance.compute("tool.fs-read", key, compute)).toBe("two");
  expect(computed).toBe(2);
});

test("a written path drops only its own entries; any write drops trees", async () => {
  const instance = fabric();
  const first = file("d.txt", "d");
  const second = file("e.txt", "e");
  await instance.compute("tool.fs-read", first.key, () => "d");
  await instance.compute("tool.fs-read", second.key, () => "e");
  await instance.compute("tool.glob", "*.md", () => "list");
  await instance.compute("tool.search", "needle", () => "hits");

  expect(instance.invalidatePaths([first.path])).toBe(3); // own entry + both trees
  expect(await instance.compute("tool.fs-read", second.key, () => "E")).toBe(
    "e",
  ); // untouched path still hot
  expect(instance.metrics("tool.glob")["tool.glob"].entries).toBe(0);
  expect(instance.metrics("tool.search")["tool.search"].entries).toBe(0);

  await instance.compute("tool.glob", "*.md", () => "list");
  expect(instance.markTreeChanged()).toBe(1);
  expect(instance.metrics("tool.glob")["tool.glob"].entries).toBe(0);
});

test("the budget bounds the store and evicts least-recently-used", async () => {
  const instance = fabric(10); // ten bytes of heat, nothing more
  await instance.compute("tool.glob", "k1", () => "12345");
  await instance.compute("tool.glob", "k2", () => "67890");
  // Touch k1 so k2 becomes least recently used.
  await instance.compute("tool.glob", "k1", () => "wrong");
  await instance.compute("tool.glob", "k3", () => "abcdefghij");
  const metrics = instance.metrics("tool.glob")["tool.glob"];
  expect(metrics.bytes).toBeLessThanOrEqual(10);
  expect(metrics.evictions).toBeGreaterThan(0);
  // k2 was the coldest: recomputing it must run the function (miss).
  let recomputed = false;
  await instance.compute("tool.glob", "k2", () => {
    recomputed = true;
    return "fresh";
  });
  expect(recomputed).toBe(true);
});

test("a failed compute stores nothing and the error propagates", async () => {
  const instance = fabric();
  const { key } = file("boom.txt", "x");
  let caught: unknown;
  try {
    await instance.compute("tool.fs-read", key, () => {
      throw new Error("read failed");
    });
  } catch (error) {
    caught = error;
  }
  expect((caught as Error).message).toBe("read failed");
  expect(instance.metrics("tool.fs-read")["tool.fs-read"].entries).toBe(0);
  // The next call recomputes rather than replaying the failure.
  expect(await instance.compute("tool.fs-read", key, () => "ok")).toBe("ok");
});

test("metrics are per-kind and complete", async () => {
  const instance = fabric();
  const { key } = file("m.txt", "metrics");
  await instance.compute("tool.fs-read", key, () => "metrics");
  await instance.compute("tool.fs-read", key, () => "metrics");
  const all = instance.metrics();
  expect(Object.keys(all).sort()).toEqual([
    "tool.fs-read",
    "tool.glob",
    "tool.search",
  ]);
  const fs = all["tool.fs-read"];
  expect(fs).toMatchObject({ hits: 1, misses: 1, invalidations: 0 });
  expect(fs.bytes).toBeGreaterThan(0);
});

test("the kinds are deterministic by type (law 1, compile-enforced)", () => {
  // `deterministic: false` cannot satisfy CacheKindDefinition — this file
  // compiling at all is the assertion; the runtime checks the rest.
  const honest: CacheKindDefinition = {
    id: "probe",
    deterministic: true,
    invalidation: "tree",
  };
  expect(honest.deterministic).toBe(true);
  expect(toolFsReadKind.invalidation).toBe("path");
  expect(toolSearchKind.invalidation).toBe("tree");
});

test("unregisterKind drops the kind's entries and its record", async () => {
  // The plugin port's ownership promise: a kind dies WITH its owner — a
  // definition unloaded with its plugin must not keep answering, and its
  // record must not linger in the metrics surface answering with zeros.
  const instance = fabric();
  const { key } = file("gone.txt", "content");
  await instance.compute("tool.glob", key, () => "listing");
  expect(instance.hasKind("tool.glob")).toBe(true);
  const dropped = instance.unregisterKind("tool.glob");
  expect(dropped).toBe(1);
  expect(instance.hasKind("tool.glob")).toBe(false);
  // Recomputing through a dropped kind is impossible (unknown kinds throw),
  // which is the point: the definition left with its owner.
  expect(() => instance.compute("tool.glob", key, () => "again")).toThrow(
    /unknown cache kind/u,
  );
  expect(instance.metrics()["tool.glob"]).toBeUndefined();
  // The other kinds are untouched, and a second unregister answers 0.
  expect(instance.hasKind("tool.fs-read")).toBe(true);
  expect(instance.unregisterKind("tool.glob")).toBe(0);
});
