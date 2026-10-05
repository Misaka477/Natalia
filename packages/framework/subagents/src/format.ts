import type { SubagentRecord, SubagentStatus } from "./types";

export function formatStatusCounts(records: SubagentRecord[]): string {
  const counts: Partial<Record<SubagentStatus, number>> = {};
  for (const rec of records) {
    counts[rec.status] = (counts[rec.status] ?? 0) + 1;
  }
  const total = records.length;
  return `remaining_resources: resource_type=subagent total=${total}${formatCount("running", counts)}${formatCount("completed", counts)}${formatCount("stopped", counts)}${formatCount("failed", counts)}${formatCount("paused", counts)}${formatCount("idle", counts)}`;
}

function formatCount(
  status: SubagentStatus,
  counts: Partial<Record<SubagentStatus, number>>,
): string {
  const v = counts[status] ?? 0;
  return v > 0 || status === "running" ? ` ${status}=${v}` : "";
}

/**
 * The truncation that SAYS it truncated. The old form returned an ellipsis and
 * nothing else, so a caller reading a relayed subagent result could not tell a
 * complete answer from a cut one — and the cut was silent at exactly the
 * places a parent acts on it (`truncate(last.text, 1200)` for the concise
 * relay, 200 per step in the status listing). The total rides with the cut now,
 * the way the other bounded readers report it.
 */
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}… (truncated, ${s.length} chars total)`;
}
