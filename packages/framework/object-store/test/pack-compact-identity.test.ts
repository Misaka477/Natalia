import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
const stores: ObjectStore[] = [];
afterAll(() => {
  // The stores hold OS-level handles (a live pack daemon, the SQLite meta
  // db) that make their root undeletable on Windows — dispose first, then
  // remove. POSIX unlinks tolerate the open files, so the dispose is a
  // no-op safety there.
  for (const store of stores) store.dispose();
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
    stores.push(store);
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

/**
 * Reads the NDX1 index's kind and base per object. The native FFI entry
 * does not carry the base id (its struct is fixed at 24 bytes), and the
 * chain's depth is exactly what this test measures, so the documented
 * layout is parsed here.
 */
async function readPackIndex(
  path: string,
): Promise<Map<string, { kind: number; baseId?: string }>> {
  const bytes = await readFile(path);
  let offset = 4 + 4 + 4; // NDX1 + version + count
  const out = new Map<string, { kind: number; baseId?: string }>();
  while (offset < bytes.length) {
    const idLen = bytes.readUInt32LE(offset);
    offset += 4;
    const id = bytes.subarray(offset, offset + idLen).toString("utf8");
    offset += idLen + 4 + 4 + 4 + 4 + 1; // offset, dataOffset, origLen, compLen, kind
    const kind = bytes[offset - 1]!;
    if (kind === 1) {
      // {baseLen, base, deltaLen} — the base length comes first.
      const baseLen = bytes.readUInt32LE(offset);
      offset += 4;
      const baseId = bytes.subarray(offset, offset + baseLen).toString("utf8");
      offset += baseLen + 4; // + deltaLen
      out.set(id, { kind, baseId });
    } else out.set(id, { kind });
  }
  return out;
}

async function onlyIdx(dir: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const name = (await readdir(dir)).find((file) => file.endsWith(".idx"));
  if (!name) throw new Error(`no .idx in ${dir}`);
  return name;
}

test("a delta base is chosen from the window, not taken positionally", async () => {
  // T5-6: the base rule used to be "whatever object came immediately before
  // this one in keep-order". That rule cannot see past its neighbour, so an
  // object whose best base is two places back was stored FULL (its delta
  // against the neighbour did not pay off) — and the chain it did build was
  // unbounded, which is a read-time cost and a blast radius. The base is now
  // chosen from a bounded window under a depth budget.
  const previous = process.env.NATALIA_OBJECT_STORE_BACKEND;
  delete process.env.NATALIA_OBJECT_STORE_BACKEND;
  try {
    const root = mkdtempSync(join(tmpdir(), "pack-base-"));
    roots.push(root);
    const store = new ObjectStore(join(root, "objects"));
    stores.push(store);
    // Two families that alternate in PACK order: same-family objects differ
    // by ONE byte; cross-family objects differ by a whole block (well past
    // the 70% delta threshold). So the only worthwhile base is the
    // same-family object a couple of places back — which the positional
    // rule (one neighbour, other family) could not reach: it stored those
    // objects FULL.
    const ids: string[] = [];
    for (let index = 0; index < 40; index++) {
      const alpha = index % 2 === 0;
      const body = alpha
        ? `A ${"alpha-".repeat(60)} tail ${index}\n`
        : `B ${"beta--".repeat(60)} tail ${index}\n`;
      ids.push(await store.put(Buffer.from(body)));
    }
    await store.compact();
    const packDir = join(root, "objects", "packs");
    const records = await readPackIndex(join(packDir, await onlyIdx(packDir)));
    // The two families alternate in PACK order too (the order is the hash
    // order, and the hashes alternate here), so an object's immediate
    // pack-order neighbour is in the OTHER family — a whole block of
    // difference. The positional rule stored those objects FULL; the window
    // rule finds the same-family base and deltas.
    const kind1 = ids.filter((id) => records.get(id)!.kind === 1).length;
    // Nearly all of them delta: the positional rule left most of these FULL
    // (its only candidate was the other family).
    expect(kind1).toBeGreaterThan(ids.length - 4);
    // Reads still answer the exact bytes (the chain is a storage detail).
    for (let index = 0; index < ids.length; index++) {
      const expected = Buffer.from(
        index % 2 === 0
          ? `A ${"alpha-".repeat(60)} tail ${index}\n`
          : `B ${"beta--".repeat(60)} tail ${index}\n`,
      );
      expect((await store.get(ids[index]!)).equals(expected)).toBe(true);
    }
  } finally {
    if (previous === undefined) delete process.env.NATALIA_OBJECT_STORE_BACKEND;
    else process.env.NATALIA_OBJECT_STORE_BACKEND = previous;
  }
});

test("a delta chain is capped by the depth budget and probed once", async () => {
  // T5-6: the base rule used to be "whatever object came immediately before
  // this one in keep-order", with no depth cap. A chain is a read-time cost
  // (the Nth object replays N-1 instruction streams) and a blast radius (one
  // corrupt intermediate takes every object after it down), so git bounds it
  // with --depth. This store now does the same.
  const previous = process.env.NATALIA_OBJECT_STORE_BACKEND;
  delete process.env.NATALIA_OBJECT_STORE_BACKEND;
  try {
    const root = mkdtempSync(join(tmpdir(), "pack-depth-"));
    roots.push(root);
    const store = new ObjectStore(join(root, "objects"));
    stores.push(store);
    // Each object differs from its immediate predecessor by ONE small edit
    // and from everything earlier by two or more, so the only worthwhile base
    // is the predecessor: the chain grows linearly. Without a depth cap that
    // chain reaches 119 and the last object replays 118 instruction streams
    // to be read — and one corrupt intermediate takes all of them down.
    const ids: string[] = [];
    const payload = `checkpoint payload ${"alpha-".repeat(60)}\n`;
    let previous = Buffer.from(payload);
    ids.push(await store.put(previous));
    for (let index = 1; index < 120; index++) {
      const next = Buffer.from(previous);
      // One edit per step, at a position that moves: object N and object
      // N-2 therefore differ in two places, so only the predecessor is a
      // worthwhile base and the chain grows linearly.
      const at = 20 + ((index * 7) % (next.length - 40));
      next.writeUInt8((next[at]! + 1) & 0xff, at);
      ids.push(await store.put(next));
      previous = next;
    }
    await store.compact();
    const packDir = join(root, "objects", "packs");
    const records = await readPackIndex(join(packDir, await onlyIdx(packDir)));
    // Walk each object's chain and measure its depth.
    const depthOf = (id: string, seen = new Set<string>()): number => {
      if (seen.has(id)) return seen.size;
      seen.add(id);
      const record = records.get(id);
      if (!record || record.kind !== 1 || !record.baseId) return 0;
      return 1 + depthOf(record.baseId, seen);
    };
    let maxDepth = 0;
    let fullRecords = 0;
    for (const id of ids) {
      const record = records.get(id);
      expect(record).toBeDefined();
      if (record!.kind === 0) fullRecords += 1;
      maxDepth = Math.max(maxDepth, depthOf(id));
    }
    // The budget holds: no chain grows past the cap, and the cap forces
    // periodic full records rather than one unbounded chain. The old
    // positional rule produced a linear chain here (depth 119, one full
    // record), which is exactly what these two assertions refuse.
    expect(maxDepth).toBeLessThanOrEqual(50);
    expect(maxDepth).toBeGreaterThan(10);
    expect(fullRecords).toBeGreaterThan(1);
  } finally {
    if (previous === undefined) delete process.env.NATALIA_OBJECT_STORE_BACKEND;
    else process.env.NATALIA_OBJECT_STORE_BACKEND = previous;
  }
});
