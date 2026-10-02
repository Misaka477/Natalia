import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { hashTreeFiles } from "@anthelia/platform";
import {
  resolveWorkspaceJsonSessionsDir,
  resolveWorkspaceJournalDatabasePath,
} from "@anthelia/platform";
import { queryDiagnostics } from "@natalia/client";
import { readOperationRecords } from "@anthelia/operation-log";
import { doctorReport } from "./index";

/**
 * `natalia debug-bundle <dest>` — the one-key capture (decisions §5:
 * 调试包一键捕获; DoD #4's "an incident is located from logs alone").
 *
 * The bundle is everything the replay-is-debugging claim needs: the raw
 * journal slice, the operational log generations, the (redacted) configs,
 * the doctor report and a query-produced recents summary — plus a
 * SHA256SUMS inventory, the same verification discipline the release and
 * store-export artifacts use (platform's hashTreeFiles, one walk).
 *
 * It is a LOG artifact, not a data copy: checkpoints stay home (only the
 * session journal travels), and config values that look like secrets are
 * the one redaction hole — tested, because a debug bundle that leaks a
 * key turns diagnosis into an incident of its own.
 */

/** The one secret rule: key names that never travel in a bundle. */
export const SECRET_KEY_PATTERN =
  /(secret|token|password|passwd|apikey|api[_-]key|credential|authorization|private[-_]?key)/iu;

export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value))
    return value.map((entry) => redactSecrets(entry)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>))
      out[key] = SECRET_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : redactSecrets(entry);
    return out as T;
  }
  return value;
}

async function copyIfPresent(from: string, to: string): Promise<boolean> {
  try {
    await stat(from);
  } catch {
    return false;
  }
  await cp(from, to, { recursive: true });
  return true;
}

export type BundleReport = {
  dest: string;
  files: number;
  bytes: number;
  captured: {
    journal: boolean;
    operationalRecords: number;
    workspaceConfig: boolean;
    globalConfig: boolean;
    doctor: boolean;
  };
};

export async function captureDebugBundle(input: {
  workspaceRoot: string;
  dest: string;
  /** The Natalia home (defaults to NATALIA_HOME, else ~/.natalia). */
  nataliaHome?: string;
}): Promise<BundleReport> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const dest = resolve(input.dest);
  const home =
    input.nataliaHome ??
    process.env.NATALIA_HOME ??
    join(homedir(), ".natalia");
  // Refuse to write into an existing tree — a bundle is a snapshot, and
  // silently merging into an old one would mix two incidents.
  try {
    await stat(dest);
    throw new Error(`destination exists (bundles are snapshots): ${dest}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dest, { recursive: true });

  // 1. The journal slice: sessions (json or sqlite) — the replay source.
  const jsonSessions = resolveWorkspaceJsonSessionsDir(workspaceRoot);
  const sqliteJournal = resolveWorkspaceJournalDatabasePath(workspaceRoot);
  const journalCopied =
    (await copyIfPresent(jsonSessions, join(dest, "journal", "sessions"))) ||
    (await copyIfPresent(sqliteJournal, join(dest, "journal", "sessions.db")));

  // 2. The operational log, active + rotated generations.
  const logsDir = join(home, "logs");
  let operationalRecords = 0;
  try {
    for (const entry of await readdir(logsDir)) {
      if (entry.startsWith("operations.jsonl"))
        await copyIfPresent(
          join(logsDir, entry),
          join(dest, "operations", entry),
        );
    }
    operationalRecords = readOperationRecords(logsDir).length;
  } catch {
    /* no logs yet: the summary below stays empty */
  }

  // 3. Configs, through the single redaction hole.
  const workspaceConfig = join(workspaceRoot, ".natalia", "config.json");
  const globalConfig = join(home, "config.json");
  let haveWorkspaceConfig = false;
  let haveGlobalConfig = false;
  // The directory exists BEFORE either write (the first version wrote into
  // it before creating it and swallowed the ENOENT as "config absent").
  await mkdir(join(dest, "config"), { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(workspaceConfig, "utf8"));
    await writeFile(
      join(dest, "config", "workspace.json"),
      `${JSON.stringify(redactSecrets(parsed), null, 2)}\n`,
      "utf8",
    );
    haveWorkspaceConfig = true;
  } catch {
    /* absent is fine */
  }
  try {
    const parsed = JSON.parse(await readFile(globalConfig, "utf8"));
    await writeFile(
      join(dest, "config", "global.json"),
      `${JSON.stringify(redactSecrets(parsed), null, 2)}\n`,
      "utf8",
    );
    haveGlobalConfig = true;
  } catch {
    /* absent is fine */
  }

  // 4. Doctor + the query primitive's own view (one filter shape).
  let haveDoctor = false;
  try {
    const report = await doctorReport({
      configPath: workspaceConfig,
      workspaceRoot,
    });
    await writeFile(
      join(dest, "doctor.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    haveDoctor = true;
  } catch {
    /* doctor needs a resolvable config; absence is itself informative */
  }
  const recents = queryDiagnostics({
    events: [],
    records: readOperationRecords(logsDir),
    filter: { level: "warn", limit: 200 },
  });
  await writeFile(
    join(dest, "recent-diagnostics.json"),
    `${JSON.stringify({ capturedAt: new Date().toISOString(), ...recents }, null, 2)}\n`,
    "utf8",
  );

  // 5. The inventory (D1/D2 discipline).
  const { files, bytes } = await hashTreeFiles(dest);
  await writeFile(
    join(dest, "SHA256SUMS"),
    `${files.map((file) => `${file.sha256}  ${file.file}`).join("\n")}\n`,
    "utf8",
  );
  return {
    dest,
    files: files.length,
    bytes,
    captured: {
      journal: journalCopied,
      operationalRecords,
      workspaceConfig: haveWorkspaceConfig,
      globalConfig: haveGlobalConfig,
      doctor: haveDoctor,
    },
  };
}
