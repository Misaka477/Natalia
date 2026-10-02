import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SubagentRecord } from "./types";

const MANIFEST = "manifest.json";

export class SubagentStore {
  readonly dir: string;
  private readonly sessionID?: string;

  constructor(workDir?: string, sessionID?: string) {
    this.sessionID = sessionID;
    if (sessionID) {
      this.dir = resolve(
        workDir ?? ".",
        ".natalia",
        "sessions",
        sessionID,
        "subagents",
      );
    } else {
      this.dir = resolve(workDir ?? ".", ".natalia", "subagents");
    }
  }

  async load(): Promise<SubagentRecord[]> {
    let records: SubagentRecord[];
    let migratedLegacy = false;
    try {
      const content = await readFile(this.path(), "utf8");
      const raw = JSON.parse(content);
      records = Array.isArray(raw)
        ? raw
            .filter((r: unknown): r is SubagentRecord => isValidRecord(r))
            .map((record) => ({
              ...record,
              continuation: record.continuation ?? 0,
            }))
        : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      records = await this.loadLegacy();
      migratedLegacy = records.length > 0;
    }
    const repaired = this.backfillParentSession(records);
    if (repaired.changed || migratedLegacy) await this.save(repaired.records);
    return repaired.records;
  }

  async save(records: SubagentRecord[]): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.path(), `${JSON.stringify(records, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  private backfillParentSession(records: SubagentRecord[]): {
    records: SubagentRecord[];
    changed: boolean;
  } {
    if (!this.sessionID) return { records, changed: false };
    let changed = false;
    const repaired = records.map((record) => {
      if (record.parentSessionID) return record;
      changed = true;
      return { ...record, parentSessionID: this.sessionID };
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
