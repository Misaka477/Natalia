import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * RINA Memory (rina-cache study Phase 7): the engine's durable, reusable
 * knowledge — distinct from the ContextVault (session-scoped, journal-
 * derived facts) and from RINA State (the live fold).
 *
 * The study's four rules, as this module's shape:
 *
 *  1. **复用冷档存储** — one SQLite file per runtime beside the vault's,
 *     the same dir and permissions, the same history discipline. No new
 *     storage technology, no second lifecycle.
 *  2. **evidence-backed 生命周期** — a memory exists in draft → active →
 *     stale → superseded, every transition recorded, and ADMISSION
 *     requires a source evidence reference: knowledge without a source is
 *     an opinion, and opinions are not engine memory.
 *  3. **检索优先级** — State → Workspace Memory → Global Memory →
 *     ContextVault, served by the memory face's recall (block 2 of this
 *     phase lanes the sources; this block is the store the lane reads).
 *  4. **只存非敏感、可复用知识** — the store applies one redaction seam on
 *     write (the same discipline as the operation log: a single exit, the
 *     caller injects it), and admission is EXPLICIT — no event mapper
 *     feeds this table automatically, which is what keeps session facts
 *     out of durable knowledge.
 */

export type MemoryScope = "global" | `workspace:${string}`;

export type MemoryStatus = "draft" | "active" | "stale" | "superseded";

/** One durable knowledge entry. `content` is the reusable knowledge; the
 * evidence is what makes it admissible. */
export type MemoryEntry = {
  id: string;
  scope: MemoryScope;
  content: string;
  status: MemoryStatus;
  /** The admission gate: what this knowledge came from (a decision id, an
   * evidence id, a journal event id). Absent = refused. */
  evidenceID: string;
  /** When this memory was superseded, by which memory (the chain). */
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type RinaMemoryService = {
  /** Admission: draft (or active) statuses only, evidence required,
   * redacted through the seam. Returns the stored entry's id. */
  remember(input: {
    id?: string;
    scope: MemoryScope;
    content: string;
    evidenceID: string;
    /**
     * The admission status. Deliberately the FULL union: the type cannot
     * police the boundary (an RPC's JSON, a plugin's `unknown`), so the
     * runtime refuses the retired statuses here — fail-fast, not a
     * statically-dead branch.
     */
    status?: MemoryStatus;
  }): string;
  /** The lifecycle transitions. Illegal transitions are refused (a
   * superseded memory never comes back), every legal one recorded. */
  transition(
    id: string,
    to: MemoryStatus,
    input?: { supersededBy?: string },
  ): { ok: true; status: MemoryStatus } | { ok: false; reason: string };
  /** The recall: active memories in a scope (the study's priority reads
   * the active set; drafts and retired knowledge stay out unless asked). */
  recall(input?: {
    scope?: MemoryScope;
    includeInactive?: boolean;
    limit?: number;
  }): MemoryEntry[];
  get(id: string): MemoryEntry | undefined;
  /** The recorded lifecycle actions on one memory, oldest first. */
  history(id: string): Array<{ action: string; at: string }>;
  /** Counts per status — the store's own observability. */
  stats(): Record<MemoryStatus, number>;
  close(): void;
};

export type RinaMemoryOptions = {
  dir: string;
  /** The write-side redaction seam (one exit, like the operation log). */
  redact?: (content: string) => string;
};

/** The legal transitions: draft may go live, active may retire, active may
 * be superseded by another memory. Nothing resurrects a retired entry. */
const LEGAL_TRANSITIONS: Record<MemoryStatus, readonly MemoryStatus[]> = {
  draft: ["active", "stale"],
  active: ["stale", "superseded"],
  stale: ["superseded"],
  superseded: [],
};

/**
 * The unavailable twin (the vault's discipline): a store that will not
 * open becomes a service whose recalls are EMPTY and whose writes fail
 * LOUD with the reason — availability is queried, never announced at
 * birth, and telemetry must never be able to kill the boot.
 */
export function createUnavailableRinaMemory(reason: string): RinaMemoryService {
  const unavailable = {
    ok: false as const,
    reason: `memory unavailable: ${reason}`,
  };
  return {
    remember: () => {
      throw new Error(`memory unavailable: ${reason}`);
    },
    transition: () => unavailable,
    recall: () => [],
    get: () => undefined,
    history: () => [],
    stats: () => ({ draft: 0, active: 0, stale: 0, superseded: 0 }),
    close: () => {},
  };
}

export function createRinaMemory(
  options: RinaMemoryOptions,
): RinaMemoryService {
  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  const db = new Database(join(options.dir, "memory.sqlite"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      superseded_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memories_scope_status ON memories (scope, status);
    CREATE TABLE IF NOT EXISTS memory_history (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      action TEXT NOT NULL,
      at TEXT NOT NULL
    );
  `);
  const insert = db.prepare(`
    INSERT OR REPLACE INTO memories
      (id, scope, content, status, evidence_id, superseded_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
  `);
  const updateStatus = db.prepare(`
    UPDATE memories SET status = ?, superseded_by = ?, updated_at = ? WHERE id = ?
  `);
  const historyInsert = db.prepare(`
    INSERT OR REPLACE INTO memory_history (id, memory_id, action, at) VALUES (?, ?, ?, ?)
  `);

  type Row = {
    id: string;
    scope: string;
    content: string;
    status: string;
    evidence_id: string;
    superseded_by: string | null;
    created_at: string;
    updated_at: string;
  };

  const toEntry = (row: Row): MemoryEntry => ({
    id: row.id,
    scope: row.scope as MemoryScope,
    content: row.content,
    status: row.status as MemoryStatus,
    evidenceID: row.evidence_id,
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  return {
    remember(input) {
      // The admission gates (the study's evidence-backed rule): a source
      // is required, and the only admissible statuses are the pre-live
      // ones — this API cannot smuggle a superseded row in.
      if (!input.evidenceID.trim())
        throw new Error("memory admission requires a source evidence id");
      const status = input.status ?? "draft";
      if (status === "stale" || status === "superseded")
        throw new Error(
          `memory admission refuses ${status}: use transition() — admission creates draft or active`,
        );
      // The default id must be unique per admission: a timestamp-only id
      // collides within a millisecond, and INSERT OR REPLACE would then
      // silently overwrite an earlier memory (three remembers in one
      // millisecond used to become ONE row).
      const id = input.id ?? `mem:${input.scope}:${randomUUID()}`;
      const now = new Date().toISOString();
      const content = options.redact
        ? options.redact(input.content)
        : input.content;
      insert.run(id, input.scope, content, status, input.evidenceID, now, now);
      historyInsert.run(`remember:${id}`, id, `remember:${status}`, now);
      return id;
    },
    transition(id, to, input) {
      const row = db.query("SELECT * FROM memories WHERE id = ?").get(id) as
        | Row
        | undefined;
      if (!row) return { ok: false, reason: "unknown memory id" };
      const from = row.status as MemoryStatus;
      if (!LEGAL_TRANSITIONS[from].includes(to))
        return {
          ok: false,
          reason: `${from} -> ${to} is not a legal transition`,
        };
      // The supersede chain: the target must be named, and must exist.
      if (to === "superseded") {
        if (!input?.supersededBy)
          return { ok: false, reason: "superseded requires supersededBy" };
        const successor = db
          .query("SELECT id FROM memories WHERE id = ?")
          .get(input.supersededBy) as { id: string } | undefined;
        if (!successor)
          return {
            ok: false,
            reason: `supersededBy names an unknown memory: ${input.supersededBy}`,
          };
      }
      const now = new Date().toISOString();
      updateStatus.run(
        to,
        to === "superseded" ? (input?.supersededBy ?? null) : null,
        now,
        id,
      );
      historyInsert.run(`${from}-${to}:${id}`, id, `${from} -> ${to}`, now);
      return { ok: true, status: to };
    },
    recall(input) {
      const filters: string[] = [];
      const args: (string | number)[] = [];
      if (input?.scope) {
        filters.push("scope = ?");
        args.push(input.scope);
      }
      if (!input?.includeInactive) {
        filters.push("status = 'active'");
      }
      const limit = Math.max(1, Math.min(input?.limit ?? 20, 200));
      const rows = db
        .query(
          `SELECT * FROM memories${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""}
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(...args, limit) as Row[];
      return rows.map(toEntry);
    },
    get(id) {
      const row = db.query("SELECT * FROM memories WHERE id = ?").get(id) as
        | Row
        | undefined;
      return row ? toEntry(row) : undefined;
    },
    history(id) {
      // Insertion order (the rowid), not `at`: several transitions in one
      // millisecond share a timestamp, and ordering by it is unstable.
      const rows = db
        .query(
          "SELECT action, at FROM memory_history WHERE memory_id = ? ORDER BY rowid ASC",
        )
        .all(id) as Array<{ action: string; at: string }>;
      return rows;
    },
    stats() {
      const rows = db
        .query("SELECT status, COUNT(*) AS n FROM memories GROUP BY status")
        .all() as Array<{ status: string; n: number }>;
      const base: Record<MemoryStatus, number> = {
        draft: 0,
        active: 0,
        stale: 0,
        superseded: 0,
      };
      for (const row of rows) base[row.status as MemoryStatus] = Number(row.n);
      return base;
    },
    close() {
      db.close();
    },
  };
}
