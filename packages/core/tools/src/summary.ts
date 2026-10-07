/**
 * The one-line summary a tool result earns (dsh's layer-1 `output.render`
 * counterpart for the row line).
 *
 * The runtime used to publish `result.slice(0, 200)` as the tool.update
 * event's summary, so every JSON-returning tool showed its first 200
 * characters of raw JSON on the transcript row — the user's 2026-10-07
 * report: "绝大多数的工具返回是 json 数据而不是按 dsh 那种返回".
 *
 * dsh's model: the tool declares what its result MEANS, and the row shows
 * that meaning. Two sources, in order:
 *   1. the tool's own projected card (presentResult's `summary`) — the
 *      sentence the tool wrote about its own result;
 *   2. a derivation over the result string — a JSON document becomes a
 *      count line (`12 fields`, `7 items`, `3 matches`), plain text its
 *      first line. Never a raw prefix.
 */

/** The card a tool's presenter projected, when it declared one. */
export type ProjectedToolSummary = {
  summary?: string;
} | null;

/** A count line for a known JSON envelope shape. */
function envelopeLine(parsed: Record<string, unknown>): string | undefined {
  for (const [key, singular, plural] of [
    ["items", "item", "items"],
    ["matches", "match", "matches"],
    ["nodes", "node", "nodes"],
    ["candidates", "candidate", "candidates"],
    ["messages", "message", "messages"],
    ["results", "result", "results"],
    ["data", "entry", "entries"],
    ["changes", "change", "changes"],
    ["errors", "error", "errors"],
    ["rules", "rule", "rules"],
    ["decisions", "decision", "decisions"],
    ["plans", "plan", "plans"],
    ["edges", "edge", "edges"],
    ["validations", "validation", "validations"],
  ] as const) {
    const value = parsed[key];
    if (Array.isArray(value)) {
      const count = value.length;
      return `${count} ${count === 1 ? singular : plural}`;
    }
  }
  if (typeof parsed.total === "number") {
    const total = parsed.total;
    return `${total} total`;
  }
  if (parsed.ok === false || parsed.error !== undefined) {
    const error =
      typeof parsed.error === "string" ? parsed.error : "an error occurred";
    return `failed: ${error}`;
  }
  if (parsed.ok === true) return "done";
  return undefined;
}

/**
 * The row's one-line summary for a tool result.
 *
 * `projected` is the tool's own presentResult output when it declared one;
 * its `summary` wins whenever it is a non-empty string. Otherwise the
 * result string is classified: a JSON envelope counts its entries, a JSON
 * object counts its fields, an array counts its elements, and plain text
 * contributes its first line. Everything is bounded — a row is a glance,
 * the body is the read.
 */
export function toolResultSummary(
  result: string,
  projected?: ProjectedToolSummary,
): string {
  const declared = projected?.summary;
  if (typeof declared === "string" && declared.trim().length > 0)
    return declared.trim();
  const text = result.trim();
  if (text.length === 0) return "done";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // Plain text: the first non-empty line, bounded.
    const first = text.split("\n").find((line) => line.trim().length > 0);
    return first === undefined ? "done" : clip(first.trim());
  }
  if (Array.isArray(parsed)) {
    const count = parsed.length;
    return `${count} ${count === 1 ? "entry" : "entries"}`;
  }
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const line = envelopeLine(record);
    if (line !== undefined) return line;
    const keys = Object.keys(record);
    return `${keys.length} field${keys.length === 1 ? "" : "s"}`;
  }
  return clip(String(parsed));
}

/** The row-line bound: a glance, not a read. */
const SUMMARY_MAX = 96;

function clip(text: string): string {
  const chars = Array.from(text);
  return chars.length > SUMMARY_MAX
    ? `${chars.slice(0, SUMMARY_MAX).join("")}…`
    : text;
}
