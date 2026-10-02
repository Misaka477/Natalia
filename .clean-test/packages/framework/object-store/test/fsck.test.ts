import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ObjectStore, rustCas } from "../src";

/**
 * Phase D's fsck (the store's self-check): the pairing truth, the entry
 * truth, and the honest answer about a broken store. The packs are
 * written by the REAL frame writer — the same bytes a compaction leaves.
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rm(root, { recursive: true, force: true });
});
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

async function storeWithPack(payloads: Buffer[]) {
  const root = await mkdtemp(join(tmpdir(), "fsck-"));
  roots.push(root);
  const packDir = join(root, "packs");
  await mkdir(packDir, { recursive: true });
  const entries = payloads.map((payload) => ({
    id: sha256(payload),
    data: payload,
  }));
  const frame = rustCas.compactFrame(entries);
  await writeFile(join(packDir, "pack-a.idx"), frame.idx);
  await writeFile(join(packDir, "pack-a.pack"), frame.pack);
  return { root, packDir, store: new ObjectStore(root) };
}

test("a healthy store fsck's clean: every indexed entry hashes to its id", async () => {
  const { store } = await storeWithPack([
    Buffer.from("first packed object"),
    Buffer.from("second packed object"),
  ]);
  const answer = await store.fsck();
  expect(answer).toMatchObject({
    packs: 1,
    indexes: 1,
    entries: 2,
    orphanIndexes: [],
    orphanPacks: [],
    corrupt: [],
    ok: true,
  });
});

test("a byte-corrupted pack is reported per entry, with its pack and id", async () => {
  const { root, store } = await storeWithPack([
    Buffer.from("first packed object"),
    Buffer.from("second packed object"),
  ]);
  // Corrupt the pack's payload hard: a mid-stream flip plus a truncation.
  // The bytes that come back no longer hash to the id (or no longer come
  // back at all) — what get() would hit, caught against the whole store.
  const packFile = join(root, "packs", "pack-a.pack");
  const bytes = await readFile(packFile);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  await writeFile(packFile, bytes.subarray(0, bytes.length - 2));
  const answer = await store.fsck();
  expect(answer.ok).toBe(false);
  expect(answer.corrupt.length).toBeGreaterThan(0);
  for (const entry of answer.corrupt) expect(entry.pack).toBe("pack-a.pack");
  // The pairing stays honest even with a bad payload.
  expect(answer.orphanPacks).toEqual([]);
  expect(answer.orphanIndexes).toEqual([]);
});

test("an index that names the wrong payload is caught by the hash, not the read", async () => {
  // The failure mode only the verify catches: the bytes inflate FINE (a
  // legitimate deflate stream of the OTHER object) but hash to the wrong
  // id. Built by pairing each id with the other's data in the frame —
  // a compaction bug's exact shape.
  const root = await mkdtemp(join(tmpdir(), "fsck-swap-"));
  roots.push(root);
  const packDir = join(root, "packs");
  await mkdir(packDir, { recursive: true });
  const alpha = Buffer.from("alpha object bytes");
  const bravo = Buffer.from("bravo object bytes");
  const frame = rustCas.compactFrame([
    { id: sha256(alpha), data: bravo }, // the index lies
    { id: sha256(bravo), data: alpha },
  ]);
  await writeFile(join(packDir, "pack-a.idx"), frame.idx);
  await writeFile(join(packDir, "pack-a.pack"), frame.pack);
  const answer = await new ObjectStore(root).fsck();
  expect(answer.ok).toBe(false);
  // Both entries: each reads back the other's bytes, hashes correctly to
  // neither id.
  expect(answer.corrupt).toHaveLength(2);
  for (const entry of answer.corrupt)
    expect(entry.reason).toContain("content hashes to");
});

test("an orphan pack (a pack with no index) is reported by name", async () => {
  const { packDir, store } = await storeWithPack([Buffer.from("only object")]);
  // A half-written compaction: the pack bytes landed, the index did not.
  await writeFile(join(packDir, "pack-orphan.pack"), Buffer.from("junk"));
  const answer = await store.fsck();
  expect(answer.ok).toBe(false);
  expect(answer.orphanPacks).toEqual(["pack-orphan.pack"]);
  // The healthy pair's entries still verified.
  expect(answer.corrupt).toEqual([]);
});

test("an orphan index (an index with no pack) is reported by name", async () => {
  const { packDir, store } = await storeWithPack([Buffer.from("only object")]);
  const { idx } = rustCas.compactFrame([
    { id: sha256(Buffer.from("another")), data: Buffer.from("another") },
  ]);
  await writeFile(join(packDir, "pack-ghost.idx"), idx);
  const answer = await store.fsck();
  expect(answer.ok).toBe(false);
  expect(answer.orphanIndexes).toEqual(["pack-ghost.idx"]);
});
