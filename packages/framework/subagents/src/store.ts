import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AuditEntry, SubagentRecord } from "./types";

const MANIFEST = "manifest.json";

export class SubagentStore {
  private readonly workDir: string;
  /**
   * The owning session, resolved LIVE at each operation.
   *
   * It used to be a string captured when the store was built — and the store
   * is built while `installSubagents` runs, which is BEFORE
   * `recoverSession`. A boot with no active session yet therefore froze the
   * workspace-level path (`.natalia/subagents/`) into every later save, so
   * whether a child's record was session-scoped or workspace-scoped depended
   * on the host's startup order (G2-16). The other three agents scope by the
   * session that owns the turn; this now asks the same question at the same
   * time they do.
   */
  private readonly sessionID?: () => string | undefined;

  constructor(
    workDir?: string,
    sessionID?: string | (() => string | undefined),
  ) {
    this.workDir = workDir ?? ".";
    this.sessionID =
      typeof sessionID === "function"
        ? sessionID
        : sessionID
          ? () => sessionID
          : undefined;
  }

  /** The store's directory, resolved against the CURRENT session. */
  get dir(): string {
    const sessionID = this.sessionID?.();
    return sessionID
      ? resolve(this.workDir, ".natalia", "sessions", sessionID, "subagents")
      : resolve(this.workDir, ".natalia", "subagents");
  }

  async load(): Promise<{
    records: SubagentRecord[];
    audit: AuditEntry[];
  }> {
    let records: SubagentRecord[];
    let audit: AuditEntry[] = [];
    let migratedLegacy = false;
    try {
      const content = await readFile(this.path(), "utf8");
      const raw = JSON.parse(content) as unknown;
      if (Array.isArray(raw)) {
        // The legacy manifest was a bare array of records; the audit trail
        // simply did not exist yet.
        records = raw
          .filter((r: unknown): r is SubagentRecord => isValidRecord(r))
          .map((record) => ({
            ...record,
            continuation: record.continuation ?? 0,
          }));
      } else if (raw && typeof raw === "object") {
        const manifest = raw as {
          records?: unknown;
          audit?: unknown;
        };
        records = Array.isArray(manifest.records)
          ? manifest.records
              .filter((r: unknown): r is SubagentRecord => isValidRecord(r))
              .map((record) => ({
                ...record,
                continuation: record.continuation ?? 0,
              }))
          : [];
        audit = Array.isArray(manifest.audit)
          ? (manifest.audit as AuditEntry[])
          : [];
      } else {
        records = [];
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return { records: [], audit: [] };
      records = await this.loadLegacy();
      migratedLegacy = records.length > 0;
    }
    const repaired = this.backfillParentSession(records);
    if (repaired.changed || migratedLegacy)
      await this.save(repaired.records, audit);
    return { records: repaired.records, audit };
  }

  async save(
    records: SubagentRecord[],
    audit: readonly AuditEntry[] = [],
  ): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(
      this.path(),
      `${JSON.stringify({ version: 2, records, audit }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  private backfillParentSession(records: SubagentRecord[]): {
    records: SubagentRecord[];
    changed: boolean;
  } {
    const sessionID = this.sessionID?.();
    if (!sessionID) return { records, changed: false };
    let changed = false;
    const repaired = records.map((record) => {
      if (record.parentSessionID) return record;
      changed = true;
      return { ...record, parentSessionID: sessionID };
    });
    return { records: repaired, changed };
  }

  private async loadLegacy(): Promise<SubagentRecord[]> {
    try {
      const files = await readdir(this.dir, { withFileTypes: true });
      const records: SubagentRecord[] = [];
      for (const entry of files) {
        if (
          !entry.isFile() ||
          !entry.name.endsWith(".json") ||
          entry.name === MANIFEST
        )
          continue;
        try {
          const content = await readFile(join(this.dir, entry.name), "utf8");
          const rec = JSON.parse(content) as SubagentRecord;
          if (isValidRecord(rec)) records.push(rec);
        } catch {
          // skip corrupt
        }
      }
      return records;
    } catch {
      return [];
    }
  }

  private path(): string {
    return join(this.dir, MANIFEST);
  }
}

function isValidRecord(r: unknown): r is SubagentRecord {
  if (!r || typeof r !== "object") return false;
  const rec = r as Record<string, unknown>;
  return (
    typeof rec.id === "string" &&
    typeof rec.task === "string" &&
    typeof rec.status === "string" &&
    Array.isArray(rec.outputs)
  );
}
