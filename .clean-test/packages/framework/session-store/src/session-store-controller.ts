import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  SessionStoreController,
  SessionStoreRecoveryView,
} from "./contracts";
import type {
  DurableContextCheckpointRecord,
  LocalAttachment,
  RuntimeEvent,
  RuntimeMessagePage,
  RuntimeSessionSummary,
  SessionID,
} from "@anthelia/contracts";
import {
  JsonSessionStore,
  SqliteSessionStore,
  createSessionRecord,
  deserializeProjectionState,
  projectSessionMessages,
  serializeProjectionState,
  type AdmittedSessionInput,
  type SessionMetadata,
  type SessionRecord,
  type SessionRow,
  type StoredContextEpoch,
} from "@anthelia/session";
import type {} from "@anthelia/runtime-services";
import {
  ensureMessageIndexInWorker,
  loadMessagePageInWorker,
  loadSessionEventsInWorker,
} from "./session-load-worker-client";
import { perfLog } from "@anthelia/runtime-services";
import type { AttachmentService } from "@anthelia/runtime";
import {
  resolveWorkspaceJsonSessionsDir,
  resolveWorkspaceJournalDatabasePath,
} from "@anthelia/platform";

/**
 * Shared SQLite handles are refcounted by database path: several runtimes in
 * one process (TUI worker, CLI, tests) may open the same `.natalia/sessions.db`,
 * and the last one to close releases the handle.
 */
const sqliteStores = new Map<string, SqliteSessionStore>();
const sqliteStoreUsers = new Map<string, number>();

function retainSqliteStore(path: string, store: SqliteSessionStore) {
  sqliteStores.set(path, store);
  sqliteStoreUsers.set(path, (sqliteStoreUsers.get(path) ?? 0) + 1);
}

function releaseSqliteStore(path: string) {
  const remaining = (sqliteStoreUsers.get(path) ?? 1) - 1;
  if (remaining > 0) {
    sqliteStoreUsers.set(path, remaining);
    return;
  }
  sqliteStoreUsers.delete(path);
  const store = sqliteStores.get(path);
  sqliteStores.delete(path);
  if (store) void store.close();
}

/**
 * The pending-human-terminal metadata as a typed value, or undefined. SQLite
 * rows carry metadata as a loose record, so the shape is checked before it is
 * projected into the public summary.
 */
function pendingHumanTerminalOf(
  metadata: Record<string, unknown>,
): RuntimeSessionSummary["pendingHumanTerminal"] | undefined {
  const pending = metadata.pendingHumanTerminal;
  if (
    !pending ||
    typeof pending !== "object" ||
    typeof (pending as { terminalID?: unknown }).terminalID !== "string" ||
    typeof (pending as { reason?: unknown }).reason !== "string" ||
    typeof (pending as { since?: unknown }).since !== "string"
  )
    return undefined;
  return pending as RuntimeSessionSummary["pendingHumanTerminal"];
}

/**
 * The session store resource controller — the first cut of the session /
 * recovery split (mainline plan §15, knife 5). It owns the store selection
 * (JSON files vs the shared SQLite handle), the session-management surface
 * (list/touch/rename/pin/duplicate/fork/delete/new/archive/export) and the
 * summary projections. The journal-recovery flow (inbox promotion, context
 * rebuild, publish) stays in the runtime — it is coupled to the turn
 * machinery, not to the store.
 *
 * Multi-session shape (plan §41.9): `sessionID()` is an accessor, and every
 * read here is by id; nothing captures "the current session".
 */
export function createSessionStoreController(input: {
  workspaceRoot: string;
  sessionID(): SessionID;
  sessionDir?: string;
  useSqliteStore?: boolean;
  title?: string;
  attachments: AttachmentService;
}): SessionStoreController {
  let sessionStore: JsonSessionStore;
  let sqliteStore: SqliteSessionStore | undefined;
  let sqliteStorePath: string | undefined;
  let initialized = false;
  const messagePageCache = new Map<SessionID, RuntimeMessagePage>();
  const messagePagePromises = new Map<SessionID, Promise<void>>();
  const messagePageVersions = new Map<SessionID, number>();

  function invalidateMessagePage(id: SessionID) {
    messagePageVersions.set(id, (messagePageVersions.get(id) ?? 0) + 1);
    messagePageCache.delete(id);
    messagePagePromises.delete(id);
  }

  async function init() {
    // §1.6: the journal lives outside the workspace like the checkpoint
    // store does; an explicit sessionDir is the portable opt-in. The
    // resolvers read a legacy workspace-local journal until the startup
    // migration has moved it, and degrade to workspace-local when the home
    // is unwritable — same rules as every other store root.
    sessionStore = new JsonSessionStore(
      input.sessionDir ?? resolveWorkspaceJsonSessionsDir(input.workspaceRoot),
    );
    if (input.useSqliteStore) {
      const databasePath = resolveWorkspaceJournalDatabasePath(
        input.workspaceRoot,
      );
      await mkdir(dirname(databasePath), { recursive: true });
      sqliteStore = sqliteStores.get(databasePath);
      if (!sqliteStore) sqliteStore = new SqliteSessionStore(databasePath);
      retainSqliteStore(databasePath, sqliteStore);
      sqliteStorePath = databasePath;
      // Import leftover JSON sessions once, then delete the JSON files so a
      // later restart cannot resurrect sessions the user already deleted from
      // SQLite. Once SQLite already has sessions, a JSON id that is missing
      // there is treated as deleted rather than re-imported.
      const sqliteHasSessions = sqliteStore.list().length > 0;
      for (const legacy of await sessionStore.list()) {
        if (sqliteStore.wasDeleted(legacy.id)) {
          await sessionStore.delete(legacy.id);
          continue;
        }
        if (!sqliteStore.get(legacy.id)) {
          if (sqliteHasSessions) {
            sqliteStore.markDeleted(legacy.id);
            await sessionStore.delete(legacy.id);
            continue;
          }
          sqliteStore.replace(legacy);
        }
        await sessionStore.delete(legacy.id);
      }
      const startup =
        sqliteStore.get(input.sessionID()) ??
        sqliteStore.create(input.sessionID(), input.title ?? "New session");
      if (input.title && !startup.metadata.titleSource)
        sqliteStore.updateMetadata(input.sessionID(), {
          titleSource: "manual",
        });
      if (process.env.NATALIA_DISABLE_EVENT_COMPACTION !== "1") {
        for (const sessionID of sqliteStore.compactHistoricalEvents()) {
          invalidateMessagePage(sessionID);
        }
        sqliteStore.checkpoint();
      }
    }
    initialized = true;
  }

  function status() {
    return {
      initialized,
      mode: input.useSqliteStore ? ("sqlite" as const) : ("json" as const),
    };
  }

  function summary(record: SessionRecord): RuntimeSessionSummary {
    return {
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      lastAccessedAt: record.metadata?.lastAccessedAt,
      pinned: Boolean(record.metadata?.pinned),
      archived: Boolean(record.metadata?.archived),
      events: record.events.length,
      pendingInputs:
        record.inbox?.filter((input) => !input.promotedAt).length ?? 0,
      cancelled: record.cancelled,
      resumable: record.resumable,
      ...(typeof record.metadata?.activePlanID === "string"
        ? { activePlanID: record.metadata.activePlanID }
        : {}),
      ...(pendingHumanTerminalOf(record.metadata ?? {})
        ? {
            pendingHumanTerminal: pendingHumanTerminalOf(
              record.metadata ?? {},
            )!,
          }
        : {}),
    };
  }

  function sqliteSummary(
    record: SessionRow,
    store: SqliteSessionStore,
  ): RuntimeSessionSummary {
    return {
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      lastAccessedAt: record.metadata.lastAccessedAt as string | undefined,
      pinned: record.pinned,
      archived: Boolean(record.metadata.archived),
      events: store.eventCount(record.id),
      pendingInputs: 0,
      cancelled: record.cancelled,
      resumable: record.resumable,
      ...(typeof record.metadata.activePlanID === "string"
        ? { activePlanID: record.metadata.activePlanID }
        : {}),
      ...(pendingHumanTerminalOf(record.metadata)
        ? { pendingHumanTerminal: pendingHumanTerminalOf(record.metadata)! }
        : {}),
    };
  }

  async function byID(id: string) {
    const record = await sessionStore.load(id as SessionID);
    if (!record) throw new Error(`session not found: ${id}`);
    return record;
  }

  async function byIDOptional(id: string) {
    return await sessionStore.load(id as SessionID);
  }

  async function load(
    id: SessionID,
    options: {
      title?: string;
      create?: boolean;
      indexedRecovery?: boolean;
      /** Load only the events the live execution projection needs. */
      runtimeEvents?: boolean;
    } = {},
  ): Promise<{
    session: SessionRecord;
    contextEpoch?: StoredContextEpoch;
    recovery?: SessionStoreRecoveryView;
  }> {
    const loadStart = performance.now();
    const mark = (name: string) =>
      perfLog(
        `[perf] sessionStore.load.${name} id=${id} +${(performance.now() - loadStart).toFixed(1)}ms`,
      );
    perfLog(`[perf] sessionStore.load start id=${id}`);
    const store = sqliteStore;
    const legacy =
      options.create && !store
        ? await sessionStore.loadOrCreate(id, options.title ?? "New session")
        : await sessionStore.load(id);
    if (!store) {
      if (!legacy) throw new Error(`session not found: ${id}`);
      mark("jsonStore");
      return { session: legacy };
    }

    let durable = store.get(id);
    if (!durable && legacy) {
      store.replace(legacy);
      durable = store.get(id);
    }
    if (!durable) throw new Error(`session not found: ${id}`);
    mark("get");
    const contextEpoch = store.loadContextEpoch(id);
    mark("contextEpoch");
    const indexedRecovery = options.indexedRecovery && Boolean(contextEpoch);
    let events = indexedRecovery
      ? []
      : options.runtimeEvents
        ? store.loadRuntimeEvents(id, {
            excludeContextCheckpoint: Boolean(contextEpoch),
          })
        : store.loadEvents(id);
    mark("events");
    if (
      !events.length &&
      !indexedRecovery &&
      !options.runtimeEvents &&
      legacy?.events.length
    ) {
      store.replace(legacy);
      durable = store.get(id)!;
      events = store.loadEvents(id);
      mark("eventsReplace");
    }
    const inbox = store.loadInbox(id);
    mark("inbox");
    const recovery = indexedRecovery
      ? store.loadRecoveryProjection(id)
      : undefined;
    if (recovery) mark("recoveryProjection");
    return {
      session: {
        ...(legacy ?? createSessionRecord(id, options.title ?? "New session")),
        title: durable.title,
        createdAt: durable.createdAt,
        cancelled: durable.cancelled,
        resumable: durable.resumable,
        metadata: durable.metadata,
        events: events.length ? events : (legacy?.events ?? []),
        inbox: inbox.length ? inbox : legacy?.inbox,
      },
      contextEpoch,
      ...(recovery ? { recovery } : {}),
    };
  }

  async function saveInbox(session: SessionRecord) {
    if (sqliteStore) sqliteStore.replaceInbox(session.id, session.inbox ?? []);
    else await sessionStore.save(session);
  }

  /**
   * The durable inbox as it stands on disk — the claim authority. Two live
   * clients over one session (the product's attach switch, the
   * two-local-clients test) each carry their own in-memory record, so a
   * `promotedAt` marked only in one of them is invisible to the other:
   * both would claim, and the turn would run twice. The turn controller
   * consults this before its own claim.
   */
  async function loadInbox(id: SessionID): Promise<AdmittedSessionInput[]> {
    if (sqliteStore) return sqliteStore.loadInbox(id);
    // The JSON store has no inbox-only reader; its file holds the whole
    // (small) session, so the read is the same cost.
    const session = await sessionStore.load(id);
    return session?.inbox ?? [];
  }

  function loadRecoveryProjection(id: SessionID) {
    return sqliteStore?.loadRecoveryProjection(id);
  }

  async function appendEvent(session: SessionRecord, event: RuntimeEvent) {
    invalidateMessagePage(session.id);
    if (sqliteStore) {
      // Queue the event and let the SQLite store flush in batches (20ms or
      // 100 events). Awaiting a flush per event makes initialization spend
      // seconds writing hundreds of synthetic capability/tool events one by
      // one; batching is safe because the store still flushes before dispose
      // and on durable barriers.
      sqliteStore.enqueueEvent(session.id, event);
    } else await sessionStore.save(session);
  }

  async function appendEvents(session: SessionRecord, events: RuntimeEvent[]) {
    invalidateMessagePage(session.id);
    if (sqliteStore) sqliteStore.appendEvents(session.id, events);
    else await sessionStore.save(session);
  }

  async function updateMetadata(
    session: SessionRecord | SessionID,
    partial: Partial<SessionMetadata>,
  ) {
    const id = typeof session === "string" ? session : session.id;
    if (sqliteStore) sqliteStore.updateMetadata(id, partial);
    else await sessionStore.updateMetadata(id, partial);
  }

  function contextEventsAfter(id: SessionID, epoch?: StoredContextEpoch) {
    return epoch && sqliteStore
      ? sqliteStore.loadEventsAfter(id, epoch.baselineSeq)
      : undefined;
  }

  function eventsAfter(id: SessionID, after: number): RuntimeEvent[] {
    return sqliteStore ? sqliteStore.loadEventsAfter(id, after) : [];
  }

  function saveProjectionCheckpoint(
    id: SessionID,
    serializedState: string,
  ): number {
    if (!sqliteStore) return 0;
    const state = deserializeProjectionState(serializedState);
    if (!state) return 0;
    return sqliteStore.saveProjectionCheckpoint(id, state);
  }

  function loadProjectionCheckpoint(id: SessionID) {
    if (!sqliteStore) return undefined;
    const loaded = sqliteStore.loadProjectionCheckpoint(id);
    if (!loaded) return undefined;
    return {
      serializedState: serializeProjectionState(loaded.state),
      lastSeq: loaded.lastSeq,
    };
  }

  function writeContextEpoch(
    id: SessionID,
    snapshot: DurableContextCheckpointRecord,
  ) {
    if (sqliteStore) sqliteStore.writeContextEpoch(id, snapshot);
  }

  function ensureMessageIndex(id: SessionID) {
    if (sqliteStore) sqliteStore.ensureMessageIndex(id);
  }

  async function ensureMessageIndexAsync(id: SessionID) {
    if (!sqliteStore) return;
    if (sqliteStorePath) {
      try {
        await ensureMessageIndexInWorker(sqliteStorePath, id);
        return;
      } catch {
        // Fall through to the shared in-process store.
      }
    }
    sqliteStore.ensureMessageIndex(id);
  }

  function prewarmMessagePage(id: SessionID): Promise<void> {
    if (!sqliteStore) return Promise.resolve();
    const existing = messagePagePromises.get(id);
    if (existing) return existing;
    const version = messagePageVersions.get(id) ?? 0;
    const promise = (async () => {
      try {
        const page = sqliteStorePath
          ? await loadMessagePageInWorker(sqliteStorePath, id, {
              limit: 100,
              order: "desc",
            })
          : sqliteStore.loadMessagePage(id, { limit: 100, order: "desc" });
        // Only store the result if no rollback/append invalidated this
        // session while the background prewarm was in flight.
        if ((messagePageVersions.get(id) ?? 0) === version) {
          messagePageCache.set(id, page);
        }
      } catch {
        // Best-effort; the first real messages RPC can compute the page.
      }
    })().finally(() => {
      if ((messagePageVersions.get(id) ?? 0) === version) {
        messagePagePromises.delete(id);
      }
    });
    messagePagePromises.set(id, promise);
    return promise;
  }

  async function loadFullAsync(
    id: SessionID,
    loadOptions: { runtimeEvents?: boolean } = {},
  ): Promise<SessionRecord> {
    if (!sqliteStore) {
      const record = await sessionStore.load(id);
      if (!record) throw new Error(`session not found: ${id}`);
      return record;
    }
    const durable = sqliteStore.get(id);
    if (!durable) throw new Error(`session not found: ${id}`);
    let events: RuntimeEvent[];
    if (loadOptions.runtimeEvents) {
      events = await sqliteStore.loadRuntimeEventsAsync(id, {
        excludeContextCheckpoint: Boolean(sqliteStore.loadContextEpoch(id)),
      });
    } else if (sqliteStorePath) {
      try {
        events = await loadSessionEventsInWorker(sqliteStorePath, id);
      } catch {
        events = await sqliteStore.loadEventsAsync(id);
      }
    } else {
      events = await sqliteStore.loadEventsAsync(id);
    }
    const inbox = sqliteStore.loadInbox(id);
    return {
      id,
      title: durable.title,
      createdAt: durable.createdAt,
      cancelled: durable.cancelled,
      resumable: durable.resumable,
      metadata: durable.metadata,
      events,
      ...(inbox.length ? { inbox } : {}),
    };
  }

  async function referencedAttachments(): Promise<LocalAttachment[]> {
    return sqliteStore
      ? sqliteStore.referencedAttachments()
      : input.attachments.referencedForSessions(await sessionStore.list());
  }

  async function eventCount(id: SessionID): Promise<number> {
    if (sqliteStore) return sqliteStore.eventCount(id);
    const record = await sessionStore.load(id);
    return record?.events.length ?? 0;
  }

  async function history(
    id: SessionID,
    fallback: RuntimeEvent[],
    options: { after?: number; offset?: number; limit?: number } = {},
  ) {
    if (sqliteStore) return sqliteStore.loadEventPage(id, options);
    const record = await sessionStore.load(id);
    const source = record?.events ?? fallback;
    const after = Math.max(0, options.after ?? 0);
    const offset = Math.max(0, options.offset ?? 0);
    const start = options.offset === undefined ? after : offset;
    const limit = Math.min(2000, Math.max(1, options.limit ?? 100));
    const page = source.slice(start, start + limit + 1);
    return {
      events: page.slice(0, limit).map((event, index) => ({
        seq: start + index + 1,
        sessionSeq: start + index + 1,
        event,
      })),
      hasMore: page.length > limit,
    };
  }

  async function eventWindow(
    id: SessionID,
    fallback: RuntimeEvent[],
    options: { beforeSeq?: number; limit?: number } = {},
  ) {
    if (sqliteStore) return sqliteStore.loadEventWindow(id, options);
    const record = await sessionStore.load(id);
    const source = record?.events ?? fallback;
    const limit = Math.min(2000, Math.max(1, options.limit ?? 100));
    const end =
      options.beforeSeq === undefined
        ? source.length
        : Math.min(source.length, Math.max(0, options.beforeSeq - 1));
    const start = Math.max(0, end - limit);
    const events = source.slice(start, end).map((event, index) => ({
      seq: start + index + 1,
      sessionSeq: start + index + 1,
      event,
    }));
    return { events, hasMore: start > 0 };
  }

  async function messages(
    id: SessionID,
    fallback: SessionRecord,
    options: { limit?: number; order?: "asc" | "desc"; cursor?: string } = {},
  ): Promise<RuntimeMessagePage> {
    if (sqliteStore) {
      if (!options.cursor && !options.order && options.limit === 100) {
        const cached = messagePageCache.get(id);
        if (cached) return cached;
        const pending = messagePagePromises.get(id);
        if (pending) {
          await pending;
          const warmed = messagePageCache.get(id);
          if (warmed) return warmed;
        }
      }
      if (sqliteStorePath) {
        try {
          return await loadMessagePageInWorker(sqliteStorePath, id, options);
        } catch {
          // Fall back to the shared in-process store.
        }
      }
      return sqliteStore.loadMessagePage(id, options);
    }
    try {
      const { projectSessionMessagesInWorker } = await import(
        "./session-messages-worker-client"
      );
      return await projectSessionMessagesInWorker(fallback, options);
    } catch {
      return projectSessionMessages(fallback, options);
    }
  }

  async function flush(id?: SessionID) {
    await sqliteStore?.flushPendingWrites(id);
  }

  // --- session management surface ---

  async function list(): Promise<RuntimeSessionSummary[]> {
    const store = sqliteStore;
    if (store)
      return store.list().map((record) => ({
        id: record.id,
        title: record.title,
        createdAt: record.createdAt,
        lastAccessedAt: record.metadata.lastAccessedAt as string | undefined,
        pinned: record.pinned,
        events: store.eventCount(record.id),
        pendingInputs: store.pendingInputCount(record.id),
        cancelled: record.cancelled,
        resumable: record.resumable,
        archived: Boolean(record.metadata.archived),
        ...(typeof record.metadata.activePlanID === "string"
          ? { activePlanID: record.metadata.activePlanID }
          : {}),
        ...(pendingHumanTerminalOf(record.metadata)
          ? { pendingHumanTerminal: pendingHumanTerminalOf(record.metadata)! }
          : {}),
      }));
    return (await sessionStore.list()).map(summary);
  }

  async function touch(id: string) {
    const store = sqliteStore as SqliteSessionStore | undefined;
    if (store) {
      store.touch(id as SessionID);
      return;
    }
    await sessionStore.updateMetadata(id as SessionID, {
      lastAccessedAt: new Date().toISOString(),
    });
  }

  async function rename(id: string, title: string) {
    const store = sqliteStore as SqliteSessionStore | undefined;
    if (store)
      return sqliteSummary(store.rename(id as SessionID, title), store);
    const session = await sessionStore.rename(id as SessionID, title);
    return summary(session);
  }

  async function pin(id: string, pinned: boolean) {
    const store = sqliteStore as SqliteSessionStore | undefined;
    if (store) return sqliteSummary(store.pin(id as SessionID, pinned), store);
    const session = await sessionStore.updateMetadata(id as SessionID, {
      pinned,
    });
    return summary(session);
  }

  async function duplicate(id: string, title?: string) {
    const store = sqliteStore as SqliteSessionStore | undefined;
    if (store)
      return summary(store.duplicate(id as SessionID, undefined, title));
    const session = await sessionStore.duplicate(
      id as SessionID,
      undefined,
      title,
    );
    return summary(session);
  }

  async function fork(id: string, turnID: string, title?: string) {
    const store = sqliteStore as SqliteSessionStore | undefined;
    if (store)
      return summary(store.fork(id as SessionID, turnID, undefined, title));
    const session = await sessionStore.fork(
      id as SessionID,
      turnID,
      undefined,
      title,
    );
    return summary(session);
  }

  async function del(id: string) {
    if (id === input.sessionID())
      throw new Error("cannot delete the active runtime session");
    const store = sqliteStore as SqliteSessionStore | undefined;
    if (store) {
      const durable = store.get(id as SessionID);
      const legacy = await sessionStore.load(id as SessionID);
      if (!durable && !legacy) throw new Error(`session not found: ${id}`);
      if (durable) store.delete(id as SessionID);
      await sessionStore.delete(id as SessionID);
      const removedAttachments = await input.attachments.cleanup(
        durable
          ? store.referencedAttachments()
          : input.attachments.referencedForSessions(await sessionStore.list()),
      );
      return { id, removedAttachments: removedAttachments.length };
    }
    await byID(id);
    await sessionStore.delete(id as SessionID);
    const removedAttachments = await input.attachments.cleanup(
      input.attachments.referencedForSessions(await sessionStore.list()),
    );
    return { id, removedAttachments: removedAttachments.length };
  }

  async function messageRollback(id: string, turnID: string) {
    const sessionID = id as SessionID;
    // The cached latest-100 message page is now stale after truncation.
    invalidateMessagePage(sessionID);
    const store = sqliteStore as SqliteSessionStore | undefined;
    if (store) {
      const startSeq = store.seqForTurnStart(id as SessionID, turnID);
      if (startSeq === undefined) throw new Error(`turn not found: ${turnID}`);
      // Removing this turn and everything after it. The new user submission
      // becomes the new version of the selected turn.
      store.truncateAfter(id as SessionID, startSeq - 1);
      return { id, rolledBackTo: turnID };
    }
    const record = await byID(id);
    const start = record.events.findIndex(
      (event) => event.type === "turn.submitted" && event.id === turnID,
    );
    if (start < 0) throw new Error(`turn not found: ${turnID}`);
    // Keep only events before the selected turn.
    record.events = record.events.slice(0, start);
    await sessionStore.save(record);
    return { id, rolledBackTo: turnID };
  }

  async function create(input_: { id?: string; title?: string }) {
    const id =
      input_.id ?? `ses_${randomUUID().replace(/-/gu, "").slice(0, 16)}`;
    const store = sqliteStore as SqliteSessionStore | undefined;
    if (store?.get(id as SessionID)) return { sessionID: id, created: false };
    if (input_.id && (await byIDOptional(id)))
      return { sessionID: id, created: false };
    const record = createSessionRecord(
      id as SessionID,
      input_.title ?? "New session",
    );
    record.metadata = { titleSource: input_.title ? "manual" : "fallback" };
    if (store) {
      store.create(record.id, record.title);
      store.updateMetadata(record.id, record.metadata);
      return { sessionID: id, created: true };
    }
    await sessionStore.save(record);
    return { sessionID: id, created: true };
  }

  async function setAutoTitle(
    id: string,
    title: string,
    source: "generated" | "fallback",
  ) {
    const store = sqliteStore as SqliteSessionStore | undefined;
    if (store)
      return sqliteSummary(
        store.setAutoTitle(id as SessionID, title, source),
        store,
      );
    return summary(
      await sessionStore.setAutoTitle(id as SessionID, title, source),
    );
  }

  async function archive(id: string) {
    const record = (await load(id as SessionID)).session;
    if (record.metadata?.archived) return { id, archived: true };
    record.metadata = { ...record.metadata, archived: true };
    await updateMetadata(record, { archived: true });
    return { id, archived: true };
  }

  async function restore(id: string) {
    const record = (await load(id as SessionID)).session;
    if (!record.metadata?.archived) return { id, archived: false };
    record.metadata = { ...record.metadata, archived: false };
    await updateMetadata(record, { archived: false });
    return { id, archived: false };
  }

  async function export_(id: string): Promise<{
    sessionID: string;
    title: string;
    createdAt: string;
    archived: boolean;
    events: Array<{ seq: number; event: RuntimeEvent }>;
  }> {
    const record = (await load(id as SessionID)).session;
    return {
      sessionID: record.id,
      title: record.title,
      createdAt: record.createdAt,
      archived: Boolean(record.metadata?.archived),
      events: record.events.map((event, index) => ({
        seq: index + 1,
        event,
      })),
    };
  }

  async function close() {
    if (sqliteStorePath) releaseSqliteStore(sqliteStorePath);
    sqliteStore = undefined;
    sqliteStorePath = undefined;
    initialized = false;
  }

  return {
    init,
    status,
    load,
    saveInbox,
    loadInbox,
    loadRecoveryProjection,
    appendEvent,
    appendEvents,
    updateMetadata,
    contextEventsAfter,
    eventsAfter,
    saveProjectionCheckpoint,
    loadProjectionCheckpoint,
    writeContextEpoch,
    ensureMessageIndex,
    ensureMessageIndexAsync,
    prewarmMessagePage,
    loadFullAsync,
    referencedAttachments,
    eventCount,
    history,
    eventWindow,
    messages,
    flush,
    list,
    touch,
    rename,
    pin,
    duplicate,
    fork,
    delete: del,
    create,
    messageRollback,
    setAutoTitle,
    archive,
    restore,
    export: export_,
    close,
  };
}
