/**
 * The kernel and framework logging & error attribution system (Chromium standard).
 *
 * Every subsystem gets a NAMED logger (`getLogger("runtime")`), every level
 * is filtered PER NAME by the exporter's threshold table, and the default
 * table is silent below `error` — so call sites are unconditional and the
 * verbosity is a deployment choice, not a code choice.
 *
 * SCOPE & PLUGIN ISOLATION:
 * - The central log service owns the `kernel` and `framework` domains directly.
 * - Plugins own their own logging instances (`registerPluginLogger(pluginId)`),
 *   which bridge into the central hub under `domain: "plugin"` only when
 *   registered, with independent per-plugin level and enablement controls.
 *
 * CHROMIUM-GRADE ATTRIBUTION:
 * - Every error/warning record (and any record carrying an Error object)
 *   automatically extracts the exact source call site (`file:line:column` and
 *   function name) plus the unwrapped `Error.cause` chain and error codes
 *   (`ENOENT`, `SQLITE_ERROR`, etc.), so an operator can locate the exact fault
 *   line in one glance (`[PID:domain:MMDD/HHMMSS.mmm:LEVEL:file.ts(line)]`).
 */

/** Severity, ordered. Numeric so threshold tables are data, not code. */
export const LoggerLevel = {
  error: 0,
  info: 1,
  warn: 2,
  debug: 3,
} as const;

/** The type as call sites spell it. */
export type LoggerLevelName = keyof typeof LoggerLevel;

/** Architectural ownership domain of a log record. */
export type LogDomain = "kernel" | "framework" | "plugin";

/** Exact source location extracted from the call stack or Error trace. */
export interface LogLocation {
  /** Normalized workspace-relative or basename file path. */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column number when available. */
  readonly column?: number;
  /** Enclosing function or method name when available. */
  readonly fn?: string;
}

/** Structured forensic breakdown of an Error and its cause chain. */
export interface StructuredErrorInfo {
  readonly name: string;
  readonly code?: string;
  readonly message: string;
  readonly location?: LogLocation;
  readonly stack?: readonly string[];
  readonly causes?: readonly StructuredErrorInfo[];
}

/** A structured record, built at the call site and delivered to exporters. */
export interface LogMessage {
  /** Monotonic per process; orders exports across loggers. */
  readonly sn: number;
  /** Epoch milliseconds at the call. */
  readonly ts: number;
  /** Process ID. */
  readonly pid?: number;
  /** Ownership domain: kernel, framework, or registered plugin. */
  readonly domain?: LogDomain;
  /** Populated when `domain === "plugin"`. */
  readonly pluginId?: string;
  /** The logger's name — the per-name threshold table's key. */
  readonly name: string;
  readonly level: LoggerLevelName;
  /** The printf-style format and its arguments, unformatted. */
  readonly args: readonly unknown[];
  /** Automatically captured source call site (`file:line:col`). */
  readonly location?: LogLocation;
  /** Automatically extracted Error chain when an Error is logged. */
  readonly error?: StructuredErrorInfo;
  /** Optional structured key-value context fields. */
  readonly fields?: Readonly<Record<string, unknown>>;
}

/** Rendering options an exporter contributes; a formatter needs only these. */
export interface LogFormatOptions {
  /** Longest line emitted before `...` truncation. Default 10240. */
  readonly maxLength?: number;
}

/**
 * A sink. `levels` maps a logger name (or `default`) to the highest severity
 * still emitted for it; a name with no entry falls back to `default`, and
 * `default` to `error`.
 */
export interface LogExporter extends LogFormatOptions {
  readonly levels?: Readonly<Record<string, LoggerLevelName>>;
  export(message: LogMessage): void;
}

/** A named facade for one subsystem. */
export interface Logger {
  readonly name: string;
  readonly domain?: LogDomain;
  error(format: string, ...args: unknown[]): void;
  info(format: string, ...args: unknown[]): void;
  warn(format: string, ...args: unknown[]): void;
  debug(format: string, ...args: unknown[]): void;
}

/** A plugin-owned logger registered into the central LogService. */
export interface RegisteredPluginLogger extends Logger {
  readonly pluginId: string;
  readonly enabled: boolean;
  readonly level: LoggerLevelName;
  setEnabled(enabled: boolean): void;
  setLevel(level: LoggerLevelName): void;
  dispose(): void;
}

export interface RegisteredPluginLogInfo {
  readonly pluginId: string;
  readonly enabled: boolean;
  readonly level: LoggerLevelName;
}

const LEVEL_NAMES: readonly string[] = ["error", "info", "warn", "debug"];

function isLevelName(value: string): value is LoggerLevelName {
  return LEVEL_NAMES.includes(value);
}

const KERNEL_SUBSYSTEMS = new Set([
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
]);

export function inferLogDomain(
  component: string,
  explicitDomain?: LogDomain,
): LogDomain {
  if (explicitDomain) return explicitDomain;
  if (component.startsWith("plugin:") || component.startsWith("natalia.ui."))
    return "plugin";
  const clean = component.replace(/^\[|\]$/gu, "");
  if (KERNEL_SUBSYSTEMS.has(clean)) return "kernel";
  return "framework";
}

/**
 * Normalize a raw filesystem or URL path from a stack frame into a clean,
 * workspace-relative path (e.g. `packages/framework/client/src/turn-runner.ts`).
 */
export function normalizeSourcePath(rawPath: string): string {
  let cleaned = rawPath
    .trim()
    .replace(/^file:\/\/\/?/iu, "")
    .replace(/\\/gu, "/");
  // Windows drive letter normalization after file:///
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

function isInternalFrame(filePath: string): boolean {
  const norm = filePath.replace(/\\/gu, "/");
  return INTERNAL_FRAME_PATTERNS.some((pat) => norm.includes(pat));
}

/**
 * Parse one V8 / JavaScriptCore stack line into `{ fn, file, line, column }`.
 */
export function parseStackFrameLine(line: string): LogLocation | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("at ")) return undefined;
  const body = trimmed.slice(3).trim();
  // Pattern 1: `at functionName (filePath:line:col)`
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
  // Pattern 2: `at filePath:line:col`
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

/**
 * Extract the caller's exact source location (`file:line:column` + `fn`) by
 * inspecting the current stack and skipping internal logging frames.
 */
export function extractCallSite(
  stackText?: string,
  extraSkipPatterns?: readonly string[],
): LogLocation | undefined {
  const raw = stackText ?? new Error().stack;
  if (!raw) return undefined;
  const lines = raw.split(/\r?\n/u);
  for (const line of lines) {
    const loc = parseStackFrameLine(line);
    if (!loc) continue;
    if (isInternalFrame(loc.file)) continue;
    if (
      extraSkipPatterns?.some((pat) =>
        loc.file.replace(/\\/gu, "/").includes(pat),
      )
    ) {
      continue;
    }
    return loc;
  }
  return undefined;
}

/**
 * Extract a structured forensic representation of an Error and its `.cause`
 * chain, including error codes (`ENOENT`, `SQLITE_ERROR`, etc.), top source
 * location, and cleaned stack frames.
 */
export function extractStructuredError(
  err: unknown,
  depth = 0,
): StructuredErrorInfo | undefined {
  if (!(err instanceof Error)) return undefined;
  const codeValue = (err as { code?: unknown }).code;
  const code =
    typeof codeValue === "string" || typeof codeValue === "number"
      ? String(codeValue)
      : undefined;
  const location = err.stack ? extractCallSite(err.stack) : undefined;
  const stackFrames = err.stack
    ? err.stack
        .split(/\r?\n/u)
        .map((l) => l.trim())
        .filter((l) => l.startsWith("at "))
        .slice(0, 15)
    : undefined;
  const causes: StructuredErrorInfo[] = [];
  if (depth < 5 && err.cause instanceof Error) {
    const nested = extractStructuredError(err.cause, depth + 1);
    if (nested) causes.push(nested);
  }
  return {
    name: err.name || "Error",
    ...(code ? { code } : {}),
    message: err.message,
    ...(location ? { location } : {}),
    ...(stackFrames && stackFrames.length > 0 ? { stack: stackFrames } : {}),
    ...(causes.length > 0 ? { causes } : {}),
  };
}

/**
 * Format a timestamp + record in Chromium's canonical header style:
 * `[PID:domain:MMDD/HHMMSS.mmm:LEVEL:file.ts(line)] [component] message`
 */
export function formatChromiumHeader(input: {
  at: string | number;
  pid?: number;
  domain?: LogDomain;
  level: string;
  location?: LogLocation;
  component: string;
}): string {
  const date =
    typeof input.at === "number" ? new Date(input.at) : new Date(input.at);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const sec = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  const pid = input.pid ?? (typeof process !== "undefined" ? process.pid : 0);
  const domain = input.domain ?? inferLogDomain(input.component);
  const sev = input.level.toUpperCase();
  const locPart = input.location
    ? `:${input.location.file.slice(input.location.file.lastIndexOf("/") + 1)}(${input.location.line})`
    : "";
  return `[${pid}:${domain}:${mm}${dd}/${hh}${min}${sec}.${ms}:${sev}${locPart}] [${input.component}]`;
}

/**
 * Parse a `NATALIA_LOG` spec — `debug`, `error`, or `name=debug,other=warn` —
 * into a threshold table. An unparseable fragment is skipped rather than
 * failing the process: a log spec is diagnostics, and refusing to boot over
 * one would make the system unobservable to fix itself.
 */
export function parseLogSpec(spec: string): Record<string, LoggerLevelName> {
  const levels: Record<string, LoggerLevelName> = {};
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    const name = separator < 0 ? "default" : trimmed.slice(0, separator).trim();
    const level = (
      separator < 0 ? trimmed : trimmed.slice(separator + 1)
    ).trim();
    if (isLevelName(level)) levels[name || "default"] = level;
  }
  return levels;
}

/** The environment's threshold table, or undefined when unset. */
export function logLevelsFromEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, LoggerLevelName> | undefined {
  const spec = env.NATALIA_LOG;
  if (!spec || !spec.trim()) return undefined;
  return parseLogSpec(spec);
}

/** The process-wide service: exporters, the threshold table, and loggers. */
export class LogService {
  private readonly exporters: LogExporter[] = [];
  private levels: Record<string, LoggerLevelName> = { default: "error" };
  private readonly pluginRegistry = new Map<
    string,
    { enabled: boolean; level: LoggerLevelName }
  >();
  private sn = 0;

  /** Add a sink. Returns a disposer. */
  addExporter(exporter: LogExporter): () => void {
    this.exporters.push(exporter);
    return () => {
      const at = this.exporters.indexOf(exporter);
      if (at >= 0) this.exporters.splice(at, 1);
    };
  }

  /** Replace the threshold table wholesale. */
  setLevels(levels: Record<string, LoggerLevelName>): void {
    this.levels = { default: "error", ...levels };
  }

  /** Return the current threshold table copy. */
  getLevels(): Record<string, LoggerLevelName> {
    return { ...this.levels };
  }

  /** The threshold for one logger name, as a number. */
  thresholdFor(name: string): number {
    return LoggerLevel[this.levels[name] ?? this.levels.default ?? "error"];
  }

  /**
   * Register a plugin's own logger into the central log system.
   * Plugins manage their own logging and opt-in to central aggregation here.
   */
  registerPluginLogger(
    pluginId: string,
    options?: { enabled?: boolean; level?: LoggerLevelName },
  ): RegisteredPluginLogger {
    const state = {
      enabled: options?.enabled ?? true,
      level: options?.level ?? "warn",
    };
    this.pluginRegistry.set(pluginId, state);
    const loggerName = `plugin:${pluginId}`;
    const PLUGIN_SEVERITY_ORDER: Record<LoggerLevelName, number> = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3,
    };
    const emitPlugin = (
      level: LoggerLevelName,
      format: string,
      args: unknown[],
    ) => {
      const current = this.pluginRegistry.get(pluginId);
      if (!current || !current.enabled) return;
      if (PLUGIN_SEVERITY_ORDER[level] > PLUGIN_SEVERITY_ORDER[current.level])
        return;
      this.emit(loggerName, level, [format, ...args], {
        domain: "plugin",
        pluginId,
      });
    };
    return {
      name: loggerName,
      domain: "plugin",
      pluginId,
      get enabled() {
        return state.enabled;
      },
      get level() {
        return state.level;
      },
      setEnabled: (enabled: boolean) => {
        state.enabled = enabled;
      },
      setLevel: (level: LoggerLevelName) => {
        state.level = level;
      },
      error: (format, ...args) => emitPlugin("error", format, args),
      warn: (format, ...args) => emitPlugin("warn", format, args),
      info: (format, ...args) => emitPlugin("info", format, args),
      debug: (format, ...args) => emitPlugin("debug", format, args),
      dispose: () => {
        this.pluginRegistry.delete(pluginId);
      },
    };
  }

  /** List all plugin loggers registered with the central hub. */
  listRegisteredPlugins(): RegisteredPluginLogInfo[] {
    return [...this.pluginRegistry.entries()].map(([pluginId, state]) => ({
      pluginId,
      enabled: state.enabled,
      level: state.level,
    }));
  }

  /**
   * Deliver a record to every exporter whose threshold admits it. Each
   * exporter decides INDEPENDENTLY: its own `levels` table first, then the
   * service table as its fallback.
   */
  emit(
    name: string,
    level: LoggerLevelName,
    args: readonly unknown[],
    meta?: {
      domain?: LogDomain;
      pluginId?: string;
      location?: LogLocation;
      error?: unknown;
      fields?: Readonly<Record<string, unknown>>;
    },
  ): void {
    this.sn += 1;
    const firstError =
      meta?.error instanceof Error
        ? meta.error
        : args.find((arg): arg is Error => arg instanceof Error);
    const extractedError = firstError
      ? extractStructuredError(firstError)
      : undefined;
    const shouldCaptureLocation =
      meta?.location !== undefined ||
      extractedError?.location !== undefined ||
      level === "error" ||
      level === "warn";
    const location =
      meta?.location ??
      extractedError?.location ??
      (shouldCaptureLocation ? extractCallSite() : undefined);
    const domain = meta?.domain ?? inferLogDomain(name);
    const message: LogMessage = {
      sn: this.sn,
      ts: Date.now(),
      pid: typeof process !== "undefined" ? process.pid : 0,
      domain,
      ...(meta?.pluginId ? { pluginId: meta.pluginId } : {}),
      name,
      level,
      args,
      ...(location ? { location } : {}),
      ...(extractedError ? { error: extractedError } : {}),
      ...(meta?.fields ? { fields: meta.fields } : {}),
    };
    for (const exporter of this.exporters) {
      const perName = exporter.levels?.[name];
      const threshold = perName
        ? LoggerLevel[perName]
        : exporter.levels?.default
          ? LoggerLevel[exporter.levels.default]
          : this.thresholdFor(name);
      if (threshold < LoggerLevel[level]) continue;
      exporter.export(message);
    }
  }

  /** Rendering for one exporter; the record is already built. */
  format(options: LogFormatOptions, message: LogMessage): string {
    return formatMessage(options, message);
  }
}

/** printf-style rendering for one record against rendering options. */
export function formatMessage(
  options: LogFormatOptions,
  message: LogMessage,
): string {
  const values = [...message.args];
  let next = 0;
  let format = "%o";
  if (values[0] instanceof Error) {
    // A leading Error IS the format: it renders as its stack
    // and cause chain, which is the difference between "rpc failed" and
    // "rpc failed / caused by: the body said unknown method".
    format = "%s";
  } else if (typeof values[0] === "string") {
    format = values[0];
    next = 1;
  }
  let out = "";
  let at = 0;
  while (at < format.length) {
    const char = format[at];
    if (char !== "%" || at + 1 >= format.length) {
      out += char;
      at += 1;
      continue;
    }
    const code = format[at + 1];
    at += 2;
    if (code === "%") {
      out += "%";
      continue;
    }
    const value = next < values.length ? values[next] : undefined;
    if (next < values.length) next += 1;
    if (code === "s") out += value === undefined ? "" : renderValue(value);
    else if (code === "d" || code === "i")
      out += value === undefined ? "" : String(Math.trunc(Number(value)));
    else if (code === "f")
      out += value === undefined ? "" : String(Number(value));
    else if (code === "o" || code === "O") {
      try {
        out += JSON.stringify(value);
      } catch {
        out += String(value);
      }
    } else {
      out += `%${code}`;
    }
  }
  for (let index = next; index < values.length; index += 1)
    out += ` ${renderValue(values[index])}`;
  const maxLength = options.maxLength ?? 10240;
  return out
    .split(/\r?\n/g)
    .map((line) =>
      line.length > maxLength ? `${line.slice(0, maxLength)}...` : line,
    )
    .join("\n");
}

function renderValue(value: unknown): string {
  if (value instanceof Error) {
    const lines = [value.stack || value.message];
    let cause = value.cause;
    while (cause instanceof Error) {
      lines.push(`caused by: ${cause.stack || cause.message}`);
      cause = cause.cause;
    }
    return lines.join("\n");
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** The shared service; `getLogger` and `configure` operate on it. */
export const logService = new LogService();

/**
 * The named logger for one kernel or framework subsystem. The table lookup
 * happens per call, so a threshold change takes effect without re-creating
 * loggers.
 */
export function getLogger(name: string, domain?: LogDomain): Logger {
  return {
    name,
    ...(domain ? { domain } : {}),
    error: (format, ...args) =>
      logService.emit(name, "error", [format, ...args], { domain }),
    info: (format, ...args) =>
      logService.emit(name, "info", [format, ...args], { domain }),
    warn: (format, ...args) =>
      logService.emit(name, "warn", [format, ...args], { domain }),
    debug: (format, ...args) =>
      logService.emit(name, "debug", [format, ...args], { domain }),
  };
}

/**
 * Convenience helper for plugins to create and register their own isolated
 * logger with the central LogService.
 */
export function registerPluginLogger(
  pluginId: string,
  options?: { enabled?: boolean; level?: LoggerLevelName },
): RegisteredPluginLogger {
  return logService.registerPluginLogger(pluginId, options);
}

/** A text exporter: `name level message`. */
export function createConsoleExporter(options?: {
  levels?: Readonly<Record<string, LoggerLevelName>>;
  write?: (line: string) => void;
}): LogExporter {
  const write =
    options?.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  return {
    levels: options?.levels,
    export(message) {
      write(
        `${message.name} ${message.level} ${formatMessage({ maxLength: 10240 }, message)}`,
      );
    },
  };
}

/**
 * An in-memory ring of the most recent records, for after-the-fact reads. The
 * `levels` argument exists so a caller can install a WIDER table than the
 * service's — a diagnostic sink that hears everything without opening the
 * process's verbosity.
 */
export function createBufferExporter(
  size = 1000,
  levels?: Readonly<Record<string, LoggerLevelName>>,
): LogExporter & {
  drain(): LogMessage[];
} {
  const buffer: LogMessage[] = [];
  return {
    levels,
    export(message) {
      buffer.push(message);
      if (buffer.length > size) buffer.splice(0, buffer.length - size);
    },
    drain() {
      return buffer.splice(0, buffer.length);
    },
  };
}

let installed: (() => void) | undefined;

/**
 * The boot call. Returns the disposer of THE install; a second call while one
 * is live returns that same disposer instead of adding a second sink.
 */
export function installDefaultLogExporter(options?: {
  write?: (line: string) => void;
  env?: Record<string, string | undefined>;
}): () => void {
  if (installed) return installed;
  const env = options?.env ?? process.env;
  const spec = env.NATALIA_LOG ?? "";
  if (spec === "off" || spec === "none")
    logService.setLevels({ default: "error" });
  else {
    const levels = logLevelsFromEnv(env);
    if (levels) logService.setLevels(levels);
  }
  const write =
    options?.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const remove = logService.addExporter({
    export(message) {
      write(
        `${message.name} ${message.level} ${formatMessage({ maxLength: 10240 }, message)}`,
      );
    },
  });
  installed = () => {
    remove();
    installed = undefined;
  };
  return installed;
}
