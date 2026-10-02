import { beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectStore, rustCas } from "../src";
import { NativePackIndex, nativePackIndexAvailable } from "../src/native-index";

/**
 * Slice 4b-α, the cross-acceptance: our pack+NDX1 BYTES are dropped
 * where the LIVE TypeScript read path looks for them — its
 * loadPackIndexes parses our index, its readPackEntry inflates our
 * full records and applies OUR delta with its own applyDelta, and its
 * get() returns the original bytes. The original code is the oracle;
 * the native-index .so stands witness to the index format.
 */

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

beforeAll(async () => {
  await rustCas.ensureBuilt();
});

test("a delta record written by Rust decodes through the TS applyDelta", async () => {
  const root = mkdtempSync(join(tmpdir(), "pack-cross-delta-"));
  const storeRoot = join(root, "objects");
  const objects = new ObjectStore(storeRoot);
  // A base >=64B and a similar target that differs in the middle: the
  // delta gate must fire (both >=64, delta <0.7x) and the LAST-window
  // matching rule must produce what applyDelta accepts.
  const base = Buffer.from(`checkpoint baseline ${"alpha-".repeat(40)}\n`);
  const target = Buffer.from(
    `checkpoint baseline ${"alpha-".repeat(20)}beta-${"alpha-".repeat(20)}\n`,
  );
  const baseId = sha256(base);
  const targetId = sha256(target);
  // the base stays loose (the read path's getRaw finds it); the target
  // exists ONLY in the pack
  const ts = new ObjectStore(storeRoot);
  expect(await ts.put(base)).toBe(baseId);
  const frame = rustCas.compactFrame([
    { id: baseId, data: base },
    { id: targetId, data: target },
  ]);
  const packDir = join(storeRoot, "packs");
  await mkdir(packDir, { recursive: true });
  await writeFile(join(packDir, "pack-cross1.pack"), frame.pack);
  await writeFile(join(packDir, "pack-cross1.idx"), frame.idx);
  // NDX1 shape: magic + version + count, and the native reader finds
  // our delta entry as kind 1
  expect(frame.idx.subarray(0, 4).toString("ascii")).toBe("NDX1");
  expect(frame.idx.readUInt32LE(8)).toBe(2);
  if (nativePackIndexAvailable()) {
    const idx = new NativePackIndex(join(packDir, "pack-cross1.idx"));
    const found = idx.find(targetId);
    expect(found).toBeDefined();
    expect(found!.kind).toBe(1);
    idx.free();
  }
  // THE CROSS: the live TS get() walks index -> pack -> applyDelta
  // with its own decoder and returns our target byte-for-byte
  const readBack = await objects.get(targetId);
  expect(readBack.equals(target)).toBe(true);
  expect((await objects.get(baseId)).equals(base)).toBe(true);
});

test("a full record round-trips through the TS inflate path, and a small object stays full", async () => {
  const root = mkdtempSync(join(tmpdir(), "pack-cross-full-"));
  const storeRoot = join(root, "objects");
  const objects = new ObjectStore(storeRoot);
  const small = Buffer.from("tiny object, below the delta floor\n"); // <64B rule
  const dissimilar = Buffer.from("x".repeat(64)); // >=64 but no window match
  const smallId = sha256(small);
  const disId = sha256(dissimilar);
  const frame = rustCas.compactFrame([
    { id: smallId, data: small },
    { id: disId, data: dissimilar },
  ]);
  const packDir = join(storeRoot, "packs");
  await mkdir(packDir, { recursive: true });
  await writeFile(join(packDir, "pack-full1.pack"), frame.pack);
  await writeFile(join(packDir, "pack-full1.idx"), frame.idx);
  expect((await objects.get(smallId)).equals(small)).toBe(true);
  expect((await objects.get(disId)).equals(dissimilar)).toBe(true);
  if (nativePackIndexAvailable()) {
    const idx = new NativePackIndex(join(packDir, "pack-full1.idx"));
    expect(idx.find(smallId)!.kind).toBe(0);
    idx.free();
  }
});

test("the Phase B multi-pack table answers across packs with the pack numbering", async () => {
  if (!nativePackIndexAvailable()) return; // the .so is a build artifact
  const { NativePackIndexSet } = await import("../src/native-index");
  const storeRoot = await mkdtempSync(join(tmpdir(), "pack-table-"));
  const packDir = join(storeRoot, "packs");
  await mkdir(packDir, { recursive: true });
  // Three packs written by the REAL frame writer (the oracle, not a
  // synthetic fixture): ids are content hashes, spread one/two per pack.
  const alpha = Buffer.from("alpha payload");
  const bravo = Buffer.from("bravo payload");
  const charlie = Buffer.from("charlie payload");
  const alphaFrame = rustCas.compactFrame([
    { id: sha256(alpha), data: alpha },
    {
      id: sha256(Buffer.from("delta payload")),
      data: Buffer.from("delta payload"),
    },
  ]);
  await writeFile(join(packDir, "pack-a.idx"), alphaFrame.idx);
  const bravoFrame = rustCas.compactFrame([{ id: sha256(bravo), data: bravo }]);
  await writeFile(join(packDir, "pack-b.idx"), bravoFrame.idx);
  const charlieFrame = rustCas.compactFrame([
    { id: sha256(charlie), data: charlie },
  ]);
  await writeFile(join(packDir, "pack-c.idx"), charlieFrame.idx);
  // A non-idx file in the same directory is ignored.
  await writeFile(join(packDir, "notes.txt"), "not an index");
  const table = new NativePackIndexSet(packDir);
  expect(table.count()).toBe(3);
  // The pack numbering follows the sorted names (a, b, c).
  expect(table.find(sha256(alpha))?.pack).toBe(0);
  expect(table.find(sha256(Buffer.from("delta payload")))?.pack).toBe(0);
  expect(table.find(sha256(bravo))?.pack).toBe(1);
  expect(table.find(sha256(charlie))?.pack).toBe(2);
  // An absent id answers undefined, never garbage.
  expect(table.find(sha256(Buffer.from("absent")))).toBeUndefined();
  table.free();
});
