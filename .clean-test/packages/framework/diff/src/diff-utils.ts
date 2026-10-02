import type { StructuredDiffResult } from "@anthelia/diff-wasm";
import type { DiffRow } from "./types";

export function diffLines(patch?: string): DiffRow[] {
  if (!patch) return [];
  const lines: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git")) {
      inHunk = false;
      oldLine = 0;
      newLine = 0;
      lines.push({ type: "is-header", sign: "", text: line });
      continue;
    }
    if (line.startsWith("@@")) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      inHunk = true;
      lines.push({ type: "is-header", sign: "", text: line });
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) {
      lines.push({ type: "is-header", sign: "", text: line });
      continue;
    }
    if (!inHunk) {
      lines.push({ type: "", sign: "", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      lines.push({
        type: "is-added",
        sign: "+",
        text: line.slice(1),
        newNo: newLine++,
      });
      continue;
    }
    if (line.startsWith("-")) {
      lines.push({
        type: "is-removed",
        sign: "-",
        text: line.slice(1),
        oldNo: oldLine++,
      });
      continue;
    }
    if (line.startsWith(" ")) {
      lines.push({
        type: "",
        sign: " ",
        text: line.slice(1),
        oldNo: oldLine++,
        newNo: newLine++,
      });
      continue;
    }
    lines.push({ type: "", sign: "", text: line });
  }
  return lines;
}

export function structuredRows(result: StructuredDiffResult): DiffRow[] {
  try {
    return result.hunks.flatMap((hunk) => [
      {
        type: "is-header",
        sign: "",
        text: `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
        oldNo: "",
        newNo: "",
      },
      ...hunk.lines.map((line) => ({
        type:
          line.type === "add"
            ? "is-added"
            : line.type === "delete"
              ? "is-removed"
              : "",
        sign: line.type === "add" ? "+" : line.type === "delete" ? "-" : " ",
        text: line.text,
        oldNo: line.oldLineNumber ?? "",
        newNo: line.newLineNumber ?? "",
        ...(Array.isArray(line.wordRanges) && line.wordRanges.length
          ? { highlights: line.wordRanges }
          : {}),
        ...(Array.isArray(line.syntaxParts) && line.syntaxParts.length
          ? { syntax: line.syntaxParts }
          : {}),
      })),
    ]);
  } catch {
    return [];
  }
}

export function languageFromPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".mts") ||
    lower.endsWith(".cts")
  )
    return "typescript";
  if (
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  )
    return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".c") || lower.endsWith(".h")) return "c";
  if (
    lower.endsWith(".cpp") ||
    lower.endsWith(".cc") ||
    lower.endsWith(".cxx") ||
    lower.endsWith(".hpp")
  )
    return "cpp";
  if (lower.endsWith(".cs")) return "csharp";
  if (lower.endsWith(".rb")) return "ruby";
  if (lower.endsWith(".php")) return "php";
  if (lower.endsWith(".swift")) return "swift";
  if (lower.endsWith(".kt") || lower.endsWith(".kts")) return "kotlin";
  if (lower.endsWith(".scala")) return "scala";
  if (lower.endsWith(".sql")) return "sql";
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) return "bash";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".scss") || lower.endsWith(".sass")) return "scss";
  if (lower.endsWith(".html") || lower.endsWith(".vue")) return "xml";
  return undefined;
}
