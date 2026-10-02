import type { RuntimeEvent } from "@anthelia/contracts";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  cosine,
  embedText,
  embeddableText,
  serializeVector,
} from "./embedding";

/**
 * RINA Phase1 — the Cold Vault (the study's own split: hot state
 * first, the vault thickens the SAME contract without rewriting it).
 *
 * What this stores: structured facts DERIVED from journaled events —
 * record type, entity key, a short deterministic LABEL as the summary,
 * and the `(sessionID, seq)` pointer. What it never stores: event
 * bodies (the study's isolation rule — a collab message's text is the
 * user's content, not a memory record; `content` stays NULL and a
 * unit test proves the body never reaches the disk).
 *
 * FTS5 with porter unicode61 (probed live in this round: bun's SQLite
 * carries it) + bm25 rank for recall; the multi-signal scoring model
 * is Phase2's, by the study's own phase table.
 *
 * The write-behind rides the study's choke point: publishForSession's
 * appendSite enqueues; a100ms/N=50 timer (or an explicit flushNow,
 * the test seam) lands them in one transaction. Rebuild = replaying
 * the same events through the same mapper — journal stays the source
 * of truth, the vault is a derived index (rebuild-identical is a
 * test).
 */

/**
 * The vault's blob storage seam (the object-store study's acceptance 5:
 * "RINA ContextVault 的 blob 存储可选使用 ObjectStore" — an OPTION, not
 * a rewrite). The interface is SYNC by the recall path's shape: the
 * semantic lane's vector scan runs inside a synchronous read, so a
 * store that answers asynchronously could never serve it (and the
 * default SQLite-inline behaviour stays byte-identical when absent).
 */
export type VaultBlobStore = {
  /** The blob's bytes, answered by their content id. */
  put(bytes: Uint8Array): string;
  /** The blob by its content id, or undefined when absent. */
  get(id: string): Uint8Array | undefined;
};

export type VaultRecordType =
  | "plan"
  | "mailbox"
  | "collab"
  | "evidence"
  | "tool_history"
  | "decision";

export type VaultRecord = {
  id: string;
  /** The record's own time (the event's `at` when known) — the time
   * signal is meaningless if every row is stamped at insert. */
  createdAt?: string;
  workspaceID: string;
  sessionID: string;
  agentID?: string;
  recordType: VaultRecordType;
  entityKey: string;
  summary: string;
  seq?: number;
  sourceEvidenceID?: string;
};

export type VaultRecallScope = {
  sessionID?: string;
  workspaceID?: string;
  recordType?: VaultRecordType;
  /** ISO bounds on the record's own time (the study's timeRange). */
  createdAfter?: string;
  createdBefore?: string;
  limit?: number;
};

export type VaultListScope = {
  sessionID?: string;
  workspaceID?: string;
  recordType?: VaultRecordType;
  /** ISO bounds on the record's own time (the study's timeRange). */
  createdAfter?: string;
  createdBefore?: string;
  limit?: number;
};

export type VaultRecallHit = {
  id: string;
  recordType: VaultRecordType;
  entityKey: string;
  summary: string;
  sessionID: string;
  seq?: number;
  createdAt: string;
  /** FTS5's bm25 (lower = better, negated so bigger = better). */
  rank: number;
  /** The four-signal total (the study's coefficients). */
  score: number;
  /** What made the total — the study's score breakdown. */
  breakdown: VaultScoreBreakdown;
};

// --- Phase2a: the study's retrieval scoring model, made explicit ------
// Its coefficients, its four signals; its TABLES are ours to name (the
// study prescribes the signals, not the numbers) — every knob lives
// here, once, commented, testable.

const SCORE_WEIGHTS = {
  fts: 0.3,
  // Phase 6's semantic lane: a weight equal to bm25's, because a
  // paraphrase the FTS cannot lexically match is exactly the recall the
  // study added the lane for. The four Phase2a coefficients retune once,
  // here, when the fifth signal lands.
  semantic: 0.2,
  time: 0.2,
  evidence: 0.15,
  entity: 0.15,
} as const;

/**
 * Phase 6's vector-scan bound: the semantic lane's candidate scan is
 * linear over the scoped rows, and this caps how many rows it touches
 * (the vault is per-workspace; a bound keeps a pathological store from
 * turning one recall into a full-table walk).
 */
const VECTOR_SCAN_CAP = 5_000;

/** A stored BLOB back to a vector (the embedding module's reader). */
function toVector(blob: Buffer | Uint8Array): Float32Array {
  return new Float32Array(
    blob.buffer,
    blob.byteOffset,
    blob.byteLength / 4,
  ).slice();
}

/** Recency horizon: the study sets the weight but no horizon;30 days
 * sits next to its curator-adjacent intervals and is the ONE place to
 * retune. */
const TIME_HALF_LIFE_DAYS = 30;

/** "Evidence strength": a per-type baseline (how much the type's
 * EXISTENCE proves) plus a real evidence reference as a bonus. */
const EVIDENCE_STRENGTH: Record<VaultRecordType, number> = {
  evidence: 1,
  decision: 0.9,
  plan: 0.8,
  mailbox: 0.7,
  collab: 0.6,
  tool_history: 0.4,
};

export type VaultScoreBreakdown = {
  fts: number;
  /** Phase 6's semantic lane: the cosine of the query and record vectors. */
  semantic: number;
  time: number;
  evidence: number;
  entity: number;
};

export type VaultPackRole = "natalia" | "navi" | "nia";

/** The study's role→type pick (its Nia example = plan/evidence/tool
 * events; Navi's job = chat/risk/mailbox; the main agent keeps the
 * whole vault). */
const ROLE_TYPES: Record<VaultPackRole, readonly VaultRecordType[] | null> = {
  natalia: null, // all types
  navi: ["mailbox", "collab"],
  nia: ["plan", "evidence", "decision", "tool_history"],
};

export type RinaVaultService = {
  /** The write-behind entry: journaled events queue here, flush on
   * N=50 /100ms or via flushNow (the explicit seam). */
  enqueue(event: RuntimeEvent): void;
  flushNow(): number;
  remember(record: VaultRecord): string;
  recall(query: string, scope?: VaultRecallScope): VaultRecallHit[];
  /** The study's context_read face: a promoted hit answers from the
   * bounded hot tier first, else the row — same shape either way (an
   * eviction can change SPEED, never the answer). */
  get(id: string, opts?: { sessionID?: string }): VaultRecallHit | undefined;
  /** The study's context_list: a STRUCTURED read (no query), newest
   * first, same scopes + the time window. */
  list(scope?: VaultListScope): VaultRecallHit[];
  /** The study's context_history: the recorded actions on one record
   * (insert/accessed/evict/rebuild), oldest first. */
  history(
    id: string,
    opts?: { sessionID?: string; limit?: number },
  ): Array<{ action: string; at: string }>;
  /** Cost-observable hot tier: the promotion's size (its cap is the
   * one bound; the eviction is unobservable by design because get()
   * falls through to the store). */
  hotStats(): { size: number };
  /** Phase 6's semantic lane's state (the constructor's opt-in, fixed
   * per vault): the recall's breakdown reads `semantic: 0` both when the
   * lane is off and when it found no neighbour — this is what tells the
   * two apart, so a consumer never reads an absent lane as an empty
   * corpus. */
  semanticLane(): boolean;
  /** Delete by scope (the study's invalidation scopes). Returns count. */
  invalidate(scope: {
    sessionID?: string;
    workspaceID?: string;
    recordType?: VaultRecordType;
    id?: string;
  }): number;
  /** Rebuild the whole vault from journaled events (rebuild-identical). */
  rebuild(events: readonly RuntimeEvent[]): number;
  /** The hot-state face: the wire injects its reader; without one the
   * answer says WHY it cannot serve (a reason, not a stub — Phase0's
   * consumers are still unswitched, the study's own boundary). */
  state(
    sessionID: string,
  ): { available: true; state: unknown } | { available: false; reason: string };
  close(): void;
};

// ---------------------------------------------------------------------------
// The event → record classification: an EXPLICIT list, law1-style. Only
// events whose identity is structural make the cut; labels come from the
// event's own short fields, never from bodies.
// ---------------------------------------------------------------------------

type EventClassification = {
  recordType: VaultRecordType;
  /** The stable identity for this event's subject. */
  entityOf: (event: RuntimeEvent) => string;
  /** The deterministic label (short fields only). */
  label: (event: RuntimeEvent) => string;
};

const CLASSIFIED: Partial<Record<RuntimeEvent["type"], EventClassification>> = {
  "composition.switched": {
    recordType: "decision",
    entityOf: (event) => (event as { to?: string }).to ?? "unknown",
    label: (event) =>
      `switched: ${(event as { reason?: string }).reason ?? ""}`.slice(0, 200),
  },
  "drift.finding_opened": {
    recordType: "evidence",
    entityOf: (event) => String((event as { id?: string }).id ?? "drift"),
    label: (event) =>
      `drift: ${String((event as { severity?: string }).severity ?? "unknown")}`,
  },
  "feedback.recorded": {
    recordType: "evidence",
    entityOf: (event) => String((event as { id?: string }).id ?? "feedback"),
    label: () => "feedback recorded",
  },
};

/** bm25 squashed to (0,1): bigger-better and bounded, so the weight
 * coefficients mean the same thing across queries. */
function squashedFts(rankRaw: number): number {
  const rank = Math.max(0, -rankRaw);
  return rank / (1 + rank);
}

function timeWeight(createdAt: string, nowMs: number): number {
  const ageDays = Math.max(0, (nowMs - Date.parse(createdAt)) / 86_400_000);
  return Math.exp(-ageDays / TIME_HALF_LIFE_DAYS);
}

/** A query's tokens against the entity key's: a simple overlap in
 * [0,1] (no tokenizer dependency; the entity keys are structural
 * strings). */
function entityOverlap(query: string, entityKey: string): number {
  const queryTokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  if (!queryTokens.length) return 0;
  const entityTokens = new Set(
    entityKey
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter(Boolean),
  );
  let matched = 0;
  for (const token of queryTokens) if (entityTokens.has(token)) matched += 1;
  return matched / queryTokens.length;
}

function classify(event: RuntimeEvent): VaultRecord | undefined {
  const rule = CLASSIFIED[event.type];
  if (!rule) return undefined;
  const sessionID = String((event as { sessionID?: string }).sessionID ?? "");
  if (!sessionID) return undefined; // an unjournaled-for-session event is not a memory
  const workspaceID = String(
    (event as { workspaceID?: string }).workspaceID ?? "",
  );
  const seq = (event as { seq?: number }).seq;
  const agentID = (event as { agentID?: string }).agentID;
  return {
    id: `${sessionID}:${seq ?? `${event.type}:${(event as { at?: string }).at ?? "0"}`}`,
    workspaceID,
    sessionID,
    ...(agentID ? { agentID } : {}),
    recordType: rule.recordType,
    entityKey: rule.entityOf(event),
    summary: rule.label(event),
    ...(typeof seq === "number" ? { seq } : {}),
    ...((event as { at?: string }).at
      ? { createdAt: (event as { at?: string }).at! }
      : {}),
  };
}

export type ContextVault = RinaVaultService & { readonly path: string };

/**
 * The fail-soft twin: a vault whose STORE cannot open (a read-only
 * home in a sandbox, a locked dir in the field) must never kill the
 * boot — and must never lie either. Enqueue drops (the wire publishes
 * a diagnostic when it constructs this, so the loss is observable),
 * reads answer empty/`available:false` with the SAME reason, and
 * explicit WRITES fail loud with it — silently swallowing a
 * remember() would be the dishonest direction.
 */
export function createUnavailableVault(reason: string): RinaVaultService {
  const absent = { available: false as const, reason };
  return {
    enqueue: () => undefined,
    flushNow: () => 0,
    remember: () => {
      throw new Error(`context vault unavailable: ${reason}`);
    },
    recall: () => [],
    get: () => undefined,
    list: () => [],
    history: () => [],
    hotStats: () => ({ size: 0 }),
    semanticLane: () => false,
    invalidate: () => 0,
    rebuild: () => 0,
    state: () => absent,
    close: () => undefined,
  };
}

const FLUSH_MS = 100;
const FLUSH_N = 50;

// --- Phase2a: ContextPack — the study's assembly component (pure) -----
// A caller owns tokenization (the runtime's estimateTokens is what
// prompt-side callers pass; a test injects a counting fake) — the pack
// assembles, it does not tokenize.

export type ContextPackItem = {
  id: string;
  recordType: VaultRecordType;
  entityKey: string;
  summary: string;
  score: number;
  breakdown: VaultScoreBreakdown;
  tokens: number;
};

export type ContextPack = {
  items: ContextPackItem[];
  tokens: number;
  truncated: boolean;
  droppedByRole: number;
  deduped: number;
};

export function buildContextPack(
  hits: readonly VaultRecallHit[],
  input: {
    role: VaultPackRole;
    budgetTokens: number;
    estimate: (text: string) => number;
  },
): ContextPack {
  const allowed = ROLE_TYPES[input.role];
  let droppedByRole = 0;
  let deduped = 0;
  const kept: VaultRecallHit[] = [];
  const entities = new Set<string>();
  for (const hit of [...hits].sort((a, b) => b.score - a.score)) {
    if (allowed && !allowed.includes(hit.recordType)) {
      droppedByRole += 1;
      continue;
    }
    if (entities.has(hit.entityKey)) {
      deduped += 1;
      continue;
    }
    entities.add(hit.entityKey);
    kept.push(hit);
  }
  const items: ContextPackItem[] = [];
  let tokens = 0;
  let truncated = false;
  for (const hit of kept) {
    const text = `${hit.summary}\n${hit.entityKey}`;
    const cost = input.estimate(text);
    if (tokens + cost > input.budgetTokens) {
      truncated = true;
      break;
    }
    tokens += cost;
    items.push({
      id: hit.id,
      recordType: hit.recordType,
      entityKey: hit.entityKey,
      summary: hit.summary,
      score: hit.score,
      breakdown: hit.breakdown,
      tokens: cost,
    });
  }
  return { items, tokens, truncated, droppedByRole, deduped };
}

/** The id scheme (`${session}:${seq...}`) makes the SESSION readable
 * from the id itself — a cross-session face refuses before touching
 * the store (the study's isolation, enforced at the edge). */
function idBelongsTo(id: string, sessionID: string | undefined): boolean {
  if (!sessionID) return true;
  return id.startsWith(`${sessionID}:`);
}

export function createContextVault(input: {
  dir: string;
  /** The hot-state reader the wire injects (Phase0's fact state). */
  readFactState?: (sessionID: string) => unknown;
  flushMs?: number;
  flushN?: number;
  /**
   * Phase 6's semantic lane. Off by default (the study's 仅按需启用):
   * the module is built and tested; an operator turns the lane on per
   * vault. Off = the four-signal behaviour, byte-identical to before.
   */
  semantic?: boolean;
  /**
   * The blob store (acceptance 5's option): when present, the semantic
   * lane's vectors are stored THERE and the row keeps the content id in
   * `vector_ref`; absent, the bytes stay inline in `vector` exactly as
   * before (byte-identical default).
   */
  blobStore?: VaultBlobStore;
}): ContextVault {
  // Phase 6's lane: opt-in per vault (off = the four-signal behaviour).
  const semanticEnabled = input.semantic ?? false;
  const blobStore = input.blobStore;
  mkdirSync(input.dir, { recursive: true, mode: 0o700 });
  const path = join(input.dir, "vault.sqlite");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_records (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT,
      record_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      summary TEXT NOT NULL,
      content TEXT,
      source_evidence_id TEXT,
      seq INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      priority REAL NOT NULL DEFAULT 0.5,
      vector BLOB
    );
    CREATE INDEX IF NOT EXISTS context_records_session ON context_records (session_id, seq);
    CREATE VIRTUAL TABLE IF NOT EXISTS context_records_fts USING fts5(
      id UNINDEXED,
      summary,
      entity_key,
      tokenize = 'porter unicode61'
    );
    CREATE TABLE IF NOT EXISTS context_history (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL,
      action TEXT NOT NULL,
      at TEXT NOT NULL
    );
  `);
  // A vault written before Phase 6 has no vector column: add it rather
  // than rebuild — the column is a derived projection of the summary
  // (the journal is the source of truth; rebuild() refills it exactly).
  const columns = db
    .query("PRAGMA table_info(context_records)")
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "vector"))
    db.exec("ALTER TABLE context_records ADD COLUMN vector BLOB");
  // The blob-store reference column: only used when a blob store is
  // injected (the vector then lives there); NULL otherwise.
  if (!columns.some((column) => column.name === "vector_ref"))
    db.exec("ALTER TABLE context_records ADD COLUMN vector_ref TEXT");

  const insert = db.prepare(`
    INSERT OR REPLACE INTO context_records
      (id, workspace_id, session_id, agent_id, record_type, entity_key, summary,
       content, source_evidence_id, seq, created_at, updated_at, access_count, priority, vector, vector_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, 0.5, ?, ?)
  `);
  const ftsInsert = db.prepare(
    "INSERT OR REPLACE INTO context_records_fts (id, summary, entity_key) VALUES (?, ?, ?)",
  );
  const historyInsert = db.prepare(
    "INSERT OR REPLACE INTO context_history (id, record_id, action, at) VALUES (?, ?, ?, ?)",
  );

  let queue: VaultRecord[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The study's promotion tier: insertion-ordered = an LRU by re-set.
  // A bound (not a TTL — law: no guessing) and eviction that can only
  // change SPEED: get() falls through to the store for the answer.
  const HOT_CAP = 200;
  const hot = new Map<string, VaultRecallHit>();

  /** The shared point-read row -> hit (no query: the fts/entity terms
   * are absent BY DEFINITION — the total is honestly over what exists). */
  const pointHit = (row: {
    id: string;
    record_type: VaultRecordType;
    entity_key: string;
    summary: string;
    session_id: string;
    seq: number | null;
    created_at: string;
    source_evidence_id: string | null;
  }): VaultRecallHit => {
    const time = timeWeight(row.created_at, Date.now());
    const strength = Math.min(
      1,
      (EVIDENCE_STRENGTH[row.record_type] ?? 0.5) +
        (row.source_evidence_id ? 0.1 : 0),
    );
    const breakdown: VaultScoreBreakdown = {
      fts: 0,
      semantic: 0,
      time,
      evidence: strength,
      entity: 0,
    };
    return {
      id: row.id,
      recordType: row.record_type,
      entityKey: row.entity_key,
      summary: row.summary,
      sessionID: row.session_id,
      ...(row.seq === null ? {} : { seq: row.seq }),
      createdAt: row.created_at,
      rank: 0,
      score: SCORE_WEIGHTS.time * time + SCORE_WEIGHTS.evidence * strength,
      breakdown,
    };
  };

  /** One promotion path for all readers (recall/get/list): re-set = an
   * LRU refresh, the cap evicts from the head. */
  const promote = (hit: VaultRecallHit): void => {
    hot.delete(hit.id);
    hot.set(hit.id, hit);
    while (hot.size > HOT_CAP) {
      const oldest = hot.keys().next().value;
      if (oldest === undefined) break;
      hot.delete(oldest);
    }
  };
  const flushMs = input.flushMs ?? FLUSH_MS;
  const flushN = input.flushN ?? FLUSH_N;

  // Use-after-close is a race, not a caller error: a record queued by a
  // turn that was still finishing when the vault was disposed lands here
  // after close (CI's slower teardown makes it routine). The spine's
  // discipline applies — a closed vault degrades (the write is dropped,
  // the caller is not thrown at), it never fails the thing that outlived
  // it.
  let closed = false;
  function land(records: readonly VaultRecord[], action: string): number {
    if (closed) return 0;
    if (!records.length) return 0;
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const record of records) {
        insert.run(
          record.id,
          record.workspaceID,
          record.sessionID,
          record.agentID ?? null,
          record.recordType,
          record.entityKey,
          record.summary,
          record.sourceEvidenceID ?? null,
          record.seq ?? null,
          record.createdAt ?? now,
          now,
          // The blob-store option: the vector's bytes go THERE (the row
          // keeps the content id), or inline exactly as before. The
          // store is SYNC by the recall path's shape — the semantic
          // lane's scan runs inside a synchronous read.
          ...(blobStore
            ? (() => {
                const id = blobStore.put(
                  serializeVector(
                    embedText(embeddableText(record.summary, record.entityKey)),
                  ),
                );
                return [null, id];
              })()
            : [
                serializeVector(
                  embedText(embeddableText(record.summary, record.entityKey)),
                ),
                null,
              ]),
        );
        ftsInsert.run(record.id, record.summary, record.entityKey);
        historyInsert.run(
          `${action}:${record.id}:${now}`,
          record.id,
          action,
          now,
        );
      }
    })();
    return records.length;
  }

  function flushNow(): number {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const pending = queue;
    queue = [];
    return land(pending, "insert");
  }

  function schedule(): void {
    if (queue.length >= flushN) {
      flushNow();
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      flushNow();
    }, flushMs);
    timer.unref?.();
  }

  const invalidateSelect = (scope: {
    sessionID?: string;
    workspaceID?: string;
    recordType?: VaultRecordType;
    id?: string;
  }): { sql: string; args: (string | number | null)[] } => {
    const where: string[] = [];
    const args: (string | number | null)[] = [];
    if (scope.id) {
      where.push("id = ?");
      args.push(scope.id);
    }
    if (scope.sessionID) {
      where.push("session_id = ?");
      args.push(scope.sessionID);
    }
    if (scope.workspaceID) {
      where.push("workspace_id = ?");
      args.push(scope.workspaceID);
    }
    if (scope.recordType) {
      where.push("record_type = ?");
      args.push(scope.recordType);
    }
    if (!where.length)
      throw new Error("invalidate scope must name at least one dimension");
    return { sql: where.join(" AND "), args };
  };

  return {
    path,
    enqueue(event: RuntimeEvent): void {
      const record = classify(event);
      if (!record) return;
      queue.push(record);
      schedule();
    },
    flushNow,
    remember(record: VaultRecord): string {
      land([record], "insert");
      return record.id;
    },
    recall(query: string, scope: VaultRecallScope = {}): VaultRecallHit[] {
      flushNow(); // a recall sees everything enqueued (no read-your-own-writes gap)
      const filters: string[] = [];
      const args: (string | number | null)[] = [];
      if (scope.sessionID) {
        filters.push("r.session_id = ?");
        args.push(scope.sessionID);
      }
      if (scope.workspaceID) {
        filters.push("r.workspace_id = ?");
        args.push(scope.workspaceID);
      }
      if (scope.recordType) {
        filters.push("r.record_type = ?");
        args.push(scope.recordType);
      }
      if (scope.createdAfter) {
        filters.push("r.created_at >= ?");
        args.push(scope.createdAfter);
      }
      if (scope.createdBefore) {
        filters.push("r.created_at <= ?");
        args.push(scope.createdBefore);
      }
      const limit = Math.max(1, Math.min(scope.limit ?? 20, 200));
      // Two-phase by the study's model: FTS supplies the CANDIDATES (a
      // wider window), the four signals pick the top-N.
      const window = Math.min(Math.max(limit * 4, 50), 500);
      const sql = `
        SELECT r.id, r.record_type, r.entity_key, r.summary, r.session_id, r.seq,
               r.created_at, r.source_evidence_id, r.vector,
               bm25(context_records_fts) AS rank
        FROM context_records_fts
        JOIN context_records r ON r.id = context_records_fts.id
        WHERE context_records_fts MATCH ?
          ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
        ORDER BY rank
        LIMIT ?`;
      let rows = db.query(sql).all(query, ...args, window) as Array<{
        id: string;
        record_type: VaultRecordType;
        entity_key: string;
        summary: string;
        session_id: string;
        seq: number | null;
        created_at: string;
        source_evidence_id: string | null;
        vector: Buffer | null;
        rank: number;
      }>;
      // Phase 6's semantic lane: the FTS window supplies the candidates
      // a lexical match found; the vector scan supplies the ones it could
      // NOT (a paraphrase sharing no token). Both scoped by the same
      // filters, both bounded by the same window — the union is the
      // fusion's candidate set. The query vector is computed once.
      const semanticByID = new Map<string, number>();
      if (semanticEnabled) {
        const queryVector = embedText(query);
        // One full-row scan over the same scope: the similarities are
        // computed here, the top window carried into the candidate set.
        const scanned = db
          .query(
            `SELECT r.id, r.record_type, r.entity_key, r.summary, r.session_id, r.seq,
                    r.created_at, r.source_evidence_id, r.vector, r.vector_ref
             FROM context_records r
             WHERE 1 = 1 ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
             LIMIT ?`,
          )
          .all(...args, VECTOR_SCAN_CAP) as Array<
          Omit<(typeof rows)[number], "rank"> & { vector_ref?: string | null }
        >;
        const known = new Set(rows.map((row) => row.id));
        const neighbors: Array<{ id: string; similarity: number }> = [];
        for (const row of scanned) {
          // The blob-store resolution: the ref's bytes through the
          // store (SYNC, the scan's own shape), else the inline blob.
          const vector = row.vector
            ? toVector(row.vector)
            : blobStore && row.vector_ref
              ? (() => {
                  const bytes = blobStore.get(row.vector_ref!);
                  return bytes ? toVector(bytes) : undefined;
                })()
              : undefined;
          if (!vector) continue;
          const similarity = cosine(queryVector, vector);
          if (similarity <= 0) continue;
          if (!semanticByID.has(row.id)) semanticByID.set(row.id, similarity);
          if (!known.has(row.id)) neighbors.push({ id: row.id, similarity });
        }
        neighbors.sort((left, right) => right.similarity - left.similarity);
        // The vector-only rows enter the fusion with rank 0 — no bm25 to
        // report for them, which the breakdown's `fts: 0` states.
        const byID = new Map(scanned.map((row) => [row.id, row] as const));
        for (const neighbor of neighbors.slice(0, window)) {
          const row = byID.get(neighbor.id);
          if (row) rows.push({ ...row, rank: 0 });
        }
      }
      const touch = db.prepare(
        "UPDATE context_records SET access_count = access_count + 1 WHERE id = ?",
      );
      const now = new Date().toISOString();
      db.transaction(() => {
        for (const row of rows) {
          touch.run(row.id);
          historyInsert.run(
            `accessed:${row.id}:${now}`,
            row.id,
            "accessed",
            now,
          );
        }
      })();
      const nowMs = Date.now();
      const scored = rows.map((row) => {
        const fts = squashedFts(row.rank);
        const time = timeWeight(row.created_at, nowMs);
        const strength = Math.min(
          1,
          (EVIDENCE_STRENGTH[row.record_type] ?? 0.5) +
            (row.source_evidence_id ? 0.1 : 0),
        );
        const entity = entityOverlap(query, row.entity_key);
        const semantic = semanticByID.get(row.id) ?? 0;
        const breakdown: VaultScoreBreakdown = {
          fts,
          semantic,
          time,
          evidence: strength,
          entity,
        };
        return {
          hit: {
            id: row.id,
            recordType: row.record_type,
            entityKey: row.entity_key,
            summary: row.summary,
            sessionID: row.session_id,
            ...(row.seq === null ? {} : { seq: row.seq }),
            createdAt: row.created_at,
            // bm25 ascends (lower better); expose a bigger-is-better rank
            rank: -row.rank,
            score:
              SCORE_WEIGHTS.fts * fts +
              SCORE_WEIGHTS.semantic * semantic +
              SCORE_WEIGHTS.time * time +
              SCORE_WEIGHTS.evidence * strength +
              SCORE_WEIGHTS.entity * entity,
            breakdown,
          } satisfies VaultRecallHit,
        };
      });
      const hits = scored
        .map((entry) => entry.hit)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
      // Promotion (the study's 升档): re-set refreshes LRU position;
      // the cap evicts from the head (Map order = insertion).
      for (const hit of hits) {
        hot.delete(hit.id);
        hot.set(hit.id, hit);
      }
      while (hot.size > HOT_CAP) {
        const oldest = hot.keys().next().value;
        if (oldest === undefined) break;
        hot.delete(oldest);
      }
      return hits;
    },
    get(id: string, opts?: { sessionID?: string }): VaultRecallHit | undefined {
      if (!idBelongsTo(id, opts?.sessionID)) return undefined;
      const promoted = hot.get(id);
      if (promoted) return promoted;
      const row = db
        .query(
          `SELECT id, record_type, entity_key, summary, session_id, seq, created_at,
                  source_evidence_id
           FROM context_records WHERE id = ?`,
        )
        .get(id) as
        | {
            id: string;
            record_type: VaultRecordType;
            entity_key: string;
            summary: string;
            session_id: string;
            seq: number | null;
            created_at: string;
            source_evidence_id: string | null;
          }
        | undefined;
      if (!row) return undefined;
      const hit = pointHit(row);
      promote(hit);
      return hit;
    },
    list(scope: VaultListScope = {}): VaultRecallHit[] {
      flushNow();
      const filters: string[] = [];
      const args: (string | number | null)[] = [];
      if (scope.sessionID) {
        filters.push("session_id = ?");
        args.push(scope.sessionID);
      }
      if (scope.workspaceID) {
        filters.push("workspace_id = ?");
        args.push(scope.workspaceID);
      }
      if (scope.recordType) {
        filters.push("record_type = ?");
        args.push(scope.recordType);
      }
      if (scope.createdAfter) {
        filters.push("created_at >= ?");
        args.push(scope.createdAfter);
      }
      if (scope.createdBefore) {
        filters.push("created_at <= ?");
        args.push(scope.createdBefore);
      }
      const limit = Math.max(1, Math.min(scope.limit ?? 50, 500));
      const sql = `
        SELECT id, record_type, entity_key, summary, session_id, seq, created_at,
               source_evidence_id
        FROM context_records
        ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
        ORDER BY created_at DESC
        LIMIT ?`;
      const rows = db.query(sql).all(...args, limit) as Array<{
        id: string;
        record_type: VaultRecordType;
        entity_key: string;
        summary: string;
        session_id: string;
        seq: number | null;
        created_at: string;
        source_evidence_id: string | null;
      }>;
      return rows.map((row) => {
        const hit = pointHit(row);
        promote(hit);
        return hit;
      });
    },
    history(
      id: string,
      opts: { sessionID?: string; limit?: number } = {},
    ): Array<{ action: string; at: string }> {
      if (!idBelongsTo(id, opts.sessionID)) return [];
      const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
      const rows = db
        .query(
          "SELECT action, at FROM context_history WHERE record_id = ? ORDER BY at ASC LIMIT ?",
        )
        .all(id, limit) as Array<{ action: string; at: string }>;
      return rows;
    },
    hotStats(): { size: number } {
      return { size: hot.size };
    },
    semanticLane(): boolean {
      return semanticEnabled;
    },
    invalidate(scope): number {
      const { sql, args } = invalidateSelect(scope);
      const ids = (
        db
          .query(`SELECT id FROM context_records WHERE ${sql}`)
          .all(...args) as Array<{
          id: string;
        }>
      ).map((row) => row.id);
      if (!ids.length) return 0;
      const now = new Date().toISOString();
      db.transaction(() => {
        db.run(`DELETE FROM context_records WHERE ${sql}`, args);
        for (const id of ids) {
          db.run("DELETE FROM context_records_fts WHERE id = ?", [id]);
          historyInsert.run(`evict:${id}:${now}`, id, "evict", now);
          hot.delete(id); // the law: a promoted hit never outlives its row
        }
      })();
      return ids.length;
    },
    rebuild(events: readonly RuntimeEvent[]): number {
      flushNow();
      hot.clear();
      const now = new Date().toISOString();
      db.transaction(() => {
        db.run(
          "DELETE FROM context_records_fts WHERE id IN (SELECT id FROM context_records)",
        );
        db.run("DELETE FROM context_records");
        db.run("DELETE FROM context_history");
      })();
      const records = events
        .map((event) => classify(event))
        .filter((record): record is VaultRecord => record !== undefined);
      const dropped = land(records, "insert");
      historyInsert.run(`rebuild:${now}`, "-", "rebuild", now);
      return dropped;
    },
    state(sessionID: string) {
      if (!input.readFactState)
        return {
          available: false,
          reason:
            "the hot-state reader attaches with Phase2's consumer switch (Phase0's facts exist; their consumers are still unswitched — the study's own boundary)",
        };
      const state = input.readFactState(sessionID);
      if (state === undefined)
        return {
          available: false,
          reason: `no hot state for session ${sessionID}`,
        };
      return { available: true, state };
    },
    close(): void {
      if (closed) return;
      closed = true;
      flushNow();
      db.close();
    },
  };
}
