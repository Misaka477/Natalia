import { Database } from "bun:sqlite";
import type {
  DurableContextCheckpointRecord,
  RuntimeEvent,
  RuntimeMessagePage,
  SessionID,
} from "@anthelia/contracts";
import type { SessionRecord } from "./index";
import { normalizeDelivery, type AdmittedSessionInput } from "./inbox";
import {
  decodeMessageCursor,
  deserializeProjectionState,
  encodeMessageCursor,
  initProjection,
  applyProjection,
  PROJECTION_STATE_VERSION,
  projectSessionMessages,
  projectTurnMessages,
  serializeProjectionState,
  type ProjectionState,
} from "./projector";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0,
  resumable INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  event TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);

CREATE TABLE IF NOT EXISTS message_turns (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT NOT NULL,
  start_seq INTEGER NOT NULL,
  PRIMARY KEY(session_id, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_message_turns_session_seq
  ON message_turns(session_id, start_seq);

CREATE TABLE IF NOT EXISTS message_index_state (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  last_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session_inputs (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  id TEXT NOT NULL,
  text TEXT NOT NULL,
  attachments TEXT,
  resources TEXT,
  agents TEXT,
  delivery TEXT NOT NULL,
  admitted_at TEXT NOT NULL,
  admitted_seq INTEGER NOT NULL,
  promoted_at TEXT,
  promoted_seq INTEGER,
  PRIMARY KEY(session_id, id)
);

CREATE INDEX IF NOT EXISTS idx_session_inputs_pending
  ON session_inputs(session_id, promoted_at, admitted_seq);

CREATE TABLE IF NOT EXISTS recovery_turns (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT NOT NULL,
  active INTEGER NOT NULL,
  PRIMARY KEY(session_id, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_recovery_turns_active
  ON recovery_turns(session_id, active);

CREATE TABLE IF NOT EXISTS recovery_interactive (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY(session_id, request_id)
);

CREATE TABLE IF NOT EXISTS recovery_selection (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  agent_name TEXT,
  model_id TEXT,
  model_variant TEXT,
  reasoning_effort TEXT,
  chat_model_profile TEXT,
  permission_mode TEXT,
  permission_profile TEXT
);

CREATE TABLE IF NOT EXISTS recovery_attachments (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT NOT NULL,
  attachments TEXT NOT NULL,
  PRIMARY KEY(session_id, turn_id)
);

CREATE TABLE IF NOT EXISTS recovery_diagnostics (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recovery_diagnostics_session_seq
  ON recovery_diagnostics(session_id, seq);

CREATE TABLE IF NOT EXISTS recovery_state (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  indexed_events INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS context_epochs (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  baseline_seq INTEGER NOT NULL,
  snapshot TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projection_checkpoints (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  state_version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  state TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deleted_sessions (
  id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
);
`;

function isDurableFlushBarrier(event: RuntimeEvent) {
  return (
    event.type === "approval.response" ||
    event.type === "question.response" ||
    event.type === "turn.finished" ||
    event.type === "turn.cancelled" ||
    event.type === "context.checkpoint" ||
    event.type === "session.created" ||
    event.type === "session.ready"
  );
}

export type SessionRow = {
  id: SessionID;
  title: string;
  createdAt: string;
  cancelled: boolean;
  resumable: boolean;
  pinned: boolean;
  metadata: Record<string, unknown>;
};

export type StoredSessionEvent = { seq: number; event: RuntimeEvent };
export type StoredContextEpoch = {
  baselineSeq: number;
  snapshot: DurableContextCheckpointRecord;
};
export type StoredRecoveryProjection = {
  activeTurnIDs: string[];
  approvals: Array<Extract<RuntimeEvent, { type: "approval.request" }>>;
  questions: Array<Extract<RuntimeEvent, { type: "question.request" }>>;
  interactives: Array<Extract<RuntimeEvent, { type: "interactive.request" }>>;
  selectedAgent?: string;
  selectedModel?: { modelID?: string; variant?: string };
  reasoningEffort?: import("@anthelia/contracts").RuntimeReasoningEffort;
  chatModelProfile?: Record<
    string,
    import("@anthelia/contracts").ChatModelProfile
  >;
  permissionMode?: "ask" | "auto" | "read_only";
  permissionProfile?: string;
  attachments: Map<string, import("@anthelia/contracts").LocalAttachment[]>;
  diagnostics: Array<Extract<RuntimeEvent, { type: "diagnostic" }>>;
};

export class SqliteSessionStore {
  private db: Database;
  private writeQueue = Promise.resolve();
  private readonly pendingAsyncEvents = new Map<SessionID, RuntimeEvent[]>();
  private readonly pendingFlushes = new Map<SessionID, Promise<void>>();
  private readonly scheduledFlushes = new Set<SessionID>();
  private readonly flushTimers = new Map<
    SessionID,
    ReturnType<typeof setTimeout>
  >();
  private closed = false;
  private insertEventStatement: ReturnType<Database["prepare"]>;
  /**
   * Live per-session projection fold, advanced on every append and persisted as
   * a checkpoint on durable flush barriers. Cleared on rollback/delete/close so
   * a stale fold is never replayed.
   */
  private readonly projectionStates = new Map<SessionID, ProjectionState>();

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec(SCHEMA);
    this.ensureNewRecoveryColumns();
    this.insertEventStatement = this.db.prepare(
      `INSERT INTO events(session_id, event) VALUES (?, ?)`,
    );
  }

  private ensureNewRecoveryColumns() {
    const columns = new Set(
      (
        this.db.query(`PRAGMA table_info(recovery_selection)`).all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    const additions: Array<[string, string]> = [
      ["reasoning_effort", "TEXT"],
      ["chat_model_profile", "TEXT"],
      ["permission_mode", "TEXT"],
      ["permission_profile", "TEXT"],
    ];
    for (const [name, type] of additions)
      if (!columns.has(name))
        this.db.exec(
          `ALTER TABLE recovery_selection ADD COLUMN ${name} ${type}`,
        );
  }

  close() {
    if (this.closed) return;
    // close() is synchronous by contract, so drain buffered async appends
    // before SQLite closes its WAL handle.
    for (const [sessionID, events] of this.pendingAsyncEvents) {
      if (events.length) this.writeBufferedBatch(sessionID, events.splice(0));
    }
    this.pendingAsyncEvents.clear();
    this.scheduledFlushes.clear();
    for (const timer of this.flushTimers.values()) clearTimeout(timer);
    this.flushTimers.clear();
    this.projectionStates.clear();
    this.checkpoint();
    this.closed = true;
    // `db.close()` calls sqlite3_close_v2, which only *defers* deallocation
    // when a prepared statement is still alive: the connection becomes a
    // zombie and keeps its OS handles on the db, -wal, and -shm files. This
    // statement is owned here and never finalized elsewhere, so releasing it
    // first is what makes the close actually release those handles. POSIX
    // hides the difference because an open file can be unlinked; Windows
    // refuses to delete the database until the handles are gone.
    this.insertEventStatement.finalize();
    this.db.close();
  }

  /** Runs passive WAL maintenance without forcing active readers to stop. */
  checkpoint() {
    const row = this.db.query(`PRAGMA wal_checkpoint(PASSIVE)`).get() as
      | Record<string, number>
      | undefined;
    return {
      busy: row?.busy ?? 0,
      logPages: row?.log ?? 0,
      checkpointedPages: row?.checkpointed ?? 0,
    };
  }

  create(id: SessionID, title: string, now = new Date()): SessionRow {
    this.clearDeleted(id);
    this.run(
      `INSERT OR IGNORE INTO sessions(id, title, created_at) VALUES (?, ?, ?)`,
      [id, title, now.toISOString()],
    );
    return this.get(id)!;
  }

  get(id: SessionID): SessionRow | undefined {
    const row = this.db
      .query(
        `SELECT id, title, created_at, cancelled, resumable, pinned, metadata FROM sessions WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return rowToSession(row);
  }

  loadOrCreate(id: SessionID, title: string): SessionRow {
    return this.get(id) ?? this.create(id, title);
  }

  list(): SessionRow[] {
    const rows = this.db
      .query(
        `SELECT id, title, created_at, cancelled, resumable, pinned, metadata
         FROM sessions
         ORDER BY pinned DESC, json_extract(metadata, '$.lastAccessedAt') DESC, created_at DESC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(rowToSession);
  }

  rename(id: SessionID, title: string) {
    const trimmed = title.trim();
    if (!trimmed) throw new Error("session title cannot be empty");
    if (!this.get(id)) throw new Error(`session not found: ${id}`);
    this.run(
      `UPDATE sessions
       SET title = ?,
           metadata = json_set(COALESCE(metadata, '{}'), '$.titleSource', 'manual')
       WHERE id = ?`,
      [trimmed, id],
    );
    return this.get(id)!;
  }

  setAutoTitle(id: SessionID, title: string, source: "generated" | "fallback") {
    if (!this.get(id)) throw new Error(`session not found: ${id}`);
    this.run(
      `UPDATE sessions
       SET title = ?,
           metadata = json_set(COALESCE(metadata, '{}'), '$.titleSource', ?)
       WHERE id = ?
         AND COALESCE(json_extract(metadata, '$.titleSource'), '') <> 'manual'`,
      [title, source, id],
    );
    return this.get(id)!;
  }

  touch(id: SessionID, at = new Date().toISOString()) {
    this.updateMetadata(id, { lastAccessedAt: at });
    return this.get(id)!;
  }

  pin(id: SessionID, pinned: boolean) {
    this.updateMetadata(id, { pinned });
    return this.get(id)!;
  }

  duplicate(id: SessionID, newID?: SessionID, newTitle?: string) {
    const source = this.loadRecord(id);
    if (!source) throw new Error(`session not found: ${id}`);
    const targetID =
      newID ??
      (`ses_${crypto.randomUUID().replace(/-/gu, "").slice(0, 16)}` as SessionID);
    const copy: SessionRecord = {
      ...source,
      id: targetID,
      title: newTitle ?? `${source.title} (copy)`,
      metadata: {
        ...source.metadata,
        lastAccessedAt: new Date().toISOString(),
      },
      inbox: source.inbox?.map((input) => ({ ...input, sessionID: targetID })),
    };
    this.replace(copy);
    return copy;
  }

  fork(id: SessionID, turnID: string, newID?: SessionID, newTitle?: string) {
    const source = this.loadRecord(id);
    if (!source) throw new Error(`session not found: ${id}`);
    const boundary = source.events.findIndex(
      (event) => event.type === "turn.submitted" && event.id === turnID,
    );
    if (boundary < 0) throw new Error(`turn not found: ${turnID}`);
    const targetID =
      newID ??
      (`ses_${crypto.randomUUID().replace(/-/gu, "").slice(0, 16)}` as SessionID);
    const includedTurns = new Set(
      source.events
        .slice(0, boundary)
        .flatMap((event) =>
          event.type === "turn.submitted" ? [event.id] : [],
        ),
    );
    const fork: SessionRecord = {
      ...source,
      id: targetID,
      title: newTitle ?? `${source.title} (fork)`,
      events: structuredClone(source.events.slice(0, boundary)),
      metadata: {
        ...source.metadata,
        lastAccessedAt: new Date().toISOString(),
      },
      inbox: source.inbox
        ?.filter((input) => includedTurns.has(input.id))
        .map((input) => ({ ...input, sessionID: targetID })),
    };
    this.replace(fork);
    return fork;
  }

  seqForTurnStart(sessionID: SessionID, turnID: string): number | undefined {
    const row = this.db
      .query(
        `SELECT start_seq FROM message_turns WHERE session_id = ? AND turn_id = ? LIMIT 1`,
      )
      .get(sessionID, turnID) as { start_seq: number } | undefined;
    return row?.start_seq;
  }

  seqForTurnEnd(sessionID: SessionID, turnID: string): number {
    const start = this.db
      .query(
        `SELECT seq FROM events
         WHERE session_id = ? AND json_extract(event, '$.type') = 'turn.submitted'
           AND json_extract(event, '$.id') = ?
         ORDER BY seq LIMIT 1`,
      )
      .get(sessionID, turnID) as { seq: number } | undefined;
    if (!start) throw new Error(`turn not found: ${turnID}`);
    const next = this.db
      .query(
        `SELECT seq FROM events
         WHERE session_id = ? AND seq > ? AND json_extract(event, '$.type') = 'turn.submitted'
         ORDER BY seq LIMIT 1`,
      )
      .get(sessionID, start.seq) as { seq: number } | undefined;
    if (next) return next.seq - 1;
    const max = this.db
      .query(
        `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events WHERE session_id = ?`,
      )
      .get(sessionID) as { max_seq: number };
    return max.max_seq;
  }

  truncateAfter(sessionID: SessionID, afterSeq: number) {
    this.db.transaction(() => {
      this.run(`DELETE FROM events WHERE session_id = ? AND seq > ?`, [
        sessionID,
        afterSeq,
      ]);
      this.run(
        `DELETE FROM message_turns WHERE session_id = ? AND start_seq > ?`,
        [sessionID, afterSeq],
      );
      this.run(`DELETE FROM message_index_state WHERE session_id = ?`, [
        sessionID,
      ]);
      this.run(
        `DELETE FROM context_epochs WHERE session_id = ? AND baseline_seq > ?`,
        [sessionID, afterSeq],
      );
      this.run(`DELETE FROM recovery_turns WHERE session_id = ?`, [sessionID]);
      this.run(
        `INSERT INTO recovery_state(session_id, indexed_events) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET indexed_events = excluded.indexed_events`,
        [sessionID, afterSeq],
      );
      // A rollback rewrites the durable log; drop the live fold and the
      // checkpoint so the next append re-folds and no stale cache is replayed.
      this.projectionStates.delete(sessionID);
      this.run(`DELETE FROM projection_checkpoints WHERE session_id = ?`, [
        sessionID,
      ]);
    })();
  }

  delete(id: SessionID) {
    this.db.transaction(() => {
      this.deleteRecoveryProjection(id);
      this.run(`DELETE FROM context_epochs WHERE session_id = ?`, [id]);
      this.run(`DELETE FROM message_turns WHERE session_id = ?`, [id]);
      this.run(`DELETE FROM message_index_state WHERE session_id = ?`, [id]);
      this.run(`DELETE FROM session_inputs WHERE session_id = ?`, [id]);
      this.run(`DELETE FROM events WHERE session_id = ?`, [id]);
      this.run(`DELETE FROM projection_checkpoints WHERE session_id = ?`, [id]);
      this.run(`DELETE FROM sessions WHERE id = ?`, [id]);
      this.markDeleted(id);
    })();
    this.projectionStates.delete(id);
  }

  wasDeleted(id: SessionID): boolean {
    const row = this.db
      .query(`SELECT 1 AS present FROM deleted_sessions WHERE id = ?`)
      .get(id) as { present?: number } | undefined;
    return Boolean(row);
  }

  markDeleted(id: SessionID, now = new Date()) {
    this.run(
      `INSERT INTO deleted_sessions(id, deleted_at) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at`,
      [id, now.toISOString()],
    );
  }

  clearDeleted(id: SessionID) {
    this.run(`DELETE FROM deleted_sessions WHERE id = ?`, [id]);
  }

  updateMetadata(id: SessionID, partial: Partial<SessionRow["metadata"]>) {
    const session = this.get(id);
    if (!session) throw new Error(`session not found: ${id}`);
    const next = { ...session.metadata, ...partial };
    this.run(`UPDATE sessions SET metadata = ?, pinned = ? WHERE id = ?`, [
      JSON.stringify(next),
      next.pinned === true ? 1 : 0,
      id,
    ]);
  }

  replace(session: SessionRecord) {
    const write = this.db.transaction(() => {
      this.clearDeleted(session.id);
      this.run(`DELETE FROM context_epochs WHERE session_id = ?`, [session.id]);
      this.run(`DELETE FROM message_turns WHERE session_id = ?`, [session.id]);
      this.run(`DELETE FROM message_index_state WHERE session_id = ?`, [
        session.id,
      ]);
      this.run(`DELETE FROM session_inputs WHERE session_id = ?`, [session.id]);
      this.deleteRecoveryProjection(session.id);
      this.run(`DELETE FROM events WHERE session_id = ?`, [session.id]);
      this.run(`DELETE FROM sessions WHERE id = ?`, [session.id]);
      this.run(
        `INSERT INTO sessions(id, title, created_at, cancelled, resumable, pinned, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          session.id,
          session.title,
          session.createdAt,
          session.cancelled ? 1 : 0,
          session.resumable ? 1 : 0,
          session.metadata?.pinned === true ? 1 : 0,
          JSON.stringify(session.metadata ?? {}),
        ],
      );
      for (const event of session.events) this.appendEvent(session.id, event);
      this.replaceInbox(session.id, session.inbox ?? []);
    });
    write();
  }

  appendEvent(sessionID: SessionID, event: RuntimeEvent) {
    this.db.transaction(() => {
      this.appendEventInTransaction(sessionID, event);
      this.bumpRecoveryState(sessionID);
    })();
  }

  appendEvents(sessionID: SessionID, events: RuntimeEvent[]) {
    const txn = this.db.transaction(() => {
      // This synchronous recovery-settlement helper deliberately retains its
      // established narrow semantics. New streaming batches use the complete
      // writeBufferedBatch path below. It still advances the session
      // projection: a settled `turn.finished` written here is a real turn, and
      // the usage accumulator must see it or the totals a later attach
      // publishes would miss the interrupted turns.
      for (const event of events) {
        this.insertEvent(sessionID, event);
        this.applyRecoveryEvent(sessionID, event);
        applyProjection(this.projectionStateFor(sessionID), event);
      }
      this.bumpRecoveryState(sessionID, events.length);
      this.persistProjectionCheckpoint(sessionID);
    });
    txn();
  }

  /**
   * Removes historical event payloads that are live-only or already covered by
   * the context epoch table. This is an idempotent storage-size migration:
   * every removed event is either reconstructible (`session.snapshot`,
   * `rollback.previewed`) or superseded by `context_epochs`
   * (`context.checkpoint`). It does not touch task/control events used by
   * recovery, transcript paging, or work-graph projections.
   */
  compactHistoricalEvents(): SessionID[] {
    // The goal fast-restore cache retired WITH the projection's goal
    // fold: the journal is the source of truth and the fold now lives
    // policy-side, so the table is obsolete — dropped here, in the same
    // idempotent storage-maintenance pass.
    this.db.run(`DROP TABLE IF EXISTS recovery_goal`);
    const affected = new Set<SessionID>();
    const live = this.db
      .query(
        `SELECT DISTINCT session_id FROM events
         WHERE json_extract(event, '$.type') IN ('session.snapshot','rollback.previewed')`,
      )
      .all() as Array<{ session_id: SessionID }>;
    for (const row of live) affected.add(row.session_id);

    const checkpoints = this.db
      .query(
        `SELECT session_id, MAX(seq) AS max_seq
         FROM events
         WHERE json_extract(event, '$.type') = 'context.checkpoint'
         GROUP BY session_id`,
      )
      .all() as Array<{ session_id: SessionID; max_seq: number }>;
    const epochs = new Map<SessionID, number>();
    for (const row of this.db
      .query(`SELECT session_id, baseline_seq FROM context_epochs`)
      .all() as Array<{ session_id: SessionID; baseline_seq: number }>)
      epochs.set(row.session_id, row.baseline_seq);
    for (const row of checkpoints)
      if (epochs.has(row.session_id)) affected.add(row.session_id);

    if (affected.size === 0) return [];
    console.warn("[session-store] compacting live-only historical events", {
      sessions: affected.size,
    });

    this.db.transaction(() => {
      this.run(
        `DELETE FROM events
         WHERE json_extract(event, '$.type') IN ('session.snapshot','rollback.previewed')`,
      );
      for (const row of checkpoints) {
        const baseline = epochs.get(row.session_id);
        if (baseline !== undefined) {
          this.run(
            `DELETE FROM events
             WHERE session_id = ?
               AND json_extract(event, '$.type') = 'context.checkpoint'
               AND seq <= ?`,
            [row.session_id, baseline],
          );
        } else {
          this.run(
            `DELETE FROM events
             WHERE session_id = ?
               AND json_extract(event, '$.type') = 'context.checkpoint'
               AND seq <> ?`,
            [row.session_id, row.max_seq],
          );
        }
      }
      for (const sessionID of affected) {
        this.run(`DELETE FROM recovery_state WHERE session_id = ?`, [
          sessionID,
        ]);
        this.run(`DELETE FROM message_index_state WHERE session_id = ?`, [
          sessionID,
        ]);
      }
    })();

    return [...affected];
  }

  loadEvents(sessionID: SessionID): RuntimeEvent[] {
    const rows = this.db
      .query(`SELECT event FROM events WHERE session_id = ? ORDER BY seq`)
      .all(sessionID) as { event: string }[];
    return rows.map((r) => JSON.parse(r.event) as RuntimeEvent);
  }

  /**
   * Loads only events that the live execution projection still needs. The
   * heavy live-only payloads (`session.snapshot`, `rollback.previewed`) and,
   * when a SQLite context epoch exists, `context.checkpoint` are filtered in
   * SQLite before JSON parsing, so a 60MB historical journal does not become a
   * 250MB JS object graph merely to attach the session.
   */
  private runtimeEventExclusion(options: {
    excludeContextCheckpoint?: boolean;
  }) {
    return [
      "session.snapshot",
      "rollback.previewed",
      ...(options.excludeContextCheckpoint ? ["context.checkpoint"] : []),
    ];
  }

  loadRuntimeEvents(
    sessionID: SessionID,
    options: { excludeContextCheckpoint?: boolean } = {},
  ): RuntimeEvent[] {
    const excluded = this.runtimeEventExclusion(options);
    const placeholders = excluded.map(() => "?").join(", ");
    const rows = this.db
      .query(
        `SELECT event FROM events
         WHERE session_id = ?
           AND json_extract(event, '$.type') NOT IN (${placeholders})
         ORDER BY seq`,
      )
      .all(sessionID, ...excluded) as { event: string }[];
    return rows.map((row) => JSON.parse(row.event) as RuntimeEvent);
  }

  async loadRuntimeEventsAsync(
    sessionID: SessionID,
    options: { excludeContextCheckpoint?: boolean } = {},
  ): Promise<RuntimeEvent[]> {
    const excluded = this.runtimeEventExclusion(options);
    const placeholders = excluded.map(() => "?").join(", ");
    const events: RuntimeEvent[] = [];
    let afterSeq = 0;
    const batchSize = 500;
    while (true) {
      const rows = this.db
        .query(
          `SELECT seq, event FROM events
           WHERE session_id = ?
             AND seq > ?
             AND json_extract(event, '$.type') NOT IN (${placeholders})
           ORDER BY seq
           LIMIT ?`,
        )
        .all(sessionID, afterSeq, ...excluded, batchSize) as Array<{
        seq: number;
        event: string;
      }>;
      if (rows.length === 0) break;
      for (const row of rows)
        events.push(JSON.parse(row.event) as RuntimeEvent);
      afterSeq = rows[rows.length - 1]!.seq;
      if (rows.length < batchSize) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return events;
  }

  async loadEventsAsync(sessionID: SessionID): Promise<RuntimeEvent[]> {
    const events: RuntimeEvent[] = [];
    let afterSeq = 0;
    const batchSize = 500;
    while (true) {
      const rows = this.db
        .query(
          `SELECT seq, event FROM events
           WHERE session_id = ? AND seq > ?
           ORDER BY seq
           LIMIT ?`,
        )
        .all(sessionID, afterSeq, batchSize) as Array<{
        seq: number;
        event: string;
      }>;
      if (rows.length === 0) break;
      for (const row of rows)
        events.push(JSON.parse(row.event) as RuntimeEvent);
      afterSeq = rows[rows.length - 1]!.seq;
      if (rows.length < batchSize) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return events;
  }

  async loadEventsAfterAsync(
    sessionID: SessionID,
    after: number,
  ): Promise<RuntimeEvent[]> {
    const rows = this.db
      .query(
        `SELECT event FROM events WHERE session_id = ? AND seq > ? ORDER BY seq`,
      )
      .all(sessionID, after) as { event: string }[];
    const events: RuntimeEvent[] = [];
    for (let index = 0; index < rows.length; index++) {
      events.push(JSON.parse(rows[index]!.event) as RuntimeEvent);
      if (index % 100 === 99)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return events;
  }

  loadRecoveryProjection(sessionID: SessionID): StoredRecoveryProjection {
    this.ensureRecoveryProjection(sessionID);
    const active = this.db
      .query(
        `SELECT turn_id FROM recovery_turns WHERE session_id = ? AND active = 1`,
      )
      .all(sessionID) as Array<{ turn_id: string }>;
    const interactive = this.db
      .query(
        `SELECT kind, event FROM recovery_interactive WHERE session_id = ?`,
      )
      .all(sessionID) as Array<{ kind: string; event: string }>;
    const selection = this.db
      .query(
        `SELECT agent_name, model_id, model_variant, reasoning_effort, chat_model_profile, permission_mode, permission_profile FROM recovery_selection WHERE session_id = ?`,
      )
      .get(sessionID) as
      | {
          agent_name?: string;
          model_id?: string;
          model_variant?: string;
          reasoning_effort?: string;
          chat_model_profile?: string;
          permission_mode?: string;
          permission_profile?: string;
        }
      | undefined;
    const attachments = new Map<
      string,
      import("@anthelia/contracts").LocalAttachment[]
    >();
    const attachmentRows = this.db
      .query(
        `SELECT turn_id, attachments FROM recovery_attachments WHERE session_id = ?`,
      )
      .all(sessionID) as Array<{ turn_id: string; attachments: string }>;
    for (const row of attachmentRows)
      attachments.set(
        row.turn_id,
        JSON.parse(
          row.attachments,
        ) as import("@anthelia/contracts").LocalAttachment[],
      );
    const diagnostics = this.db
      .query(
        `SELECT event FROM recovery_diagnostics WHERE session_id = ? ORDER BY seq`,
      )
      .all(sessionID) as Array<{ event: string }>;
    return {
      activeTurnIDs: active.map((row) => row.turn_id),
      approvals: interactive
        .filter((row) => row.kind === "approval")
        .map(
          (row) =>
            JSON.parse(row.event) as Extract<
              RuntimeEvent,
              { type: "approval.request" }
            >,
        ),
      questions: interactive
        .filter((row) => row.kind === "question")
        .map(
          (row) =>
            JSON.parse(row.event) as Extract<
              RuntimeEvent,
              { type: "question.request" }
            >,
        ),
      interactives: interactive
        .filter((row) => row.kind.startsWith("interactive:"))
        .map(
          (row) =>
            JSON.parse(row.event) as Extract<
              RuntimeEvent,
              { type: "interactive.request" }
            >,
        ),
      selectedAgent: selection?.agent_name,
      selectedModel:
        selection?.model_id || selection?.model_variant
          ? { modelID: selection.model_id, variant: selection.model_variant }
          : undefined,
      reasoningEffort:
        (selection?.reasoning_effort as
          | import("@anthelia/contracts").RuntimeReasoningEffort
          | undefined) ?? undefined,
      chatModelProfile: selection?.chat_model_profile
        ? (JSON.parse(selection.chat_model_profile) as Record<
            string,
            import("@anthelia/contracts").ChatModelProfile
          >)
        : undefined,
      permissionMode:
        (selection?.permission_mode as
          | "ask"
          | "auto"
          | "read_only"
          | undefined) ?? undefined,
      permissionProfile: selection?.permission_profile ?? undefined,
      attachments,
      diagnostics: diagnostics.map(
        (row) =>
          JSON.parse(row.event) as Extract<
            RuntimeEvent,
            { type: "diagnostic" }
          >,
      ),
    };
  }

  loadRecord(id: SessionID): SessionRecord | undefined {
    const row = this.get(id);
    if (!row) return undefined;
    return {
      id: row.id,
      title: row.title,
      createdAt: row.createdAt,
      cancelled: row.cancelled,
      resumable: row.resumable,
      metadata: row.metadata,
      events: this.loadEvents(id),
      inbox: this.loadInbox(id),
    };
  }

  loadInbox(sessionID: SessionID): AdmittedSessionInput[] {
    const rows = this.db
      .query(
        `SELECT id, text, attachments, resources, agents, delivery, admitted_at, admitted_seq, promoted_at, promoted_seq
         FROM session_inputs WHERE session_id = ? ORDER BY admitted_seq`,
      )
      .all(sessionID) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      sessionID,
      text: row.text as string,
      attachments: parseOptionalJSON(row.attachments),
      resources: parseOptionalJSON(row.resources),
      agents: parseOptionalJSON(row.agents),
      delivery: normalizeDelivery(row.delivery),
      admittedAt: row.admitted_at as string,
      admittedSeq: row.admitted_seq as number,
      promotedAt: (row.promoted_at as string | null) ?? undefined,
      promotedSeq: (row.promoted_seq as number | null) ?? undefined,
    }));
  }

  replaceInbox(sessionID: SessionID, inputs: AdmittedSessionInput[]) {
    const insert = this.db.prepare(
      `INSERT INTO session_inputs(session_id, id, text, attachments, resources, agents, delivery, admitted_at, admitted_seq, promoted_at, promoted_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      this.db.transaction(() => {
        this.run(`DELETE FROM session_inputs WHERE session_id = ?`, [
          sessionID,
        ]);
        for (const input of inputs)
          insert.run(
            sessionID,
            input.id,
            input.text,
            optionalJSON(input.attachments),
            optionalJSON(input.resources),
            optionalJSON(input.agents),
            input.delivery,
            input.admittedAt,
            input.admittedSeq,
            input.promotedAt ?? null,
            input.promotedSeq ?? null,
          );
      })();
    } finally {
      insert.finalize();
    }
  }

  pendingInputCount(sessionID: SessionID) {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS count FROM session_inputs WHERE session_id = ? AND promoted_at IS NULL`,
      )
      .get(sessionID) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  referencedAttachments() {
    const sessions = this.db.query(`SELECT id FROM sessions`).all() as Array<{
      id: SessionID;
    }>;
    for (const session of sessions) this.ensureRecoveryProjection(session.id);
    const attachments: import("@anthelia/contracts").LocalAttachment[] = [];
    const eventRows = this.db
      .query(`SELECT attachments FROM recovery_attachments`)
      .all() as Array<{ attachments: string }>;
    for (const row of eventRows)
      attachments.push(
        ...(JSON.parse(
          row.attachments,
        ) as import("@anthelia/contracts").LocalAttachment[]),
      );
    const inputRows = this.db
      .query(
        `SELECT attachments FROM session_inputs WHERE attachments IS NOT NULL`,
      )
      .all() as Array<{ attachments: string }>;
    for (const row of inputRows) {
      const input = parseOptionalJSON(row.attachments);
      if (Array.isArray(input))
        attachments.push(
          ...(input as import("@anthelia/contracts").LocalAttachment[]),
        );
    }
    return attachments;
  }

  loadEventsAfter(sessionID: SessionID, after: number): RuntimeEvent[] {
    const rows = this.db
      .query(
        `SELECT event FROM events WHERE session_id = ? AND seq > ? ORDER BY seq`,
      )
      .all(sessionID, after) as { event: string }[];
    return rows.map((row) => JSON.parse(row.event) as RuntimeEvent);
  }

  /**
   * Persists a per-session projection checkpoint stamped with the current max
   * event sequence, so a later attach can resume by folding only the tail.
   */
  saveProjectionCheckpoint(sessionID: SessionID, state: ProjectionState) {
    const row = this.db
      .query(`SELECT MAX(seq) AS m FROM events WHERE session_id = ?`)
      .get(sessionID) as { m: number | null } | undefined;
    const lastSeq = row?.m ?? 0;
    this.run(
      `INSERT INTO projection_checkpoints(session_id, state_version, last_seq, state)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         state_version = excluded.state_version,
         last_seq = excluded.last_seq,
         state = excluded.state`,
      [sessionID, state.version, lastSeq, serializeProjectionState(state)],
    );
    return lastSeq;
  }

  /**
   * Loads a persisted projection checkpoint. A row written by an older
   * `PROJECTION_STATE_VERSION` (or a corrupt payload) is discarded (returns
   * undefined) so the caller fails soft to a full projection.
   */
  loadProjectionCheckpoint(
    sessionID: SessionID,
  ): { state: ProjectionState; lastSeq: number } | undefined {
    const row = this.db
      .query(
        `SELECT state_version, last_seq, state FROM projection_checkpoints WHERE session_id = ?`,
      )
      .get(sessionID) as
      | { state_version: number; last_seq: number; state: string }
      | undefined;
    if (!row) return undefined;
    if (row.state_version !== PROJECTION_STATE_VERSION) return undefined;
    const state = deserializeProjectionState(row.state);
    if (!state) return undefined;
    return { state, lastSeq: row.last_seq };
  }

  loadEventPage(
    sessionID: SessionID,
    options: { after?: number; offset?: number; limit?: number } = {},
  ) {
    const after = Math.max(0, options.after ?? 0);
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.min(2000, Math.max(1, options.limit ?? 100));
    const rows = (
      options.offset === undefined
        ? this.db
            .query(
              `SELECT seq, event, session_seq FROM (
                 SELECT seq, event,
                   ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq) AS session_seq
                 FROM events WHERE session_id = ?
               ) WHERE seq > ? ORDER BY seq LIMIT ?`,
            )
            .all(sessionID, after, limit + 1)
        : this.db
            .query(
              `SELECT seq, event, session_seq FROM (
                 SELECT seq, event,
                   ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq) AS session_seq
                 FROM events WHERE session_id = ?
               ) ORDER BY seq LIMIT ? OFFSET ?`,
            )
            .all(sessionID, limit + 1, offset)
    ) as Array<{
      seq: number;
      event: string;
      session_seq: number;
    }>;
    const hasMore = rows.length > limit;
    return {
      events: rows.slice(0, limit).map((row) => ({
        seq: row.seq,
        sessionSeq: row.session_seq,
        event: JSON.parse(row.event) as RuntimeEvent,
      })),
      hasMore,
    };
  }

  loadEventWindow(
    sessionID: SessionID,
    options: { beforeSeq?: number; limit?: number } = {},
  ) {
    const limit = Math.min(2000, Math.max(1, options.limit ?? 100));
    const before =
      options.beforeSeq === undefined
        ? Number.MAX_SAFE_INTEGER
        : Math.max(1, options.beforeSeq);
    const rows = this.db
      .query(
        `SELECT seq, event, session_seq FROM (
           SELECT seq, event,
             ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq) AS session_seq
           FROM events WHERE session_id = ?
         ) WHERE session_seq < ? ORDER BY session_seq DESC LIMIT ?`,
      )
      .all(sessionID, before, limit + 1) as Array<{
      seq: number;
      event: string;
      session_seq: number;
    }>;
    const hasMore = rows.length > limit;
    return {
      events: rows
        .slice(0, limit)
        .reverse()
        .map((row) => ({
          seq: row.seq,
          sessionSeq: row.session_seq,
          event: JSON.parse(row.event) as RuntimeEvent,
        })),
      hasMore,
    };
  }

  loadMessagePage(
    sessionID: SessionID,
    options: { limit?: number; order?: "asc" | "desc"; cursor?: string } = {},
  ): RuntimeMessagePage {
    const cursor = options.cursor
      ? decodeMessageCursor(options.cursor)
      : undefined;
    if (cursor && options.order)
      throw new Error("message cursor cannot be combined with order");
    const order = cursor?.order ?? options.order ?? "desc";
    const limit = Math.min(200, Math.max(1, options.limit ?? 100));
    if (!this.messageIndexIsCurrent(sessionID)) {
      try {
        this.buildMessageIndex(sessionID);
      } catch (error) {
        // A read-only workspace must still be able to page through an existing
        // session. Fall back to projecting the journal in memory.
        if (isReadonlyError(error))
          return this.projectFromEvents(sessionID, options);
        throw error;
      }
    }
    const anchor = cursor
      ? this.messageTurn(sessionID, cursor.anchor)
      : undefined;
    if (cursor && !anchor)
      throw new Error("message cursor anchor is no longer available");
    const direction = cursor?.direction ?? "next";
    const query = messageTurnQuery(order, direction, anchor?.startSeq);
    const turns = this.db
      .query(query.sql)
      .all(sessionID, ...query.params, limit + 1) as Array<{
      turn_id: string;
      start_seq: number;
      event: string;
    }>;
    const pageTurns = turns.slice(0, limit);
    if (query.reverse) pageTurns.reverse();
    const data = this.projectMessageTurns(sessionID, pageTurns);
    const first = pageTurns[0];
    const last = pageTurns.at(-1);
    const hasPrevious = first
      ? this.hasMessageTurn(
          sessionID,
          first.start_seq,
          order === "asc" ? "before" : "after",
        )
      : false;
    const hasNext = last
      ? this.hasMessageTurn(
          sessionID,
          last.start_seq,
          order === "asc" ? "after" : "before",
        )
      : false;
    return {
      data,
      cursor: {
        previous:
          hasPrevious && first
            ? encodeMessageCursor({
                order,
                direction: "previous",
                anchor: first.turn_id,
              })
            : undefined,
        next:
          hasNext && last
            ? encodeMessageCursor({
                order,
                direction: "next",
                anchor: last.turn_id,
              })
            : undefined,
      },
    };
  }

  loadContextEpoch(sessionID: SessionID): StoredContextEpoch | undefined {
    const row = this.db
      .query(
        `SELECT baseline_seq, snapshot FROM context_epochs WHERE session_id = ?`,
      )
      .get(sessionID) as { baseline_seq: number; snapshot: string } | undefined;
    if (!row) return undefined;
    return {
      baselineSeq: row.baseline_seq,
      snapshot: JSON.parse(row.snapshot) as DurableContextCheckpointRecord,
    };
  }

  eventCount(sessionID: SessionID): number {
    const row = this.db
      .query(`SELECT COUNT(*) as cnt FROM events WHERE session_id = ?`)
      .get(sessionID) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  writeContextEpoch(
    sessionID: SessionID,
    snapshot: import("@anthelia/contracts").DurableContextCheckpointRecord,
  ) {
    const row = this.db
      .query(
        `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events WHERE session_id = ?`,
      )
      .get(sessionID) as { max_seq: number };
    const baselineSeq = Number(row?.max_seq ?? 0);
    this.run(
      `INSERT INTO context_epochs(session_id, baseline_seq, snapshot) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET baseline_seq = excluded.baseline_seq, snapshot = excluded.snapshot`,
      [sessionID, baselineSeq, JSON.stringify(snapshot)],
    );
  }

  async appendEventAsync(sessionID: SessionID, event: RuntimeEvent) {
    this.enqueueEvent(sessionID, event);
    await this.flushPendingWrites(sessionID);
  }

  /** Queues a non-barrier durable event for the next microtask/count/barrier flush. */
  enqueueEvent(sessionID: SessionID, event: RuntimeEvent) {
    if (this.closed) throw new Error("SQLite session store is closed");
    const events = this.pendingAsyncEvents.get(sessionID) ?? [];
    events.push(event);
    this.pendingAsyncEvents.set(sessionID, events);
    if (events.length >= 100 || isDurableFlushBarrier(event)) {
      void this.flushPendingWrites(sessionID);
      return;
    }
    this.scheduleFlush(sessionID);
  }

  /** Flushes queued non-barrier appends before dispose or an explicit audit boundary. */
  async flushPendingWrites(sessionID?: SessionID) {
    if (sessionID) {
      await this.flushSession(sessionID);
      return;
    }
    await Promise.all(
      [...this.pendingAsyncEvents.keys()].map((id) => this.flushSession(id)),
    );
  }

  private run(sql: string, params: unknown[] = []) {
    // `prepare()` is not cached by Bun: the caller owns the statement. Leaving
    // it unfinalized keeps it alive until GC, and any live statement makes
    // sqlite3_close_v2 defer releasing the database file handles.
    const statement = this.db.prepare(sql);
    try {
      statement.run(...(params as never[]));
    } finally {
      statement.finalize();
    }
  }

  private insertEvent(sessionID: SessionID, event: RuntimeEvent) {
    const inserted = this.insertEventStatement.run(
      sessionID,
      JSON.stringify(event),
    );
    if (event.type === "turn.submitted")
      this.run(
        `INSERT OR IGNORE INTO message_turns(session_id, turn_id, start_seq) VALUES (?, ?, ?)`,
        [sessionID, event.id, Number(inserted.lastInsertRowid)],
      );
    return inserted;
  }

  private projectionStateFor(sessionID: SessionID): ProjectionState {
    let state = this.projectionStates.get(sessionID);
    if (state === undefined) {
      state = initProjection();
      for (const event of this.loadEvents(sessionID))
        applyProjection(state, event);
      this.projectionStates.set(sessionID, state);
    }
    return state;
  }

  private appendEventInTransaction(sessionID: SessionID, event: RuntimeEvent) {
    // Advance the live projection fold before inserting so the lazy init reads
    // only the prior events; then fold this event and persist a checkpoint on
    // durable flush barriers so a later attach can resume from the tail.
    const projection = this.projectionStateFor(sessionID);
    const inserted = this.insertEvent(sessionID, event);
    applyProjection(projection, event);
    this.applyRecoveryEvent(sessionID, event);
    if (event.type === "context.checkpoint")
      this.run(
        `INSERT INTO context_epochs(session_id, baseline_seq, snapshot) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET baseline_seq = excluded.baseline_seq, snapshot = excluded.snapshot`,
        [
          sessionID,
          Number(inserted.lastInsertRowid),
          JSON.stringify(event.snapshot),
        ],
      );
    if (event.type === "session.created")
      this.run(`UPDATE sessions SET title = ? WHERE id = ?`, [
        event.title,
        sessionID,
      ]);
    if (event.type === "turn.cancelled")
      this.run(`UPDATE sessions SET cancelled = 1 WHERE id = ?`, [sessionID]);
    if (isDurableFlushBarrier(event))
      this.persistProjectionCheckpoint(sessionID);
  }

  /** Writes the live projection fold for a session as a durable checkpoint. */
  private persistProjectionCheckpoint(sessionID: SessionID) {
    const projection = this.projectionStates.get(sessionID);
    if (!projection) return;
    this.saveProjectionCheckpoint(sessionID, projection);
  }

  private scheduleFlush(sessionID: SessionID) {
    if (this.scheduledFlushes.has(sessionID)) return;
    this.scheduledFlushes.add(sessionID);
    this.flushTimers.set(
      sessionID,
      setTimeout(() => {
        this.scheduledFlushes.delete(sessionID);
        this.flushTimers.delete(sessionID);
        if (!this.closed) void this.flushSession(sessionID);
      }, 20),
    );
  }

  private async flushSession(sessionID: SessionID) {
    const timer = this.flushTimers.get(sessionID);
    if (timer) clearTimeout(timer);
    this.flushTimers.delete(sessionID);
    this.scheduledFlushes.delete(sessionID);
    const existing = this.pendingFlushes.get(sessionID);
    if (existing) {
      await existing;
      if (this.pendingAsyncEvents.get(sessionID)?.length)
        await this.flushSession(sessionID);
      return;
    }
    const events = this.pendingAsyncEvents.get(sessionID);
    if (!events?.length) return;
    const batch = events.splice(0);
    const run = () => this.writeBufferedBatch(sessionID, batch);
    const queued = this.writeQueue.then(run, run);
    this.writeQueue = queued.catch(() => undefined);
    const flush = queued.finally(() => this.pendingFlushes.delete(sessionID));
    this.pendingFlushes.set(sessionID, flush);
    await flush;
    if (this.pendingAsyncEvents.get(sessionID)?.length)
      await this.flushSession(sessionID);
  }

  private writeBufferedBatch(sessionID: SessionID, events: RuntimeEvent[]) {
    if (!events.length) return;
    this.db.transaction(() => {
      for (const event of events)
        this.appendEventInTransaction(sessionID, event);
      this.bumpRecoveryState(sessionID, events.length);
    })();
  }

  private ensureRecoveryProjection(sessionID: SessionID) {
    const indexed = this.db
      .query(`SELECT indexed_events FROM recovery_state WHERE session_id = ?`)
      .get(sessionID) as { indexed_events: number } | undefined;
    const total = this.eventCount(sessionID);
    if (indexed?.indexed_events === total) return;
    const events = this.loadEvents(sessionID);
    this.db.transaction(() => {
      this.deleteRecoveryProjection(sessionID);
      for (const event of events) this.applyRecoveryEvent(sessionID, event);
      this.run(
        `INSERT INTO recovery_state(session_id, indexed_events) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET indexed_events = excluded.indexed_events`,
        [sessionID, events.length],
      );
    })();
  }

  private applyRecoveryEvent(sessionID: SessionID, event: RuntimeEvent) {
    if (event.type === "turn.submitted") {
      this.run(
        `INSERT INTO recovery_turns(session_id, turn_id, active) VALUES (?, ?, 1)
         ON CONFLICT(session_id, turn_id) DO UPDATE SET active = 1`,
        [sessionID, event.id],
      );
      if (event.attachments?.length)
        this.run(
          `INSERT INTO recovery_attachments(session_id, turn_id, attachments) VALUES (?, ?, ?)
           ON CONFLICT(session_id, turn_id) DO UPDATE SET attachments = excluded.attachments`,
          [sessionID, event.id, JSON.stringify(event.attachments)],
        );
      return;
    }
    if (event.type === "turn.finished" || event.type === "turn.cancelled") {
      this.run(
        `UPDATE recovery_turns SET active = 0 WHERE session_id = ? AND turn_id = ?`,
        [sessionID, event.id],
      );
      return;
    }
    if (
      event.type === "approval.request" ||
      event.type === "question.request" ||
      event.type === "interactive.request"
    ) {
      const kind =
        event.type === "approval.request"
          ? "approval"
          : event.type === "question.request"
            ? "question"
            : `interactive:${event.kind}`;
      this.run(
        `INSERT INTO recovery_interactive(session_id, request_id, kind, event) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, request_id) DO UPDATE SET kind = excluded.kind, event = excluded.event`,
        [sessionID, event.id, kind, JSON.stringify(event)],
      );
      return;
    }
    if (
      event.type === "approval.response" ||
      event.type === "question.response" ||
      event.type === "interactive.response"
    ) {
      this.run(
        `DELETE FROM recovery_interactive WHERE session_id = ? AND request_id = ?`,
        [sessionID, event.id],
      );
      return;
    }
    if (event.type === "agent.selection" && !event.pending) {
      this.run(
        `INSERT INTO recovery_selection(session_id, agent_name) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET agent_name = excluded.agent_name`,
        [sessionID, event.name],
      );
      return;
    }
    if (event.type === "model.selection")
      this.run(
        `INSERT INTO recovery_selection(session_id, model_id, model_variant) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET model_id = excluded.model_id, model_variant = excluded.model_variant`,
        [sessionID, event.modelID ?? null, event.variant ?? null],
      );
    if (event.type === "model.reasoning.set")
      this.run(
        `INSERT INTO recovery_selection(session_id, reasoning_effort) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET reasoning_effort = excluded.reasoning_effort`,
        [sessionID, event.reasoningEffort ?? null],
      );
    if (
      event.type === "navi.chat.model.profile" ||
      event.type === "nia.chat.model.profile" ||
      event.type === "chat.model.profile"
    ) {
      const existing = this.db
        .query(
          `SELECT chat_model_profile FROM recovery_selection WHERE session_id = ?`,
        )
        .get(sessionID) as { chat_model_profile?: string } | undefined;
      const profiles = existing?.chat_model_profile
        ? (JSON.parse(existing.chat_model_profile) as Record<
            string,
            import("@anthelia/contracts").ChatModelProfile
          >)
        : {};
      const chatProfileChannel =
        event.type === "navi.chat.model.profile"
          ? "navi"
          : event.type === "nia.chat.model.profile"
            ? "nia"
            : event.channel;
      profiles[chatProfileChannel] = event.profile;
      this.run(
        `INSERT INTO recovery_selection(session_id, chat_model_profile) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET chat_model_profile = excluded.chat_model_profile`,
        [sessionID, JSON.stringify(profiles)],
      );
    }
    if (event.type === "session.permission.mode")
      this.run(
        `INSERT INTO recovery_selection(session_id, permission_mode, permission_profile) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET permission_mode = excluded.permission_mode, permission_profile = excluded.permission_profile`,
        [sessionID, event.mode, event.profile ?? null],
      );
    if (event.type === "diagnostic") {
      this.run(
        `INSERT INTO recovery_diagnostics(session_id, event) VALUES (?, ?)`,
        [sessionID, JSON.stringify(event)],
      );
      this.run(
        `DELETE FROM recovery_diagnostics
         WHERE session_id = ? AND seq NOT IN (
           SELECT seq FROM recovery_diagnostics
           WHERE session_id = ? ORDER BY seq DESC LIMIT 500
         )`,
        [sessionID, sessionID],
      );
    }
  }

  private bumpRecoveryState(sessionID: SessionID, count = 1) {
    this.run(
      `INSERT INTO recovery_state(session_id, indexed_events) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET indexed_events = indexed_events + ?`,
      [sessionID, count, count],
    );
  }

  private deleteRecoveryProjection(sessionID: SessionID) {
    this.run(`DELETE FROM recovery_turns WHERE session_id = ?`, [sessionID]);
    this.run(`DELETE FROM recovery_interactive WHERE session_id = ?`, [
      sessionID,
    ]);
    this.run(`DELETE FROM recovery_selection WHERE session_id = ?`, [
      sessionID,
    ]);
    this.run(`DELETE FROM recovery_attachments WHERE session_id = ?`, [
      sessionID,
    ]);
    this.run(`DELETE FROM recovery_diagnostics WHERE session_id = ?`, [
      sessionID,
    ]);
    this.run(`DELETE FROM recovery_state WHERE session_id = ?`, [sessionID]);
  }

  ensureMessageIndex(sessionID: SessionID) {
    this.buildMessageIndex(sessionID);
  }

  private buildMessageIndex(sessionID: SessionID) {
    // The cursor is this session's own highest INDEXED turn, never the
    // `message_index_state` watermark: that watermark is the session's max
    // seq — a journal-global number once many sessions share one sequence
    // space — and using it as a per-session cursor skips every turn written
    // below it. A session whose turns predate the watermark was therefore
    // never indexed at all, and its message page came back empty: the
    // transcript blank and the usage bar at zero after a restart, while the
    // same session was correct live (live events never go through the page).
    const indexed = this.db
      .query(
        `SELECT COALESCE(MAX(start_seq), 0) AS last_seq FROM message_turns WHERE session_id = ?`,
      )
      .get(sessionID) as { last_seq: number } | undefined;
    const lastSeq = indexed?.last_seq ?? 0;
    this.run(
      `INSERT OR IGNORE INTO message_turns(session_id, turn_id, start_seq)
       SELECT session_id, json_extract(event, '$.id'), seq
       FROM events
         WHERE session_id = ? AND seq > ? AND json_extract(event, '$.type') = 'turn.submitted'`,
      [sessionID, lastSeq],
    );
    const max = this.db
      .query(
        `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events WHERE session_id = ?`,
      )
      .get(sessionID) as { max_seq: number };
    this.run(
      `INSERT INTO message_index_state(session_id, last_seq) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_seq = excluded.last_seq`,
      [sessionID, max.max_seq],
    );
  }

  private messageIndexIsCurrent(sessionID: SessionID): boolean {
    const state = this.db
      .query(`SELECT last_seq FROM message_index_state WHERE session_id = ?`)
      .get(sessionID) as { last_seq: number } | undefined;
    if (!state) return false;
    // Currency is measured in the domain buildMessageIndex writes: the
    // session's highest sequence. Comparing that watermark to the session's
    // EVENT COUNT could only match when the journal held one session whose
    // sequences started at 1, so on any real multi-session journal the check
    // failed forever and every page load paid for a rebuild it could not skip.
    const max = this.db
      .query(
        `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events WHERE session_id = ?`,
      )
      .get(sessionID) as { max_seq: number };
    const turnCount = this.db
      .query(`SELECT COUNT(*) AS count FROM message_turns WHERE session_id = ?`)
      .get(sessionID) as { count: number } | undefined;
    return state.last_seq === max.max_seq && (turnCount?.count ?? 0) > 0;
  }

  private projectFromEvents(
    sessionID: SessionID,
    options: { limit?: number; order?: "asc" | "desc"; cursor?: string } = {},
  ): RuntimeMessagePage {
    const events = this.loadEvents(sessionID);
    return projectSessionMessages(
      { id: sessionID, title: "", createdAt: "", events } as SessionRecord,
      options,
    );
  }

  private messageTurn(sessionID: SessionID, turnID: string) {
    const row = this.db
      .query(
        `SELECT turn_id, start_seq FROM message_turns WHERE session_id = ? AND turn_id = ?`,
      )
      .get(sessionID, turnID) as
      | { turn_id: string; start_seq: number }
      | undefined;
    return row ? { turnID: row.turn_id, startSeq: row.start_seq } : undefined;
  }

  private hasMessageTurn(
    sessionID: SessionID,
    sequence: number,
    direction: "before" | "after",
  ) {
    const comparison = direction === "before" ? "<" : ">";
    return Boolean(
      this.db
        .query(
          `SELECT 1 FROM message_turns WHERE session_id = ? AND start_seq ${comparison} ? LIMIT 1`,
        )
        .get(sessionID, sequence),
    );
  }

  private projectMessageTurns(
    sessionID: SessionID,
    turns: Array<{ turn_id: string; start_seq: number; event: string }>,
  ) {
    if (!turns.length) return [];
    const firstSequence = Math.min(...turns.map((turn) => turn.start_seq));
    const lastSequence = Math.max(...turns.map((turn) => turn.start_seq));
    const next = this.db
      .query(
        `SELECT start_seq FROM message_turns WHERE session_id = ? AND start_seq > ? ORDER BY start_seq LIMIT 1`,
      )
      .get(sessionID, lastSequence) as { start_seq: number } | undefined;
    const rows = this.db
      .query(
        `SELECT seq, event FROM events WHERE session_id = ? AND seq >= ? ${next ? "AND seq < ?" : ""} ORDER BY seq`,
      )
      .all(
        ...(next
          ? [sessionID, firstSequence, next.start_seq]
          : [sessionID, firstSequence]),
      ) as Array<{
      seq: number;
      event: string;
    }>;
    const parsed = rows.map((row) => ({
      seq: row.seq,
      event: JSON.parse(row.event) as RuntimeEvent,
    }));
    // Reuse the event-stream projector instead of rebuilding each turn from its
    // seq slice with `projectTurnMessage`. The slice form attaches
    // `turn.input` to the wrong enclosing turn and lets a collaboration row
    // belong to the previous turn even when the stream opened a newer turn,
    // which surfaced as duplicate / out-of-order rows in the SQLite-backed
    // message page. `projectTurnMessages` is the same algorithm the non-SQLite
    // path already uses, so both stores now return identical turn semantics.
    const projected = new Map(
      projectTurnMessages(parsed.map((row) => row.event)).map((message) => [
        message.turnID,
        message,
      ]),
    );
    return turns.flatMap((turn) => {
      const message = projected.get(turn.turn_id);
      return message === undefined ? [] : [message];
    });
  }
}

function messageTurnQuery(
  order: "asc" | "desc",
  direction: "next" | "previous",
  anchor?: number,
) {
  const forward = direction === "next";
  const descending = order === "desc" ? forward : !forward;
  const comparison =
    anchor === undefined ? "" : `AND start_seq ${descending ? "<" : ">"} ?`;
  return {
    sql: `SELECT message_turns.turn_id, message_turns.start_seq, events.event
      FROM message_turns JOIN events
        ON events.session_id = message_turns.session_id AND events.seq = message_turns.start_seq
      WHERE message_turns.session_id = ? ${comparison}
      ORDER BY message_turns.start_seq ${descending ? "DESC" : "ASC"}
      LIMIT ?`,
    params: anchor === undefined ? [] : [anchor],
    reverse: descending !== (order === "desc"),
  };
}

function rowToSession(row: Record<string, unknown>): SessionRow {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.metadata as string);
    if (parsed && typeof parsed === "object") metadata = parsed;
  } catch {
    // Corrupt metadata is silently discarded; the active session remains usable.
  }
  return {
    id: row.id as SessionID,
    title: row.title as string,
    createdAt: row.created_at as string,
    cancelled: (row.cancelled as number) === 1,
    resumable: (row.resumable as number) === 1,
    pinned: (row.pinned as number) === 1,
    metadata,
  };
}

function optionalJSON(value: unknown) {
  return value === undefined ? null : JSON.stringify(value);
}

function parseOptionalJSON(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as any;
  } catch {
    return undefined;
  }
}

function isReadonlyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "SQLITE_READONLY"
  );
}
