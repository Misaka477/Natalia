/**
 * The generic tool-result flattener (UI refactor R5.5).
 *
 * The layer-1 contract: `execute` returns a typed value and
 * `output.render` turns it into the text the model reads, so a UI never
 * shows raw JSON. Our tools return JSON strings and a tool may declare no
 * presenter at all, so this is the floor under them: every JSON result is
 * flattened into `key: value` lines a human can read, nested values recurse
 * to a bounded depth, arrays become one line per element, and non-JSON text
 * passes through untouched.
 *
 * It lives HERE, in the contracts leaf, because both sides need the same
 * reading: the runtime publishes it as a presenter-less tool's default card
 * body, and a client renders that body verbatim. One implementation, no
 * drift. The TOOL-NAME special cases the old flattener carried are NOT
 * here: every tool they covered now declares its own presenter (the floor
 * sweep's bucket is empty), and a contract must not know tool names.
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
    if (value.length === 0) return "(none)";
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

/** One record as an inline `a=1, b=2` line (the per-element spelling). */
function recordLine(item: unknown, depth: number): string {
  if (isPlainObject(item))
    return Object.entries(item)
      .map(([key, nested]) => `${key}=${flattenValue(nested, depth + 1)}`)
      .join(", ");
  return flattenValue(item, depth);
}

/**
 * The generic object flatten — a REAL recursion (the user's 2026-10-08
 * report: `data: {items=[{...}]}` and `breakdown={fts=...}` — a nested
 * object's structured value must expand onto its own lines at every depth,
 * never inline as a `{k=v}` blob):
 *
 *   {a: 1, list: [{x, y}]}   a: 1
 *                            list:
 *                              · x=..., y=...
 *   {outer: {inner: [{x}]}}  outer:
 *                              inner:
 *                                · x=...
 */
function flattenObject(value: Record<string, unknown>, depth = 0): string {
  return Object.entries(value)
    .map(([key, item]) => renderMember(key, item, depth))
    .join("\n");
}

/** One object member: the key, then its value's rendering. */
function renderMember(key: string, item: unknown, depth: number): string {
  const pad = "  ".repeat(depth);
  if (Array.isArray(item) && item.some(isPlainObject))
    return `${pad}${key}:\n${item
      .map((element) => renderRecord(element, depth + 1))
      .join("\n")}`;
  // An object expands whenever it is not absurdly deep: its lines are
  // cheap and a clipped `{…}` hides exactly the fields a reader opened the
  // card for (the score decomposition, the change set).
  if (
    isPlainObject(item) &&
    Object.keys(item).length > 0 &&
    depth < OBJECT_DEPTH
  )
    return `${pad}${key}:\n${flattenObject(item, depth + 1)}`;
  return `${pad}${key}: ${flattenValue(item, depth + 1)}`;
}

/**
 * One record: its scalar members inline (`a=1, b=2`), each STRUCTURED
 * member as its own indented block beneath. The split is what keeps a
 * record readable — inlining a nested object mid-line (the old
 * `breakdown={fts=0.9, ...}`) breaks the line's own comma structure.
 */
function renderRecord(element: unknown, depth: number): string {
  const pad = "  ".repeat(depth);
  if (!isPlainObject(element)) return `${pad}· ${flattenValue(element, depth)}`;
  const entries = Object.entries(element);
  const scalars = entries.filter(([, value]) => !isStructured(value));
  const structured = entries.filter(([, value]) => isStructured(value));
  const inline = scalars
    .map(([key, value]) => `${key}=${flattenValue(value, depth + 1)}`)
    .join(", ");
  const blocks = structured
    .map(([key, value]) => renderMember(key, value, depth + 1))
    .join("\n");
  return `${pad}· ${inline}${blocks ? `\n${blocks}` : ""}`;
}

/** Whether a value must expand onto its own lines rather than inline. */
function isStructured(value: unknown): boolean {
  return (
    (Array.isArray(value) && value.some(isPlainObject)) ||
    (isPlainObject(value) && Object.keys(value).length > 0)
  );
}

/** The object-expansion budget (deeper than the scalar clip). */
const OBJECT_DEPTH = 6;

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
/**
 * Flattens a tool's result text into something a human reads.
 *
 * Non-JSON text returns unchanged. A JSON object becomes `key: value`
 * lines (nested values recurse, depth-bounded); a JSON array becomes one
 * line per element (objects as `a=1, b=2`, long lines clipped).
 */
export function toolResultBody(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return value;
  }
  if (Array.isArray(parsed)) return flattenArray(parsed);
  if (isPlainObject(parsed)) return flattenObject(parsed);
  return flattenValue(parsed, 0);
}
