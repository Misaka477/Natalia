/**
 * Stable row identity for transcript projections.
 *
 * Solid's `<For>` keys by item identity, so a projection that maps messages to
 * fresh objects on every animation frame destroys and rebuilds every row. The
 * projection memo can still re-run each frame — this keeps the previously built
 * row object whenever its signature is unchanged, so only rows whose content
 * actually changed are re-rendered.
 */

/** Cheap, composable per-row revision. Compared element-wise by `===`. */
export type RowSignature = readonly unknown[];

export type StableRow<T> = {
  id: string;
  signature: RowSignature;
  create(): T;
};

export function stableRows<T extends { id: string }>(
  cache: Map<string, { signature: RowSignature; value: T }>,
  rows: readonly StableRow<T>[],
): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.id);
    const cached = cache.get(row.id);
    if (
      cached !== undefined &&
      sameSignature(cached.signature, row.signature)
    ) {
      out.push(cached.value);
      continue;
    }
    const value = row.create();
    cache.set(row.id, { signature: row.signature, value });
    out.push(value);
  }
  // Rows that left the visible window must not pin their objects forever.
  for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
  return out;
}

function sameSignature(a: RowSignature, b: RowSignature): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Preserve first occurrence for each transcript row id. */
export function dedupeTranscriptRowsById<T extends { id: string }>(
  rows: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

/**
 * Collapse duplicate assistant / thinking rows that belong to the same turn
 * and carry identical display text. Durable replay and message-page hydration
 * can race into a projection and produce two segment ids for one logical
 * response; the transcript must show one row, not two.
 */
export function collapseDuplicateTranscriptRows<
  T extends {
    id: string;
    role: string;
    content: string;
    toolCalls?: readonly unknown[];
  },
>(rows: readonly T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    // Tool cards also carry role "assistant" with an empty `content`; they are
    // distinct records and must never be collapsed together just because that
    // display text is empty.
    if (
      (row.role !== "assistant" && row.role !== "thinking") ||
      row.content.length === 0 ||
      (row.toolCalls?.length ?? 0) > 0
    ) {
      out.push(row);
      continue;
    }
    const turnID = row.id.startsWith("turn_")
      ? (row.id.split(":")[0] ?? row.id)
      : row.id;
    const key = `${turnID}\u0000${row.role}\u0000${row.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
