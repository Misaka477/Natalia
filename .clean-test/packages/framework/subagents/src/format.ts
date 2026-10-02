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

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
