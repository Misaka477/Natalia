/**
 * Durable checkpoint journal (format v3) — semantic delta + content-defined
 * chunk storage.
 *
 * A v2 record inlined a full workspace manifest and a full context-ledger
 * snapshot. Across a long session those are ~99% redundant, which made the
 * journal — and every full-journal rewrite — grow without bound. A v3 record
 * keeps the small scalar header inline and stores the two payloads separately:
 *
 *   * **semantic layer (A):** a context or manifest only stores what changed
 *     versus the previous record (`{ added, removed }`), falling back to a full
 *     "anchor" whenever the change is not a provable prefix extension (context
 *     compaction, a large manifest rewrite, the first record). This is where
 *     the ~190× reduction comes from.
 *   * **physical layer (CDC):** the payload bytes go through the content-defined
 *     chunk store, which deduplicates any repeated byte range across records.
 *
 * Reads stay cheap because the two layers are lazy: `summary` exposes only the
 * scalar header, and full context/manifest are reconstructed on demand by
 * replaying deltas from the nearest anchor.
 */
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  resolveWorkspaceChunksRoot,
  resolveWorkspaceCheckpointSessionsRoot,
} from "@anthelia/platform";
import {
  copyFile,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { join } from "node:path";
import { ChunkStore, type ChunkRef } from "./chunk-store";
import type {
  CheckpointManifestMeta,
  CheckpointRecord,
  ManifestEntry,
  WorkspaceManifest,
} from "./checkpoint";
import type { DurableContextCheckpoint } from "./context";

/** Scalar context facts available without materializing the ledger. */
export type CheckpointContextMeta = {
  journalOffset: number;
  step: number;
  tokenEstimate: number;
  compactionGeneration: number;
  /** Ledger entry count at the checkpoint (`context.entries.length`). */
  entryCount: number;
};

/**
 * A payload is either small enough to inline (base64 in the journal line) or
 * large enough to earn its own chunk files. Inlining keeps the thousands of
 * sub-4KB deltas from becoming thousands of one-block files, which on a 4KB
 * filesystem block wastes more than the payload itself; a chunk ref carries a
 * 64-char hash per chunk and costs a file, so it is reserved for real payloads.
 */
type StoredPayload = { ref: ChunkRef } | { inline: string };

const INLINE_MAX_BYTES = 4 * 1024;

type StoredRef = {
  kind: "anchor" | "delta";
  /** Sequence of the record this delta extends; absent for anchors. */
  base?: number;
} & StoredPayload;

export type StoredContext = StoredRef & CheckpointContextMeta;

export type StoredManifest = StoredRef & {
  root: string;
  complete: boolean;
  errors: string[];
  ignoredFiles: number;
  totalBytes: number;
  entryCount: number;
};

export type StoredCheckpoint = Omit<
  CheckpointRecord,
  "schemaVersion" | "context" | "manifest" | "contextMeta" | "manifestMeta"
> & {
  schemaVersion: 3;
  context: StoredContext;
  manifest: StoredManifest;
};

type JournalEntry =
  | { schema: 2; record: CheckpointRecord }
  | { schema: 3; stored: StoredCheckpoint };

type ContextDeltaPayload = {
  added: DurableContextCheckpoint["entries"];
  resources: DurableContextCheckpoint["resources"];
  checkpoint?: DurableContextCheckpoint["checkpoint"];
};

type ManifestDeltaPayload = {
  added: Record<string, ManifestEntry>;
  removed: string[];
};

function sameManifestEntry(left: ManifestEntry, right: ManifestEntry): boolean {
  return (
    left.kind === right.kind &&
    left.objectHash === right.objectHash &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.linkTarget === right.linkTarget
  );
}

function sameEntry(
  left: DurableContextCheckpoint["entries"][number],
  right: DurableContextCheckpoint["entries"][number],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** True when `next` extends `previous` without touching an existing entry. */
function isPrefixExtension(
  previous: DurableContextCheckpoint["entries"],
  next: DurableContextCheckpoint["entries"],
): boolean {
  if (next.length < previous.length) return false;
  for (let index = 0; index < previous.length; index++)
    if (!sameEntry(previous[index]!, next[index]!)) return false;
  return true;
}

/**
 * Legacy v2 records may carry a `pty` resource kind that was renamed to
 * `terminal`. Normalising here (rather than in `list()`) keeps it off the hot
 * path: it only runs when a context is actually materialized.
 */
function normalizeContext(
  context: DurableContextCheckpoint,
): DurableContextCheckpoint {
  if (
    !context.resources?.some((resource) => (resource.kind as string) === "pty")
  )
    return context;
  return {
    ...context,
    resources: context.resources.map((resource) =>
      (resource.kind as string) === "pty"
        ? { ...resource, kind: "terminal" }
        : resource,
    ),
  } as DurableContextCheckpoint;
}

/**
 * True when the journal's first record is v2. The first record carries its
 * `schemaVersion` in the first bytes, so a small head read is enough even when
 * the record itself is megabytes.
 */
export async function journalNeedsMigration(path: string): Promise<boolean> {
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.allocUnsafe(4096);
      const { bytesRead } = await handle.read(buffer, 0, 4096, 0);
      const head = buffer.subarray(0, bytesRead).toString("utf8");
      // Tolerate whitespace: real journals are `JSON.stringify` output, but a
      // hand-written or re-serialized record may not be.
      const version = /"schemaVersion"\s*:\s*(\d+)/u.exec(head)?.[1];
      return version !== undefined && version !== "3";
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function contextMetaOf(
  context: DurableContextCheckpoint,
): CheckpointContextMeta {
  return {
    journalOffset: context.journalOffset,
    step: context.step,
    tokenEstimate: context.tokenEstimate,
    compactionGeneration: context.compactionGeneration,
    entryCount: context.entries.length,
  };
}

/** Scalar manifest header; never materializes `entries`. */
export function manifestMetaOf(
  manifest: WorkspaceManifest,
): CheckpointManifestMeta {
  return {
    root: manifest.root,
    complete: manifest.complete,
    errors: manifest.errors,
    ignoredFiles: manifest.ignoredFiles,
    totalBytes: manifest.totalBytes,
    entryCount: Object.keys(manifest.entries).length,
  };
}

/**
 * A parsed checkpoint journal. Holds the small stored descriptors in memory and
 * reconstructs context/manifest lazily, so listing a 1400-checkpoint session
 * touches ~200 KB of headers instead of ~1 GB of snapshots.
 */
export class CheckpointJournal {
  private readonly bySequence = new Map<number, number>();
  private readonly contextMemo = new Map<number, DurableContextCheckpoint>();
  private readonly manifestMemo = new Map<number, WorkspaceManifest>();

  private constructor(
    private readonly path: string,
    private readonly chunks: ChunkStore,
    private entries: JournalEntry[],
  ) {
    this.reindex();
  }

  static async load(
    path: string,
    chunks: ChunkStore,
  ): Promise<CheckpointJournal> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return new CheckpointJournal(path, chunks, []);
      throw error;
    }
    const entries: JournalEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      const parsed = JSON.parse(line) as { schemaVersion?: number };
      if (parsed.schemaVersion === 3)
        entries.push({ schema: 3, stored: parsed as StoredCheckpoint });
      else entries.push({ schema: 2, record: parsed as CheckpointRecord });
    }
    return new CheckpointJournal(path, chunks, entries);
  }

  /**
   * Rewrites a v2 journal (inline manifest + context per record) as v3
   * (delta + CDC). Streams line by line so a 1 GB legacy journal never has to
   * be held in memory, keeps the previous full record for delta encoding, and
   * copies the original to `<journal>.v2-backup` before the atomic replace.
   */
  static async migrate(
    path: string,
    chunks: ChunkStore,
  ): Promise<{ migrated: number; backup: string } | undefined> {
    if (!(await journalNeedsMigration(path))) return undefined;
    const backup = `${path}.v2-backup`;
    const temp = `${path}.${randomUUID()}.tmp`;
    const helper = new CheckpointJournal(path, chunks, []);
    const output = createWriteStream(temp, { mode: 0o600 });
    const input = createReadStream(path, { encoding: "utf8" });
    const reader = createInterface({ input, crlfDelay: Infinity });
    let previous: CheckpointRecord | undefined;
    let migrated = 0;
    try {
      for await (const line of reader) {
        if (!line) continue;
        const parsed = JSON.parse(line) as CheckpointRecord | StoredCheckpoint;
        if ((parsed as StoredCheckpoint).schemaVersion === 3) {
          if (!output.write(`${line}\n`)) await once(output, "drain");
          continue;
        }
        const record = parsed as CheckpointRecord;
        const stored = await helper.encode(record, previous);
        if (!output.write(`${JSON.stringify(stored)}\n`))
          await once(output, "drain");
        previous = record;
        migrated += 1;
      }
      await new Promise<void>((resolve, reject) => {
        output.once("finish", () => resolve());
        output.once("error", reject);
        output.end();
      });
      const handle = await open(temp, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await copyFile(path, backup);
      await rename(temp, path);
      return { migrated, backup };
    } catch (error) {
      output.destroy();
      await import("node:fs/promises")
        .then(({ rm }) => rm(temp, { force: true }))
        .catch(() => undefined);
      throw error;
    }
  }

  get length(): number {
    return this.entries.length;
  }

  /** True when the journal has at least one record (used by baseline setup). */
  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  private reindex() {
    this.bySequence.clear();
    for (let index = 0; index < this.entries.length; index++) {
      const sequence = this.sequenceAt(index);
      if (sequence !== undefined) this.bySequence.set(sequence, index);
    }
  }

  sequenceAt(index: number): number | undefined {
    const entry = this.entries[index];
    if (!entry) return undefined;
    return entry.schema === 3 ? entry.stored.sequence : entry.record.sequence;
  }

  private indexOfSequence(sequence: number): number | undefined {
    return this.bySequence.get(sequence);
  }

  private indexOfID(id: string): number | undefined {
    if (id === "last") return this.entries.length - 1;
    for (let index = 0; index < this.entries.length; index++) {
      const entry = this.entries[index]!;
      const matches =
        entry.schema === 3
          ? entry.stored.id === id || String(entry.stored.sequence) === id
          : entry.record.id === id || String(entry.record.sequence) === id;
      if (matches) return index;
    }
    return undefined;
  }

  contextMetaAt(index: number): CheckpointContextMeta | undefined {
    const entry = this.entries[index];
    if (!entry) return undefined;
    if (entry.schema === 2)
      return entry.record.context
        ? contextMetaOf(entry.record.context)
        : undefined;
    const { context } = entry.stored;
    return {
      journalOffset: context.journalOffset,
      step: context.step,
      tokenEstimate: context.tokenEstimate,
      compactionGeneration: context.compactionGeneration,
      entryCount: context.entryCount,
    };
  }

  /** Reconstructs the full ledger context for a record, replaying deltas. */
  async contextAt(index: number): Promise<DurableContextCheckpoint> {
    const cached = this.contextMemo.get(index);
    if (cached) return cached;
    const entry = this.entries[index];
    if (!entry) throw new Error(`checkpoint index out of range: ${index}`);
    if (entry.schema === 2) {
      const context = entry.record.context
        ? normalizeContext(entry.record.context)
        : emptyContext();
      this.contextMemo.set(index, context);
      return context;
    }
    const stored = entry.stored.context;
    let context: DurableContextCheckpoint;
    if (stored.kind === "anchor") {
      const payload = await this.decodePayload(stored);
      context = normalizeContext(
        JSON.parse(payload.toString("utf8")) as DurableContextCheckpoint,
      );
    } else {
      const baseIndex =
        stored.base === undefined
          ? undefined
          : this.indexOfSequence(stored.base);
      if (baseIndex === undefined)
        throw new Error(
          `checkpoint context delta names missing base ${stored.base}`,
        );
      const base = await this.contextAt(baseIndex);
      const payload = await this.decodePayload(stored);
      const delta = JSON.parse(payload.toString("utf8")) as ContextDeltaPayload;
      context = {
        ...base,
        entries: [...base.entries, ...delta.added],
        resources: delta.resources,
        ...(delta.checkpoint ? { checkpoint: delta.checkpoint } : {}),
      };
    }
    const result: DurableContextCheckpoint = {
      ...context,
      journalOffset: stored.journalOffset,
      step: stored.step,
      tokenEstimate: stored.tokenEstimate,
      compactionGeneration: stored.compactionGeneration,
    };
    this.contextMemo.set(index, result);
    return result;
  }

  /** Reconstructs the full workspace manifest for a record. */
  async manifestAt(index: number): Promise<WorkspaceManifest> {
    const cached = this.manifestMemo.get(index);
    if (cached) return cached;
    const entry = this.entries[index];
    if (!entry) throw new Error(`checkpoint index out of range: ${index}`);
    if (entry.schema === 2) {
      const legacy = entry.record.manifest;
      if (!legacy)
        throw new Error(`checkpoint manifest missing: ${entry.record.id}`);
      this.manifestMemo.set(index, legacy);
      return legacy;
    }
    const stored = entry.stored.manifest;
    let manifest: WorkspaceManifest;
    if (stored.kind === "anchor") {
      const payload = await this.decodePayload(stored);
      manifest = JSON.parse(payload.toString("utf8")) as WorkspaceManifest;
    } else {
      const baseIndex =
        stored.base === undefined
          ? undefined
          : this.indexOfSequence(stored.base);
      if (baseIndex === undefined)
        throw new Error(
          `checkpoint manifest delta names missing base ${stored.base}`,
        );
      const base = await this.manifestAt(baseIndex);
      const payload = await this.decodePayload(stored);
      const delta = JSON.parse(
        payload.toString("utf8"),
      ) as ManifestDeltaPayload;
      const entries: Record<string, ManifestEntry> = { ...base.entries };
      for (const path of delta.removed) delete entries[path];
      for (const [path, value] of Object.entries(delta.added))
        entries[path] = value;
      manifest = { ...base, entries };
    }
    const result: WorkspaceManifest = {
      ...manifest,
      root: stored.root,
      complete: stored.complete,
      errors: stored.errors,
      ignoredFiles: stored.ignoredFiles,
      totalBytes: stored.totalBytes,
    };
    this.manifestMemo.set(index, result);
    return result;
  }

  /** Light record for listings: scalar context header, no ledger entries. */
  private legacyRecord(
    record: CheckpointRecord,
    includeContext: boolean,
  ): CheckpointRecord {
    const { context, manifest, ...rest } = record;
    return {
      ...rest,
      ...(manifest ? { manifest } : {}),
      manifestMeta: manifest
        ? manifestMetaOf(manifest)
        : {
            root: record.cwd,
            complete: record.complete,
            errors: record.errors,
            ignoredFiles: 0,
            totalBytes: 0,
            entryCount: 0,
          },
      ...(includeContext && context ? { context } : {}),
      contextMeta: context ? contextMetaOf(context) : emptyMeta(),
    } as CheckpointRecord;
  }

  async summaryAt(index: number): Promise<CheckpointRecord> {
    const entry = this.entries[index];
    if (!entry) throw new Error(`checkpoint index out of range: ${index}`);
    if (entry.schema === 2) return this.legacyRecord(entry.record, false);
    // Schema 3: scalars come from the stored header, so the manifest (and its
    // entries) stays unmaterialized until a consumer asks for it.
    return this.buildRecord(entry.stored, undefined, undefined);
  }

  /** Full record, with ledger context and manifest materialized. */
  async recordAt(index: number): Promise<CheckpointRecord> {
    const entry = this.entries[index];
    if (!entry) throw new Error(`checkpoint index out of range: ${index}`);
    if (entry.schema === 2) return this.legacyRecord(entry.record, true);
    return this.buildRecord(
      entry.stored,
      await this.contextAt(index),
      await this.manifestAt(index),
    );
  }

  async summaries(): Promise<CheckpointRecord[]> {
    const out: CheckpointRecord[] = [];
    for (let index = 0; index < this.entries.length; index++)
      out.push(await this.summaryAt(index));
    return out;
  }

  async all(): Promise<CheckpointRecord[]> {
    const out: CheckpointRecord[] = [];
    for (let index = 0; index < this.entries.length; index++)
      out.push(await this.recordAt(index));
    return out;
  }

  async get(id: string): Promise<CheckpointRecord | undefined> {
    const index = this.indexOfID(id);
    return index === undefined ? undefined : await this.recordAt(index);
  }

  private buildRecord(
    stored: StoredCheckpoint,
    context: DurableContextCheckpoint | undefined,
    manifest: WorkspaceManifest | undefined,
  ): CheckpointRecord {
    const {
      context: storedContext,
      manifest: storedManifest,
      ...rest
    } = stored;
    return {
      ...rest,
      schemaVersion: 3,
      ...(manifest ? { manifest } : {}),
      manifestMeta: {
        root: storedManifest.root,
        complete: storedManifest.complete,
        errors: storedManifest.errors,
        ignoredFiles: storedManifest.ignoredFiles,
        totalBytes: storedManifest.totalBytes,
        entryCount: storedManifest.entryCount,
      },
      ...(context ? { context } : {}),
      contextMeta: {
        journalOffset: storedContext.journalOffset,
        step: storedContext.step,
        tokenEstimate: storedContext.tokenEstimate,
        compactionGeneration: storedContext.compactionGeneration,
        entryCount: storedContext.entryCount,
      },
    } as CheckpointRecord;
  }

  /**
   * Encodes a materialized record against its predecessor and appends one line.
   * The caller has already serialized concurrent writes through the checkpoint
   * queue.
   */
  async append(record: CheckpointRecord): Promise<void> {
    const previousIndex = this.entries.length - 1;
    const previous =
      previousIndex >= 0 ? await this.recordAt(previousIndex) : undefined;
    const stored = await this.encode(record, previous);
    this.entries.push({ schema: 3, stored });
    this.bySequence.set(stored.sequence, this.entries.length - 1);
    await appendFileLine(this.path, JSON.stringify(stored));
  }

  /** Encodes a record without writing it (used by tests and compaction). */
  async encode(
    record: CheckpointRecord,
    previous: CheckpointRecord | undefined,
    forceAnchor = false,
  ): Promise<StoredCheckpoint> {
    const context = record.context ?? (await this.contextFromMeta(record));
    if (!record.manifest)
      throw new Error(
        "cannot encode a checkpoint without its workspace manifest",
      );
    return {
      schemaVersion: 3,
      id: record.id,
      sequence: record.sequence,
      sessionID: record.sessionID,
      ...(record.turnID ? { turnID: record.turnID } : {}),
      ...(record.stepID ? { stepID: record.stepID } : {}),
      step: record.step,
      reason: record.reason,
      ...(record.name ? { name: record.name } : {}),
      createdAt: record.createdAt,
      cwd: record.cwd,
      complete: record.complete,
      errors: record.errors,
      changes: record.changes,
      runtime: record.runtime,
      diskUsageBytes: record.diskUsageBytes,
      ...(record.metadata ? { metadata: record.metadata } : {}),
      context: await this.encodeContext(context, previous, forceAnchor),
      manifest: await this.encodeManifest(
        record.manifest,
        previous,
        forceAnchor,
      ),
    };
  }

  private async contextFromMeta(
    record: CheckpointRecord,
  ): Promise<DurableContextCheckpoint> {
    const index = this.indexOfID(record.id);
    if (index === undefined)
      throw new Error("cannot encode a checkpoint without its context");
    return this.contextAt(index);
  }

  private async encodeContext(
    context: DurableContextCheckpoint,
    previous: CheckpointRecord | undefined,
    forceAnchor = false,
  ): Promise<StoredContext> {
    const meta = contextMetaOf(context);
    const previousContext = previous?.context;
    if (
      !forceAnchor &&
      previousContext &&
      isPrefixExtension(previousContext.entries, context.entries)
    ) {
      const delta: ContextDeltaPayload = {
        added: context.entries.slice(previousContext.entries.length),
        resources: context.resources,
        ...(context.checkpoint ? { checkpoint: context.checkpoint } : {}),
      };
      const payload = await this.encodePayload(
        Buffer.from(JSON.stringify(delta), "utf8"),
      );
      return { kind: "delta", base: previous!.sequence, ...payload, ...meta };
    }
    const payload = await this.encodePayload(
      Buffer.from(JSON.stringify(context), "utf8"),
    );
    return { kind: "anchor", ...payload, ...meta };
  }

  /** Inlines a small payload, otherwise stores it through the chunk library. */
  private async encodePayload(bytes: Buffer): Promise<StoredPayload> {
    if (bytes.length <= INLINE_MAX_BYTES)
      return { inline: bytes.toString("base64") };
    return { ref: await this.chunks.put(bytes) };
  }

  /** Reverses {@link encodePayload}. */
  private async decodePayload(stored: StoredPayload): Promise<Buffer> {
    if ("inline" in stored) return Buffer.from(stored.inline, "base64");
    return await this.chunks.get(stored.ref);
  }

  private async encodeManifest(
    manifest: WorkspaceManifest,
    previous: CheckpointRecord | undefined,
    forceAnchor = false,
  ): Promise<StoredManifest> {
    const header = {
      root: manifest.root,
      complete: manifest.complete,
      errors: manifest.errors,
      ignoredFiles: manifest.ignoredFiles,
      totalBytes: manifest.totalBytes,
      entryCount: Object.keys(manifest.entries).length,
    };
    const previousManifest = previous?.manifest;
    if (previousManifest && !forceAnchor) {
      const added: Record<string, ManifestEntry> = {};
      for (const [path, value] of Object.entries(manifest.entries)) {
        const before = previousManifest.entries[path];
        if (!before || !sameManifestEntry(before, value)) added[path] = value;
      }
      const removed = Object.keys(previousManifest.entries).filter(
        (path) => !(path in manifest.entries),
      );
      const delta: ManifestDeltaPayload = { added, removed };
      const encoded = Buffer.from(JSON.stringify(delta), "utf8");
      const anchorBytes = Buffer.from(JSON.stringify(manifest), "utf8");
      if (encoded.length * 2 < anchorBytes.length) {
        const payload = await this.encodePayload(encoded);
        return {
          kind: "delta",
          base: previous!.sequence,
          ...payload,
          ...header,
        };
      }
    }
    const payload = await this.encodePayload(
      Buffer.from(JSON.stringify(manifest), "utf8"),
    );
    return { kind: "anchor", ...payload, ...header };
  }

  /** Renames one record in place, keeping its delta chain intact. */
  async rename(
    id: string,
    name: string,
  ): Promise<CheckpointRecord | undefined> {
    const index = this.indexOfID(id);
    if (index === undefined) return undefined;
    const entry = this.entries[index]!;
    if (entry.schema === 3) {
      const updated: StoredCheckpoint = { ...entry.stored, name };
      this.entries[index] = { schema: 3, stored: updated };
    } else {
      this.entries[index] = {
        schema: 2,
        record: { ...entry.record, name },
      };
    }
    await this.writeAll();
    return await this.summaryAt(index);
  }

  /**
   * Drops every record later than `sequence`, optionally keeping one record
   * with `keepSequence` (the rollback safety checkpoint, which sits above the
   * target but must survive so a failed rollback can be recovered).
   */
  async truncateAfter(sequence: number, keepSequence?: number): Promise<void> {
    const kept: JournalEntry[] = [];
    let keepIndex: number | undefined;
    for (let index = 0; index < this.entries.length; index++) {
      const entry = this.entries[index]!;
      const at =
        entry.schema === 3 ? entry.stored.sequence : entry.record.sequence;
      if (at <= sequence) kept.push(entry);
      else if (keepSequence !== undefined && at === keepSequence)
        keepIndex = index;
    }
    // The retained safety record sits above the truncation point, so the delta
    // chain it pointed at is being dropped. Re-anchor it (materialize, then
    // store full) so it stays self-contained instead of dangling.
    if (keepIndex !== undefined) {
      const record = await this.recordAt(keepIndex);
      kept.push({
        schema: 3,
        stored: await this.encode(record, undefined, true),
      });
    }
    this.entries = kept;
    this.reindex();
    this.contextMemo.clear();
    this.manifestMemo.clear();
    await this.writeAll();
  }

  /** Chunk refs referenced by the journal (GC roots for the chunk store). */
  referencedChunks(): Set<string> {
    const referenced = new Set<string>();
    for (const entry of this.entries) {
      if (entry.schema !== 3) continue;
      for (const payload of [entry.stored.context, entry.stored.manifest]) {
        if (!("ref" in payload)) continue;
        for (const hash of payload.ref.chunks) referenced.add(hash);
      }
    }
    return referenced;
  }

  /** Serialized lines, for a full rewrite (rename/truncate/migration). */
  serializedLines(): string[] {
    return this.entries.map((entry) =>
      entry.schema === 3
        ? JSON.stringify(entry.stored)
        : JSON.stringify(entry.record),
    );
  }

  /** Replaces the on-disk journal with the current in-memory entries. */
  async writeAll(): Promise<void> {
    await replaceJournal(this.path, `${this.serializedLines().join("\n")}\n`);
  }

  /** Swaps in freshly migrated entries (used by the v2→v3 migration). */
  static async fromEntries(
    path: string,
    chunks: ChunkStore,
    entries: StoredCheckpoint[],
  ): Promise<void> {
    await replaceJournal(
      path,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
  }
}

/**
 * Migrates every v2 checkpoint journal under `<workspaceRoot>/.natalia/checkpoints`
 * to v3 (delta + CDC), one session at a time. Each migrated journal keeps a
 * `<journal>.v2-backup`; sessions already on v3 are skipped. Run this while no
 * runtime is writing to the workspace, or just let the runtime migrate on first
 * load.
 */
export async function migrateAllCheckpointJournals(
  workspaceRoot: string,
): Promise<Array<{ sessionID: string; migrated: number; backup: string }>> {
  const sessionsDir = resolveWorkspaceCheckpointSessionsRoot(workspaceRoot);
  let entries;
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const results: Array<{
    sessionID: string;
    migrated: number;
    backup: string;
  }> = [];
  // The chunk store is shared across sessions; fold any pre-shared per-session
  // roots in first so migrated refs and existing chunks live in one place.
  const chunks = new ChunkStore(resolveWorkspaceChunksRoot(workspaceRoot));
  await chunks.migrateLegacyRoots();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const journal = join(sessionsDir, entry.name, "journal.jsonl");
    const migrated = await CheckpointJournal.migrate(journal, chunks);
    if (migrated) results.push({ sessionID: entry.name, ...migrated });
  }
  return results;
}

/**
 * Deletes `<journal>.v2-backup` files once the v3 journal next to them loads
 * and its newest record fully reconstructs from the shared chunk store.
 *
 * Deliberately opt-in and offline-only: the runtime never prunes a backup, and
 * the newest record is reconstructed first so the only remaining copy is proven
 * self-sufficient before it is deleted.
 */
export async function pruneV2Backups(
  workspaceRoot: string,
): Promise<{ pruned: number; bytes: number }> {
  const sessionsDir = resolveWorkspaceCheckpointSessionsRoot(workspaceRoot);
  let entries;
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { pruned: 0, bytes: 0 };
    throw error;
  }
  const chunks = new ChunkStore(resolveWorkspaceChunksRoot(workspaceRoot));
  let pruned = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const journalPath = join(sessionsDir, entry.name, "journal.jsonl");
    const backupPath = `${journalPath}.v2-backup`;
    let backupInfo;
    try {
      backupInfo = await stat(backupPath);
    } catch {
      continue;
    }
    const journal = await CheckpointJournal.load(journalPath, chunks);
    if (journal.length > 0) {
      const last = journal.length - 1;
      await journal.manifestAt(last);
      await journal.contextAt(last);
    }
    await rm(backupPath, { force: true });
    bytes += backupInfo.size;
    pruned += 1;
  }
  return { pruned, bytes };
}

function emptyContext(): DurableContextCheckpoint {
  return {
    entries: [],
    resources: [],
    journalOffset: 0,
    step: 0,
    tokenEstimate: 0,
    compactionGeneration: 0,
  };
}

function emptyMeta(): CheckpointContextMeta {
  return {
    journalOffset: 0,
    step: 0,
    tokenEstimate: 0,
    compactionGeneration: 0,
    entryCount: 0,
  };
}

async function appendFileLine(path: string, line: string): Promise<void> {
  const { open } = await import("node:fs/promises");
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${line}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceJournal(path: string, contents: string): Promise<void> {
  const { open, rename, rm, writeFile } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600 });
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export type { JournalEntry };
