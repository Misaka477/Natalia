import { DiffCache, ObjectStore } from "@anthelia/object-store";
import { createHash } from "node:crypto";
import { ChunkStore } from "./chunk-store";
import {
  CheckpointJournal,
  contextMetaOf,
  manifestMetaOf,
  type CheckpointContextMeta,
} from "./checkpoint-journal";
import { constants } from "node:fs";
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createSymlink,
  defaultCheckpointStoreDir,
  ensureNataliaIgnoreFile,
  forceRemove,
  isSnapshotIgnored,
  loadNataliaIgnore,
  NATALIA_IGNORE_FILE,
  normalizeLinkTarget,
  resolveWorkspaceChunksRoot,
  resolveWorkspaceObjectsRoot,
  type SnapshotIgnoreRule,
} from "@anthelia/platform";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  CheckpointChangeKind,
  CheckpointPreview,
  CheckpointResourcePolicy,
  RuntimeEvent,
  RuntimeWorkspaceDiffChange,
  SessionID,
} from "@anthelia/contracts";
import type { ContextLedger, DurableContextCheckpoint } from "./context";

export type CheckpointReason =
  | "baseline"
  | "turn_begin"
  | "step_begin"
  | "manual"
  | "pre_tool"
  | "pre_compaction"
  | "rollback_safety"
  | "audit_round";

export type CheckpointKind =
  | "audit"
  | "manual"
  | "auto_safety"
  | "rollback_safety";

export type AuditRoundRecord = {
  checkpointID: string;
  planID: string;
  round: number;
  verdict: "gaps" | "passed";
  auditReportAt: string;
  sequence: number;
  createdAt: string;
};

export type CheckpointRef =
  | { kind: "checkpoint"; id: string }
  | { kind: "round"; planID: string; round: number }
  | { kind: "last_audit"; planID?: string }
  | { kind: "baseline" }
  | { kind: "current" };

export type DiffCheckpointsOptions = {
  paths?: string[];
  includePatch?: boolean;
  includeContent?: boolean;
  maxFiles?: number;
  maxPatchChars?: number;
};

export type ManifestEntry = {
  path: string;
  kind: "regular" | "symlink";
  objectHash?: string;
  size?: number;
  mode: number;
  linkTarget?: string;
};

export type WorkspaceManifest = {
  root: string;
  entries: Record<string, ManifestEntry>;
  complete: boolean;
  errors: string[];
  ignoredFiles: number;
  totalBytes: number;
};

/**
 * Scalar manifest header. Always present on a record; the (potentially huge)
 * `manifest` itself is omitted from `list()` summaries and rebuilt on demand
 * via `CheckpointStore.loadManifest`.
 */
export type CheckpointManifestMeta = {
  root: string;
  complete: boolean;
  errors: string[];
  ignoredFiles: number;
  totalBytes: number;
  entryCount: number;
};

export type CheckpointChange = {
  kind: CheckpointChangeKind;
  path: string;
  oldPath?: string;
  mode?: string;
};

export type CheckpointRecord = {
  schemaVersion: 2 | 3;
  id: string;
  sequence: number;
  sessionID: SessionID;
  turnID?: string;
  stepID?: string;
  step: number;
  reason: CheckpointReason;
  name?: string;
  createdAt: string;
  cwd: string;
  complete: boolean;
  errors: string[];
  /**
   * Full workspace manifest. `list()` deliberately omits it so a long session
   * does not materialize every manifest just to render a list; the scalar
   * `manifestMeta` is always present, and `CheckpointStore.loadManifest` (or
   * `get`) rebuilds the entries on demand by replaying the stored deltas.
   */
  manifest?: WorkspaceManifest;
  /** Scalar manifest header; always present, even when `manifest` is omitted. */
  manifestMeta: CheckpointManifestMeta;
  /**
   * Full ledger snapshot. `list()` deliberately omits it so a long session does
   * not materialize ~1 GB of history just to render a list; the scalar
   * `contextMeta` is always present, and `CheckpointStore.loadContext` (or
   * `get`) rebuilds the entries on demand by replaying the stored deltas.
   */
  context?: DurableContextCheckpoint;
  /** Scalar facts about the ledger state, without the entries. */
  contextMeta: CheckpointContextMeta;
  changes: CheckpointChange[];
  runtime: {
    status: string;
    model?: string;
    tokenEstimate: number;
    compactionGeneration: number;
  };
  diskUsageBytes: number;
  /** 新增：宽松元数据，旧记录不存在时忽略。 */
  metadata?: Record<string, unknown>;
};

export type CheckpointRuntimeResource = {
  kind: CheckpointResourcePolicy["kind"];
  id: string;
  status: "running" | "waiting" | "pending" | "stopped" | "preserve_dirty";
  summary: string;
};

export type CheckpointStoreOptions = {
  sessionID: SessionID;
  workspaceRoot: string;
  storeDir?: string;
  enabled?: boolean;
  maxFiles?: number;
  maxBytes?: number;
  ignore?: string[];
  additionalDirs?: string[];
  onEvent?: (event: RuntimeEvent) => void;
  now?: () => Date;
};

export type CreateCheckpointInput = {
  reason: CheckpointReason;
  context: ContextLedger;
  step: number;
  turnID?: string;
  stepID?: string;
  model?: string;
  status?: string;
  name?: string;
  metadata?: Record<string, unknown>;
};

export type RollbackOptions = {
  context: ContextLedger;
  dryRun?: boolean;
  resources?: CheckpointRuntimeResource[];
  onResourcePolicy?: (policy: CheckpointResourcePolicy) => Promise<void>;
  onContextRestored?: (checkpoint: DurableContextCheckpoint) => Promise<void>;
  failAfterWorkspaceApply?: boolean;
  failContextRestore?: boolean;
};

export type CheckpointCommandResult = {
  ok: boolean;
  output: string;
  event?: RuntimeEvent;
};

export class CheckpointStore {
  readonly workspaceRoot: string;
  readonly storeDir: string;
  /** The shared content-addressed object library (`.natalia/objects`). */
  private readonly objects: ObjectStore;
  private readonly diffCache: DiffCache;
  private readonly sessionID: SessionID;
  private readonly enabled: boolean;
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  /** Legacy checkpoint.ignore patterns, migrated once into .nataliaignore. */
  private readonly legacyIgnore: string[];
  private readonly additionalDirs: string[];
  private readonly now: () => Date;
  private readonly onEvent?: (event: RuntimeEvent) => void;
  private unavailableReason: string | undefined;
  private checkpointQueue = Promise.resolve();
  /** Per-session content-defined chunk library for v3 payloads. */
  private readonly chunks: ChunkStore;
  private readonly chunkRoot: string;
  private journal: CheckpointJournal | undefined;

  constructor(options: CheckpointStoreOptions) {
    this.sessionID = options.sessionID;
    this.workspaceRoot = resolve(options.workspaceRoot);
    // §1.6: the rescue ring defaults OUTSIDE the workspace; an explicit
    // storeDir is the portable opt-in and takes the whole store local with it
    // (metadata, objects and chunks move together — a half-moved store is
    // metadata pointing at data that died with the workspace).
    const explicitStore = options.storeDir !== undefined;
    this.storeDir = resolve(
      options.storeDir ??
        defaultCheckpointStoreDir(this.workspaceRoot, options.sessionID),
    );
    this.objects = new ObjectStore(
      explicitStore
        ? join(this.workspaceRoot, ".natalia", "objects")
        : resolveWorkspaceObjectsRoot(this.workspaceRoot),
    );
    this.diffCache = new DiffCache(this.objects, "checkpoint-diff");
    this.enabled = options.enabled ?? true;
    this.maxFiles = options.maxFiles ?? 20000;
    this.maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
    this.legacyIgnore = [...(options.ignore ?? [])];
    this.additionalDirs = options.additionalDirs ?? [];
    this.now = options.now ?? (() => new Date());
    this.onEvent = options.onEvent;
    // Kept out of `storeDir`: the chunk library is not part of one checkpoint's
    // disk footprint, and `storeDir` is what `diskUsageBytes` reports. One
    // shared root lets identical payloads dedupe across sessions; GC unions
    // every session's references so that sharing stays safe.
    this.chunkRoot = explicitStore
      ? join(this.workspaceRoot, ".natalia", "chunks")
      : resolveWorkspaceChunksRoot(this.workspaceRoot);
    this.chunks = new ChunkStore(this.chunkRoot);
  }

  private async loadJournal(): Promise<CheckpointJournal> {
    if (!this.journal) {
      if (process.env.NATALIA_CHECKPOINT_NO_MIGRATE !== "1") {
        // Upgrade the pre-shared per-session chunk roots in place before any
        // read resolves a chunk through the shared root.
        const chunkMigration = await this.chunks.migrateLegacyRoots();
        if (chunkMigration.roots > 0)
          console.warn(
            `[checkpoint] merged ${chunkMigration.moved} chunks from ${chunkMigration.roots} legacy session root(s)`,
          );
        // Fold any loose one-file-per-chunk leftovers into packs (covers the
        // shared-root layout written before packing existed).
        await this.chunks.packLooseChunks();
        // One-time forward migration of a v2 journal to the delta + CDC format.
        // The original is copied to `<journal>.v2-backup` first, and every
        // checkpoint is preserved.
        const migration = await CheckpointJournal.migrate(
          this.journalPath(),
          this.chunks,
        );
        if (migration)
          console.warn(
            `[checkpoint] migrated ${migration.migrated} records to v3; backup at ${migration.backup}`,
          );
      }
      this.journal = await CheckpointJournal.load(
        this.journalPath(),
        this.chunks,
      );
    }
    return this.journal;
  }

  static async open(options: CheckpointStoreOptions) {
    const store = new CheckpointStore(options);
    await store.initialize();
    return store;
  }

  isEnabled() {
    return this.enabled;
  }

  async initialize() {
    if (!this.enabled) {
      this.unavailableReason = "disabled_by_config";
      this.emit({
        type: "checkpoint.unavailable",
        reason: "disabled_by_config",
        suggestion:
          "Set checkpoint.enabled=true to restore /checkpoint and /rollback.",
        disabledByConfig: true,
      });
      return;
    }
    try {
      assertContained(this.workspaceRoot, this.workspaceRoot);
      // The journal lives per session; the objects live in the shared library.
      await mkdir(this.storeDir, { recursive: true, mode: 0o700 });
      await mkdir(this.objectRoot(), { recursive: true, mode: 0o700 });
      await appendFile(this.journalPath(), "", { mode: 0o600 });
    } catch (error) {
      const message = `checkpoint storage unavailable: ${errorKind(error)}`;
      this.unavailableReason = message;
      this.emit({
        type: "checkpoint.unavailable",
        reason: message,
        suggestion:
          "Check workspace permissions and the checkpoint store path, then restart the session.",
      });
    }
  }

  async ensureBaseline(context: ContextLedger, step = 0) {
    // Read-only workspaces or permission failures must not block the rest of
    // the runtime. Checkpoint creation stays available for writable workspaces;
    // if the store is unavailable, skip the baseline and continue degraded.
    if (this.unavailableReason) return undefined;
    // Existence only. Reading the whole journal here made every turn pay for
    // the entire checkpoint history: `createTurnCheckpoint` calls `init()`,
    // which calls this before creating the turn's own checkpoint. On a long
    // session the journal grows to hundreds of MB, so an O(journal) check
    // stalled the turn before the provider ever ran (the UI sat on
    // "Planning" and a kill lost the in-flight reply). The tail read is O(1).
    if ((await this.readLastRecord()) !== undefined) return undefined;
    return this.createCheckpoint({
      reason: "baseline",
      context,
      step,
      status: "baseline",
    });
  }

  async createCheckpoint(
    input: CreateCheckpointInput,
  ): Promise<CheckpointRecord> {
    const create = () => this.createCheckpointLocked(input);
    const queued = this.checkpointQueue.then(create, create);
    this.checkpointQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return await queued;
  }

  private async createCheckpointLocked(
    input: CreateCheckpointInput,
  ): Promise<CheckpointRecord> {
    this.assertAvailable();
    // Append-only in the journal, and O(1) in journal size: the durable line is
    // a small header plus chunk refs, and the payloads are semantic deltas
    // (context/manifest) stored through the content-defined chunk library.
    const previous = await this.readLastRecord();
    const sequence = previous ? previous.sequence + 1 : 0;
    const id = sequence === 0 ? "checkpoint_0" : `checkpoint_${sequence}`;
    try {
      const manifest = await this.captureManifest();
      const context = input.context.durableCheckpoint(input.step);
      const diskUsageBytes = await this.diskUsageBytes();
      const record: CheckpointRecord = {
        schemaVersion: 3,
        id,
        sequence,
        sessionID: this.sessionID,
        turnID: input.turnID,
        stepID: input.stepID,
        step: input.step,
        reason: input.reason,
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        createdAt: this.now().toISOString(),
        cwd: this.workspaceRoot,
        complete: manifest.complete,
        errors: manifest.errors,
        manifest,
        manifestMeta: manifestMetaOf(manifest),
        context,
        contextMeta: contextMetaOf(context),
        changes: diffManifests(previous?.manifest, manifest),
        runtime: {
          status: input.status ?? "ready",
          model: input.model,
          tokenEstimate: context.tokenEstimate,
          compactionGeneration: context.compactionGeneration,
        },
        diskUsageBytes,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      await (await this.loadJournal()).append(record);
      if (!record.complete)
        this.emit({
          type: "checkpoint.failed",
          reason: record.reason,
          message: "checkpoint captured incomplete workspace manifest",
          incomplete: true,
          errors: record.errors,
        });
      else
        this.emit({
          type: "checkpoint.created",
          id: record.id,
          reason: record.reason,
          turnID: record.turnID,
          stepID: record.stepID,
          sequence: record.sequence,
          complete: record.complete,
          files: record.manifestMeta.entryCount,
          changes: record.changes.length,
          contextJournalOffset: context.journalOffset,
          step: context.step,
          tokenEstimate: context.tokenEstimate,
          diskUsageBytes: record.diskUsageBytes,
        });
      return record;
    } catch (error) {
      const message = `checkpoint creation failed: ${errorKind(error)}`;
      this.emit({ type: "checkpoint.failed", reason: input.reason, message });
      throw error;
    }
  }

  /**
   * Records for listings. Ledger entries are intentionally NOT materialized:
   * the scalar `contextMeta` carries what list consumers need, and `get` (or
   * `loadContext`) reconstructs the entries for the single record that needs
   * them. Materializing every context here would rebuild ~1 GB of history just
   * to show a list.
   */
  async list(): Promise<CheckpointRecord[]> {
    if (this.unavailableReason) return [];
    return await (await this.loadJournal()).summaries();
  }

  /** One record with its full ledger context materialized. */
  async get(id: string) {
    if (this.unavailableReason) return undefined;
    return await (await this.loadJournal()).get(id);
  }

  /** Materializes the ledger context of an already-listed record. */
  async loadContext(
    record: CheckpointRecord,
  ): Promise<DurableContextCheckpoint> {
    if (record.context) return record.context;
    const journal = await this.loadJournal();
    for (let index = journal.length - 1; index >= 0; index--)
      if (journal.sequenceAt(index) === record.sequence)
        return await journal.contextAt(index);
    throw new Error(`checkpoint context not found: ${record.id}`);
  }

  /** Materializes the workspace manifest of an already-listed record. */
  async loadManifest(record: CheckpointRecord): Promise<WorkspaceManifest> {
    if (record.manifest) return record.manifest;
    const journal = await this.loadJournal();
    for (let index = journal.length - 1; index >= 0; index--)
      if (journal.sequenceAt(index) === record.sequence)
        return await journal.manifestAt(index);
    throw new Error(`checkpoint manifest not found: ${record.id}`);
  }

  async listCheckpointsByKind(
    kind?: CheckpointKind,
  ): Promise<CheckpointRecord[]> {
    const records = await this.list();
    if (!kind) return records;
    return records.filter((record) => checkpointKind(record) === kind);
  }

  async listAuditRounds(planID?: string): Promise<AuditRoundRecord[]> {
    const records = await this.list();
    const rounds: AuditRoundRecord[] = [];
    for (const record of records) {
      if (record.reason !== "audit_round") continue;
      const metadata = record.metadata ?? {};
      const metadataPlanID = metadata.planID;
      if (typeof metadataPlanID !== "string") continue;
      if (planID && metadataPlanID !== planID) continue;
      const round = metadata.round;
      const verdict = metadata.verdict;
      if (typeof round !== "number") continue;
      if (verdict !== "gaps" && verdict !== "passed") continue;
      rounds.push({
        checkpointID: record.id,
        planID: metadataPlanID,
        round,
        verdict,
        auditReportAt:
          typeof metadata.auditReportAt === "string"
            ? metadata.auditReportAt
            : record.createdAt,
        sequence: record.sequence,
        createdAt: record.createdAt,
      });
    }
    return rounds.sort((a, b) => a.round - b.round);
  }

  async createAuditRoundCheckpoint(input: {
    planID: string;
    round: number;
    verdict: "gaps" | "passed";
    context: ContextLedger;
    step: number;
    sessionID: SessionID;
    turnID?: string;
    reportID?: string;
  }): Promise<CheckpointRecord> {
    const existing = await this.listAuditRounds(input.planID);
    if (existing.some((round) => round.round === input.round))
      throw new Error(
        `audit round already exists: ${input.planID}:${input.round}`,
      );
    return this.createCheckpoint({
      reason: "audit_round",
      context: input.context,
      step: input.step,
      turnID: input.turnID,
      name: `audit_round:${input.planID}:${input.round}`,
      status: `audit_round:${input.verdict}`,
      metadata: {
        kind: "audit_round",
        planID: input.planID,
        round: input.round,
        verdict: input.verdict,
        auditReportAt: this.now().toISOString(),
        ...(input.reportID ? { reportID: input.reportID } : {}),
      },
    });
  }

  async diffCheckpoints(
    from: CheckpointRef,
    to: CheckpointRef,
    options: DiffCheckpointsOptions = {},
  ): Promise<RuntimeWorkspaceDiffChange[]> {
    this.assertAvailable();
    const fromManifest = await this.manifestForRef(from);
    const toManifest = await this.manifestForRef(to);
    const changes = diffManifests(fromManifest, toManifest);
    return this.renderDiffChanges(fromManifest, toManifest, changes, options);
  }

  private async manifestForRef(ref: CheckpointRef): Promise<WorkspaceManifest> {
    if (ref.kind === "current") return this.captureManifest();
    const records = await this.list();
    let record: CheckpointRecord | undefined;
    if (ref.kind === "baseline") {
      record = records.find((candidate) => candidate.complete);
      if (!record) throw new Error("baseline checkpoint not found");
    } else if (ref.kind === "checkpoint") {
      record = records.find(
        (candidate) =>
          candidate.id === ref.id || String(candidate.sequence) === ref.id,
      );
      if (!record) throw new Error(`checkpoint not found: ${ref.id}`);
    } else if (ref.kind === "round") {
      const rounds = await this.listAuditRounds(ref.planID);
      const round = rounds.find((candidate) => candidate.round === ref.round);
      if (!round)
        throw new Error(`audit round not found: ${ref.planID}:${ref.round}`);
      record = records.find((candidate) => candidate.id === round.checkpointID);
    } else {
      const rounds = await this.listAuditRounds(ref.planID);
      if (!rounds.length)
        throw new Error(
          `no audit round found${ref.planID ? ` for plan ${ref.planID}` : ""}`,
        );
      const round = rounds.at(-1)!;
      record = records.find((candidate) => candidate.id === round.checkpointID);
    }
    if (!record) throw new Error("checkpoint record not found");
    if (!record.complete)
      throw new Error(`checkpoint is incomplete: ${record.id}`);
    return await this.loadManifest(record);
  }

  private async renderDiffChanges(
    fromManifest: WorkspaceManifest,
    toManifest: WorkspaceManifest,
    changes: CheckpointChange[],
    options: DiffCheckpointsOptions,
  ): Promise<RuntimeWorkspaceDiffChange[]> {
    const result: RuntimeWorkspaceDiffChange[] = [];
    const maxFiles = options.maxFiles ?? 50;
    const maxPatchChars = options.maxPatchChars ?? 12_000;
    for (const change of changes) {
      if (result.length >= maxFiles) break;
      if (
        options.paths?.length &&
        !options.paths.some(
          (path) => change.path === path || change.path.startsWith(`${path}/`),
        )
      )
        continue;
      const oldEntry =
        fromManifest.entries[change.oldPath ?? change.path] ??
        (change.oldPath ? fromManifest.entries[change.oldPath] : undefined);
      const newEntry = toManifest.entries[change.path];
      const oldContent = oldEntry?.objectHash
        ? await this.objects
            .get(oldEntry.objectHash)
            .then((buffer) => buffer.toString("utf8"))
            .catch(() => undefined)
        : undefined;
      const newContent = newEntry?.objectHash
        ? await this.objects
            .get(newEntry.objectHash)
            .then((buffer) => buffer.toString("utf8"))
            .catch(() => undefined)
        : undefined;
      const operation =
        change.kind === "add"
          ? "added"
          : change.kind === "delete"
            ? "deleted"
            : change.kind === "rename"
              ? "renamed"
              : "modified";
      const text = await this.diffTextCached(
        change.path,
        oldContent,
        newContent,
      );
      const patch =
        options.includePatch === false
          ? undefined
          : text.patch?.slice(0, maxPatchChars);
      if (oldContent === undefined && newContent === undefined) {
        result.push({
          path: change.path,
          operation,
          ...(change.oldPath ? { oldPath: change.oldPath } : {}),
          additions: 0,
          deletions: 0,
          ...(change.mode ? { mode: change.mode } : {}),
        });
        continue;
      }
      result.push({
        path: change.path,
        operation,
        ...(change.oldPath ? { oldPath: change.oldPath } : {}),
        additions: text.additions,
        deletions: text.deletions,
        ...(patch ? { patch } : {}),
        ...(text.structured ? { structured: text.structured } : {}),
        ...(options.includeContent !== false && oldContent !== undefined
          ? { before: oldContent }
          : {}),
        ...(options.includeContent !== false && newContent !== undefined
          ? { after: newContent }
          : {}),
        ...(change.mode ? { mode: change.mode } : {}),
      });
    }
    return result;
  }

  async rename(id: string, name: string): Promise<CheckpointRecord> {
    this.assertAvailable();
    const trimmed = name.trim();
    if (!trimmed) throw new Error("checkpoint name must not be empty");
    const updated = await (await this.loadJournal()).rename(id, trimmed);
    if (!updated) throw new Error(`checkpoint not found: ${id}`);
    this.emit({
      type: "checkpoint.created",
      id: updated.id,
      reason: updated.reason,
      turnID: updated.turnID,
      stepID: updated.stepID,
      sequence: updated.sequence,
      complete: updated.complete,
      files: updated.manifestMeta.entryCount,
      changes: updated.changes.length,
      contextJournalOffset: updated.contextMeta.journalOffset,
      step: updated.contextMeta.step,
      tokenEstimate: updated.contextMeta.tokenEstimate,
      diskUsageBytes: updated.diskUsageBytes,
    });
    return updated;
  }

  async previewRollback(
    id: string,
    context: ContextLedger,
    resources: CheckpointRuntimeResource[] = [],
    dryRun = false,
  ): Promise<CheckpointPreview> {
    this.assertAvailable();
    const target = await this.get(id);
    if (!target) throw new Error(`checkpoint not found: ${id}`);
    const targetManifest = await this.loadManifest(target);
    const current = await this.captureManifest();
    const contextStatus = context.journalStatus();
    const preview: CheckpointPreview = {
      checkpointID: target.id,
      dryRun,
      changes: await this.previewChangesWithDiff(
        current,
        targetManifest,
        diffManifests(current, targetManifest),
      ),
      context: {
        // Scalar header only: preview must not materialize the ledger.
        truncateMessages: Math.max(
          0,
          contextStatus.messageCount - target.contextMeta.entryCount,
        ),
        targetJournalOffset: target.contextMeta.journalOffset,
        targetStep: target.contextMeta.step,
        targetTokens: target.contextMeta.tokenEstimate,
        compactionGeneration: target.contextMeta.compactionGeneration,
      },
      resources: resourcePolicies(resources),
      ignoredFiles: current.ignoredFiles,
      diskUsageBytes: await this.diskUsageBytes(),
      complete: target.complete && current.complete,
      warnings: [
        ...target.errors,
        ...current.errors,
        ...additionalDirWarnings(this.workspaceRoot, this.additionalDirs),
      ],
    };
    this.emit({ type: "rollback.previewed", preview });
    return preview;
  }

  /**
   * Returns a global object-store diff from the earliest complete checkpoint to
   * the current workspace. This is the "own diff" source used by the review
   * UI before git integration: it sees every change since the checkpoint,
   * regardless of who made it.
   */
  async workspaceDiff(): Promise<RuntimeWorkspaceDiffChange[]> {
    this.assertAvailable();
    const records = await this.list();
    if (!records.some((record) => record.complete)) return [];
    return this.diffCheckpoints(
      { kind: "baseline" },
      { kind: "current" },
      {
        includePatch: true,
        includeContent: true,
        maxFiles: 20_000,
        maxPatchChars: 1_000_000,
      },
    );
  }

  private async diffTextCached(
    path: string,
    oldText: string | undefined,
    newText: string | undefined,
  ): Promise<Awaited<ReturnType<typeof diffTextAsync>>> {
    const oldTextValue = oldText ?? "";
    const newTextValue = newText ?? "";
    const cached = await this.diffCache.get(oldTextValue, newTextValue);
    if (cached)
      return {
        additions: cached.additions,
        deletions: cached.deletions,
        structured: cached.structured,
      };
    const result = await diffTextAsync(path, oldText, newText);
    if (result.structured)
      await this.diffCache.set(oldTextValue, newTextValue, {
        additions: result.additions,
        deletions: result.deletions,
        structured: result.structured,
      });
    return result;
  }

  private async previewChangesWithDiff(
    current: WorkspaceManifest,
    target: WorkspaceManifest,
    changes: CheckpointChange[],
  ): Promise<CheckpointPreview["changes"]> {
    const result: CheckpointPreview["changes"] = [];
    for (const change of changes) {
      const fromEntry =
        current.entries[change.oldPath ?? change.path] ??
        (change.oldPath ? current.entries[change.oldPath] : undefined);
      const toEntry = target.entries[change.path];
      const beforeContent = fromEntry?.objectHash
        ? await this.objects
            .get(fromEntry.objectHash)
            .then((buffer) => buffer.toString("utf8"))
            .catch(() => undefined)
        : undefined;
      const afterContent = toEntry?.objectHash
        ? await this.objects
            .get(toEntry.objectHash)
            .then((buffer) => buffer.toString("utf8"))
            .catch(() => undefined)
        : undefined;
      const text = await this.diffTextCached(
        change.path,
        beforeContent,
        afterContent,
      );
      result.push({
        kind: change.kind,
        path: change.path,
        ...(change.oldPath ? { oldPath: change.oldPath } : {}),
        ...(change.mode ? { mode: change.mode } : {}),
        additions: text.additions,
        deletions: text.deletions,
        ...(text.patch ? { patch: text.patch } : {}),
        ...(text.structured ? { structured: text.structured } : {}),
        ...(beforeContent !== undefined ? { before: beforeContent } : {}),
        ...(afterContent !== undefined ? { after: afterContent } : {}),
      });
    }
    return result;
  }

  async rollbackTo(
    id: string,
    options: RollbackOptions,
  ): Promise<CheckpointPreview> {
    const target = await this.get(id);
    if (!target) throw new Error(`checkpoint not found: ${id}`);
    if (!target.complete)
      throw new Error(`checkpoint is incomplete: ${target.id}`);
    // Rolling back the ledger is the one place that needs the full entries, so
    // materialize exactly this record's context (replaying its deltas).
    const targetContext = await this.loadContext(target);
    const targetManifest = await this.loadManifest(target);
    const preview = await this.previewRollback(
      target.id,
      options.context,
      options.resources,
      Boolean(options.dryRun),
    );
    if (options.dryRun) return preview;

    const safety = await this.createCheckpoint({
      reason: "rollback_safety",
      context: options.context,
      step: options.context.journalStatus().messageCount,
      status: "rollback_safety",
    });
    if (!safety.complete)
      throw new Error(
        "rollback safety checkpoint is incomplete; refusing workspace mutation",
      );
    const safetyContext = await this.loadContext(safety);
    const safetyManifest = await this.loadManifest(safety);
    preview.safetyCheckpointID = safety.id;
    this.emit({
      type: "rollback.begin",
      checkpointID: target.id,
      safetyCheckpointID: safety.id,
    });
    try {
      for (const policy of preview.resources)
        if (policy.action !== "none" && policy.action !== "preserve_dirty")
          await options.onResourcePolicy?.(policy);
      const applied = await this.applyManifest(targetManifest);
      if (options.failAfterWorkspaceApply)
        throw new Error("injected workspace rollback failure");
      if (options.failContextRestore)
        throw new Error("injected context rollback failure");
      options.context.restoreDurableCheckpoint(targetContext);
      await options.onContextRestored?.(targetContext);
      await this.truncateFutureCheckpoints(target, safety);
      this.emit({
        type: "rollback.end",
        checkpointID: target.id,
        safetyCheckpointID: safety.id,
        restoredFiles: applied.restoredFiles,
        deletedFiles: applied.deletedFiles,
        contextJournalOffset: target.contextMeta.journalOffset,
        step: target.contextMeta.step,
      });
      return preview;
    } catch (error) {
      let recovered = false;
      try {
        await this.applyManifest(safetyManifest);
        options.context.restoreDurableCheckpoint(safetyContext);
        await options.onContextRestored?.(safetyContext);
        recovered = true;
      } finally {
        this.emit({
          type: "rollback.failed",
          checkpointID: target.id,
          safetyCheckpointID: safety.id,
          message: `rollback transaction failed: ${errorKind(error)}`,
          recovered,
        });
      }
      throw error;
    }
  }

  async gcObjects(dryRun = true, extraReachable?: Iterable<string>) {
    // Serialized with checkpoint creation: a checkpoint writes its chunks and
    // only then appends the journal line that references them, so running GC
    // through the same queue removes the "chunk written but not yet referenced"
    // window entirely. The age window below is the second line of defence for
    // a chunk written by another process.
    const run = () => this.gcObjectsLocked(dryRun, extraReachable);
    const queued = this.checkpointQueue.then(run, run);
    this.checkpointQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return await queued;
  }

  /**
   * Every sibling session journal under the same checkpoint parent, plus the
   * caller's own journal. The workspace object store and the chunk root are
   * shared, so a GC that only saw this session would delete another session's
   * live payloads.
   */
  private async journalsForGc(
    ownJournal: CheckpointJournal,
  ): Promise<CheckpointJournal[]> {
    const journals = [ownJournal];
    const parent = dirname(this.storeDir);
    const ownDir = resolve(this.storeDir);
    let entries;
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return journals;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionDir = resolve(parent, entry.name);
      if (sessionDir === ownDir) continue;
      const journalPath = join(sessionDir, "journal.jsonl");
      try {
        journals.push(await CheckpointJournal.load(journalPath, this.chunks));
      } catch (error) {
        // A foreign/corrupt directory must never make GC unsafe: skipping it
        // can only keep payloads that might already be dead, never delete a
        // live one.
        console.warn(
          `[checkpoint] GC skipped unreadable journal ${journalPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return journals;
  }

  private async gcObjectsLocked(
    dryRun: boolean,
    extraReachable?: Iterable<string>,
  ) {
    // The object store and the chunk root are both shared across sessions, so
    // reachability must union *every* session's refs (plus the sandbox's
    // snapshot indices passed in `extraReachable`). A GC that only saw this
    // journal would delete another session's live payloads.
    const ownJournal = await this.loadJournal();
    const journals = await this.journalsForGc(ownJournal);
    const referenced = new Set<string>();
    const referencedChunks = new Set<string>();
    // GC is the one listing path that genuinely needs every manifest entry, so
    // materialize each manifest here (on demand) rather than in `list()`.
    for (const journal of journals) {
      for (let index = 0; index < journal.length; index++) {
        const manifest = await journal.manifestAt(index);
        for (const entry of Object.values(manifest.entries))
          if (entry.objectHash) referenced.add(entry.objectHash);
      }
      for (const hash of journal.referencedChunks()) referencedChunks.add(hash);
    }
    for (const id of extraReachable ?? []) {
      referenced.add(id);
      referencedChunks.add(id);
    }
    const chunks = await this.chunks.collectGarbage(referencedChunks, dryRun, {
      minAgeMs: 60_000,
    });
    if (dryRun) {
      const existing = new Set(await this.objects.list());
      const unreachable = [...existing].filter((hash) => !referenced.has(hash));
      let bytes = 0;
      for (const hash of unreachable)
        bytes += (await stat(this.objectPath(hash))).size;
      return {
        dryRun,
        unreachableObjects: unreachable.length,
        bytes,
        unreachableChunks: chunks.removed,
        chunkBytes: chunks.bytes,
      };
    }
    return {
      dryRun,
      ...(await this.objects.collectGarbage(referenced)),
      unreachableChunks: chunks.removed,
      chunkBytes: chunks.bytes,
    };
  }

  async diskUsageBytes() {
    return directorySize(this.storeDir);
  }

  async captureManifest(
    options: { writeObjects?: boolean } = {},
  ): Promise<WorkspaceManifest> {
    const writeObjects = options.writeObjects ?? true;
    await ensureNataliaIgnoreFile(this.workspaceRoot, this.legacyIgnore);
    const ignoreRules = (await loadNataliaIgnore(this.workspaceRoot)).rules;
    const manifest: WorkspaceManifest = {
      root: this.workspaceRoot,
      entries: {},
      complete: true,
      errors: [],
      ignoredFiles: 0,
      totalBytes: 0,
    };
    const roots = [this.workspaceRoot];
    for (const dir of this.additionalDirs) {
      const resolved = resolve(this.workspaceRoot, dir);
      if (isContained(this.workspaceRoot, resolved)) roots.push(resolved);
      else {
        manifest.complete = false;
        manifest.errors.push(
          "checkpoint additional directory is outside the managed workspace",
        );
      }
    }
    for (const root of roots)
      await this.scanDirectory(root, manifest, writeObjects, ignoreRules);
    return manifest;
  }

  private async scanDirectory(
    dir: string,
    manifest: WorkspaceManifest,
    writeObjects: boolean,
    ignoreRules: readonly SnapshotIgnoreRule[],
  ): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = normalizeManifestPath(relative(this.workspaceRoot, full));
      if (
        !rel ||
        this.shouldIgnore(rel, full, entry.isDirectory(), ignoreRules)
      ) {
        manifest.ignoredFiles += 1;
        continue;
      }
      if (Object.keys(manifest.entries).length >= this.maxFiles) {
        manifest.complete = false;
        manifest.errors.push(
          `checkpoint file count guard exceeded: ${this.maxFiles}`,
        );
        return;
      }
      try {
        const info = await lstat(full);
        if (info.isDirectory()) {
          await this.scanDirectory(full, manifest, writeObjects, ignoreRules);
          continue;
        }
        if (info.isSymbolicLink()) {
          await this.captureSymlink(full, rel, manifest);
          continue;
        }
        if (!info.isFile()) {
          manifest.ignoredFiles += 1;
          continue;
        }
        manifest.totalBytes += info.size;
        if (manifest.totalBytes > this.maxBytes) {
          manifest.complete = false;
          manifest.errors.push(
            `checkpoint byte guard exceeded: ${this.maxBytes}`,
          );
          return;
        }
        const bytes = await readFile(full);
        const objectHash = createHash("sha256").update(bytes).digest("hex");
        if (writeObjects) await this.writeObject(objectHash, bytes);
        manifest.entries[rel] = {
          path: rel,
          kind: "regular",
          objectHash,
          size: info.size,
          mode: info.mode & 0o777,
        };
      } catch (error) {
        manifest.complete = false;
        manifest.errors.push(
          `checkpoint could not read a workspace entry: ${errorKind(error)}`,
        );
      }
    }
  }

  private async captureSymlink(
    full: string,
    rel: string,
    manifest: WorkspaceManifest,
  ) {
    const target = await readlink(full);
    // A Windows junction reports an extended-length `\\?\C:\...` target, which
    // no containment check can match. Normalising keeps such a workspace
    // capturable instead of silently marking every manifest incomplete and
    // disabling rollback outright.
    const resolvedTarget = resolve(dirname(full), normalizeLinkTarget(target));
    if (!isContained(this.workspaceRoot, resolvedTarget)) {
      manifest.complete = false;
      manifest.errors.push(
        "checkpoint contains a symlink outside the managed workspace",
      );
      return;
    }
    const info = await lstat(full);
    manifest.entries[rel] = {
      path: rel,
      kind: "symlink",
      mode: info.mode & 0o777,
      linkTarget: target,
    };
  }

  private async writeObject(hash: string, bytes: Buffer) {
    // The shared store dedups by content hash; `hash` is sha256(bytes), so the
    // written object id is identical.
    await this.objects.put(bytes);
  }

  private async applyManifest(manifest: WorkspaceManifest) {
    const current = await this.captureManifest({ writeObjects: false });
    let restoredFiles = 0;
    let deletedFiles = 0;
    for (const path of Object.keys(current.entries)) {
      if (manifest.entries[path]) continue;
      await removeWorkspacePath(this.workspaceRoot, path);
      deletedFiles += 1;
    }
    for (const entry of Object.values(manifest.entries)) {
      const full = workspacePath(this.workspaceRoot, entry.path);
      await mkdir(dirname(full), { recursive: true });
      await forceRemove(full, { recursive: true });
      if (entry.kind === "symlink") {
        if (!entry.linkTarget)
          throw new Error(`missing symlink target: ${entry.path}`);
        const resolvedTarget = resolve(
          dirname(full),
          normalizeLinkTarget(entry.linkTarget),
        );
        if (!isContained(this.workspaceRoot, resolvedTarget))
          throw new Error(
            `refusing to restore escaping symlink: ${entry.path}`,
          );
        // Windows needs the link type up front: a directory link must be a
        // junction, which is also the only kind an unelevated process can
        // create. POSIX ignores the hint.
        const targetIsDirectory = await stat(resolvedTarget)
          .then((info) => info.isDirectory())
          .catch(() => false);
        await createSymlink(entry.linkTarget, full, { targetIsDirectory });
        restoredFiles += 1;
        continue;
      }
      if (!entry.objectHash)
        throw new Error(`missing object hash: ${entry.path}`);
      const temp = `${full}.natalia-rollback-tmp`;
      await copyFile(
        this.objectPath(entry.objectHash),
        temp,
        constants.COPYFILE_FICLONE_FORCE,
      ).catch(async () => copyFile(this.objectPath(entry.objectHash!), temp));
      await chmod(temp, entry.mode);
      await rename(temp, full);
      restoredFiles += 1;
    }
    return { restoredFiles, deletedFiles };
  }

  private async truncateFutureCheckpoints(
    target: CheckpointRecord,
    safety: CheckpointRecord,
  ) {
    await (
      await this.loadJournal()
    ).truncateAfter(target.sequence, safety.sequence);
  }

  /** Newest record summary, for sequence numbering and baseline checks. */
  private async readLastRecord(): Promise<CheckpointRecord | undefined> {
    const journal = await this.loadJournal();
    if (journal.isEmpty) return undefined;
    const index = journal.length - 1;
    // The previous record is used to diff manifests, so materialize exactly its
    // manifest (never the ledger).
    const record = await journal.summaryAt(index);
    return { ...record, manifest: await journal.manifestAt(index) };
  }

  private shouldIgnore(
    rel: string,
    full: string,
    directory: boolean,
    ignoreRules: readonly SnapshotIgnoreRule[],
  ): boolean {
    // Structural self-exclusion: a snapshot must never include its own store,
    // the shared object library, or the chunk library, even if the user removes
    // .natalia/ from .nataliaignore.
    if (
      full === this.storeDir ||
      isContained(this.storeDir, full) ||
      full === this.objectRoot() ||
      isContained(this.objectRoot(), full) ||
      full === this.chunkRoot ||
      isContained(this.chunkRoot, full)
    )
      return true;
    if (full === resolve(this.workspaceRoot, NATALIA_IGNORE_FILE)) return true;
    return isSnapshotIgnored(rel, directory, ignoreRules);
  }

  private assertAvailable() {
    if (!this.enabled) throw new Error("checkpoint disabled by config");
    if (this.unavailableReason)
      throw new Error(`checkpoint unavailable: ${this.unavailableReason}`);
  }

  private journalPath() {
    return join(this.storeDir, "journal.jsonl");
  }

  private objectRoot() {
    // The shared object library, git-style: one store for checkpoint and the
    // sandbox, so identical files across subsystems share a single object.
    // The root is the ObjectStore's own (public since the store moved
    // outside the workspace): a second hardcoded resolution here is how a
    // rollback would read a directory the writes never landed in.
    return this.objects.root;
  }

  private objectPath(hash: string) {
    return join(this.objectRoot(), hash.slice(0, 2), hash);
  }

  private emit(event: RuntimeEvent) {
    this.onEvent?.(event);
  }
}

export async function initializeDefaultCheckpointStore(
  options: CheckpointStoreOptions & { context: ContextLedger },
) {
  const store = await CheckpointStore.open(options);
  if (options.enabled !== false) await store.ensureBaseline(options.context, 0);
  return store;
}

export async function runCheckpointCommand(
  store: CheckpointStore,
  context: ContextLedger,
  command: string,
  options: Omit<RollbackOptions, "context" | "dryRun"> = {},
  /**
   * Other object-library owners' referenced ids (the sandbox's snapshot
   * indices), so GC never prunes a live sandbox object.
   */
  extraReachable?: () => Promise<Iterable<string> | undefined>,
): Promise<CheckpointCommandResult> {
  const parts = command.trim().split(/\s+/u);
  const name = parts[0];
  if (name === "/checkpoint") {
    const record = await store.createCheckpoint({
      reason: "manual",
      context,
      step: context.journalStatus().messageCount,
    });
    return { ok: true, output: formatCheckpoint(record) };
  }
  if (name === "/checkpoints") {
    if (parts[1] === "gc") {
      const result = await store.gcObjects(
        parts.includes("--dry-run"),
        await extraReachable?.(),
      );
      return {
        ok: true,
        output: `checkpoint gc ${result.dryRun ? "dry-run" : "applied"}: ${result.unreachableObjects} objects, ${result.bytes} bytes`,
      };
    }
    const limitIndex = parts.indexOf("--limit");
    const limit = limitIndex >= 0 ? Number(parts[limitIndex + 1]) : 20;
    const records = (await store.list()).slice(-limit);
    return { ok: true, output: records.map(formatCheckpoint).join("\n") };
  }
  if (name === "/rollback") {
    const target = parts[1] ?? "last";
    const dryRun = parts.includes("--dry-run");
    const preview = await store.rollbackTo(target, {
      context,
      dryRun,
      ...options,
    });
    return { ok: true, output: formatRollbackPreview(preview) };
  }
  return { ok: false, output: `unknown checkpoint command: ${name}` };
}

type DiffLineOp =
  | { type: "equal"; text: string }
  | { type: "delete"; text: string }
  | { type: "insert"; text: string };

function diffText(
  path: string,
  oldText: string | undefined,
  newText: string | undefined,
): { additions: number; deletions: number; patch?: string } {
  const before = oldText ?? "";
  const after = newText ?? "";
  const a = before.endsWith("\n")
    ? before.slice(0, -1).split("\n")
    : before
      ? before.split("\n")
      : [];
  const b = after.endsWith("\n")
    ? after.slice(0, -1).split("\n")
    : after
      ? after.split("\n")
      : [];
  if (a.length === 0 && b.length === 0) return { additions: 0, deletions: 0 };
  const ops = diffLineOps(a, b);
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.type === "insert") additions++;
    if (op.type === "delete") deletions++;
  }
  if (additions === 0 && deletions === 0) return { additions: 0, deletions: 0 };
  return {
    additions,
    deletions,
    patch: renderUnifiedPatch(path, ops),
  };
}

function renderUnifiedPatch(path: string, ops: DiffLineOp[]): string {
  const entries: Array<{
    op: DiffLineOp;
    oldLine: number;
    newLine: number;
  }> = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    entries.push({ op, oldLine, newLine });
    if (op.type !== "insert") oldLine++;
    if (op.type !== "delete") newLine++;
  }
  const changeIndexes = entries.flatMap((entry, index) =>
    entry.op.type === "equal" ? [] : [index],
  );
  if (!changeIndexes.length) return "";
  const context = 3;
  const ranges: Array<[number, number]> = [];
  for (const index of changeIndexes) {
    const start = Math.max(0, index - context);
    const end = Math.min(entries.length - 1, index + context);
    const last = ranges.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const [start, end] of ranges) {
    const first = entries[start]!;
    const slice = entries.slice(start, end + 1);
    const oldCount = slice.filter((entry) => entry.op.type !== "insert").length;
    const newCount = slice.filter((entry) => entry.op.type !== "delete").length;
    lines.push(
      `@@ -${first.oldLine},${oldCount} +${first.newLine},${newCount} @@`,
    );
    for (const entry of slice) {
      if (entry.op.type === "insert") lines.push(`+${entry.op.text}`);
      else if (entry.op.type === "delete") lines.push(`-${entry.op.text}`);
      else lines.push(` ${entry.op.text}`);
    }
  }
  return lines.join("\n") + "\n";
}

function diffLineOps(a: string[], b: string[]): DiffLineOp[] {
  // A practical LCS line diff. Files larger than the guard fall back to a
  // whole-file block diff; the object store and UI still get usable output.
  const maxLines = 2000;
  if (a.length > maxLines || b.length > maxLines) {
    const ops: DiffLineOp[] = [];
    for (const line of a) ops.push({ type: "delete", text: line });
    for (const line of b) ops.push({ type: "insert", text: line });
    return ops;
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: DiffLineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "delete", text: a[i]! });
      i++;
    } else {
      ops.push({ type: "insert", text: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "delete", text: a[i++]! });
  while (j < m) ops.push({ type: "insert", text: b[j++]! });
  return ops;
}

/**
 * Pure in-process text diff. Unlike the Git tab, checkpoint and sandbox diffs
 * deliberately do not require git to be installed.
 */
async function diffTextAsync(
  path: string,
  oldText: string | undefined,
  newText: string | undefined,
): Promise<{
  additions: number;
  deletions: number;
  patch?: string;
  structured?: import("@anthelia/contracts").RuntimeStructuredDiff;
}> {
  try {
    const { diffWasmStructured } = await import("@anthelia/diff-wasm");
    const wasm = await diffWasmStructured(oldText ?? "", newText ?? "");
    const patch = wasm.hunks.length
      ? `--- a/${path}
+++ b/${path}
${renderStructuredPatch(wasm)}`
      : undefined;
    return {
      additions: wasm.additions,
      deletions: wasm.deletions,
      ...(patch ? { patch } : {}),
      structured: wasm,
    };
  } catch {
    // Fall back to the pure JS engine when WASM is unavailable.
  }
  return diffText(path, oldText, newText);
}

function renderStructuredPatch(diff: {
  hunks: Array<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: Array<{
      type: "context" | "add" | "delete" | "hunk";
      text: string;
      oldLineNumber: number | null;
      newLineNumber: number | null;
    }>;
  }>;
}): string {
  if (!diff.hunks.length) return "";
  const lines: string[] = [];
  for (const hunk of diff.hunks) {
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
    );
    for (const line of hunk.lines) {
      if (line.type === "add") lines.push(`+${line.text}`);
      else if (line.type === "delete") lines.push(`-${line.text}`);
      else lines.push(` ${line.text}`);
    }
  }
  return lines.join("\n") + "\n";
}

function checkpointKind(record: CheckpointRecord): CheckpointKind {
  if (record.reason === "rollback_safety") return "rollback_safety";
  if (record.reason === "manual") return "manual";
  if (record.reason === "audit_round" || record.reason === "baseline")
    return "audit";
  return "auto_safety";
}

function diffManifests(
  before: WorkspaceManifest | undefined,
  after: WorkspaceManifest,
): CheckpointChange[] {
  if (!before) {
    return Object.values(after.entries).map((entry) => ({
      kind: "add" as const,
      path: entry.path,
      mode: modeString(entry.mode),
    }));
  }
  const changes: CheckpointChange[] = [];
  const beforeByHash = new Map<string, string>();
  for (const entry of Object.values(before.entries)) {
    const key = entryKey(entry);
    if (key) beforeByHash.set(key, entry.path);
  }
  for (const [path, entry] of Object.entries(after.entries)) {
    const old = before.entries[path];
    if (!old) {
      const oldPath = beforeByHash.get(entryKey(entry));
      changes.push({
        kind: oldPath ? "rename" : "add",
        path,
        oldPath,
        mode: modeString(entry.mode),
      });
      continue;
    }
    if (old.kind !== entry.kind) changes.push({ kind: "symlink", path });
    else if (
      old.objectHash !== entry.objectHash ||
      old.linkTarget !== entry.linkTarget
    )
      changes.push({
        kind: entry.kind === "symlink" ? "symlink" : "modify",
        path,
      });
    if (old.mode !== entry.mode)
      changes.push({
        kind: "mode",
        path,
        mode: `${modeString(old.mode)} -> ${modeString(entry.mode)}`,
      });
  }
  for (const path of Object.keys(before.entries)) {
    if (!after.entries[path]) changes.push({ kind: "delete", path });
  }
  return changes;
}

function resourcePolicies(
  resources: CheckpointRuntimeResource[],
): CheckpointResourcePolicy[] {
  return resources.map((resource) => {
    if (resource.kind === "pending_modal")
      return {
        kind: resource.kind,
        id: resource.id,
        action: "invalidate",
        summary: resource.summary,
      };
    if (resource.kind === "tool")
      return {
        kind: resource.kind,
        id: resource.id,
        action: "cancel",
        summary: resource.summary,
      };
    if (
      resource.status === "running" ||
      resource.status === "waiting" ||
      resource.status === "pending"
    )
      return {
        kind: resource.kind,
        id: resource.id,
        action: "stop",
        summary: resource.summary,
      };
    if (resource.status === "preserve_dirty")
      return {
        kind: resource.kind,
        id: resource.id,
        action: "preserve_dirty",
        summary: resource.summary,
      };
    return {
      kind: resource.kind,
      id: resource.id,
      action: "none",
      summary: resource.summary,
    };
  });
}

function formatCheckpoint(record: CheckpointRecord) {
  const name = record.name ? ` name=${JSON.stringify(record.name)}` : "";
  return `${record.id} step=${record.step} reason=${record.reason}${name} files=${record.manifestMeta.entryCount} changes=${record.changes.length} tokens=${record.contextMeta.tokenEstimate} ${record.complete ? "complete" : "incomplete"}`;
}

function formatRollbackPreview(preview: CheckpointPreview) {
  return `rollback ${preview.checkpointID}${preview.dryRun ? " dry-run" : ""}: ${preview.changes.length} file changes, truncate ${preview.context.truncateMessages} messages, resources=${preview.resources.length}`;
}

function additionalDirWarnings(root: string, dirs: string[]) {
  return dirs
    .filter((dir) => !isContained(root, resolve(root, dir)))
    .map(
      () => "checkpoint additional directory is outside the managed workspace",
    );
}

function entryKey(entry: ManifestEntry | undefined) {
  if (!entry) return "";
  if (entry.kind === "regular")
    return `regular:${entry.objectHash}:${entry.size}`;
  return `symlink:${entry.linkTarget}`;
}

function modeString(mode: number) {
  return `0${mode.toString(8)}`;
}

function normalizeManifestPath(path: string) {
  return path.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function workspacePath(root: string, path: string) {
  const resolved = resolve(root, path);
  assertContained(root, resolved);
  return resolved;
}

async function removeWorkspacePath(root: string, path: string) {
  const full = workspacePath(root, path);
  await forceRemove(full, { recursive: true });
}

function assertContained(root: string, target: string) {
  if (!isContained(root, target))
    throw new Error(`path escapes workspace root: ${target}`);
}

function isContained(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function directorySize(path: string): Promise<number> {
  try {
    const info = await lstat(path);
    if (info.isFile() || info.isSymbolicLink()) return info.size;
    if (!info.isDirectory()) return 0;
    const entries = await readdir(path);
    let size = 0;
    for (const entry of entries) size += await directorySize(join(path, entry));
    return size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function listObjectHashes(root: string): Promise<string[]> {
  try {
    const buckets = await readdir(root, { withFileTypes: true });
    const hashes: string[] = [];
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue;
      const files = await readdir(join(root, bucket.name), {
        withFileTypes: true,
      });
      for (const file of files) if (file.isFile()) hashes.push(file.name);
    }
    return hashes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function fileSize(path: string) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function errorKind(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "filesystem_error";
}

/**
 * Atomically replaces the journal. POSIX rename is atomic and returns on the
 * first attempt; Windows rejects the rename while another client holds the
 * target open for reading (its handle lacks FILE_SHARE_DELETE), so the
 * overwrite retries with a short backoff and falls back to a direct write
 * once the lock clears. Journal writers are serialized per store, so the
 * fallback cannot interleave two updates.
 */
async function replaceJournalFile(source: string, target: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = errorKind(error);
      if (
        code !== "EPERM" &&
        code !== "EBUSY" &&
        code !== "EACCES" &&
        code !== "EEXIST"
      )
        throw error;
      if (attempt >= 4) {
        await writeFile(target, await readFile(source, "utf8"), {
          mode: 0o600,
        });
        return;
      }
      await Bun.sleep(25 * (attempt + 1));
    }
  }
}
