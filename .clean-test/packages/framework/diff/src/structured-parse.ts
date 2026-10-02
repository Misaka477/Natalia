import type { StructuredDiffResult } from "@anthelia/diff-wasm";

export function patchToStructured(patch: string): {
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
  additions: number;
  deletions: number;
} {
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
  let current:
    | {
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
      }
    | undefined;
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
      const text = raw.slice(1);
      current.lines.push({
        type: "add",
        text,
        oldLineNumber: null,
        newLineNumber: newLine++,
      });
      additions++;
      continue;
    }
    if (raw.startsWith("-")) {
      const text = raw.slice(1);
      current.lines.push({
        type: "delete",
        text,
        oldLineNumber: oldLine++,
        newLineNumber: null,
      });
      deletions++;
      continue;
    }
    if (raw.startsWith(" ")) {
      const text = raw.slice(1);
      current.lines.push({
        type: "context",
        text,
        oldLineNumber: oldLine++,
        newLineNumber: newLine++,
      });
      continue;
    }
  }
  return { hunks, additions, deletions };
}

export function countPatch(patch: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

export type { StructuredDiffResult };

export function diffToChanges(rawDiff: string) {
  const changes: Array<{
    path: string;
    operation: "modified";
    additions: number;
    deletions: number;
    patch?: string;
    structured?: ReturnType<typeof patchToStructured>;
  }> = [];
  const sections = rawDiff.split(/(?=^diff --git )/m);
  for (const section of sections) {
    if (!section.trim()) continue;
    const header = section.split("\n")[0] ?? "";
    const match = header.match(/^diff --git a\/(.+) b\/(.+)$/u);
    if (!match) continue;
    const path = match[2]!;
    const counts = countPatch(section);
    const patch = section.trim() ? section.trimEnd() + "\n" : undefined;
    const structured = patch ? patchToStructured(patch) : undefined;
    changes.push({
      path,
      operation: "modified",
      additions: counts.additions,
      deletions: counts.deletions,
      ...(patch ? { patch } : {}),
      ...(structured ? { structured } : {}),
    });
  }
  return changes;
}
