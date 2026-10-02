/**
 * Sliding-window repeated tool-call guard.
 *
 * Unlike the old exact-count guard, this keeps a per-session (or per-subagent)
 * sliding window of timestamps for each normalized tool signature. A call is
 * blocked only when the same normalized tool call appears more than
 * `REPEAT_MAX` times inside `REPEAT_WINDOW_MS`.
 *
 * The key is normalized before comparison:
 * - JSON arguments are parsed and re-serialized;
 * - absolute workspace paths are replaced with a stable `<workspace>` marker;
 * - non-JSON raw argument strings also get the same workspace-path replacement.
 */
export const REPEAT_WINDOW_MS = Math.max(
  1_000,
  Number(process.env.NATALIA_REPEAT_WINDOW_MS ?? 60_000),
);
export const REPEAT_MAX = Math.max(
  1,
  Number(process.env.NATALIA_REPEAT_MAX ?? 10),
);

export type RepeatStore = Map<string, number[]>;

function normalizeString(value: string, workspaceRoot: string): string {
  if (workspaceRoot && value.includes(workspaceRoot))
    return value.split(workspaceRoot).join("<workspace>");
  return value;
}

function normalizeValue(value: unknown, workspaceRoot: string): unknown {
  if (typeof value === "string") return normalizeString(value, workspaceRoot);
  if (Array.isArray(value))
    return value.map((item) => normalizeValue(item, workspaceRoot));
  if (value && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      normalized[key] = normalizeValue(item, workspaceRoot);
    return normalized;
  }
  return value;
}

export function repeatKey(
  toolName: string,
  rawArguments: string,
  workspaceRoot: string,
): string {
  try {
    const parsed = JSON.parse(rawArguments);
    return `${toolName}\u0000${JSON.stringify(
      normalizeValue(parsed, workspaceRoot),
    )}`;
  } catch {
    return `${toolName}\u0000${normalizeString(rawArguments, workspaceRoot)}`;
  }
}

export function recordRepeat(
  store: RepeatStore,
  key: string,
  now = Date.now(),
): { count: number; blocked: boolean } {
  const cutoff = now - REPEAT_WINDOW_MS;
  const recent = (store.get(key) ?? []).filter((at) => at >= cutoff);
  recent.push(now);
  store.set(key, recent);
  return {
    count: recent.length,
    blocked: recent.length > REPEAT_MAX,
  };
}

export function clearRepeat(store: RepeatStore, key: string): void {
  store.delete(key);
}
