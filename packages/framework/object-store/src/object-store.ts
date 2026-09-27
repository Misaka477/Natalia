/**
 * The shared content-addressed object store — one object library for the
 * framework's durable snapshots.
 *
 * Both checkpoint and the sandbox's git-free backend write here, so identical
 * files across the two subsystems share a single object (git's one global
 * object database). Objects are addressed by sha256 and stored git-style in
 * two-character prefix directories, so a directory listing never has to scan
 * a flat pile of thousands of files.
 *
 * Garbage collection is owner-relative: `collectGarbage(reachable)` deletes
 * every object the caller did not mark reachable. Owners (checkpoint journals,
 * sandbox snapshot indices) compute their own reachable set and union it, so
 * one owner's GC can never prune another owner's live objects.
 */
import { Database } from "bun:sqlite";
import { openPackDaemon, type PackDaemon } from "./daemon-client";
import { createHash } from "node:crypto";
import { objectStoreBackendStatus, rustCas } from "./rust-store";
import { mkdirSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import {
  NativePackIndex,
  nativePackIndexAvailable,
  type NativeIndexEntry,
} from "./native-index";

function objectStoreWorkerDisabled(): boolean {
  return (
    (globalThis as unknown as { __NATALIA_OBJECT_STORE_NO_WORKER?: boolean })
      .__NATALIA_OBJECT_STORE_NO_WORKER === true
  );
}

export class ObjectStore {
  private readonly lru = new Map<string, Buffer>();
  private lruBytes = 0;
  private readonly lruMaxBytes = 32 * 1024 * 1024;
  private readonly lruMaxEntryBytes = 4 * 1024 * 1024;
  private readonly metaDb: Database;
  private readonly chunkMin = 32 * 1024;
  private readonly chunkMax = 1024 * 1024;
  private readonly chunkMask = 0x3ffff;
  private readonly packMagic = Buffer.from("NPAC", "ascii");
  private readonly packVersion = 1;
  private readonly packs = new Map<
    string,
    {
      packFile: string;
      offset: number;
      dataOffset: number;
      origLen: number;
      compLen: number;
      kind: number;
      baseId?: string;
      deltaLen?: number;
    }
  >();
  private packsLoaded = false;
  private nativeIndexes = new Map<string, NativePackIndex>();
  /** The daemon-number → pack-file cache (the daemon's sorted names). */
  private daemonPackNames: string[] = [];
  private readonly packBloom = new Uint8Array(1 << 20);
  private packBloomInitialized = false;
  /** The loose-object fast path through the Rust core (slice 2 of the
   * object-store-rust plan); the TS path stays the implementation and
   * the fallback — packs, chunks and meta are always TS (their slices). */
  private readonly useRust: boolean;
  /**
   * Phase B's daemon preference: the operator's env switch (the same
   * shape as the backend selection), resolved once per store. Off means
   * the store's own index load — the behavior this whole phase must not
   * change by default. `daemonFactory` is the injection seam: production
   * leaves it (the lazy spawn), a test observes the preference through a
   * recording double.
   */
  private readonly daemonPreference: boolean;
  private daemonFactory:
    | ((packsDir: string) => Promise<PackDaemon | undefined>)
    | undefined;
  /** The daemon handle: `hit` false after a failed probe (one attempt,
   * then the local path for this store's life). */
  private daemon:
    | { hit: false; handle: undefined }
    | { hit: true; handle: PackDaemon }
    | undefined;

  constructor(
    /**
     * The store's root, public so consumers that share this library (the
     * checkpoint store's rollback path) resolve object paths through the
     * same root the writes went to — the §1.6 migration moved that root
     * outside the workspace, and a second hardcoded resolution is how a
     * reader ends up reading a directory the writer never wrote to.
     */
    readonly root: string,
    options?: {
      /** The test seam: a daemon factory replacing the lazy spawn. */
      daemonFactory?: (packsDir: string) => Promise<PackDaemon | undefined>;
    },
  ) {
    this.useRust = objectStoreBackendStatus() === "rust";
    this.daemonPreference = options?.daemonFactory
      ? true
      : process.env.NATALIA_PACK_DAEMON === "1";
    this.daemonFactory = options?.daemonFactory;
    const metaDir = join(root, ".meta");
    mkdirSync(metaDir, { recursive: true, mode: 0o700 });
    this.metaDb = new Database(join(metaDir, "index.sqlite"));
    this.metaDb.run(`
      CREATE TABLE IF NOT EXISTS metadata (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(namespace, key)
      );
    `);
    this.metaDb.run("PRAGMA journal_mode=WAL");
    this.metaDb.run("PRAGMA synchronous=NORMAL");
  }

  /** Stores a blob if absent, returning its content id. */
  async put(content: Buffer | string): Promise<string> {
    const data = Buffer.from(content);
    const id = createHash("sha256").update(data).digest("hex");
    if (await this.has(id)) return id;
    if (data.length > this.chunkMin && this.useRust) {
      // Slice 3: Rust owns the CDC split + chunk/manifest writes; the
      // meta row below (SQLite) stays here — the store of record for
      // chunk maps never left the TS metaDb. A single-chunk outcome
      // writes NOTHING and falls through to the plain put, exactly as
      // the TS path does (the second if is mutually excluded).
      const outcome = rustCas.putChunked(this.root, data);
      if (outcome.chunkCount > 1) {
        const manifest = JSON.parse(
          (await this.chunkRead(outcome.manifestId!)).toString("utf8"),
        ) as { version: number; chunks: string[] };
        await this.putMeta(`chunked:${id}`, {
          manifestId: outcome.manifestId,
          totalLength: data.length,
          chunks: manifest.chunks,
        });
        return id;
      }
    }
    if (data.length > this.chunkMin && !this.useRust) {
      const chunks = this.splitIntoChunks(data);
      if (chunks.length > 1) {
        const chunkIds: string[] = [];
        for (const chunk of chunks) chunkIds.push(await this.putRaw(chunk));
        const manifest = JSON.stringify({ version: 1, chunks: chunkIds });
        const manifestId = await this.putRaw(manifest);
        await this.putMeta(`chunked:${id}`, {
          manifestId,
          totalLength: data.length,
          chunks: chunkIds,
        });
        return id;
      }
    }
    return await this.putRaw(data);
  }

  async has(id: string): Promise<boolean> {
    if (this.lru.has(id)) return true;
    if (await this.getMeta<{ manifestId: string }>(`chunked:${id}`))
      return true;
    const looseExists = this.useRust
      ? rustCas.has(this.root, id)
      : await stat(this.objectPath(id)).then(
          () => true,
          () => false,
        );
    if (looseExists) return true;
    // Fall through to pack indexes.
    if (this.packBloomInitialized && !this.bloomMaybe(id)) return false;
    await this.loadPackIndexes();
    return this.packs.has(id);
  }

  private bloomSet(id: string): void {
    const b1 = this.bloomHash(id, 1) & (this.packBloom.length - 1);
    const b2 = this.bloomHash(id, 2) & (this.packBloom.length - 1);
    this.packBloom[b1] = 1;
    this.packBloom[b2] = 1;
  }

  private bloomMaybe(id: string): boolean {
    const b1 = this.bloomHash(id, 1) & (this.packBloom.length - 1);
    const b2 = this.bloomHash(id, 2) & (this.packBloom.length - 1);
    return this.packBloom[b1] === 1 && this.packBloom[b2] === 1;
  }

  private bloomHash(id: string, salt: number): number {
    let hash = 2166136261;
    for (let i = 0; i < id.length; i++) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= salt;
    return hash >>> 0;
  }

  async get(id: string): Promise<Buffer> {
    const cached = this.lru.get(id);
    if (cached) {
      this.lru.delete(id);
      this.lru.set(id, cached);
      return cached;
    }
    if (this.useRust && rustCas.has(this.root, id)) {
      // The Rust side verified while reading; the TS verify rides along
      // as the belt — one hash over bytes already in memory, and the
      // contract byte-for-byte identical across backends.
      try {
        return this.verify(id, rustCas.get(this.root, id));
      } catch (error) {
        if (String(error).includes("not found")) {
          // vanished between has and get: fall to the TS path's answer
        } else {
          throw error;
        }
      }
    }
    return this.verify(id, await this.readObject(id));
  }

  /**
   * Checks an object against the address it was fetched by.
   *
   * The store addresses by sha256, which buys deduplication on write; verifying
   * on read is what turns that same address into an integrity check. Without it
   * a truncated write or a rotted file is returned as content — and since the
   * caller has no checksum of its own, nothing downstream can tell.
   *
   * Read cost is one hash over bytes that were just read to build the buffer.
   */
  private verify(id: string, buffer: Buffer): Buffer {
    const actual = createHash("sha256").update(buffer).digest("hex");
    if (actual !== id)
      throw new Error(`object ${id} is corrupt: content hashes to ${actual}`);
    return buffer;
  }

  private async readObject(id: string): Promise<Buffer> {
    const chunked = await this.getMeta<{
      manifestId: string;
      totalLength: number;
    }>(`chunked:${id}`);
    if (chunked) {
      const manifest = JSON.parse(
        (await this.chunkRead(chunked.manifestId)).toString("utf8"),
      ) as { version: number; chunks: string[] };
      const parts: Buffer[] = [];
      for (const chunkId of manifest.chunks)
        parts.push(await this.chunkRead(chunkId));
      const buffer = Buffer.concat(parts);
      this.cacheSet(id, buffer);
      return buffer;
    }
    try {
      const buffer = await readFile(this.objectPath(id));
      this.cacheSet(id, buffer);
      return buffer;
    } catch {
      return await this.packGet(id);
    }
  }

  /**
   * Phase D's fsck: the store's self-check. Three families of truth:
   *
   *  1. **pairing** — every `.idx` has its `.pack` and vice versa; an
   *     orphan index claims entries nobody can read, an orphan pack holds
   *     bytes no index names (a half-written compaction);
   *  2. **entries** — every indexed entry must inflate to bytes that hash
   *     to its id (the content-addressed contract the get() path
   *     enforces, enforced here against the whole store at once);
   *  3. **the meta** — a delta entry's base must exist (a delta whose
   *     base is gone cannot apply).
   *
   * A full fsck is HEAVY by design: it hashes every packed byte. It is a
   * maintenance operation (the CLI's, not the hot path's), and a
   * sampled check would be a lie about the store's state.
   */
  async fsck(): Promise<{
    packs: number;
    indexes: number;
    entries: number;
    orphanIndexes: string[];
    orphanPacks: string[];
    corrupt: Array<{ pack: string; id?: string; reason: string }>;
    ok: boolean;
  }> {
    await this.loadPackIndexes();
    const packDir = join(this.root, "packs");
    const files = await readdir(packDir).catch(() => [] as string[]);
    const packNames = files.filter((file) => file.endsWith(".pack")).sort();
    const indexNames = files.filter((file) => file.endsWith(".idx")).sort();
    const packStems = new Set(
      packNames.map((name) => name.slice(0, -".pack".length)),
    );
    const indexStems = new Set(
      indexNames.map((name) => name.slice(0, -".idx".length)),
    );
    const orphanPacks = packNames.filter(
      (name) => !indexStems.has(name.slice(0, -".pack".length)),
    );
    const orphanIndexes = indexNames.filter(
      (name) => !packStems.has(name.slice(0, -".idx".length)),
    );
    const corrupt: Array<{ pack: string; id?: string; reason: string }> = [];
    const byPack = new Map<string, string[]>();
    for (const [id, entry] of this.packs) {
      const packName = entry.packFile.split("/").pop() ?? entry.packFile;
      const list = byPack.get(packName) ?? [];
      list.push(id);
      byPack.set(packName, list);
    }
    for (const packName of packNames) {
      for (const id of byPack.get(packName) ?? []) {
        try {
          const buffer = await this.packGet(id);
          this.verify(id, buffer);
        } catch (error) {
          corrupt.push({
            pack: packName,
            id,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return {
      packs: packNames.length,
      indexes: indexNames.length,
      entries: this.packs.size,
      orphanIndexes,
      orphanPacks,
      corrupt,
      ok:
        orphanIndexes.length === 0 &&
        orphanPacks.length === 0 &&
        corrupt.length === 0,
    };
  }

  /**
   * Streams an object's contents without forcing a whole large object into one
   * Buffer. Chunked objects yield each stored chunk; normal objects yield a
   * single buffer.
   */
  async *getStream(id: string): AsyncGenerator<Buffer> {
    const chunked = await this.getMeta<{
      manifestId: string;
      chunks: string[];
    }>(`chunked:${id}`);
    if (!chunked) {
      yield await this.get(id);
      return;
    }
    const manifest = JSON.parse(
      (await this.chunkRead(chunked.manifestId)).toString("utf8"),
    ) as { version: number; chunks: string[] };
    // Chunks are yielded as they are read, so the checksum can only be checked
    // at the end — but the reader is told rather than handed corrupt bytes.
    const hash = createHash("sha256");
    for (const chunkId of manifest.chunks) {
      const chunk = await this.chunkRead(chunkId);
      hash.update(chunk);
      yield chunk;
    }
    const actual = hash.digest("hex");
    if (actual !== id)
      throw new Error(`object ${id} is corrupt: content hashes to ${actual}`);
  }

  private async putRaw(content: Buffer | string): Promise<string> {
    const data = Buffer.from(content);
    if (this.useRust)
      // Same contract end to end: id = sha256, dedup by existence, the
      // Rust side writes atomically (temp+rename) where the TS write is
      // direct — a torn file becomes impossible rather than merely
      // detected by the next verify-on-read. A pack-only id (packs are
      // slice 4) gets a redundant loose copy instead of TS's early
      // return; readers see identical truth.
      return rustCas.put(this.root, data);
    const id = createHash("sha256").update(data).digest("hex");
    if (await this.has(id)) return id;
    const path = this.objectPath(id);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, data, { mode: 0o600 });
    return id;
  }

  /**
   * A chunk-map part (the manifest itself or one chunk): the Rust core
   * reads a loose object WITH verify; anything else (a packed chunk, a
   * missing file) keeps the TS route. The stream path's early honest
   * "is corrupt" satisfies the same `rejects.toThrow(/corrupt/)`
   * contract the drain test pins — the reader is told, never handed
   * rotted bytes.
   */
  private async chunkRead(id: string): Promise<Buffer> {
    if (this.useRust && rustCas.has(this.root, id))
      return rustCas.get(this.root, id);
    return await this.getRaw(id);
  }

  private async getRaw(id: string): Promise<Buffer> {
    try {
      return await readFile(this.objectPath(id));
    } catch {
      return await this.packGet(id);
    }
  }

  private splitIntoChunks(data: Buffer): Buffer[] {
    const chunks: Buffer[] = [];
    let start = 0;
    while (start < data.length) {
      let end = Math.min(data.length, start + this.chunkMax);
      let hash = 0;
      for (let i = start; i < end; i++) {
        hash =
          (((hash << 1) + (hash << 7) + (hash << 15) + data[i]) >>> 0) ^
          data[i];
        if (
          i - start >= this.chunkMin &&
          (hash & this.chunkMask) === 0 &&
          i + 1 < data.length
        ) {
          end = i + 1;
          break;
        }
      }
      chunks.push(data.subarray(start, end));
      start = end;
    }
    return chunks;
  }

  async batchHas(ids: string[]): Promise<boolean[]> {
    return await Promise.all(ids.map((id) => this.has(id)));
  }

  async batchGet(ids: string[]): Promise<Array<Buffer | undefined>> {
    return await Promise.all(
      ids.map(async (id) => {
        try {
          return await this.get(id);
        } catch {
          return undefined;
        }
      }),
    );
  }

  async batchPut(contents: Array<Buffer | string>): Promise<string[]> {
    return await Promise.all(contents.map((content) => this.put(content)));
  }

  /**
   * Removes an object however it is stored.
   *
   * Three forms have to be handled, and removing the loose file covers only the
   * first: a chunked object never had one (its bytes live as chunk objects
   * behind metadata), and a packed object's loose file was already removed by
   * the pack. Miss either and `delete` becomes a no-op that still reports
   * success while `has` and `get` keep answering.
   */
  async delete(id: string): Promise<void> {
    const existing = this.lru.get(id);
    if (existing) {
      this.lru.delete(id);
      this.lruBytes -= existing.byteLength;
    }
    const chunked = await this.getMeta<{
      manifestId: string;
      chunks?: string[];
    }>(`chunked:${id}`);
    if (chunked) {
      // The chunks are separate objects with no other owner, so they go too —
      // otherwise they leak with nothing left pointing at them.
      for (const chunkId of [chunked.manifestId, ...(chunked.chunks ?? [])]) {
        await rm(this.objectPath(chunkId), { force: true });
        const cached = this.lru.get(chunkId);
        if (cached) {
          this.lru.delete(chunkId);
          this.lruBytes -= cached.byteLength;
        }
      }
      await this.deleteMeta(`chunked:${id}`);
    }
    await rm(this.objectPath(id), { force: true });
    // A pack is an append-only file, so the only way to remove one object from
    // it is to write the pack again without that object.
    await this.loadPackIndexes();
    if (this.packs.has(id)) {
      await this.rebuildPacks(
        new Set([...this.packs.keys()].filter((packed) => packed !== id)),
      );
    }
  }

  private cacheSet(id: string, buffer: Buffer): void {
    if (buffer.byteLength > this.lruMaxEntryBytes) return;
    const existing = this.lru.get(id);
    if (existing) this.lruBytes -= existing.byteLength;
    this.lru.delete(id);
    this.lru.set(id, buffer);
    this.lruBytes += buffer.byteLength;
    while (this.lruBytes > this.lruMaxBytes && this.lru.size > 0) {
      const [oldest, value] = this.lru.entries().next().value as [
        string,
        Buffer,
      ];
      this.lru.delete(oldest);
      this.lruBytes -= value.byteLength;
    }
  }

  private async mapConcurrent<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (true) {
          const index = next++;
          if (index >= items.length) return;
          results[index] = await fn(items[index]!);
        }
      },
    );
    await Promise.all(workers);
    return results;
  }

  /** Stores a small JSON metadata record under an arbitrary logical key. */
  async putMeta(key: string, value: unknown): Promise<void> {
    this.metaDb.run(
      `INSERT INTO metadata (namespace, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
      ["default", key, JSON.stringify(value), Date.now()],
    );
    // Keep legacy file fallback for older readers/tools.
    const path = this.metaPath(key);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    const row = this.metaDb
      .query("SELECT value FROM metadata WHERE namespace = ? AND key = ?")
      .get("default", key) as { value: string } | undefined;
    if (row) {
      try {
        return JSON.parse(row.value) as T;
      } catch {
        return undefined;
      }
    }
    try {
      return JSON.parse(await readFile(this.metaPath(key), "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  async deleteMeta(key: string): Promise<void> {
    this.metaDb.run("DELETE FROM metadata WHERE namespace = ? AND key = ?", [
      "default",
      key,
    ]);
    await rm(this.metaPath(key), { force: true });
  }

  /** Compacts the SQLite metadata file after heavy delete/eviction work. */
  async vacuumMeta(): Promise<void> {
    this.metaDb.run("VACUUM");
  }

  /** Every object id currently in the store. */
  async list(): Promise<string[]> {
    const ids = new Set<string>();
    for (const prefix of await readdir(this.root).catch(() => [] as string[])) {
      if (prefix.length !== 2) continue;
      const dir = join(this.root, prefix);
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (name.startsWith(prefix)) ids.add(name);
      }
    }
    await this.loadPackIndexes();
    for (const id of this.packs.keys()) ids.add(id);
    const chunkedRows = this.metaDb
      .query("SELECT key FROM metadata WHERE namespace = ? AND key LIKE ?")
      .all("default", "chunked:%") as Array<{ key: string }>;
    for (const row of chunkedRows) ids.add(row.key.slice("chunked:".length));
    return [...ids];
  }

  /**
   * Deletes every object not in `reachable`. Owners compute the union of what
   * they reference — checkpoint journals and sandbox snapshot indices — so this
   * never prunes a live object of another owner.
   */
  async collectGarbage(reachable: Set<string>): Promise<{
    unreachableObjects: number;
    bytes: number;
  }> {
    const workerResult = await this.tryMaintenance<{
      unreachableObjects: number;
      bytes: number;
    }>({
      op: "collectGarbage",
      root: this.root,
      reachable: [...reachable],
    });
    if (workerResult) {
      this.packsLoaded = false;
      this.packs.clear();
      this.lru.clear();
      this.lruBytes = 0;
      await this.loadPackIndexes();
      return workerResult;
    }
    await this.loadPackIndexes();
    const allIds = new Set<string>(await this.list());
    const extendedReachable = new Set(reachable);
    for (const id of reachable) {
      const chunked = await this.getMeta<{
        manifestId: string;
        chunks?: string[];
      }>(`chunked:${id}`);
      if (!chunked) continue;
      extendedReachable.add(chunked.manifestId);
      for (const chunkId of chunked.chunks ?? [])
        extendedReachable.add(chunkId);
    }
    const unreachableIds = [...allIds].filter(
      (id) => !extendedReachable.has(id),
    );
    let unreachableObjects = 0;
    let bytes = 0;
    for (const id of unreachableIds) {
      const chunked = await this.getMeta<{ manifestId: string }>(
        `chunked:${id}`,
      );
      if (chunked) {
        await this.deleteMeta(`chunked:${id}`);
        unreachableObjects++;
        continue;
      }
      const path = this.objectPath(id);
      try {
        bytes += (await stat(path)).size;
      } catch {
        continue;
      }
      await rm(path, { force: true });
      const cached = this.lru.get(id);
      if (cached) {
        this.lru.delete(id);
        this.lruBytes -= cached.byteLength;
      }
      unreachableObjects++;
    }
    const keepRawIds = new Set<string>();
    for (const id of extendedReachable) {
      if (await this.getMeta(`chunked:${id}`)) continue;
      keepRawIds.add(id);
    }
    await this.rebuildPacks(keepRawIds);
    return { unreachableObjects, bytes };
  }

  private async rebuildPacks(keepIds: Set<string>): Promise<void> {
    await this.loadPackIndexes();
    const oldPackFiles = new Set(
      [...this.packs.values()].map((entry) => entry.packFile),
    );
    const packDir = join(this.root, "packs");
    await mkdir(packDir, { recursive: true, mode: 0o700 });
    if (!keepIds.size) {
      for (const file of oldPackFiles) {
        await rm(file, { force: true });
        this.nativeIndexes.get(file)?.free();
      }
      const oldIndexes = await readdir(packDir).catch(() => [] as string[]);
      for (const file of oldIndexes.filter(
        (name) => name.endsWith(".idx.json") || name.endsWith(".idx"),
      ))
        await rm(join(packDir, file), { force: true });
      this.nativeIndexes.clear();
      this.packs.clear();
      this.packsLoaded = false;
      return;
    }
    const stamp = Date.now().toString(36);
    const packFile = join(packDir, `pack-${stamp}.pack`);
    const indexEntries: Array<{
      id: string;
      offset: number;
      dataOffset: number;
      origLen: number;
      compLen: number;
      kind: number;
      baseId?: string;
      deltaLen?: number;
    }> = [];
    const keepIdList = [...keepIds];
    const originals = await this.mapConcurrent(keepIdList, 4, async (id) => {
      try {
        return await readFile(this.objectPath(id));
      } catch {
        return await this.packGet(id);
      }
    });
    const originalById = new Map(
      originals.map((original, index) => [keepIdList[index]!, original]),
    );
    if (this.useRust) {
      // Rust builds the frame (delta chain + NDX1 in one call) over the
      // SAME keep order; fs/order and the file-management tail (old-pack
      // removal, reload) stay TS. Write order mirrors the TS path:
      // pack first, then the index — the index IS the commit (a pack
      // without one is ignored), and on any failure the half-written
      // pack is removed exactly like the TS catch below.
      try {
        const entries = [...keepIds].map((id) => ({
          id,
          data: originalById.get(id)!,
        }));
        const frame = rustCas.compactFrame(entries);
        await writeFile(packFile, frame.pack);
        await writeFile(packFile.replace(/\.pack$/, ".idx"), frame.idx, {
          mode: 0o600,
        });
      } catch (error) {
        await rm(packFile, { force: true });
        throw error;
      }
    } else {
      const fd = await open(packFile, "w");
      await fd.write(this.packMagic);
      await fd.write(Buffer.from([this.packVersion]));
      let offset = this.packMagic.length + 1;
      let lastId: string | undefined;
      let lastOriginal: Buffer | undefined;
      try {
        for (const id of keepIds) {
          const original = originalById.get(id)!;
          const delta =
            lastOriginal && this.deltaSize(original, lastOriginal)
              ? this.computeDelta(lastOriginal, original)
              : undefined;
          if (delta) {
            const baseId = lastId!;
            const baseIdBuffer = Buffer.from(baseId, "utf8");
            const header = Buffer.alloc(1 + 4 + baseIdBuffer.length + 4 + 4);
            header.writeUInt8(1, 0);
            header.writeUInt32LE(baseIdBuffer.length, 1);
            baseIdBuffer.copy(header, 5);
            header.writeUInt32LE(original.length, 5 + baseIdBuffer.length);
            header.writeUInt32LE(delta.bytes.length, 9 + baseIdBuffer.length);
            await fd.write(header);
            await fd.write(delta.bytes);
            indexEntries.push({
              id,
              offset,
              dataOffset: offset + header.length,
              origLen: original.length,
              compLen: 0,
              kind: 1,
              baseId,
              deltaLen: delta.bytes.length,
            });
            offset += header.length + delta.bytes.length;
          } else {
            const compressed = deflateSync(original);
            const idBuffer = Buffer.from(id, "utf8");
            const header = Buffer.alloc(1 + 4 + idBuffer.length + 4 + 4);
            header.writeUInt8(0, 0);
            header.writeUInt32LE(idBuffer.length, 1);
            idBuffer.copy(header, 5);
            header.writeUInt32LE(original.length, 5 + idBuffer.length);
            header.writeUInt32LE(compressed.length, 9 + idBuffer.length);
            await fd.write(header);
            await fd.write(compressed);
            indexEntries.push({
              id,
              offset,
              dataOffset: offset + header.length,
              origLen: original.length,
              compLen: compressed.length,
              kind: 0,
            });
            offset += header.length + compressed.length;
          }
          lastId = id;
          lastOriginal = original;
        }
        await fd.close();
      } catch (error) {
        await fd.close().catch(() => undefined);
        await rm(packFile, { force: true });
        throw error;
      }
      await this.writeBinaryIndex(packFile, indexEntries);
    }
    for (const file of oldPackFiles) {
      await rm(file, { force: true });
      await rm(file.replace(/\.pack$/, ".idx.json"), { force: true });
      await rm(file.replace(/\.pack$/, ".idx"), { force: true });
      this.nativeIndexes.get(file)?.free();
      this.nativeIndexes.delete(file);
    }
    this.packs.clear();
    this.packsLoaded = false;
    await this.loadPackIndexes();
  }

  private async tryMaintenance<T>(
    request:
      | { op: "compact"; root: string }
      | {
          op: "collectGarbage";
          root: string;
          reachable: string[];
        },
  ): Promise<T | undefined> {
    if (objectStoreWorkerDisabled()) return undefined;
    try {
      const { runObjectStoreMaintenance } = await import(
        "./object-store-worker-client"
      );
      return await runObjectStoreMaintenance<T>(request);
    } catch {
      return undefined;
    }
  }

  /**
   * Writes a pack file containing loose objects and removes the loose copies.
   * This is the Phase C compaction entry point; random reads still work
   * through the pack index.
   */
  async compact(): Promise<{
    packed: number;
    bytes: number;
    packFile: string;
  }> {
    const looseIds = await this.listLoose();
    if (!looseIds.length) return { packed: 0, bytes: 0, packFile: "" };
    const workerResult = await this.tryMaintenance<{
      packed: number;
      bytes: number;
      packFile: string;
    }>({ op: "compact", root: this.root });
    if (workerResult) {
      this.packsLoaded = false;
      this.packs.clear();
      this.lru.clear();
      this.lruBytes = 0;
      await this.loadPackIndexes();
      return workerResult;
    }
    const packDir = join(this.root, "packs");
    await mkdir(packDir, { recursive: true, mode: 0o700 });
    const stamp = Date.now().toString(36);
    const packFile = join(packDir, `pack-${stamp}.pack`);
    const indexEntries: Array<{
      id: string;
      offset: number;
      dataOffset: number;
      origLen: number;
      compLen: number;
      kind: number;
      baseId?: string;
      deltaLen?: number;
    }> = [];
    const looseOriginals = await this.mapConcurrent(looseIds, 4, (id) =>
      readFile(this.objectPath(id)),
    );
    const originalById = new Map(
      looseOriginals.map((original, index) => [looseIds[index]!, original]),
    );
    let totalBytes = 0;
    if (this.useRust) {
      // Same contract as the loop below, one call: ordered loose
      // entries -> pack + NDX1 bytes, pack-then-index (the index is
      // the commit), and totalBytes keeps its meaning (the sum of the
      // ORIGINAL lengths of what was packed).
      try {
        const entries = looseIds.map((id) => ({
          id,
          data: originalById.get(id)!,
        }));
        const frame = rustCas.compactFrame(entries);
        await writeFile(packFile, frame.pack);
        await writeFile(packFile.replace(/\.pack$/, ".idx"), frame.idx, {
          mode: 0o600,
        });
        totalBytes = entries.reduce((sum, entry) => sum + entry.data.length, 0);
      } catch (error) {
        await rm(packFile, { force: true });
        throw error;
      }
    } else {
      const fd = await open(packFile, "w");
      await fd.write(this.packMagic);
      await fd.write(Buffer.from([this.packVersion]));
      let offset = this.packMagic.length + 1;
      let lastId: string | undefined;
      let lastOriginal: Buffer | undefined;
      try {
        for (const id of looseIds) {
          const original = originalById.get(id)!;
          const delta =
            lastOriginal && this.deltaSize(original, lastOriginal)
              ? this.computeDelta(lastOriginal, original)
              : undefined;
          if (delta) {
            const baseId = lastId!;
            const baseIdBuffer = Buffer.from(baseId, "utf8");
            const header = Buffer.alloc(1 + 4 + baseIdBuffer.length + 4 + 4);
            header.writeUInt8(1, 0);
            header.writeUInt32LE(baseIdBuffer.length, 1);
            baseIdBuffer.copy(header, 5);
            header.writeUInt32LE(original.length, 5 + baseIdBuffer.length);
            header.writeUInt32LE(delta.bytes.length, 9 + baseIdBuffer.length);
            await fd.write(header);
            await fd.write(delta.bytes);
            indexEntries.push({
              id,
              offset,
              dataOffset: offset + header.length,
              origLen: original.length,
              compLen: 0,
              kind: 1,
              baseId,
              deltaLen: delta.bytes.length,
            });
            offset += header.length + delta.bytes.length;
          } else {
            const compressed = deflateSync(original);
            const idBuffer = Buffer.from(id, "utf8");
            const header = Buffer.alloc(1 + 4 + idBuffer.length + 4 + 4);
            header.writeUInt8(0, 0);
            header.writeUInt32LE(idBuffer.length, 1);
            idBuffer.copy(header, 5);
            header.writeUInt32LE(original.length, 5 + idBuffer.length);
            header.writeUInt32LE(compressed.length, 9 + idBuffer.length);
            await fd.write(header);
            await fd.write(compressed);
            indexEntries.push({
              id,
              offset,
              dataOffset: offset + header.length,
              origLen: original.length,
              compLen: compressed.length,
              kind: 0,
            });
            offset += header.length + compressed.length;
          }
          totalBytes += original.length;
          lastId = id;
          lastOriginal = original;
        }
        await fd.close();
      } catch (error) {
        await fd.close().catch(() => undefined);
        await rm(packFile, { force: true });
        throw error;
      }
      await this.writeBinaryIndex(packFile, indexEntries);
    }
    this.packsLoaded = false;
    await this.loadPackIndexes();
    for (const id of looseIds) {
      await rm(this.objectPath(id), { force: true });
      this.lru.delete(id);
    }
    return { packed: looseIds.length, bytes: totalBytes, packFile };
  }

  private async loadPackIndexes(): Promise<void> {
    if (this.packsLoaded) return;
    this.packsLoaded = true;
    this.packBloom.fill(0);
    this.packBloomInitialized = false;
    this.nativeIndexes.clear();
    const packDir = join(this.root, "packs");
    const files = await readdir(packDir).catch(() => [] as string[]);
    for (const file of files) {
      const packFile = file.endsWith(".idx")
        ? join(packDir, file.replace(/\.idx$/, ".pack"))
        : file.endsWith(".idx.json")
          ? join(packDir, file.replace(/\.idx\.json$/, ".pack"))
          : undefined;
      if (!packFile) continue;
      let entries: Array<{
        id: string;
        offset: number;
        dataOffset: number;
        origLen: number;
        compLen: number;
        kind?: number;
        baseId?: string;
        deltaLen?: number;
      }>;
      try {
        entries = file.endsWith(".idx")
          ? this.readBinaryIndex(await readFile(join(packDir, file)))
          : (JSON.parse(
              await readFile(join(packDir, file), "utf8"),
            ) as typeof entries);
        try {
          await stat(packFile);
        } catch {
          continue;
        }
        if (file.endsWith(".idx") && nativePackIndexAvailable()) {
          try {
            this.nativeIndexes.set(packFile, new NativePackIndex(packFile));
          } catch {
            // Native module optional; JS binary parser remains authoritative.
          }
        }
        for (const entry of entries) {
          this.packs.set(entry.id, {
            packFile,
            offset: entry.offset,
            dataOffset: entry.dataOffset,
            origLen: entry.origLen,
            compLen: entry.compLen,
            kind: entry.kind ?? 0,
            ...(entry.baseId ? { baseId: entry.baseId } : {}),
            ...(entry.deltaLen !== undefined
              ? { deltaLen: entry.deltaLen }
              : {}),
          });
          this.bloomSet(entry.id);
        }
      } catch {
        // Ignore malformed pack indexes; loose objects remain fallback.
      }
    }
    this.packBloomInitialized = true;
  }

  private readBinaryIndex(buffer: Buffer): Array<{
    id: string;
    offset: number;
    dataOffset: number;
    origLen: number;
    compLen: number;
    kind: number;
    baseId?: string;
    deltaLen?: number;
  }> {
    if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "NDX1")
      throw new Error("invalid binary pack index");
    const count = buffer.readUInt32LE(8);
    let offset = 12;
    const entries: Array<{
      id: string;
      offset: number;
      dataOffset: number;
      origLen: number;
      compLen: number;
      kind: number;
      baseId?: string;
      deltaLen?: number;
    }> = [];
    for (let i = 0; i < count; i++) {
      const idLen = buffer.readUInt32LE(offset);
      offset += 4;
      const id = buffer.toString("utf8", offset, offset + idLen);
      offset += idLen;
      const recOffset = buffer.readUInt32LE(offset);
      const dataOffset = buffer.readUInt32LE(offset + 4);
      const origLen = buffer.readUInt32LE(offset + 8);
      const compLen = buffer.readUInt32LE(offset + 12);
      const kind = buffer[offset + 16];
      offset += 17;
      let baseId: string | undefined;
      let deltaLen: number | undefined;
      if (kind === 1) {
        const baseLen = buffer.readUInt32LE(offset);
        offset += 4;
        baseId = buffer.toString("utf8", offset, offset + baseLen);
        offset += baseLen;
        deltaLen = buffer.readUInt32LE(offset);
        offset += 4;
      }
      entries.push({
        id,
        offset: recOffset,
        dataOffset,
        origLen,
        compLen,
        kind,
        ...(baseId ? { baseId } : {}),
        ...(deltaLen !== undefined ? { deltaLen } : {}),
      });
    }
    return entries;
  }

  private async writeBinaryIndex(
    packFile: string,
    entries: Array<{
      id: string;
      offset: number;
      dataOffset: number;
      origLen: number;
      compLen: number;
      kind: number;
      baseId?: string;
      deltaLen?: number;
    }>,
  ): Promise<void> {
    const indexPath = packFile.replace(/\.pack$/, ".idx");
    const buffers = [Buffer.from("NDX1", "ascii"), Buffer.alloc(8)];
    buffers[1]!.writeUInt32LE(1, 0);
    buffers[1]!.writeUInt32LE(entries.length, 4);
    for (const entry of entries) {
      const idBuffer = Buffer.from(entry.id, "utf8");
      const baseIdBuffer = entry.baseId
        ? Buffer.from(entry.baseId, "utf8")
        : undefined;
      const header = Buffer.alloc(
        4 +
          idBuffer.length +
          4 +
          4 +
          4 +
          4 +
          1 +
          (entry.kind === 1 ? 4 + (baseIdBuffer?.length ?? 0) + 4 : 0),
      );
      let o = 0;
      header.writeUInt32LE(idBuffer.length, o);
      o += 4;
      idBuffer.copy(header, o);
      o += idBuffer.length;
      header.writeUInt32LE(entry.offset, o);
      o += 4;
      header.writeUInt32LE(entry.dataOffset, o);
      o += 4;
      header.writeUInt32LE(entry.origLen, o);
      o += 4;
      header.writeUInt32LE(entry.compLen, o);
      o += 4;
      header.writeUInt8(entry.kind, o);
      o += 1;
      if (entry.kind === 1) {
        header.writeUInt32LE(baseIdBuffer?.length ?? 0, o);
        o += 4;
        if (baseIdBuffer) baseIdBuffer.copy(header, o);
        o += baseIdBuffer?.length ?? 0;
        header.writeUInt32LE(entry.deltaLen ?? 0, o);
      }
      buffers.push(header);
    }
    await writeFile(indexPath, Buffer.concat(buffers), { mode: 0o600 });
  }

  private deltaSize(current: Buffer, base: Buffer): boolean {
    if (current.length < 64 || base.length < 64) return false;
    const delta = this.computeDelta(base, current).bytes;
    // Only use delta when the instruction stream is meaningfully smaller
    // than shipping the whole object as a full zlib record.
    return delta.length < current.length * 0.7;
  }

  private computeDelta(base: Buffer, current: Buffer): { bytes: Buffer } {
    const instructions: Buffer[] = [];
    const literal: number[] = [];
    let i = 0;
    const minMatch = 8;
    const window = 16;
    const baseWindows = new Map<string, number>();
    for (let pos = 0; pos + window <= base.length; pos++) {
      baseWindows.set(base.subarray(pos, pos + window).toString("latin1"), pos);
    }

    const flushLiteral = () => {
      if (!literal.length) return;
      const buf = Buffer.from(literal);
      const head = Buffer.alloc(5);
      head.writeUInt8(1, 0);
      head.writeUInt32LE(buf.length, 1);
      instructions.push(head, buf);
      literal.length = 0;
    };

    while (i < current.length) {
      let bestLen = 0;
      let bestPos = 0;
      if (i + window <= current.length) {
        const key = current.subarray(i, i + window).toString("latin1");
        const candidate = baseWindows.get(key);
        if (candidate !== undefined) {
          const pos = candidate;
          let len = window;
          while (
            i + len < current.length &&
            pos + len < base.length &&
            base[pos + len] === current[i + len]
          )
            len++;
          bestLen = len;
          bestPos = pos;
        }
      }
      if (bestLen >= minMatch) {
        flushLiteral();
        const head = Buffer.alloc(9);
        head.writeUInt8(0, 0);
        head.writeUInt32LE(bestPos, 1);
        head.writeUInt32LE(bestLen, 5);
        instructions.push(head);
        i += bestLen;
      } else {
        literal.push(current[i]);
        i++;
      }
    }
    flushLiteral();
    return { bytes: Buffer.concat(instructions) };
  }

  private applyDelta(base: Buffer, delta: Buffer, expectedLen: number): Buffer {
    const parts: Buffer[] = [];
    let offset = 0;
    while (offset < delta.length) {
      const op = delta[offset++];
      if (op === 0) {
        const pos = delta.readUInt32LE(offset);
        const len = delta.readUInt32LE(offset + 4);
        offset += 8;
        parts.push(base.subarray(pos, pos + len));
      } else if (op === 1) {
        const len = delta.readUInt32LE(offset);
        offset += 4;
        parts.push(delta.subarray(offset, offset + len));
        offset += len;
      } else {
        throw new Error(`unknown delta op ${op}`);
      }
    }
    const original = Buffer.concat(parts);
    if (original.length !== expectedLen)
      throw new Error("delta result length mismatch");
    return original;
  }

  private findNativeEntry(
    id: string,
  ): (NativeIndexEntry & { packFile: string }) | undefined {
    for (const [packFile, native] of this.nativeIndexes) {
      const found = native.find(id);
      if (found) return { ...found, packFile };
    }
    return undefined;
  }

  /**
   * The pack daemon (Phase B's "TS ObjectStore 优先连 daemon，失败回退
   * 本地 FS"): the INDEX server answers where an object lives; the bytes
   * still come from the local pack file. A hit short-circuits the store's
   * own index load; a MISS or any failure falls through identically —
   * the daemon's freshness is the writer's reload to declare, so a read
   * must not miss a freshly written object because the daemon's table
   * is old.
   */
  private async packDaemon(): Promise<PackDaemon | undefined> {
    if (!this.daemonPreference) return undefined;
    if (this.daemon) return this.daemon.hit ? this.daemon.handle : undefined;
    const handle = await (this.daemonFactory
      ? this.daemonFactory(join(this.root, "packs"))
      : openPackDaemon({ packsDir: join(this.root, "packs") }));
    // The probe failed once: remember the absence for this store's life
    // (a dead daemon would otherwise be re-spawned per read).
    if (!handle) {
      this.daemon = { hit: false, handle: undefined };
      return undefined;
    }
    this.daemon = { hit: true, handle };
    return handle;
  }

  /**
   * The daemon's pack number → the pack file name: the daemon numbers by
   * the sorted `.idx` names in the packs directory (its own walk made
   * deterministic), and the store's cache of the same listing keeps the
   * two in step. An out-of-range number (a stale daemon) answers
   * undefined and the read falls to the local path.
   */
  private packFileAt(pack: number): string | undefined {
    return this.daemonPackNames[pack];
  }

  private async refreshDaemonPackNames(): Promise<void> {
    const dir = join(this.root, "packs");
    const files = await readdir(dir).catch(() => [] as string[]);
    this.daemonPackNames = files
      .filter((file) => file.endsWith(".idx"))
      .sort()
      .map((file) => file.replace(/\.idx$/, ".pack"));
  }

  private async packGet(id: string): Promise<Buffer> {
    if (this.daemonPackNames.length === 0) await this.refreshDaemonPackNames();
    const daemon = await this.packDaemon();
    if (daemon) {
      const hit = await daemon.find(id);
      const packFile = hit ? this.packFileAt(hit.pack) : undefined;
      if (hit && packFile)
        return await this.readPackEntry(id, {
          packFile: join(this.root, "packs", packFile),
          offset: hit.offset,
          dataOffset: hit.dataOffset,
          origLen: hit.origLen,
          compLen: hit.compLen,
          kind: hit.kind,
          ...(hit.deltaLen === undefined ? {} : { deltaLen: hit.deltaLen }),
        });
    }
    await this.loadPackIndexes();
    const nativeEntry = this.findNativeEntry(id);
    if (nativeEntry && nativeEntry.kind === 0) {
      return await this.readPackEntry(id, {
        packFile: nativeEntry.packFile,
        offset: nativeEntry.offset,
        dataOffset: nativeEntry.dataOffset,
        origLen: nativeEntry.origLen,
        compLen: nativeEntry.compLen,
        kind: 0,
      });
    }
    let entry = this.packs.get(id);
    if (!entry) throw new Error(`object not found: ${id}`);
    try {
      return await this.readPackEntry(id, entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Another ObjectStore instance may have repacked/deleted this pack.
      this.packsLoaded = false;
      this.packs.clear();
      await this.loadPackIndexes();
      entry = this.packs.get(id);
      if (!entry) throw new Error(`object not found: ${id}`);
      return await this.readPackEntry(id, entry);
    }
  }

  private async readPackEntry(
    id: string,
    entry: {
      packFile: string;
      offset: number;
      dataOffset: number;
      origLen: number;
      compLen: number;
      kind: number;
      baseId?: string;
      deltaLen?: number;
    },
  ): Promise<Buffer> {
    const fd = await open(entry.packFile, "r");
    try {
      if (entry.kind === 1) {
        const delta = Buffer.alloc(entry.deltaLen ?? 0);
        await fd.read(delta, 0, delta.length, entry.dataOffset);
        const base = entry.baseId ? await this.getRaw(entry.baseId) : undefined;
        if (!base) throw new Error(`missing delta base for ${id}`);
        const original = this.applyDelta(base, delta, entry.origLen);
        this.cacheSet(id, original);
        return original;
      }
      const compressed = Buffer.alloc(entry.compLen);
      await fd.read(compressed, 0, entry.compLen, entry.dataOffset);
      const original = inflateSync(compressed);
      if (original.length !== entry.origLen)
        throw new Error(`pack object size mismatch for ${id}`);
      this.cacheSet(id, original);
      return original;
    } finally {
      await fd.close();
    }
  }

  private async listLoose(): Promise<string[]> {
    const ids: string[] = [];
    for (const prefix of await readdir(this.root).catch(() => [] as string[])) {
      if (prefix.length !== 2) continue;
      const dir = join(this.root, prefix);
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (name.startsWith(prefix)) ids.push(name);
      }
    }
    return ids;
  }

  private objectPath(id: string): string {
    return join(this.root, id.slice(0, 2), id);
  }

  private metaPath(key: string): string {
    return join(
      this.root,
      ".meta",
      Buffer.from(key).toString("base64url") + ".json",
    );
  }
}
