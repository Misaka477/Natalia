/**
 * The line diff's op stream — the shared primitive under the sandbox's
 * before/after views AND the three-way merge. Extracted from diff.ts so the
 * merge engine and the views cannot drift apart: one LCS, two consumers.
 */

export type DiffLineOp =
  | { type: "equal"; text: string }
  | { type: "delete"; text: string }
  | { type: "insert"; text: string };

export function diffLineOps(
  a: readonly string[],
  b: readonly string[],
): DiffLineOp[] {
  const maxLines = 2000;
  if (a.length > maxLines || b.length > maxLines) {
    const ops: DiffLineOp[] = [];
    for (const line of a) ops.push({ type: "delete", text: line });
    for (const line of b) ops.push({ type: "insert", text: line });
    return ops;
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: DiffLineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "delete", text: a[i]! });
      i++;
    } else {
      ops.push({ type: "insert", text: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "delete", text: a[i++]! });
  while (j < m) ops.push({ type: "insert", text: b[j++]! });
  return ops;
}
