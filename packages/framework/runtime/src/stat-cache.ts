import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

/**
 * The stat cache — why a checkpoint is O(changed files) instead of O(tree).
 *
 * `captureManifest` used to `readFile` + sha256 every file in the workspace
 * on every checkpoint: on this repository's own tree that is ~8 GiB of I/O
 * per tool call, which is the real reason the 20,000-file / 512 MiB guards
 * exist (they cap the cost, not the correctness). git has no such limit
 * because `.git/index` carries a stat tuple per path, so `git status` is
 * O(changed files). This is that index, for the checkpoint store.
 *
 * The rules, taken from git's read-cache.c and kept deliberately narrow:
 *
 *   1. **Only the full stat tuple is trusted** — size, mtimeMs, ino AND
 *      mode. mtime alone is exactly the shortcut that loses writes (a
 *      same-size in-place rewrite inside one mtime tick).
 *   2. **Racy entries are dirty.** An entry whose mtime is at or after the
 *      cache's own write time cannot be told from "written after we
 *      hashed", so it is re-hashed (git's `is_racy_stat`).
 *   3. **The cache is an accelerator, never an authority.** A missing,
 *      unreadable or version-mismatched cache degrades to a full recompute;
 *      a wrong hash must be impossible, so every miss re-reads the file.
 *
 * The cache lives beside the journal (per session, per workspace) and is
 * rewritten only when a capture actually changed something.
 */

/** One path's stat tuple and the object hash it produced. */
export type StatCacheEntry = {
  size: number;
  mtimeMs: number;
  ino: number;
  mode: number;
  objectHash: string;
};

export type StatCacheFile = {
  version: 1;
  /** When this cache was written; entries at or after it are racy. */
  writtenAtMs: number;
  entries: Record<string, StatCacheEntry>;
};

const CACHE_VERSION = 1;

export class StatCache {
  private entries = new Map<string, StatCacheEntry>();
  private writtenAtMs = 0;
  private dirty = false;
  private loaded = false;

  constructor(private readonly path: string) {}

  /** Loads the cache; any failure degrades to an empty (full-recompute) one. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(
        await readFile(this.path, "utf8"),
      ) as StatCacheFile;
      if (parsed?.version !== CACHE_VERSION) return; // wrong shape: recompute
      this.writtenAtMs = parsed.writtenAtMs ?? 0;
      this.entries = new Map(Object.entries(parsed.entries ?? {}));
    } catch {
      // Missing or corrupt: the cache is an accelerator, so this is a
      // degrade, never a failure.
      this.entries = new Map();
      this.writtenAtMs = 0;
    }
  }

  /**
   * The cached hash for a path, when the stat tuple still describes it.
   *
   * `stat` is the lstat the scan already took; passing it in keeps the
   * matching to one syscall per file. A racy entry (mtime at or after this
   * cache's write time) is treated as changed.
   */
  match(
    path: string,
    stat: { size: number; mtimeMs: number; ino: number; mode: number },
  ): string | undefined {
    const entry = this.entries.get(path);
    if (!entry) return undefined;
    if (
      entry.size !== stat.size ||
      entry.mtimeMs !== stat.mtimeMs ||
      entry.ino !== stat.ino ||
      entry.mode !== stat.mode
    )
      return undefined;
    // Racily clean: written in the same millisecond the cache was written,
    // so the hash may predate the write.
    if (this.writtenAtMs > 0 && stat.mtimeMs >= this.writtenAtMs)
      return undefined;
    return entry.objectHash;
  }

  /** Records a freshly hashed path. */
  record(
    path: string,
    stat: { size: number; mtimeMs: number; ino: number; mode: number },
    objectHash: string,
  ): void {
    this.entries.set(path, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ino: stat.ino,
      mode: stat.mode,
      objectHash,
    });
    this.dirty = true;
  }

  /**
   * Drops the paths a capture did not see (deleted files), so the cache
   * cannot outlive the tree it describes.
   */
  retain(paths: Iterable<string>): void {
    const live = new Set(paths);
    for (const path of [...this.entries.keys()])
      if (!live.has(path)) {
        this.entries.delete(path);
        this.dirty = true;
      }
  }

  /** Persists the cache when a capture changed it. */
  async save(): Promise<void> {
    if (!this.dirty) return;
    const file: StatCacheFile = {
      version: CACHE_VERSION,
      writtenAtMs: Date.now(),
      entries: Object.fromEntries(this.entries),
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    await writeFile(temp, `${JSON.stringify(file)}\n`);
    await rename(temp, this.path);
    this.dirty = false;
  }

  /** Entry count, for diagnostics and tests. */
  get size(): number {
    return this.entries.size;
  }
}

import { mkdir, rename } from "node:fs/promises";

/** The conventional cache path beside a session's journal. */
export function statCachePath(storeDir: string): string {
  return join(storeDir, "stat-cache.json");
}

/** Exposed for the diagnostics line: a short digest of the cache's shape. */
export function statCacheDigest(cache: StatCache): string {
  return createHash("sha256")
    .update(String(cache.size))
    .digest("hex")
    .slice(0, 8);
}
