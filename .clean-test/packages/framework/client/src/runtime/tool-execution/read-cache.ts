import { READ_CACHE_TOOL_KINDS, type CacheFabric } from "@anthelia/rina";

/**
 * The L1 read-cache wrap (RINA study: the insertion point is "after the
 * policy decision, before execution" — exactly where this sits).
 *
 * Classification lives with the fabric (`READ_CACHE_TOOL_KINDS`): tools not
 * on the list execute every time, and a runtime without the fabric
 * provided executes everything — caching may make work cheaper, it may
 * never become a correctness dependency.
 */

/** Stable JSON: sorted keys at every depth so equal inputs share a key. */
export function stableCacheKey(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(stableCacheKey).join(",")}]`;
  if (input && typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${JSON.stringify(key)}:${stableCacheKey(value)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(input) ?? "null";
}

export async function executeWithReadCache(input: {
  fabric: CacheFabric | undefined;
  toolName: string;
  parsed: unknown;
  execute: () => Promise<string>;
}): Promise<string> {
  const kind =
    input.fabric === undefined
      ? undefined
      : READ_CACHE_TOOL_KINDS[input.toolName];
  if (!input.fabric || !kind) return input.execute();
  return input.fabric.compute(
    kind,
    stableCacheKey(input.parsed),
    input.execute,
  );
}
