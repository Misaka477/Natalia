import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Workspace-root snapshot ignore file. It never participates in access policy. */
export const NATALIA_IGNORE_FILE = ".nataliaignore";

/**
 * Default snapshot ignores. These are intentionally about build/runtime bulk,
 * not about hiding files from the UI or model tools.
 */
export const DEFAULT_NATALIA_IGNORE_PATTERNS = [
  ".git/",
  ".natalia/",
  "node_modules/",
  "dist/",
  "build/",
  "target/",
  "coverage/",
  "__pycache__/",
  ".next/",
  ".turbo/",
  "*.log",
  "*.tmp",
  "*.swp",
] as const;

export const DEFAULT_NATALIA_IGNORE_CONTENT = `${[
  "# Natalia snapshot ignore",
  "# Used by checkpoint and sandbox only.",
  "# This file does not affect file visibility, reading, writing, search,",
  "# or model tool access.",
  "",
  ...DEFAULT_NATALIA_IGNORE_PATTERNS,
  "",
].join("\n")}`;

export type SnapshotIgnoreRule = {
  base: string;
  directoryOnly: boolean;
  negated: boolean;
  pattern: RegExp;
};

function normalizeIgnorePath(path: string) {
  return path.split(/[\\/]/u).join("/");
}

export function parseSnapshotIgnoreLine(
  line: string,
  base = "",
): SnapshotIgnoreRule | undefined {
  const value = line.trimEnd();
  if (!value || value.startsWith("#")) return;
  const negated = value.startsWith("!") && !value.startsWith("\\!");
  const rawPattern = (negated ? value.slice(1) : value).replace(
    /^\\([#!])/u,
    "$1",
  );
  const directoryOnly = rawPattern.endsWith("/");
  const anchored = rawPattern.startsWith("/");
  const pattern = rawPattern.replace(/^\//u, "").replace(/\/$/u, "");
  if (!pattern) return;
  const body = globExpression(pattern);
  const prefix = anchored || pattern.includes("/") ? "^" : "^(?:.*/)?";
  return {
    base,
    directoryOnly,
    negated,
    pattern: new RegExp(`${prefix}${body}(?:/.*)?$`, "u"),
  };
}

export function parseSnapshotIgnore(
  contents: string,
  base = "",
): SnapshotIgnoreRule[] {
  const rules: SnapshotIgnoreRule[] = [];
  for (const line of contents.split(/\r?\n/u)) {
    const rule = parseSnapshotIgnoreLine(line, base);
    if (rule) rules.push(rule);
  }
  return rules;
}

/**
 * Gitignore-style decision. `allowedIgnoredPaths` is only for structural
 * self-exclusions and exact trusted paths, never for normal file access.
 */
export function isSnapshotIgnored(
  path: string,
  directory: boolean,
  rules: readonly SnapshotIgnoreRule[],
  allowedIgnoredPaths?: ReadonlySet<string>,
): boolean {
  const normalized = normalizeIgnorePath(path);
  if (allowedIgnoredPaths?.has(normalized)) return false;
  return rules.reduce<boolean>((ignored, rule) => {
    if (
      rule.base &&
      normalized !== rule.base &&
      !normalized.startsWith(`${rule.base}/`)
    )
      return ignored;
    const relativePath = normalized.slice(rule.base.length).replace(/^\//u, "");
    if (
      !relativePath ||
      (rule.directoryOnly && !directory && !relativePath.includes("/"))
    )
      return ignored;
    if (!rule.pattern.test(relativePath)) return ignored;
    return !rule.negated;
  }, false);
}

export async function loadNataliaIgnore(workspaceRoot: string): Promise<{
  path: string;
  exists: boolean;
  patterns: string[];
  rules: SnapshotIgnoreRule[];
}> {
  const path = resolve(workspaceRoot, NATALIA_IGNORE_FILE);
  try {
    const contents = await readFile(path, "utf8");
    const patterns = contents
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    return {
      path,
      exists: true,
      patterns,
      rules: parseSnapshotIgnore(contents),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { path, exists: false, patterns: [], rules: [] };
  }
}

/**
 * Creates the default `.nataliaignore` when absent. Existing files are never
 * overwritten; `migratedPatterns` is used only for the one-time
 * `checkpoint.ignore` migration.
 */
export async function ensureNataliaIgnoreFile(
  workspaceRoot: string,
  migratedPatterns: readonly string[] = [],
): Promise<{ path: string; created: boolean }> {
  const path = resolve(workspaceRoot, NATALIA_IGNORE_FILE);
  try {
    await readFile(path, "utf8");
    return { path, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lines = [
    "# Natalia snapshot ignore",
    "# Used by checkpoint and sandbox only.",
    "# This file does not affect file visibility, reading, writing, search,",
    "# or model tool access.",
    "",
    ...DEFAULT_NATALIA_IGNORE_PATTERNS,
  ];
  const migrated = migratedPatterns
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (migrated.length) {
    lines.push("", "# Migrated from checkpoint.ignore", ...migrated);
  }
  lines.push("");
  await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  return { path, created: true };
}

function globExpression(pattern: string) {
  let expression = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    const next = pattern[index + 1];
    if (character === "*" && next === "*") {
      index++;
      if (pattern[index + 1] === "/") {
        index++;
        expression += "(?:.*/)?";
        continue;
      }
      expression += ".*";
      continue;
    }
    if (character === "*") {
      expression += "[^/]*";
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      continue;
    }
    expression += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  return expression;
}
