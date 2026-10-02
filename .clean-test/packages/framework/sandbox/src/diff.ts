/**
 * A small line diff used by the sandbox object-store backends.
 *
 * This is intentionally independent from git so a snapshot sandbox can show
 * real before/after content even when the workspace is not a git repository.
 */
export type TextDiffResult = {
  additions: number;
  deletions: number;
  patch?: string;
  structured?: import("@anthelia/contracts").RuntimeStructuredDiff;
};

type DiffLineOp =
  | { type: "equal"; text: string }
  | { type: "delete"; text: string }
  | { type: "insert"; text: string };

export function diffText(
  path: string,
  oldText: string | undefined,
  newText: string | undefined,
): TextDiffResult {
  const before = oldText ?? "";
  const after = newText ?? "";
  const a = before.endsWith("\n")
    ? before.slice(0, -1).split("\n")
    : before
      ? before.split("\n")
      : [];
  const b = after.endsWith("\n")
    ? after.slice(0, -1).split("\n")
    : after
      ? after.split("\n")
      : [];
  if (a.length === 0 && b.length === 0) return { additions: 0, deletions: 0 };
  const ops = diffLineOps(a, b);
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.type === "insert") additions++;
    if (op.type === "delete") deletions++;
  }
  if (additions === 0 && deletions === 0) return { additions: 0, deletions: 0 };
  return {
    additions,
    deletions,
    patch: renderUnifiedPatch(path, ops),
  };
}

function renderUnifiedPatch(path: string, ops: DiffLineOp[]): string {
  const entries: Array<{
    op: DiffLineOp;
    oldLine: number;
    newLine: number;
  }> = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    entries.push({ op, oldLine, newLine });
    if (op.type !== "insert") oldLine++;
    if (op.type !== "delete") newLine++;
  }
  const changeIndexes = entries.flatMap((entry, index) =>
    entry.op.type === "equal" ? [] : [index],
  );
  if (!changeIndexes.length) return "";
  const context = 3;
  const ranges: Array<[number, number]> = [];
  for (const index of changeIndexes) {
    const start = Math.max(0, index - context);
    const end = Math.min(entries.length - 1, index + context);
    const last = ranges.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const [start, end] of ranges) {
    const first = entries[start]!;
    const slice = entries.slice(start, end + 1);
    const oldCount = slice.filter((entry) => entry.op.type !== "insert").length;
    const newCount = slice.filter((entry) => entry.op.type !== "delete").length;
    lines.push(
      `@@ -${first.oldLine},${oldCount} +${first.newLine},${newCount} @@`,
    );
    for (const entry of slice) {
      if (entry.op.type === "insert") lines.push(`+${entry.op.text}`);
      else if (entry.op.type === "delete") lines.push(`-${entry.op.text}`);
      else lines.push(` ${entry.op.text}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function unifiedPatchToStructured(
  patch: string,
): import("@anthelia/contracts").RuntimeStructuredDiff {
  const hunks: Array<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: Array<{
      type: "context" | "add" | "delete" | "hunk";
      text: string;
      oldLineNumber: number | null;
      newLineNumber: number | null;
    }>;
  }> = [];
  let oldLine = 0;
  let newLine = 0;
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  let current: (typeof hunks)[number] | undefined;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git")) {
      inHunk = false;
      current = undefined;
      continue;
    }
    if (raw.startsWith("@@")) {
      const match = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u);
      if (match) {
        const oldStart = Number(match[1]);
        const oldCount = Number(match[2] ?? 1);
        const newStart = Number(match[3]);
        const newCount = Number(match[4] ?? 1);
        oldLine = oldStart;
        newLine = newStart;
        inHunk = true;
        current = {
          oldStart,
          oldCount,
          newStart,
          newCount,
          lines: [],
        };
        hunks.push(current);
      }
      continue;
    }
    if (!inHunk || !current) continue;
    if (raw.startsWith("---") || raw.startsWith("+++") || raw.startsWith("\\"))
      continue;
    if (raw.startsWith("+")) {
      current.lines.push({
        type: "add",
        text: raw.slice(1),
        oldLineNumber: null,
        newLineNumber: newLine++,
      });
      additions++;
    } else if (raw.startsWith("-")) {
      current.lines.push({
        type: "delete",
        text: raw.slice(1),
        oldLineNumber: oldLine++,
        newLineNumber: null,
      });
      deletions++;
    } else if (raw.startsWith(" ")) {
      current.lines.push({
        type: "context",
        text: raw.slice(1),
        oldLineNumber: oldLine++,
        newLineNumber: newLine++,
      });
    }
  }
  return { hunks, additions, deletions };
}

function renderStructuredPatch(diff: {
  hunks: Array<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: Array<{
      type: "context" | "add" | "delete" | "hunk";
      text: string;
      oldLineNumber: number | null;
      newLineNumber: number | null;
    }>;
  }>;
}): string {
  if (!diff.hunks.length) return "";
  const lines: string[] = [];
  for (const hunk of diff.hunks) {
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
    );
    for (const line of hunk.lines) {
      if (line.type === "add") lines.push(`+${line.text}`);
      else if (line.type === "delete") lines.push(`-${line.text}`);
      else lines.push(` ${line.text}`);
    }
  }
  return lines.join("\n") + "\n";
}

function diffLineOps(a: string[], b: string[]): DiffLineOp[] {
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

/**
 * High-quality text diff backed by `git diff --no-index`.
 *
 * The object store provides old/new contents; git is used only as the diff
 * engine, not as the workspace data source.
 */
export async function diffTextAsync(
  path: string,
  oldText: string | undefined,
  newText: string | undefined,
): Promise<TextDiffResult> {
  try {
    const { diffWasmStructured } = await import("@anthelia/diff-wasm");
    const wasm = await diffWasmStructured(oldText ?? "", newText ?? "");
    const patch = wasm.hunks.length
      ? `--- a/${path}\n+++ b/${path}\n${renderStructuredPatch(wasm)}`
      : undefined;
    return {
      additions: wasm.additions,
      deletions: wasm.deletions,
      ...(patch ? { patch } : {}),
      structured: wasm,
    };
  } catch {
    // Fall back to the pure JS engine when WASM is unavailable.
  }
  return diffText(path, oldText, newText);
}
