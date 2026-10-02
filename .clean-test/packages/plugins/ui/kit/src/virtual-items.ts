/**
 * Small pure helpers for transcript virtual-window diagnostics.
 *
 * TanStack Virtual normally returns one entry per logical row, but hydration /
 * measurement / key transitions can leave the same index in the window twice.
 * The transcript row id is the render key, so a duplicated index duplicates the
 * whole message group; dedupe at this boundary.
 */

export function dedupeVirtualItems<T extends { index: number }>(
  items: readonly T[],
): T[] {
  if (items.length < 2) return [...items];
  const seen = new Set<number>();
  const out: T[] = [];
  for (const item of items) {
    if (item === undefined || seen.has(item.index)) continue;
    seen.add(item.index);
    out.push(item);
  }
  return out;
}

/** Return each value that occurs more than once, in first-seen order. */
export function duplicateValues<T>(values: readonly T[]): T[] {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const seen = new Set<T>();
  const out: T[] = [];
  for (const value of values) {
    if ((counts.get(value) ?? 0) < 2 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function duplicateVirtualIndexes<T extends { index: number }>(
  items: readonly T[],
): number[] {
  return duplicateValues(items.map((item) => item.index));
}
