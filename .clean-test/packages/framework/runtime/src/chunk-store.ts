/**
 * Content-defined chunk store — the physical dedup layer for large checkpoint
 * payloads.
 *
 * Checkpoint journals used to inline a full workspace manifest and a full
 * context-ledger snapshot per record. Most of those bytes repeat across
 * records, so the durable representation is now split:
 *
 *   * the semantic layer (checkpoint.ts) removes the *obvious* duplication by
 *     storing only what changed (allow-list: the new context entries and the
 *     changed manifest entries);
 *   * this store removes the *non-obvious* duplication by chunking the
 *     serialized payload on content-defined boundaries and deduplicating the
 *     chunks by SHA-256. A chunk that already exists is never written twice,
 *     so a repeated tool result, a shared manifest region or an unchanged
 *     anchor band costs one copy no matter how many records reference it.
 *
 * Content-defined (rolling-hash) boundaries are what make this work across
 * versions of the same payload: appending to the front/overwriting a range
 * only reshapes the chunks near the edit, so everything else still dedupes.
 * A fixed-size split would shift every boundary and dedupe nothing.
 *
 * Physical layout (v3):
 *
 *   * `packs/pack_<n>.pack` — append-only pack files holding many chunks;
 *   * `packs/index.jsonl` — append-only `hash -> {pack, offset, length}` map;
 *   * `<xx>/<hash>` — the legacy one-file-per-chunk layout, still read as a
 *     fallback and folded into packs by `packLooseChunks()`.
 *
 * Packing keeps one directory from holding hundreds of thousands of tiny
 * files. Compaction rewrites only the packs that actually contain dead chunks,
 * atomically swaps the index, and keeps the old packs as `.stale` for a grace
 * window before reclaiming them.
 */
import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Ordered content-defined chunks that reconstruct one payload. */
export type ChunkRef = {
  /** SHA-256 of each chunk, in order. */
  chunks: string[];
  /** Total payload length, verified on read. */
  size: number;
};

export type ChunkReadOptions = {
  /** Re-hash each chunk against its address on read. Defaults to true. */
  verify?: boolean;
};

export type ChunkGcOptions = {
  /**
   * Skip chunks younger than this. A chunk is written before the journal line
   * that references it, so a grace window keeps a concurrent writer's fresh
   * chunks (or another process's not-yet-committed refs) out of the collector.
   */
  minAgeMs?: number;
  /** Rewrite packs that hold dead chunks. Defaults to true. */
  compact?: boolean;
};

/**
 * Chunker tuning. Average 8 KiB keeps the per-chunk index small relative to
 * the payload while still giving CDC enough boundary freedom to dedupe; the
 * min/max bounds stop a pathological rolling hash from producing tiny or huge
 * chunks.
 */
const MIN_CHUNK = 2 * 1024;
const MAX_CHUNK = 64 * 1024;
const AVG_CHUNK = 8 * 1024;
const MASK = AVG_CHUNK - 1;

/** Roll to a new pack beyond this size so a single file stays readable. */
const MAX_PACK_BYTES = 64 * 1024 * 1024;

/** A compaction keeps old packs as `.stale` for this long before reclaiming. */
const STALE_PACK_GRACE_MS = 60_000;

/** Deterministic gear table (LCG), so chunk boundaries are process-stable. */
const GEAR: Uint32Array = (() => {
  const table = new Uint32Array(256);
  let x = 0x2545f491;
  for (let index = 0; index < 256; index++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    table[index] = x >>> 0;
  }
  return table;
})();

/**
 * Splits `bytes` into content-defined chunks and returns them in order. An
 * empty payload yields no chunks (the ref then reconstructs to "").
 */
export function contentDefinedChunks(bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let start = 0;
  let hash = 0;
  for (let index = 0; index < bytes.length; index++) {
    hash = ((hash << 1) + GEAR[bytes[index]!]!) >>> 0;
    const size = index - start + 1;
    if ((size >= MIN_CHUNK && (hash & MASK) === 0) || size >= MAX_CHUNK) {
      chunks.push(bytes.subarray(start, index + 1));
      start = index + 1;
      hash = 0;
    }
  }
  if (start < bytes.length) chunks.push(bytes.subarray(start));
  return chunks;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function sha256FileHex(path: string): Promise<string | undefined> {
  const bytes = await readFile(path).catch((error) => {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  });
  return bytes ? sha256Hex(bytes) : undefined;
}

/** Removes empty directories bottom-up, never touching files. */
async function removeEmptyDirectories(dir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  for (const entry of entries)
    if (entry.isDirectory())
      await removeEmptyDirectories(join(dir, entry.name));
  await rmdir(dir).catch((error) => {
    if (isCode(error, "ENOENT") || isCode(error, "ENOTEMPTY")) return;
    throw error;
  });
}

type PackEntry = { pack: number; offset: number; length: number };

/**
 * Shared per-root state. Every `ChunkStore` for one root shares the same maps,
 * so a compaction performed through one instance is visible to its siblings
 * without a disk round-trip. Cross-process readers that hold a stale entry
 * recover by reloading the index on a failed read.
 */
type RootState = {
  index: Map<string, PackEntry>;
  packSizes: Map<number, number>;
  currentPack: number;
  currentOffset: number;
  loaded: boolean;
};

const rootStates = new Map<string, RootState>();

function stateFor(root: string): RootState {
  let state = rootStates.get(root);
  if (!state) {
    state = {
      index: new Map(),
      packSizes: new Map(),
      currentPack: 1,
      currentOffset: 0,
      loaded: false,
    };
    rootStates.set(root, state);
  }
  return state;
}

/** Serializes all mutations for one root, across every in-process instance. */
const rootLocks = new Map<string, Promise<void>>();

async function withRootLock<T>(
  root: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = rootLocks.get(root) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  rootLocks.set(
    root,
    previous.then(() => gate),
  );
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (rootLocks.get(root) === gate) rootLocks.delete(root);
  }
}

function indexLine(hash: string, entry: PackEntry): string {
  return `${JSON.stringify({ h: hash, p: entry.pack, o: entry.offset, l: entry.length })}\n`;
}

/**
 * A git-style content-addressed chunk library. Chunks are immutable and
 * addressed by their own hash, so writes are idempotent and concurrent writers
 * can race safely.
 */
export class ChunkStore {
  private readonly packsDir: string;
  private readonly indexPath: string;
  private readonly state: RootState;

  constructor(private readonly root: string) {
    this.packsDir = join(root, "packs");
    this.indexPath = join(this.packsDir, "index.jsonl");
    this.state = stateFor(root);
  }

  private looseChunkPath(hash: string): string {
    return join(this.root, hash.slice(0, 2), hash);
  }

  private packPath(pack: number): string {
    return join(this.packsDir, `pack_${String(pack).padStart(6, "0")}.pack`);
  }

  /** Loads `packs/index.jsonl` into the shared root state (once per process). */
  private async loadState(): Promise<void> {
    if (this.state.loaded) return;
    this.state.loaded = true;
    this.state.index.clear();
    this.state.packSizes.clear();
    let text = "";
    try {
      text = await readFile(this.indexPath, "utf8");
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      throw error;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let parsed: { h?: unknown; p?: unknown; o?: unknown; l?: unknown };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        continue;
      }
      const { h, p, o, l } = parsed;
      if (
        typeof h !== "string" ||
        typeof p !== "number" ||
        typeof o !== "number" ||
        typeof l !== "number"
      )
        continue;
      this.state.index.set(h, { pack: p, offset: o, length: l });
      this.state.packSizes.set(
        p,
        Math.max(this.state.packSizes.get(p) ?? 0, o + l),
      );
    }
    const packs = [...this.state.packSizes.keys()].sort((a, b) => a - b);
    const last = packs.at(-1);
    this.state.currentPack = last ?? 1;
    this.state.currentOffset = last ? (this.state.packSizes.get(last) ?? 0) : 0;
  }

  private async reloadState(): Promise<void> {
    this.state.loaded = false;
    await this.loadState();
  }

  /** Stores a payload, writing only chunks that are not already present. */
  async put(bytes: Uint8Array): Promise<ChunkRef> {
    const payload = Buffer.from(bytes);
    const chunks: string[] = [];
    await this.loadState();
    await withRootLock(this.root, async () => {
      await this.loadState();
      for (const chunk of contentDefinedChunks(payload)) {
        const hash = sha256Hex(chunk);
        // A loose legacy copy still counts as present; `packLooseChunks` folds
        // it into a pack later.
        if (
          this.state.index.has(hash) ||
          (await pathExists(this.looseChunkPath(hash)))
        ) {
          chunks.push(hash);
          continue;
        }
        if (this.state.currentOffset >= MAX_PACK_BYTES) {
          this.state.currentPack += 1;
          this.state.currentOffset = 0;
        }
        await mkdir(this.packsDir, { recursive: true, mode: 0o700 });
        const offset = this.state.currentOffset;
        const pack = this.state.currentPack;
        await appendFile(this.packPath(pack), chunk, { mode: 0o600 });
        this.state.currentOffset += chunk.length;
        this.state.packSizes.set(pack, this.state.currentOffset);
        const entry: PackEntry = {
          pack,
          offset,
          length: chunk.length,
        };
        this.state.index.set(hash, entry);
        // Index after the bytes: a crash leaves an orphaned chunk, never a
        // dangling reference.
        await appendFile(this.indexPath, indexLine(hash, entry), {
          mode: 0o600,
        });
        chunks.push(hash);
      }
    });
    return { chunks, size: payload.length };
  }

  private async readPackRange(entry: PackEntry): Promise<Buffer> {
    const handle = await open(this.packPath(entry.pack), "r");
    try {
      const buffer = Buffer.allocUnsafe(entry.length);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        entry.length,
        entry.offset,
      );
      if (bytesRead !== entry.length)
        throw new Error(
          `chunk read short: expected ${entry.length} bytes, got ${bytesRead}`,
        );
      return buffer;
    } finally {
      await handle.close();
    }
  }

  private async readChunk(hash: string): Promise<Buffer> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const entry = this.state.index.get(hash);
      if (entry) {
        try {
          return await this.readPackRange(entry);
        } catch (error) {
          if (attempt === 0 && isCode(error, "ENOENT")) {
            await this.reloadState();
            continue;
          }
          throw error;
        }
      }
      try {
        return await readFile(this.looseChunkPath(hash));
      } catch (error) {
        if (attempt === 0) {
          // A sibling process may have packed it since our index was loaded.
          await this.reloadState();
          continue;
        }
        throw error;
      }
    }
    throw new Error(`chunk not found: ${hash}`);
  }

  /**
   * Streams a payload one chunk at a time, re-hashing each chunk against its
   * content address unless `verify` is disabled. Callers that write into a sink
   * never hold the whole payload; `get` preallocates one output buffer so it
   * never holds both the chunk list and a second concatenated copy.
   */
  async *read(
    ref: ChunkRef,
    options: ChunkReadOptions = {},
  ): AsyncGenerator<Buffer> {
    const verify = options.verify ?? true;
    await this.loadState();
    for (const hash of ref.chunks) {
      let chunk = await this.readChunk(hash);
      if (verify && sha256Hex(chunk) !== hash) {
        // A stale cross-process index entry: reload and retry once.
        await this.reloadState();
        chunk = await this.readChunk(hash);
        const actual = sha256Hex(chunk);
        if (actual !== hash)
          throw new Error(
            `chunk ${hash} failed integrity check (content hashes to ${actual})`,
          );
      }
      yield chunk;
    }
  }

  /** Rebuilds a payload, verifying per-chunk content and the total length. */
  async get(ref: ChunkRef, options: ChunkReadOptions = {}): Promise<Buffer> {
    const output = Buffer.allocUnsafe(ref.size);
    let offset = 0;
    for await (const chunk of this.read(ref, options)) {
      if (offset + chunk.length > ref.size)
        throw new Error(
          `chunk payload overruns declared size ${ref.size} at offset ${offset}`,
        );
      chunk.copy(output, offset);
      offset += chunk.length;
    }
    if (offset !== ref.size)
      throw new Error(
        `chunk payload size mismatch: expected ${ref.size}, got ${offset}`,
      );
    return output;
  }

  /** True when every chunk of the ref is present. */
  async has(ref: ChunkRef): Promise<boolean> {
    await this.loadState();
    for (const hash of ref.chunks)
      if (
        !this.state.index.has(hash) &&
        !(await pathExists(this.looseChunkPath(hash)))
      )
        return false;
    return true;
  }

  /**
   * Folds the legacy one-file-per-chunk layout into packs. Idempotent and safe
   * to run at every startup: an empty loose layout costs one directory scan.
   */
  async packLooseChunks(): Promise<{ packed: number }> {
    let packed = 0;
    await this.loadState();
    await withRootLock(this.root, async () => {
      await this.loadState();
      let entries;
      try {
        entries = await readdir(this.root, { withFileTypes: true });
      } catch (error) {
        if (isCode(error, "ENOENT")) return;
        throw error;
      }
      const files: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        let children;
        try {
          children = await readdir(dir, { withFileTypes: true });
        } catch (error) {
          if (isCode(error, "ENOENT")) return;
          throw error;
        }
        for (const child of children) {
          const full = join(dir, child.name);
          if (child.isDirectory()) {
            await walk(full);
            continue;
          }
          if (child.isFile()) files.push(full);
        }
      };
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === "packs") continue;
        await walk(join(this.root, entry.name));
      }
      for (const full of files) {
        const hash = basename(full);
        const packedEntry = this.state.index.get(hash);
        if (packedEntry) {
          const packed = await this.readPackRange(packedEntry).catch(
            () => undefined,
          );
          if (packed && sha256Hex(packed) === hash) {
            await rm(full, { force: true }).catch(() => undefined);
            continue;
          }
          // The index says this is already packed, but the pack is missing or
          // corrupt. Fold the loose copy again instead of deleting the only
          // good bytes we can see.
        }
        const chunk = await readFile(full);
        if (sha256Hex(chunk) !== hash) continue;
        if (this.state.currentOffset >= MAX_PACK_BYTES) {
          this.state.currentPack += 1;
          this.state.currentOffset = 0;
        }
        await mkdir(this.packsDir, { recursive: true, mode: 0o700 });
        const offset = this.state.currentOffset;
        const pack = this.state.currentPack;
        await appendFile(this.packPath(pack), chunk, { mode: 0o600 });
        this.state.currentOffset += chunk.length;
        this.state.packSizes.set(pack, this.state.currentOffset);
        const packEntry: PackEntry = { pack, offset, length: chunk.length };
        this.state.index.set(hash, packEntry);
        await appendFile(this.indexPath, indexLine(hash, packEntry), {
          mode: 0o600,
        });
        await rm(full, { force: true });
        packed += 1;
      }
      // Remove the now-empty shard directories.
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === "packs") continue;
        const shard = join(this.root, entry.name);
        const remaining = await readdir(shard).catch(() => ["keep"]);
        if (remaining.length === 0)
          await rm(shard, { recursive: true, force: true }).catch(
            () => undefined,
          );
      }
    });
    return { packed };
  }

  /**
   * Deletes every stored chunk whose hash is not in `referenced`, then
   * compacts packs that held dead chunks. Only call this with the complete set
   * of live refs (checkpoint journals plus any other owner), or live payloads
   * are lost.
   */
  async collectGarbage(
    referenced: ReadonlySet<string>,
    dryRun = false,
    options: ChunkGcOptions = {},
  ): Promise<{ removed: number; bytes: number }> {
    const minAgeMs = options.minAgeMs ?? 0;
    const compact = options.compact ?? true;
    const cutoff = Date.now() - minAgeMs;
    await this.loadState();

    let removed = 0;
    let bytes = 0;

    // 1) Legacy loose files.
    const looseWalk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (isCode(error, "ENOENT")) return;
        throw error;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (dir === this.root && entry.name === "packs") continue;
          await looseWalk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (referenced.has(entry.name)) continue;
        const info = await stat(full);
        if (minAgeMs > 0 && info.mtimeMs > cutoff) continue;
        if (!dryRun) await rm(full, { force: true });
        removed += 1;
        bytes += info.size;
      }
    };
    await looseWalk(this.root);

    // 2) Dead index entries. A dead chunk in a pack younger than the grace
    // window may still be referenced by an in-flight journal write.
    const dead = new Map<string, PackEntry>();
    const deadByPack = new Map<number, PackEntry[]>();
    for (const [hash, entry] of this.state.index) {
      if (referenced.has(hash)) continue;
      const info = await stat(this.packPath(entry.pack)).catch(() => undefined);
      if (!info) {
        // The pack file is gone (a concurrent cross-process compaction): the
        // entry is dead either way.
        dead.set(hash, entry);
        deadByPack.set(entry.pack, [
          ...(deadByPack.get(entry.pack) ?? []),
          entry,
        ]);
        continue;
      }
      if (minAgeMs > 0 && info.mtimeMs > cutoff) continue;
      dead.set(hash, entry);
      deadByPack.set(entry.pack, [
        ...(deadByPack.get(entry.pack) ?? []),
        entry,
      ]);
    }
    for (const [, entry] of dead) {
      removed += 1;
      bytes += entry.length;
    }

    if (dryRun || dead.size === 0) {
      if (!dryRun && dead.size === 0) await this.reapStalePacks(cutoff);
      return { removed, bytes };
    }

    await withRootLock(this.root, async () => {
      await this.loadState();
      // Re-derive under the lock: a concurrent put/compaction may have moved
      // things since the dry estimate above.
      const live = new Map<string, PackEntry>();
      const packsToRewrite = new Set<number>();
      for (const [hash, entry] of this.state.index) {
        if (referenced.has(hash)) {
          live.set(hash, entry);
          continue;
        }
        packsToRewrite.add(entry.pack);
      }
      if (compact && packsToRewrite.size > 0) {
        await this.compactPacks(live, packsToRewrite);
      } else {
        // No rewrite: drop the dead index entries, keep the packs as-is.
        await this.rewriteIndex(live);
      }
      await this.reapStalePacks(cutoff);
    });
    return { removed, bytes };
  }

  /** Writes `live` as the new index, atomically, and swaps the shared state. */
  private async rewriteIndex(live: Map<string, PackEntry>): Promise<void> {
    await mkdir(this.packsDir, { recursive: true, mode: 0o700 });
    const temp = `${this.indexPath}.${process.pid}.tmp`;
    const contents = [...live]
      .map(([hash, entry]) => indexLine(hash, entry))
      .join("");
    await writeFile(temp, contents, { mode: 0o600 });
    await rename(temp, this.indexPath);
    this.state.index.clear();
    this.state.packSizes.clear();
    for (const [hash, entry] of live) {
      this.state.index.set(hash, entry);
      this.state.packSizes.set(
        entry.pack,
        Math.max(
          this.state.packSizes.get(entry.pack) ?? 0,
          entry.offset + entry.length,
        ),
      );
    }
    const packs = [...this.state.packSizes.keys()].sort((a, b) => a - b);
    const last = packs.at(-1);
    this.state.currentPack = last ?? 1;
    this.state.currentOffset = last ? (this.state.packSizes.get(last) ?? 0) : 0;
  }

  /**
   * Rewrites `packsToRewrite` (each containing at least one dead chunk) into
   * fresh packs, keeping every live chunk. The old packs are renamed to
   * `.stale` before the new index is published, so a reader that is mid-flight
   * never sees a half-written pack.
   */
  private async compactPacks(
    live: Map<string, PackEntry>,
    packsToRewrite: Set<number>,
  ): Promise<void> {
    const liveByPack = new Map<number, Array<[string, PackEntry]>>();
    for (const [hash, entry] of live)
      liveByPack.set(entry.pack, [
        ...(liveByPack.get(entry.pack) ?? []),
        [hash, entry],
      ]);

    let nextPack = Math.max(0, ...[...this.state.packSizes.keys()]) + 1;
    let nextOffset = 0;
    const rewritten = new Map<string, PackEntry>();
    const kept = new Map<string, PackEntry>();
    for (const [hash, entry] of live) {
      if (!packsToRewrite.has(entry.pack)) kept.set(hash, entry);
    }
    for (const pack of [...packsToRewrite].sort((a, b) => a - b)) {
      const entries = liveByPack.get(pack) ?? [];
      for (const [hash, entry] of entries) {
        const chunk = await this.readPackRange(entry);
        if (nextOffset >= MAX_PACK_BYTES) {
          nextPack += 1;
          nextOffset = 0;
        }
        await mkdir(this.packsDir, { recursive: true, mode: 0o700 });
        await appendFile(this.packPath(nextPack), chunk, { mode: 0o600 });
        rewritten.set(hash, {
          pack: nextPack,
          offset: nextOffset,
          length: chunk.length,
        });
        nextOffset += chunk.length;
      }
      // Keep the old data recoverable for the grace window.
      await rename(this.packPath(pack), `${this.packPath(pack)}.stale`).catch(
        (error) => {
          if (!isCode(error, "ENOENT")) throw error;
        },
      );
    }
    const merged = new Map<string, PackEntry>([...kept, ...rewritten]);
    await this.rewriteIndex(merged);
  }

  /** Deletes `.stale` packs older than `cutoff`. */
  private async reapStalePacks(cutoff: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.packsDir, { withFileTypes: true });
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".stale")) continue;
      const full = join(this.packsDir, entry.name);
      const info = await stat(full).catch(() => undefined);
      if (!info) continue;
      if (info.mtimeMs > cutoff) continue;
      await rm(full, { force: true });
    }
  }

  /**
   * Moves chunks from a legacy per-session root into this (shared) root.
   *
   * Source files are deleted only after a byte-identical target has been
   * verified. A failed copy therefore leaves the source in place; a later run
   * can retry it. Legacy session directories are removed only when empty.
   */
  async mergeFrom(
    legacyRoot: string,
  ): Promise<{ moved: number; skipped: number }> {
    let moved = 0;
    let skipped = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (isCode(error, "ENOENT")) return;
        throw error;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;

        const hash = entry.name;
        if (!/^[0-9a-f]{64}$/u.test(hash)) {
          skipped += 1;
          console.warn(
            `[checkpoint] chunk migration skipped non-hash file ${full}`,
          );
          continue;
        }
        const sourceHash = await sha256FileHex(full);
        if (sourceHash !== hash) {
          skipped += 1;
          console.warn(
            `[checkpoint] chunk migration skipped corrupt file ${full}`,
          );
          continue;
        }

        const target = this.looseChunkPath(hash);
        const targetHash = await sha256FileHex(target);
        if (targetHash !== undefined) {
          if (targetHash === hash) {
            await rm(full, { force: true }).catch(() => undefined);
            skipped += 1;
          } else {
            skipped += 1;
            console.warn(
              `[checkpoint] chunk migration kept ${full}: target ${target} is corrupt`,
            );
          }
          continue;
        }

        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        try {
          await rename(full, target);
        } catch (error) {
          if (!isCode(error, "EXDEV")) throw error;
          const temp = `${target}.${process.pid}.tmp`;
          await copyFile(full, temp);
          const copiedHash = await sha256FileHex(temp);
          if (copiedHash !== hash) {
            await rm(temp, { force: true }).catch(() => undefined);
            throw new Error(
              `chunk migration copy failed verification for ${hash}`,
            );
          }
          await rename(temp, target);
          await rm(full, { force: true }).catch(() => undefined);
        }
        moved += 1;
      }
    };
    await walk(legacyRoot);
    await removeEmptyDirectories(legacyRoot);
    return { moved, skipped };
  }

  /**
   * One-time upgrade from the per-session chunk roots of the pre-shared layout
   * (`.natalia/chunks/<sessionID>/…`) to the shared root.
   *
   * Only directories named like a Natalia session are considered legacy roots.
   * The shared `packs/` directory, two-hex shard directories, and any unknown
   * directory are never deleted. Unknown directories are left byte-for-byte.
   */
  async migrateLegacyRoots(): Promise<{ moved: number; roots: number }> {
    const result = await withRootLock(this.root, async () => {
      let entries;
      try {
        entries = await readdir(this.root, { withFileTypes: true });
      } catch (error) {
        if (isCode(error, "ENOENT")) return { moved: 0, roots: 0 };
        throw error;
      }
      let moved = 0;
      let roots = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === "packs" || /^[0-9a-f]{2}$/u.test(entry.name))
          continue;
        if (!entry.name.startsWith("ses_")) {
          console.warn(
            `[checkpoint] chunk migration left unknown directory untouched: ${join(this.root, entry.name)}`,
          );
          continue;
        }
        roots += 1;
        moved += (await this.mergeFrom(join(this.root, entry.name))).moved;
      }
      return { moved, roots };
    });
    // `packLooseChunks()` takes the same root lock, so call it after releasing
    // the migration lock.
    if (result.roots > 0) await this.packLooseChunks();
    return result;
  }
}
