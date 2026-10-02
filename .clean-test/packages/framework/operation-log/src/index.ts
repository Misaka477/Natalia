export { operationLog } from "./service-token";
import { AsyncLocalStorage } from "node:async_hooks";
import { operationLog } from "./service-token";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/**
 * The runtime operation-log layer (architecture decisions §5: our
 * telemetry zone — volatile, level-adjustable, schema-disciplined like the
 * journal; interface spec §4.5: correlation is injected on the RECORD side
 * so no call site's discipline is load-bearing).
 *
 * The Hermes record-factory pattern (comparative study §4.1) ported to
 * async_hooks: `runWithCorrelation` scopes an ambient correlation bag;
 * every record merges it (bound overrides win), so session/turn/step/
 * ids arrive without callers passing them. One JSONL file per runtime,
 * 0700 dir / 0600 file, size rotation with a bounded keep count (level
 * gating is the primary retention — debug/trace vanish at the default),
 * a serialized async write chain (logs never block the hot path), and a
 * SINGLE redaction hole: the seam runs over the serialized line, so
 * message, fields and ids all pass through one exit (完备性经济学:
 * 统一出口).
 *
 * Telemetry may never crash the runtime: an unwritable directory disables
 * the logger with a recorded reason (stats().disabledReason) instead of
 * throwing — the same honest-degradation rule the store paths follow.
 */

export type OperationLevel = "error" | "warn" | "info" | "debug" | "trace";

const LEVEL_ORDER: Record<OperationLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

/** The frozen event correlation fields plus §4.5's injection list. */
export type CorrelationFields = {
  episodeID?: string;
  sessionID?: string;
  workspaceID?: string;
  agentID?: string;
  turnID?: string;
  stepID?: string;
  toolCallID?: string;
};

export type OperationRecord = {
  at: string;
  level: OperationLevel;
  component: string;
  message: string;
  corr?: CorrelationFields;
  fields?: Record<string, unknown>;
};

export interface ComponentLogger {
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  trace(message: string, fields?: Record<string, unknown>): void;
  /** Bound correlation: wins over the ambient bag for this component. */
  withCorrelation(corr: CorrelationFields): ComponentLogger;
}

export interface OperationLog {
  component(name: string): ComponentLogger;
  /**
   * The converted-telemetry shape: component travels with the call (the
   * bracket tokens vary within a file), so a converted site is one line:
   * `log.info("collab-wake-submit", "scheduling", { sessionID })`.
   */
  error(
    component: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void;
  warn(
    component: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void;
  info(
    component: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void;
  debug(
    component: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void;
  trace(
    component: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void;
  /** The record-side injection: everything logged inside carries `corr`. */
  runWithCorrelation<T>(corr: CorrelationFields, fn: () => T): T;
  currentCorrelation(): CorrelationFields | undefined;
  stats(): {
    path: string | undefined;
    written: number;
    dropped: number;
    rotated: number;
    queued: number;
    disabledReason?: string;
  };
  /** Drain the write chain (tests, shutdown). */
  flush(): Promise<void>;
  close(): Promise<void>;
}

export type OperationLogOptions = {
  /** Where records go. Undefined disables the logger with that reason. */
  dir?: string;
  /** Default gate: `info` (debug/trace only when asked for). */
  level?: OperationLevel;
  /** Rotate the active file past this size (default 8 MiB). */
  maxBytes?: number;
  /** How many rotated files to keep (default 3). */
  keep?: number;
  /** The unified redaction exit — runs over each serialized line. */
  redact?: (line: string) => string;
  /** Bound the write backlog (default 4096 records) — overflow drops. */
  maxQueued?: number;
};

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_KEEP = 3;
const DEFAULT_MAX_QUEUED = 4096;

export type OperationLogStats = {
  path: string | undefined;
  written: number;
  dropped: number;
  rotated: number;
  queued: number;
  disabledReason?: string;
};

function serialize(record: OperationRecord): string {
  const shaped: Record<string, unknown> = {
    at: record.at,
    level: record.level,
    component: record.component,
    message: record.message,
    ...(record.corr && Object.keys(record.corr).length > 0
      ? { corr: record.corr }
      : {}),
    ...(record.fields ? { fields: record.fields } : {}),
  };
  return JSON.stringify(shaped);
}

function describeDisabled(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code ? `${code}: ${message}` : message;
}

export function createOperationLog(
  options: OperationLogOptions = {},
): OperationLog {
  const level = options.level ?? "info";
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = options.keep ?? DEFAULT_KEEP;
  const maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
  const redact = options.redact;
  const als = new AsyncLocalStorage<CorrelationFields>();

  const stats: OperationLogStats = {
    path: options.dir ? join(options.dir, "operations.jsonl") : undefined,
    written: 0,
    dropped: 0,
    rotated: 0,
    queued: 0,
    ...(options.dir ? {} : { disabledReason: "no log directory configured" }),
  };

  let fd: number | undefined;
  let bytes = 0;
  let chain: Promise<void> = Promise.resolve();

  function disable(error: unknown): void {
    stats.disabledReason ??= describeDisabled(error);
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
      fd = undefined;
    }
  }

  function ensureOpen(): boolean {
    if (stats.disabledReason) return false;
    if (fd !== undefined) return true;
    try {
      mkdirSync(options.dir!, { recursive: true, mode: 0o700 });
      fd = openSync(stats.path!, "a", 0o600);
      try {
        bytes = statSync(stats.path!).size;
      } catch {
        bytes = 0;
      }
      return true;
    } catch (error) {
      disable(error);
      return false;
    }
  }

  function rotateIfNeeded(): void {
    if (fd === undefined || bytes < maxBytes) return;
    try {
      closeSync(fd);
    } catch {
      /* closing before the rename either way */
    }
    fd = undefined;
    try {
      const target = `${stats.path!}.${keep}`;
      rmSync(target, { force: true });
      for (let index = keep - 1; index >= 1; index -= 1) {
        const from = `${stats.path!}.${index}`;
        try {
          renameSync(from, `${stats.path!}.${index + 1}`);
        } catch {
          /* missing generations are fine */
        }
      }
      renameSync(stats.path!, `${stats.path!}.1`);
      stats.rotated += 1;
      bytes = 0;
      // Reopen immediately: the active file must exist after ANY write —
      // a reader (the query primitives, the debug bundle) looks for
      // `operations.jsonl`, not for "whatever the next record creates".
      ensureOpen();
    } catch (error) {
      disable(error);
    }
  }

  function writeRecord(record: OperationRecord): void {
    if (stats.disabledReason) {
      stats.dropped += 1;
      return;
    }
    if (LEVEL_ORDER[record.level] > LEVEL_ORDER[level]) return;
    const line = `${redact ? redact(serialize(record)) : serialize(record)}\n`;
    if (!ensureOpen()) {
      stats.dropped += 1;
      return;
    }
    try {
      writeSync(fd!, line);
      bytes += Buffer.byteLength(line);
      stats.written += 1;
      rotateIfNeeded();
    } catch (error) {
      disable(error);
      stats.dropped += 1;
    }
  }

  function enqueue(record: OperationRecord): void {
    if (stats.queued >= maxQueued) {
      stats.dropped += 1;
      return;
    }
    stats.queued += 1;
    // The chain IS the serialization: one writer, order preserved, the
    // caller returns immediately (logs never enter the hot path).
    chain = chain.then(() => {
      stats.queued -= 1;
      writeRecord(record);
    });
  }

  function makeLogger(
    component: string,
    bound?: CorrelationFields,
  ): ComponentLogger {
    const emit =
      (recordLevel: OperationLevel) =>
      (message: string, fields?: Record<string, unknown>) => {
        const corr = { ...als.getStore(), ...bound };
        enqueue({
          at: new Date().toISOString(),
          level: recordLevel,
          component,
          message,
          ...(Object.keys(corr).length > 0 ? { corr } : {}),
          ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
        });
      };
    return {
      error: emit("error"),
      warn: emit("warn"),
      info: emit("info"),
      debug: emit("debug"),
      trace: emit("trace"),
      withCorrelation: (corr) => makeLogger(component, { ...bound, ...corr }),
    };
  }

  const direct =
    (recordLevel: OperationLevel) =>
    (component: string, message: string, fields?: Record<string, unknown>) =>
      makeLogger(component)[recordLevel](message, fields);

  return {
    error: direct("error"),
    warn: direct("warn"),
    info: direct("info"),
    debug: direct("debug"),
    trace: direct("trace"),
    component: (name) => makeLogger(name),
    runWithCorrelation: (corr, fn) =>
      als.run({ ...als.getStore(), ...corr }, fn),
    currentCorrelation: () => als.getStore(),
    stats: () => ({ ...stats, queued: stats.queued }),
    flush: async () => {
      await chain;
    },
    close: async () => {
      await chain;
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* closing twice is fine */
        }
        fd = undefined;
      }
    },
  };
}

/** A logger that records nothing — telemetry degrades, never crashes. */
export const noopOperationLog: OperationLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  component: () => ({
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
    withCorrelation: () => noOpLogger,
  }),
  runWithCorrelation: (_corr, fn) => fn(),
  currentCorrelation: () => undefined,
  stats: () => ({
    path: undefined,
    written: 0,
    dropped: 0,
    rotated: 0,
    queued: 0,
    disabledReason: "no operation log provided",
  }),
  flush: async () => {},
  close: async () => {},
};

const noOpLogger: ComponentLogger = noopOperationLog.component("noop");

/**
 * The call-site helper: the provided log when the runtime has one, the
 * no-op otherwise — converted telemetry never grows optional-chaining
 * and never throws in a bare context.
 */
export function logOf(directory: {
  getOptional(token: unknown): OperationLog | undefined;
}): OperationLog {
  return directory.getOptional(operationLog) ?? noopOperationLog;
}

// ---------------------------------------------------------------------------
// The read side: diagnostics are read as often as written (interface spec
// §4.5's query primitives), so the file's owner also reads it — active file
// plus rotated generations, newest last, one filter shape the unified query
// reuses.
// ---------------------------------------------------------------------------

export type OperationLogFilter = {
  /** ISO timestamp; records at or after it (default: from the beginning). */
  since?: string;
  /** Minimum severity: "warn" returns warn+error, "error" only errors. */
  level?: OperationLevel;
  component?: string;
  /** Case-insensitive substring over the whole serialized record. */
  contains?: string;
  /** Keep only the newest N records (after filtering). */
  limit?: number;
};

/**
 * Reads a log directory's records (active + rotated), filtered by the one
 * query shape. Malformed lines are skipped — a half-written line at a crash
 * must not hide the lines around it.
 */
export function readOperationRecords(
  dir: string,
  filter: OperationLogFilter = {},
): OperationRecord[] {
  const paths = [
    join(dir, "operations.jsonl.5"),
    join(dir, "operations.jsonl.4"),
    join(dir, "operations.jsonl.3"),
    join(dir, "operations.jsonl.2"),
    join(dir, "operations.jsonl.1"),
    join(dir, "operations.jsonl"),
  ];
  const records: OperationRecord[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue; // absent generation
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let record: OperationRecord;
      try {
        record = JSON.parse(line) as OperationRecord;
      } catch {
        continue;
      }
      if (filter.level && LEVEL_ORDER[record.level] > LEVEL_ORDER[filter.level])
        continue;
      if (filter.component && record.component !== filter.component) continue;
      if (filter.since && (!record.at || record.at < filter.since)) continue;
      if (
        filter.contains &&
        !JSON.stringify(record)
          .toLowerCase()
          .includes(filter.contains.toLowerCase())
      )
        continue;
      records.push(record);
    }
  }
  // keep = read oldest generation first ... newest last; limit keeps the tail.
  return filter.limit ? records.slice(-filter.limit) : records;
}
