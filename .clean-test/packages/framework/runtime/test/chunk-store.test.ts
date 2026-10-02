import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { ChunkStore, contentDefinedChunks } from "../src/chunk-store";
import type { ChunkRef } from "../src/chunk-store";

/** Deterministic pseudo-random bytes, so chunk boundaries are reproducible. */
function bytes(seed: number, length: number): Buffer {
  const out = Buffer.allocUnsafe(length);
  let x = seed >>> 0 || 1;
  for (let index = 0; index < length; index++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[index] = x & 0xff;
  }
  return out;
}

/** Writes the legacy one-file-per-chunk layout by hand. */
async function putLoose(root: string, payload: Buffer): Promise<ChunkRef> {
  const chunks: string[] = [];
  for (const chunk of contentDefinedChunks(payload)) {
    const hash = createHash("sha256").update(chunk).digest("hex");
    const path = join(root, hash.slice(0, 2), hash);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, chunk);
    chunks.push(hash);
  }
  return { chunks, size: payload.length };
}

/** Every hash currently recorded in the pack index. */
async function indexHashes(root: string): Promise<string[]> {
  try {
    const text = await readFile(join(root, "packs", "index.jsonl"), "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { h: string }).h);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function countChunks(root: string): Promise<number> {
  const walk = async (dir: string): Promise<number> => {
    const entries = await readdir(dir, { withFileTypes: true });
    let count = 0;
    for (const entry of entries)
      count += entry.isDirectory()
        ? await walk(join(dir, entry.name))
        : entry.isFile()
          ? 1
          : 0;
    return count;
  };
  try {
    return await walk(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

test("chunk store round-trips a payload exactly", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chunks-"));
  try {
    const store = new ChunkStore(root);
    const payload = bytes(7, 300_000);
    const ref = await store.put(payload);
    expect(ref.size).toBe(payload.length);
    expect(ref.chunks.length).toBeGreaterThan(1);
    expect(await store.get(ref)).toEqual(payload);
    expect(await store.has(ref)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chunk store handles the empty payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chunks-"));
  try {
    const store = new ChunkStore(root);
    const ref = await store.put(Buffer.alloc(0));
    expect(ref).toEqual({ chunks: [], size: 0 });
    expect((await store.get(ref)).length).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("identical payloads dedupe to the same on-disk chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chunks-"));
  try {
    const store = new ChunkStore(root);
    const payload = bytes(11, 200_000);
    const first = await store.put(payload);
    const afterFirst = await countChunks(root);
    const second = await store.put(payload);
    expect(second).toEqual(first);
    expect(await countChunks(root)).toBe(afterFirst);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("content-defined boundaries resync after an edit, so chunks dedupe", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chunks-"));
  try {
    const store = new ChunkStore(root);
    const base = bytes(23, 500_000);
    const edited = Buffer.concat([Buffer.from("inserted-prefix\n"), base]);
    const baseRef = await store.put(base);
    const editedRef = await store.put(edited);
    const shared = editedRef.chunks.filter((hash) =>
      baseRef.chunks.includes(hash),
    ).length;
    // Only the chunk(s) around the edit should change; a fixed-size split would
    // share nothing because every boundary shifts. Random data has ~8KiB
    // chunks, so 500KiB is ~60 chunks and the tail must clearly survive.
    expect(shared).toBeGreaterThan(editedRef.chunks.length * 0.8);
    expect(await store.get(editedRef)).toEqual(edited);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("garbage collection removes only unreferenced chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chunks-"));
  try {
    const store = new ChunkStore(root);
    const kept = await store.put(bytes(3, 120_000));
    const dropped = await store.put(bytes(99, 120_000));
    const referenced = new Set(kept.chunks);
    const removed = await store.collectGarbage(referenced);
    expect(removed.removed).toBe(dropped.chunks.length);
    expect(await store.get(kept)).toEqual(bytes(3, 120_000));
    expect(await store.has(dropped)).toBe(false);
    // The published index no longer names any dead chunk.
    expect(await indexHashes(root)).toEqual(
      expect.arrayContaining(kept.chunks),
    );
    expect((await indexHashes(root)).length).toBe(
      new Set(await indexHashes(root)).size,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chunk store detects a corrupted chunk on read", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chunks-"));
  try {
    const store = new ChunkStore(root);
    const payload = bytes(7, 200_000);
    const ref = await store.put(payload);
    const target = ref.chunks[0]!;
    const entry = (await readFile(join(root, "packs", "index.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { h: string; p: number; o: number })
      .find((candidate) => candidate.h === target)!;
    const path = join(
      root,
      "packs",
      `pack_${String(entry.p).padStart(6, "0")}.pack`,
    );
    const corrupted = Buffer.from(await readFile(path));
    corrupted[entry.o] = corrupted[entry.o]! ^ 0xff;
    await writeFile(path, corrupted);
    await expect(store.get(ref)).rejects.toThrow(/integrity/);
    // Verification is opt-out: the size still checks out, only the hash differs.
    expect((await store.get(ref, { verify: false })).length).toBe(
      payload.length,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("garbage collection honours the age grace window", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chunks-"));
  try {
    const store = new ChunkStore(root);
    const ref = await store.put(bytes(1, 50_000));
    const held = await store.collectGarbage(new Set(), false, {
      minAgeMs: 60_000,
    });
    expect(held.removed).toBe(0);
    expect(await store.has(ref)).toBe(true);
    const reaped = await store.collectGarbage(new Set(), false, {
      minAgeMs: 0,
    });
    expect(reaped.removed).toBe(ref.chunks.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chunk store streams a payload without concatenating it", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chunks-"));
  try {
    const store = new ChunkStore(root);
    const payload = bytes(13, 150_000);
    const ref = await store.put(payload);
    const parts: Buffer[] = [];
    for await (const chunk of store.read(ref)) parts.push(chunk);
    expect(parts.length).toBe(ref.chunks.length);
    expect(Buffer.concat(parts).equals(payload)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chunker emits the same ranges for the same bytes", () => {
  const payload = bytes(5, 100_000);
  const first = contentDefinedChunks(payload).map((chunk) => chunk.length);
  const second = contentDefinedChunks(payload).map((chunk) => chunk.length);
  expect(first).toEqual(second);
  expect(first.reduce((sum, length) => sum + length, 0)).toBe(payload.length);
});

test("migrateLegacyRoots merges per-session chunk dirs into the shared root", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chunk-migrate-"));
  try {
    const legacyA = join(root, "ses_a");
    const legacyB = join(root, "ses_b");
    const refA = await putLoose(legacyA, Buffer.from("payload a ".repeat(500)));
    const refB = await putLoose(legacyB, Buffer.from("payload b ".repeat(500)));
    // A payload shared by both sessions must not duplicate after the merge.
    const shared = Buffer.from("shared payload ".repeat(500));
    const refSharedA = await putLoose(legacyA, shared);
    const refSharedB = await putLoose(legacyB, shared);

    const sharedStore = new ChunkStore(root);
    const migration = await sharedStore.migrateLegacyRoots();
    expect(migration.roots).toBe(2);
    expect(migration.moved).toBeGreaterThan(0);

    // Every legacy ref now resolves from the shared root, and the shared chunk
    // exists exactly once.
    expect(await sharedStore.get(refA)).toEqual(
      Buffer.from("payload a ".repeat(500)),
    );
    expect(await sharedStore.get(refB)).toEqual(
      Buffer.from("payload b ".repeat(500)),
    );
    expect(await sharedStore.get(refSharedA)).toEqual(shared);
    expect(await sharedStore.get(refSharedB)).toEqual(shared);
    const hashes = await indexHashes(root);
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(new Set(hashes).size).toBe(
      new Set([...refA.chunks, ...refB.chunks, ...refSharedA.chunks]).size,
    );

    // Legacy roots are gone; a second run is a no-op.
    const again = await sharedStore.migrateLegacyRoots();
    expect(again.roots).toBe(0);
    expect(again.moved).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrateLegacyRoots leaves unknown directories untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chunk-unknown-"));
  try {
    const notes = join(root, "notes");
    await mkdir(notes, { recursive: true });
    const keep = join(notes, "keep.txt");
    await writeFile(keep, "keep me");

    const store = new ChunkStore(root);
    const migration = await store.migrateLegacyRoots();
    expect(migration.roots).toBe(0);
    expect(migration.moved).toBe(0);
    expect(await readFile(keep, "utf8")).toBe("keep me");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrateLegacyRoots leaves corrupt session chunks in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chunk-corrupt-"));
  try {
    const legacy = join(root, "ses_corrupt");
    await mkdir(legacy, { recursive: true });
    const bad = join(legacy, "a".repeat(64));
    await writeFile(bad, "not-a-chunk");

    const store = new ChunkStore(root);
    const migration = await store.migrateLegacyRoots();
    expect(migration.moved).toBe(0);
    expect(await readFile(bad, "utf8")).toBe("not-a-chunk");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrateLegacyRoots never deletes the shared packs directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chunk-packs-skip-"));
  try {
    const packs = join(root, "packs");
    await mkdir(packs, { recursive: true });
    await writeFile(join(packs, "index.jsonl"), "");
    await writeFile(join(packs, "pack_000001.pack"), "pack-bytes");

    const store = new ChunkStore(root);
    const migration = await store.migrateLegacyRoots();
    expect(migration.roots).toBe(0);
    expect(await readFile(join(packs, "pack_000001.pack"), "utf8")).toBe(
      "pack-bytes",
    );
    expect(await readdir(packs)).toEqual(
      expect.arrayContaining(["index.jsonl"]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chunks are packed into append-only pack files, not one file each", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chunks-"));
  try {
    const store = new ChunkStore(root);
    const ref = await store.put(bytes(5, 200_000));
    expect(ref.chunks.length).toBeGreaterThan(1);
    expect(new Set(await indexHashes(root))).toEqual(new Set(ref.chunks));
    // No loose shard copy is left behind.
    for (const hash of ref.chunks) {
      let loose = true;
      try {
        await readFile(join(root, hash.slice(0, 2), hash));
      } catch {
        loose = false;
      }
      expect(loose).toBe(false);
    }
    // A second instance on the same root shares the in-process index.
    expect(await new ChunkStore(root).get(ref)).toEqual(bytes(5, 200_000));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packLooseChunks folds the legacy loose layout into packs", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chunks-"));
  try {
    const payload = bytes(9, 200_000);
    const ref = await putLoose(root, payload);
    const store = new ChunkStore(root);
    expect((await store.packLooseChunks()).packed).toBe(ref.chunks.length);
    expect(await store.get(ref)).toEqual(payload);
    expect(new Set(await indexHashes(root))).toEqual(new Set(ref.chunks));
    // Idempotent, and the empty shard directories are gone.
    expect((await store.packLooseChunks()).packed).toBe(0);
    const entries = await readdir(root, { withFileTypes: true });
    expect(
      entries.some(
        (entry) => entry.isDirectory() && /^[0-9a-f]{2}$/u.test(entry.name),
      ),
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GC compaction rewrites a shared pack without losing live chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chunks-"));
  try {
    const store = new ChunkStore(root);
    const live = await store.put(bytes(31, 120_000));
    const dead = await store.put(bytes(32, 120_000));
    expect((await indexHashes(root)).length).toBe(
      live.chunks.length + dead.chunks.length,
    );
    const removed = await store.collectGarbage(new Set(live.chunks));
    expect(removed.removed).toBe(dead.chunks.length);
    expect(await store.get(live)).toEqual(bytes(31, 120_000));
    expect(await store.has(dead)).toBe(false);
    expect(new Set(await indexHashes(root))).toEqual(new Set(live.chunks));
    expect(await store.get(live, { verify: true })).toEqual(bytes(31, 120_000));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
