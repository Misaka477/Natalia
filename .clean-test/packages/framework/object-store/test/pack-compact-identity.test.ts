import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectStore, rustCas } from "../src";
import { NativePackIndex, nativePackIndexAvailable } from "../src/native-index";

/**
 * Slice 4b-β, the glue's cross-identity: the SAME content compacted by
 * the TS writer and by the Rust frame writer must produce stores that
 * answer IDENTICALLY (get/list/batchGet), and their index entries must
 * agree on the delta DECISION — kind, origLen and deltaLen byte-equal
 * (the delta rule ported clause for clause), with compLen explicitly
 * NOT compared: stored-vs-dynamic deflate is the encoder choice the
 * slice-4a doc recorded as a documented divergence.
 *
 * Both stores withdraw the OTHER mode for themselves (flip-and-
 * restore): a test that wants the TypeScript path must retire the
 * demand, or under the rust-mode runner it would silently test Rust
 * twice (the round-74 lesson).
 */

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

beforeAll(async () => {
  await rustCas.ensureBuilt();
});

const CONTENT = [
  // four pairwise-similar >=64B variants: WHATEVER the fs directory
  // order (both stores share it — identical filename sets), any two
  // adjacent entries delta against each other, so the first-in-order
  // is the only full record and the other three must be kind1 — a
  // pigeonhole-stable expectation, not a filesystem bet.
  Buffer.from(`checkpoint baseline ${"alpha-".repeat(40)}\n`),
  Buffer.from(`checkpoint baseXine ${"alpha-".repeat(40)}\n`),
  Buffer.from(
    `checkpoint baseline ${"alpha-".repeat(20)}beta-${"alpha-".repeat(20)}\n`,
  ),
  Buffer.from(`checkpoint baseline ${"alpha-".repeat(39)}gammaX\n`),
].map((buffer, index) => ({ id: sha256(buffer), buffer, index }));

async function buildAndCompact(rustMode: boolean): Promise<{
  store: ObjectStore;
  storeRoot: string;
}> {
  const previous = process.env.NATALIA_OBJECT_STORE_BACKEND;
  if (rustMode) process.env.NATALIA_OBJECT_STORE_BACKEND = "rust";
  else delete process.env.NATALIA_OBJECT_STORE_BACKEND;
  try {
    const root = mkdtempSync(join(tmpdir(), "pack-id-"));
    roots.push(root);
    const storeRoot = join(root, "objects");
    const store = new ObjectStore(storeRoot);
    // identical creation order in both stores = the same readdir order
    // = the same delta-vs-previous chain
    for (const item of CONTENT)
      expect(await store.put(item.buffer)).toBe(item.id);
    await store.compact();
    return { store, storeRoot };
  } finally {
    if (previous === undefined) delete process.env.NATALIA_OBJECT_STORE_BACKEND;
    else process.env.NATALIA_OBJECT_STORE_BACKEND = previous;
  }
}

test("TS-compact and Rust-compact stores answer identically; the delta decision agrees", async () => {
  const ts = await buildAndCompact(false);
  const rs = await buildAndCompact(true);

  // reads through each store's OWN backend: the content is the contract
  for (const item of CONTENT) {
    expect((await ts.store.get(item.id)).equals(item.buffer)).toBe(true);
    expect((await rs.store.get(item.id)).equals(item.buffer)).toBe(true);
  }
  expect([...(await ts.store.list())].sort()).toEqual(
    [...(await rs.store.list())].sort(),
  );
  const tsBatch = await ts.store.batchGet(CONTENT.map((item) => item.id));
  const rsBatch = await rs.store.batchGet(CONTENT.map((item) => item.id));
  for (const [index, item] of CONTENT.entries()) {
    expect(tsBatch[index]!.equals(rsBatch[index]!)).toBe(true);
    expect(tsBatch[index]!.equals(item.buffer)).toBe(true);
  }

  // the delta DECISION parity, per entry (the encoder choice is the one
  // deliberate difference: compLen is excluded, slice4a recorded why)
  if (nativePackIndexAvailable()) {
    const tsIdx = new NativePackIndex(
      join(ts.storeRoot, "packs", await onlyIdx(join(ts.storeRoot, "packs"))),
    );
    const rsIdx = new NativePackIndex(
      join(rs.storeRoot, "packs", await onlyIdx(join(rs.storeRoot, "packs"))),
    );
    for (const item of CONTENT) {
      const a = tsIdx.find(item.id);
      const b = rsIdx.find(item.id);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(b!.kind).toBe(a!.kind);
      expect(b!.origLen).toBe(a!.origLen);
      expect(b!.deltaLen).toBe(a!.deltaLen);
    }
    // every order shares its shape: the first entry has no base, the
    // other three each delta against a similar previous -> kind1 count
    // is3 in BOTH writers (and equal — same order, same rule).
    const kind1Count = (index: typeof tsIdx) =>
      CONTENT.reduce(
        (count, item) => count + (index.find(item.id)!.kind === 1 ? 1 : 0),
        0,
      );
    expect(kind1Count(tsIdx)).toBe(3);
    expect(kind1Count(rsIdx)).toBe(3);
    tsIdx.free();
    rsIdx.free();
  }
});

async function onlyIdx(dir: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const name = (await readdir(dir)).find((file) => file.endsWith(".idx"));
  if (!name) throw new Error(`no .idx in ${dir}`);
  return name;
}
