/**
 * The framework and kernel's logging system.
 *
 * Every subsystem gets a NAMED logger (`getLogger("runtime")`), every level
 * is filtered PER NAME by the exporter's threshold table, and the default
 * table is silent below `error` — so call sites are unconditional and the
 * verbosity is a deployment choice, not a code choice.
 *
 *   import { getLogger } from "@anthelia/logging";
 *   const log = getLogger("runtime");
 *   log.error("turn failed: %s", error.message);
 *
 * The reference is the DeepSeek Harness logger (devref/deepseek-harness,
 * vendor/cordis/src/logger.ts): severities error/info/warn/debug, printf-style
 * formatting, per-exporter per-name level tables, Error-chain unwrapping.
 *
 * SCOPE: the framework and the kernel. Plugins own their own logging — a
 * plugin is a separate unit with its own failure reporting, and a shared
 * logger would make their output indistinguishable from the runtime's.
 *
 * A LOG POINT costs nothing when filtered (one table lookup and a comparison,
 * no string formatting) and formats lazily only when it will be emitted.
 * Error paths are NOT optional: `error` is on by default, because an error
 * the operator cannot see is an error reported as silence.
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

/** A structured record, built at the call site and delivered to exporters. */
export interface LogMessage {
  /** Monotonic per process; orders exports across loggers. */
  readonly sn: number;
  /** Epoch milliseconds at the call. */
  readonly ts: number;
  /** The logger's name — the per-name threshold table's key. */
  readonly name: string;
  readonly level: LoggerLevelName;
  /** The printf-style format and its arguments, unformatted. */
  readonly args: readonly unknown[];
}

/**
 * A sink. `levels` maps a logger name (or `default`) to the highest severity
 * still emitted for it; a name with no entry falls back to `default`, and
 * `default` to `error`.
 */
export interface LogExporter {
  readonly levels?: Readonly<Record<string, LoggerLevelName>>;
  /** Longest line emitted before `...` truncation. Default 10240. */
  readonly maxLength?: number;
  export(message: LogMessage): void;
}

/** A named facade for one subsystem. */
export interface Logger {
  readonly name: string;
  error(format: string, ...args: unknown[]): void;
  info(format: string, ...args: unknown[]): void;
  warn(format: string, ...args: unknown[]): void;
  debug(format: string, ...args: unknown[]): void;
}

const LEVEL_NAMES: readonly string[] = ["error", "info", "warn", "debug"];

function isLevelName(value: string): value is LoggerLevelName {
  return LEVEL_NAMES.includes(value);
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

  /** The threshold for one logger name, as a number. */
  thresholdFor(name: string): number {
    return LoggerLevel[this.levels[name] ?? this.levels.default ?? "error"];
  }

  /**
   * Deliver a record to every exporter whose threshold admits it. Each
   * exporter decides INDEPENDENTLY: its own `levels` table first, then the
   * service table as its fallback. A service-level early return would make a
   * wider exporter unreachable — measured: a `{default:"debug"}` exporter
   * went silent because the service table said `error`.
   */
  emit(name: string, level: LoggerLevelName, args: readonly unknown[]): void {
    this.sn += 1;
    const message: LogMessage = {
      sn: this.sn,
      ts: Date.now(),
      name,
      level,
      args,
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
  format(exporter: LogExporter, message: LogMessage): string {
    return formatMessage(exporter, message);
  }
}

/** printf-style rendering for one record against one exporter's options. */
export function formatMessage(
  exporter: LogExporter,
  message: LogMessage,
): string {
  const values = [...message.args];
  let next = 0;
  let format = "%o";
  if (values[0] instanceof Error) {
    // A leading Error IS the format (dsh's rule): it renders as its stack
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
  const maxLength = exporter.maxLength ?? 10240;
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
 * The named logger for one subsystem. The table lookup happens per call, so
 * a threshold change takes effect without re-creating loggers.
 */
export function getLogger(name: string): Logger {
  return {
    name,
    error: (format, ...args) =>
      logService.emit(name, "error", [format, ...args]),
    info: (format, ...args) => logService.emit(name, "info", [format, ...args]),
    warn: (format, ...args) => logService.emit(name, "warn", [format, ...args]),
    debug: (format, ...args) =>
      logService.emit(name, "debug", [format, ...args]),
  };
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

/** An in-memory ring of the most recent records, for after-the-fact reads. */
export function createBufferExporter(size = 1000): LogExporter & {
  drain(): LogMessage[];
} {
  const buffer: LogMessage[] = [];
  return {
    export(message) {
      buffer.push(message);
      if (buffer.length > size) buffer.splice(0, buffer.length - size);
    },
    drain() {
      return buffer.splice(0, buffer.length);
    },
  };
}
