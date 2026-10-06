/**
 * The generic tool-result flattener (presentation plan P0.1).
 *
 * dsh's layer-1 contract: `execute` returns a typed value and
 * `output.render` turns it into the text the model reads, so a UI never
 * shows raw JSON. Our tools return JSON strings and many declare no
 * presenter, so this is the floor under them: every JSON result is
 * flattened into `key: value` lines a human can read, nested values
 * recurse to a bounded depth, arrays become one line per element, and
 * non-JSON text passes through untouched.
 *
 * The known-tool cases below are the plan's pinned list: they existed as
 * JSON blobs nobody could read. A tool absent from the table gets the
 * generic flatten, which is the honest answer for a tool nobody has
 * classified yet.
 */

/** Maximum nesting depth the generic flatten renders before eliding. */
const MAX_DEPTH = 4;

/** Maximum line width before a line is cut (the FTS-free preview bound). */
const MAX_LINE = 200;

function clip(text: string, max = MAX_LINE): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A scalar as display text; structured values elide at this depth. */
function scalarText(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string") return clip(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return undefined;
}

function flattenValue(value: unknown, depth: number): string {
  const scalar = scalarText(value);
  if (scalar !== undefined) return scalar;
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? "[…]" : "{…}";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.map((item) => flattenValue(item, depth + 1)).join(", ")}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    return `{${entries
      .map(([key, item]) => `${key}=${flattenValue(item, depth + 1)}`)
      .join(", ")}}`;
  }
  return String(value);
}

/** The generic object flatten: one `key: value` line per top-level key. */
function flattenObject(value: Record<string, unknown>, depth = 0): string {
  return Object.entries(value)
    .map(([key, item]) => `${key}: ${flattenValue(item, depth + 1)}`)
    .join("\n");
}

/** The generic array flatten: one element per line, objects as `a=1, b=2`. */
function flattenArray(value: unknown[]): string {
  if (value.length === 0) return "(no items)";
  return value
    .map((item) => {
      if (isPlainObject(item))
        return Object.entries(item)
          .map(([key, nested]) => `${key}=${flattenValue(nested, 1)}`)
          .join(", ");
      return flattenValue(item, 0);
    })
    .join("\n");
}

/** `session_history` rounds, grouped: the round's facts on their own lines. */
function sessionHistory(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value.filter(isPlainObject);
  if (rows.length === 0) return undefined;
  // The envelope shape ({items/rounds}) or a bare array both land here.
  return rows
    .map((row) => {
      const label = scalarText(row.round ?? row.turn ?? row.id) ?? "round";
      const rest = Object.entries(row)
        .filter(([key]) => !["round", "turn", "id"].includes(key))
        .map(([key, item]) => `${key}=${flattenValue(item, 1)}`)
        .join(", ");
      return `${label}${rest ? ` · ${rest}` : ""}`;
    })
    .join("\n");
}

/** `collab_inbox` / `mailbox_status` messages: one message per line. */
function messageList(value: unknown): string | undefined {
  const rows = Array.isArray(value)
    ? value
    : isPlainObject(value) && Array.isArray(value.messages)
      ? value.messages
      : undefined;
  if (!rows) return undefined;
  const items = rows.filter(isPlainObject);
  if (items.length === 0) return undefined;
  return items
    .map((row) => {
      const from = scalarText(row.from) ?? "?";
      const to = scalarText(row.to) ?? "";
      const text = scalarText(row.text ?? row.summary) ?? "";
      const status = scalarText(row.status);
      return `${from}${to && to !== from ? ` → ${to}` : ""}${status ? ` [${status}]` : ""}: ${text}`;
    })
    .join("\n");
}

/** `process_audit` (the former background_audit): a field table per process. */
function processTable(value: unknown): string | undefined {
  if (!isPlainObject(value) || !Array.isArray(value.processes))
    return undefined;
  const rows = value.processes.filter(isPlainObject);
  if (rows.length === 0) return undefined;
  return rows
    .map((row) =>
      Object.entries(row)
        .map(([key, item]) => `${key}=${flattenValue(item, 1)}`)
        .join(", "),
    )
    .join("\n");
}

/** `ask_user`'s answer: the picked options as one line. */
function questionAnswer(value: unknown): string | undefined {
  if (!isPlainObject(value) || !Array.isArray(value.answers)) return undefined;
  const answers = value.answers
    .map((answer) =>
      Array.isArray(answer)
        ? answer.map((item) => scalarText(item) ?? String(item)).join(", ")
        : (scalarText(answer) ?? String(answer)),
    )
    .filter((entry) => entry.length > 0);
  if (answers.length === 0) return undefined;
  return `Answer: ${answers.join("; ")}`;
}

/** The plan's pinned special cases, by tool name. */
const SPECIAL_CASES: Record<string, (value: unknown) => string | undefined> = {
  session_history: sessionHistory,
  collab_inbox: messageList,
  mailbox_status: messageList,
  process_audit: processTable,
  background_audit: processTable,
  ask_user: questionAnswer,
};

/**
 * Flattens a tool's result text into something a human reads.
 *
 * Non-JSON text returns unchanged. A JSON object becomes `key: value`
 * lines (nested values recurse, depth-bounded); a JSON array becomes one
 * line per element (objects as `a=1, b=2`, long lines clipped). The
 * pinned tool names get their grouped form; everything else the generic
 * flatten.
 */
export function humanizeToolResult(value: string, toolName: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  const special = SPECIAL_CASES[toolName]?.(parsed);
  if (special !== undefined) return special;
  if (Array.isArray(parsed)) return flattenArray(parsed);
  if (isPlainObject(parsed)) return flattenObject(parsed);
  return flattenValue(parsed, 0);
}
