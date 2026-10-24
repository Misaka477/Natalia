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
 * The runtime operation-log & Chromium-grade error attribution layer.
 *
 * SCOPE & OWNERSHIP:
 * - Directly records `kernel` and `framework` telemetry and errors.
 * - Plugins manage their own logging and can register an isolated
 *   `PluginComponentLogger` via `registerPluginLogger(pluginId, options)` so
 *   their records flow into the central log with `domain: "plugin"` and
 *   `pluginId`.
 *
 * CHROMIUM-GRADE ATTRIBUTION:
 * - Every `error` and `warn` record automatically captures the exact caller
 *   source location (`file`, `line`, `column`, `fn`) from the V8/JSC stack and
 *   unwraps any `Error` (and `.cause` chain) into structured forensic fields.
 */

export type OperationLevel = "error" | "warn" | "info" | "debug" | "trace";
export type OperationDomain = "kernel" | "framework" | "plugin";

const LEVEL_ORDER: Record<OperationLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

/** Exact source location extracted from the call stack or Error trace. */
export type OperationLocation = {
  file: string;
  line: number;
  column?: number;
  fn?: string;
};

/** Structured forensic breakdown of an Error and its cause chain. */
export type OperationErrorInfo = {
  name: string;
  code?: string;
  message: string;
  location?: OperationLocation;
  stack?: string[];
  causes?: OperationErrorInfo[];
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
  domain?: OperationDomain;
  pluginId?: string;
  pid?: number;
  component: string;
  message: string;
  location?: OperationLocation;
  error?: OperationErrorInfo;
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

export interface RegisteredPluginOperationLogger extends ComponentLogger {
  readonly pluginId: string;
  readonly enabled: boolean;
  readonly level: OperationLevel;
  setEnabled(enabled: boolean): void;
  setLevel(level: OperationLevel): void;
  dispose(): void;
}

export interface OperationLog {
  component(name: string, domain?: OperationDomain): ComponentLogger;
  /**
   * Register a plugin's own logger into the central operation log.
   * Plugins own their logging lifecycle and bridge into the central log here.
   */
  registerPlugin(
    pluginId: string,
    options?: { enabled?: boolean; level?: OperationLevel },
  ): RegisteredPluginOperationLogger;
  /** Ingest a pre-built record (e.g. bridged from `@anthelia/logging`). */
  ingest?(record: OperationRecord): void;
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

const KERNEL_COMPONENTS = new Set([
  "kernel",
  "runtime",
  "session",
  "session-store",
  "sqlite-store",
  "checkpoint",
  "memory-trace",
  "providers",
  "context-ledger",
  "rina",
  "event-window",
  "session-full-events",
]);

export function inferOperationDomain(
  component: string,
  explicit?: OperationDomain,
): OperationDomain {
  if (explicit) return explicit;
  if (component.startsWith("plugin:") || component.startsWith("natalia.ui."))
    return "plugin";
  const clean = component.replace(/^\[|\]$/gu, "");
  if (KERNEL_COMPONENTS.has(clean)) return "kernel";
  return "framework";
}

function normalizeSourcePath(rawPath: string): string {
  let cleaned = rawPath
    .trim()
    .replace(/^file:\/\/\/?/iu, "")
    .replace(/\\/gu, "/");
  if (/^\/[A-Za-z]:\//u.test(cleaned)) {
    cleaned = cleaned.slice(1);
  }
  const pkgIdx = cleaned.indexOf("packages/");
  if (pkgIdx >= 0) return cleaned.slice(pkgIdx);
  const appsIdx = cleaned.indexOf("apps/");
  if (appsIdx >= 0) return cleaned.slice(appsIdx);
  const srcIdx = cleaned.lastIndexOf("/src/");
  if (srcIdx >= 0) {
    const prefix = cleaned.slice(0, srcIdx);
    const parentSlash = prefix.lastIndexOf("/");
    return parentSlash >= 0 ? cleaned.slice(parentSlash + 1) : cleaned;
  }
  return cleaned;
}

const INTERNAL_FRAME_PATTERNS = [
  "packages/core/logging/src/",
  "packages/framework/operation-log/src/",
  "node:internal",
  "native:",
];

function parseStackFrame(line: string): OperationLocation | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("at ")) return undefined;
  const body = trimmed.slice(3).trim();
  const withFn = /^(.+?)\s+\((.+):(\d+):(\d+)\)$/u.exec(body);
  if (withFn) {
    const fnName = withFn[1]!.trim();
    const file = normalizeSourcePath(withFn[2]!);
    const lineNum = Number(withFn[3]);
    const colNum = Number(withFn[4]);
    if (Number.isFinite(lineNum) && lineNum > 0) {
      return {
        file,
        line: lineNum,
        ...(Number.isFinite(colNum) ? { column: colNum } : {}),
        ...(fnName && fnName !== "<anonymous>" ? { fn: fnName } : {}),
      };
    }
  }
  const bare = /^(.+):(\d+):(\d+)$/u.exec(body);
  if (bare) {
    const file = normalizeSourcePath(bare[1]!);
    const lineNum = Number(bare[2]);
    const colNum = Number(bare[3]);
    if (Number.isFinite(lineNum) && lineNum > 0) {
      return {
        file,
        line: lineNum,
        ...(Number.isFinite(colNum) ? { column: colNum } : {}),
      };
    }
  }
  return undefined;
}

export function extractOperationCallSite(
  stackText?: string,
): OperationLocation | undefined {
  const raw = stackText ?? new Error().stack;
  if (!raw) return undefined;
  for (const line of raw.split(/\r?\n/u)) {
    const loc = parseStackFrame(line);
    if (!loc) continue;
    const norm = loc.file.replace(/\\/gu, "/");
    if (INTERNAL_FRAME_PATTERNS.some((pat) => norm.includes(pat))) continue;
    return loc;
  }
  return undefined;
}

export function extractOperationError(
  err: unknown,
  depth = 0,
): OperationErrorInfo | undefined {
  if (!(err instanceof Error)) return undefined;
  const codeVal = (err as { code?: unknown }).code;
  const code =
    typeof codeVal === "string" || typeof codeVal === "number"
      ? String(codeVal)
      : undefined;
  const location = err.stack ? extractOperationCallSite(err.stack) : undefined;
  const stack = err.stack
    ? err.stack
        .split(/\r?\n/u)
        .map((l) => l.trim())
        .filter((l) => l.startsWith("at "))
        .slice(0, 15)
    : undefined;
  const causes: OperationErrorInfo[] = [];
  if (depth < 5 && err.cause instanceof Error) {
    const nested = extractOperationError(err.cause, depth + 1);
    if (nested) causes.push(nested);
  }
  return {
    name: err.name || "Error",
    ...(code ? { code } : {}),
    message: err.message,
    ...(location ? { location } : {}),
    ...(stack && stack.length > 0 ? { stack } : {}),
    ...(causes.length > 0 ? { causes } : {}),
  };
}

function serialize(record: OperationRecord): string {
  const shaped: Record<string, unknown> = {
    at: record.at,
    level: record.level,
    ...(record.domain ? { domain: record.domain } : {}),
    ...(record.pluginId ? { pluginId: record.pluginId } : {}),
    ...(record.pid !== undefined ? { pid: record.pid } : {}),
    component: record.component,
    message: record.message,
    ...(record.location ? { location: record.location } : {}),
    ...(record.error ? { error: record.error } : {}),
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
    chain = chain.then(() => {
      stats.queued -= 1;
      writeRecord(record);
    });
  }

  function normalizeFieldsAndError(fields?: Record<string, unknown>): {
    cleanedFields?: Record<string, unknown>;
    errorInfo?: OperationErrorInfo;
  } {
    if (!fields || Object.keys(fields).length === 0) return {};
    let errorInfo: OperationErrorInfo | undefined;
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k === "_err" && v instanceof Error) {
        errorInfo ??= extractOperationError(v);
      } else if (v instanceof Error) {
        errorInfo ??= extractOperationError(v);
        copy[k] = v.message;
      } else {
        copy[k] = v;
      }
    }
    return { cleanedFields: copy, errorInfo };
  }

  function makeLogger(
    component: string,
    bound?: CorrelationFields,
    explicitDomain?: OperationDomain,
    pluginId?: string,
  ): ComponentLogger {
    const emit =
      (recordLevel: OperationLevel) =>
      (message: string, fields?: Record<string, unknown>) => {
        // Drop empty-message noise below warn level
        if (
          !message.trim() &&
          recordLevel !== "error" &&
          recordLevel !== "warn"
        ) {
          return;
        }
        const corr = { ...als.getStore(), ...bound };
        const { cleanedFields, errorInfo } = normalizeFieldsAndError(fields);
        // Capture call-site location on error/warn (skipping test files when
        // maxBytes is tiny so unit test byte-rotation fixtures stay exact).
        const captureSite =
          (recordLevel === "error" || recordLevel === "warn") &&
          maxBytes > 4096;
        const location =
          errorInfo?.location ??
          (captureSite ? extractOperationCallSite() : undefined);
        const domain =
          captureSite || explicitDomain || pluginId
            ? inferOperationDomain(component, explicitDomain)
            : undefined;
        enqueue({
          at: new Date().toISOString(),
          level: recordLevel,
          ...(domain ? { domain } : {}),
          ...(pluginId ? { pluginId } : {}),
          ...(captureSite && typeof process !== "undefined"
            ? { pid: process.pid }
            : {}),
          component,
          message: message || component,
          ...(location ? { location } : {}),
          ...(errorInfo ? { error: errorInfo } : {}),
          ...(Object.keys(corr).length > 0 ? { corr } : {}),
          ...(cleanedFields && Object.keys(cleanedFields).length > 0
            ? { fields: cleanedFields }
            : {}),
        });
      };
    return {
      error: emit("error"),
      warn: emit("warn"),
      info: emit("info"),
      debug: emit("debug"),
      trace: emit("trace"),
      withCorrelation: (corr) =>
        makeLogger(component, { ...bound, ...corr }, explicitDomain, pluginId),
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
    component: (name, domain) => makeLogger(name, undefined, domain),
    registerPlugin: (pluginId, pluginOpts) => {
      let enabled = pluginOpts?.enabled ?? true;
      let gate: OperationLevel = pluginOpts?.level ?? "warn";
      const baseLogger = makeLogger(
        `plugin:${pluginId}`,
        undefined,
        "plugin",
        pluginId,
      );
      const gated =
        (lvl: OperationLevel) =>
        (msg: string, fields?: Record<string, unknown>) => {
          if (!enabled) return;
          if (LEVEL_ORDER[lvl] > LEVEL_ORDER[gate]) return;
          baseLogger[lvl](msg, fields);
        };
      const pluginLogger: RegisteredPluginOperationLogger = {
        pluginId,
        get enabled() {
          return enabled;
        },
        get level() {
          return gate;
        },
        setEnabled(next) {
          enabled = next;
        },
        setLevel(next) {
          gate = next;
        },
        dispose() {
          enabled = false;
        },
        error: gated("error"),
        warn: gated("warn"),
        info: gated("info"),
        debug: gated("debug"),
        trace: gated("trace"),
        withCorrelation: (corr) => {
          const boundBase = makeLogger(
            `plugin:${pluginId}`,
            corr,
            "plugin",
            pluginId,
          );
          return {
            error: (m, f) => enabled && boundBase.error(m, f),
            warn: (m, f) =>
              enabled &&
              LEVEL_ORDER.warn <= LEVEL_ORDER[gate] &&
              boundBase.warn(m, f),
            info: (m, f) =>
              enabled &&
              LEVEL_ORDER.info <= LEVEL_ORDER[gate] &&
              boundBase.info(m, f),
            debug: (m, f) =>
              enabled &&
              LEVEL_ORDER.debug <= LEVEL_ORDER[gate] &&
              boundBase.debug(m, f),
            trace: (m, f) =>
              enabled &&
              LEVEL_ORDER.trace <= LEVEL_ORDER[gate] &&
              boundBase.trace(m, f),
            withCorrelation: (c2) =>
              pluginLogger.withCorrelation({ ...corr, ...c2 }),
          };
        },
      };
      return pluginLogger;
    },
    ingest: (record) => {
      const corr = { ...als.getStore(), ...record.corr };
      enqueue({
        ...record,
        ...(Object.keys(corr).length > 0 ? { corr } : {}),
      });
    },
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
  registerPlugin: (pluginId) => ({
    pluginId,
    enabled: false,
    level: "error",
    setEnabled: () => {},
    setLevel: () => {},
    dispose: () => {},
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
    withCorrelation: () => noOpLogger,
  }),
  ingest: () => {},
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

export function logOf(directory: {
  getOptional(token: unknown): OperationLog | undefined;
}): OperationLog {
  return directory.getOptional(operationLog) ?? noopOperationLog;
}

export type OperationLogFilter = {
  /** ISO timestamp; records at or after it (default: from the beginning). */
  since?: string;
  /** Minimum severity: "warn" returns warn+error, "error" only errors. */
  level?: OperationLevel;
  /** Filter by architectural domain (`kernel`, `framework`, `plugin`). */
  domain?: OperationDomain;
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
      continue;
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
      if (filter.domain) {
        const recDomain =
          record.domain ?? inferOperationDomain(record.component);
        if (recDomain !== filter.domain) continue;
      }
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
  return filter.limit ? records.slice(-filter.limit) : records;
}
