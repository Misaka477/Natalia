import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import fuzzysort from "fuzzysort";
import { RuntimeInvalidParams, RuntimeRefusal } from "@anthelia/contracts";
import { NATALIA_IGNORE_FILE } from "./natalia-ignore";
import type {
  RuntimeWorkspaceContent,
  RuntimeWorkspaceFileEntry,
  RuntimeWorkspaceListPage,
} from "@anthelia/contracts";

const ignoredDirectories = new Set([
  ".git",
  ".hg",
  ".svn",
  ".natalia",
  ".next",
  ".turbo",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

type IgnoreRule = {
  base: string;
  directoryOnly: boolean;
  negated: boolean;
  pattern: RegExp;
};

const catalogs = new Map<
  string,
  {
    entries: RuntimeWorkspaceFileEntry[];
    expiresAt: number;
    ignoreRules: IgnoreRule[];
  }
>();
const maxSearchFileBytes = 1024 * 1024;
const maxReadFileBytes = 1024 * 1024;
const maxMediaIngestBytes = 20 * 1024 * 1024;
const maxReadPageBytes = 50 * 1024;
/**
 * Content search is user-initiated and should reach past the first page of the
 * workspace catalog. The cap only protects against pathological trees; normal
 * repositories are fully walked before the result limit is reached.
 */
const maxSearchFiles = 50_000;
const maxReadLines = 2_000;
const maxReadLineChars = 2_000;

export async function findWorkspaceFiles(input: {
  workspaceRoot: string;
  query?: string;
  type?: "file" | "directory";
  limit?: number;
}): Promise<RuntimeWorkspaceFileEntry[]> {
  const root = await realpath(input.workspaceRoot);
  const cached = catalogs.get(root);
  const catalog =
    cached && cached.expiresAt > Date.now()
      ? cached
      : await refreshWorkspaceFiles(root);
  const query = input.query?.trim().toLowerCase() ?? "";
  const entries = input.type
    ? catalog.entries.filter((entry) => entry.type === input.type)
    : catalog.entries;
  if (!query)
    return [...entries]
      .sort(
        (left, right) =>
          left.path.length - right.path.length ||
          left.path.localeCompare(right.path),
      )
      .slice(0, Math.min(200, Math.max(1, input.limit ?? 50)));
  const results = fuzzysort.go(query, entries, {
    key: "path",
    limit: Math.min(200, Math.max(1, input.limit ?? 50)),
  });
  return results.map((result) => result.obj);
}

export function invalidateWorkspaceFiles(workspaceRoot: string) {
  catalogs.delete(resolve(workspaceRoot));
}

export async function listWorkspaceFiles(input: {
  workspaceRoot: string;
  path?: string;
  offset?: number;
  limit?: number;
}): Promise<RuntimeWorkspaceListPage> {
  const root = await realpath(input.workspaceRoot);
  const directory = await resolveWorkspacePath(root, input.path ?? ".");
  if (!(await stat(directory)).isDirectory())
    throw new RuntimeInvalidParams(
      `workspace path is not a directory: ${input.path ?? "."}`,
    );
  const children = await readdir(directory, { withFileTypes: true });
  const entries = (
    await Promise.all(
      children.map(async (child) => {
        const path = resolve(directory, child.name);
        const real = await realpath(path).catch(() => undefined);
        if (!real || !contains(root, real)) return;
        const relativePath = relative(root, path).split(sep).join("/");
        if (child.isDirectory())
          return { path: `${relativePath}/`, type: "directory" as const };
        if (child.isFile())
          return { path: relativePath, type: "file" as const };
      }),
    )
  )
    .filter((entry): entry is RuntimeWorkspaceFileEntry => entry !== undefined)
    .sort((left, right) =>
      left.type === right.type
        ? left.path.localeCompare(right.path)
        : left.type === "directory"
          ? -1
          : 1,
    );
  const offset = Math.max(1, input.offset ?? 1);
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const selected = entries.slice(offset - 1, offset - 1 + limit);
  const truncated = offset - 1 + selected.length < entries.length;
  return {
    entries: selected,
    truncated,
    ...(truncated ? { next: offset + selected.length } : {}),
  };
}

export async function readWorkspaceFile(input: {
  workspaceRoot: string;
  path: string;
  offset?: number;
  limit?: number;
}): Promise<RuntimeWorkspaceContent> {
  const root = await realpath(input.workspaceRoot);
  const path = await resolveWorkspacePath(root, input.path);
  const info = await stat(path);
  if (!info.isFile())
    throw new RuntimeInvalidParams(
      `workspace path is not a file: ${input.path}`,
    );
  const header = new Uint8Array(
    await Bun.file(path).slice(0, 12).arrayBuffer(),
  );
  const media = imageMime(header);
  if (media && info.size > maxMediaIngestBytes)
    throw new RuntimeRefusal(
      `workspace media exceeds ${maxMediaIngestBytes} bytes: ${input.path}`,
    );
  if (!media && info.size > maxReadFileBytes)
    throw new RuntimeRefusal(
      `workspace file exceeds ${maxReadFileBytes} bytes: ${input.path}`,
    );
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  if (media)
    return {
      path: relative(root, path).split(sep).join("/"),
      content: Buffer.from(bytes).toString("base64"),
      encoding: "base64",
      mime: media,
    };
  const text = decodeUtf8(bytes);
  if (
    text !== undefined &&
    (bytes.length > maxReadPageBytes || input.offset || input.limit)
  ) {
    const offset = Math.max(1, input.offset ?? 1);
    const limit = Math.min(
      maxReadLines,
      Math.max(1, input.limit ?? maxReadLines),
    );
    const lines = text.endsWith("\n")
      ? text.slice(0, -1).replace(/\r$/u, "").split(/\r?\n/u)
      : text.split(/\r?\n/u);
    const selected: string[] = [];
    let usedBytes = 0;
    let next: number | undefined;
    for (let index = offset - 1; index < lines.length; index++) {
      if (selected.length >= limit) {
        next = index + 1;
        break;
      }
      const line = lines[index]!.slice(0, maxReadLineChars);
      const lineBytes =
        Buffer.byteLength(line, "utf8") + (selected.length ? 1 : 0);
      if (usedBytes + lineBytes > maxReadPageBytes) {
        next = index + 1;
        break;
      }
      selected.push(line);
      usedBytes += lineBytes;
    }
    if (!selected.length && offset > lines.length)
      throw new RuntimeInvalidParams(
        `workspace read offset is out of range: ${offset}`,
      );
    return {
      path: relative(root, path).split(sep).join("/"),
      content: selected.join("\n"),
      encoding: "utf8",
      mime: mimeType(path),
      offset,
      truncated: next !== undefined,
      ...(next === undefined ? {} : { next }),
    };
  }
  return {
    path: relative(root, path).split(sep).join("/"),
    content: text ?? Buffer.from(bytes).toString("base64"),
    encoding: text === undefined ? "base64" : "utf8",
    mime: mimeType(path),
  };
}

export async function globWorkspaceFiles(input: {
  workspaceRoot: string;
  pattern: string;
  path?: string;
  limit?: number;
}): Promise<RuntimeWorkspaceFileEntry[]> {
  if (
    !input.pattern ||
    input.pattern.includes("..") ||
    input.pattern.startsWith("/")
  )
    throw new RuntimeRefusal(
      "workspace glob pattern must remain inside workspace",
    );
  const root = await realpath(input.workspaceRoot);
  const directory = await resolveWorkspacePath(root, input.path ?? ".");
  if (!(await stat(directory)).isDirectory())
    throw new RuntimeInvalidParams(
      `workspace path is not a directory: ${input.path ?? "."}`,
    );
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const entries: RuntimeWorkspaceFileEntry[] = [];
  for await (const relativePath of new Bun.Glob(input.pattern).scan({
    cwd: directory,
    onlyFiles: true,
  })) {
    if (entries.length >= limit) break;
    const path = resolve(directory, relativePath);
    const real = await realpath(path).catch(() => undefined);
    if (!real || !contains(root, real)) continue;
    entries.push({
      path: relative(root, path).split(sep).join("/"),
      type: "file",
    });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

const maxGlobScannedFiles = 500;
const maxGlobScannedBytes = 4 * 1024 * 1024;
const maxGlobDeadlineMs = 8_000;

export type WorkspaceGlobResult = {
  paths: string[];
  truncated: boolean;
  nextCursor?: string;
  scannedFiles: number;
  scannedBytes: number;
  timedOut?: boolean;
};

export type WorkspaceGlobInput = {
  workspaceRoot: string;
  pattern: string;
  path?: string;
  limit?: number;
  cursor?: string;
  maxScannedFiles?: number;
  maxScannedBytes?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  authorize?: (input: { toolName: "glob"; paths: string[] }) => Promise<void>;
};

type GlobFrame = { path: string; index: number };

type GlobCursorState = {
  v: 1;
  root: string;
  pattern: string;
  scope: string;
  stack: GlobFrame[];
  scannedFiles: number;
  scannedBytes: number;
};

function globCursorQueryMatches(
  state: GlobCursorState,
  input: { root: string; pattern: string; scope: string },
) {
  return (
    state.v === 1 &&
    state.root === input.root &&
    state.pattern === input.pattern &&
    state.scope === input.scope
  );
}

function encodeGlobCursor(state: GlobCursorState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeGlobCursor(cursor: string): GlobCursorState {
  try {
    return JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as GlobCursorState;
  } catch {
    throw new RuntimeInvalidParams("glob cursor is invalid");
  }
}

function throwIfGlobAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("glob aborted");
}

/**
 * Bounded, cursor-paginated glob.
 *
 * Uses the same deterministic DFS and default heavy-directory skips as grep.
 * Unlike grep there is no file content to read, so the byte budget is based on
 * stat sizes and only matching paths consume the result limit.
 */
export async function globWorkspaceFilesBounded(
  input: WorkspaceGlobInput,
): Promise<WorkspaceGlobResult> {
  if (
    !input.pattern ||
    input.pattern.includes("..") ||
    input.pattern.startsWith("/")
  )
    throw new RuntimeRefusal(
      "workspace glob pattern must remain inside workspace",
    );

  const root = await realpath(input.workspaceRoot);
  const scopeArg = input.path?.trim() || ".";
  const scopeAbs = await realpath(resolve(root, scopeArg)).catch(() => {
    throw new RuntimeInvalidParams(`glob path does not exist: ${scopeArg}`);
  });
  if (!contains(root, scopeAbs))
    throw new RuntimeInvalidParams("glob path must remain inside workspace");
  if (!(await stat(scopeAbs)).isDirectory())
    throw new RuntimeInvalidParams(`glob path is not a directory: ${scopeArg}`);
  const scope = relative(root, scopeAbs).split(sep).join("/");
  const limit = Math.min(1_000, Math.max(1, input.limit ?? 200));
  const matcher = new Bun.Glob(input.pattern);
  const maxScannedFiles = Math.max(
    1,
    input.maxScannedFiles ?? maxGlobScannedFiles,
  );
  const maxScannedBytes = Math.max(
    1,
    input.maxScannedBytes ?? maxGlobScannedBytes,
  );
  const deadline =
    Date.now() + Math.max(1, input.deadlineMs ?? maxGlobDeadlineMs);

  let state: GlobCursorState;
  if (input.cursor) {
    state = decodeGlobCursor(input.cursor);
    if (
      !globCursorQueryMatches(state, {
        root,
        pattern: input.pattern,
        scope,
      })
    )
      throw new RuntimeInvalidParams("glob cursor does not match the query");
  } else {
    state = {
      v: 1,
      root,
      pattern: input.pattern,
      scope,
      stack: [{ path: scope, index: 0 }],
      scannedFiles: 0,
      scannedBytes: 0,
    };
  }

  const paths: string[] = [];
  let timedOut = false;

  const result = (truncated: boolean, nextState?: GlobCursorState) => ({
    paths,
    truncated,
    ...(truncated && nextState
      ? { nextCursor: encodeGlobCursor(nextState) }
      : {}),
    scannedFiles: state.scannedFiles,
    scannedBytes: state.scannedBytes,
    ...(timedOut ? { timedOut } : {}),
  });

  const budgetReached = () =>
    paths.length >= limit ||
    state.scannedFiles >= maxScannedFiles ||
    state.scannedBytes >= maxScannedBytes;

  const authorizeResults = () =>
    input.authorize?.({ toolName: "glob", paths: [...paths] }) ??
    Promise.resolve();

  const stopWithCursor = async () => {
    await authorizeResults();
    return result(true, {
      ...state,
      stack: state.stack.map((frame) => ({ ...frame })),
    });
  };

  while (state.stack.length > 0) {
    throwIfGlobAborted(input.signal);
    if (Date.now() >= deadline) {
      timedOut = true;
      return stopWithCursor();
    }

    const frame = state.stack[state.stack.length - 1]!;
    const directory = resolve(root, frame.path || ".");
    const children = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    children.sort((left, right) => left.name.localeCompare(right.name));
    if (frame.index >= children.length) {
      state.stack.pop();
      continue;
    }
    if (budgetReached()) return stopWithCursor();

    const child = children[frame.index]!;
    frame.index += 1;
    const childRelative = frame.path
      ? `${frame.path}/${child.name}`
      : child.name;
    const childAbsolute = resolve(directory, child.name);

    if (child.isDirectory()) {
      if (
        DEFAULT_GREP_IGNORED_DIRECTORIES.has(child.name) &&
        childRelative !== scope &&
        !includeMayEnterDirectory(childRelative, input.pattern)
      )
        continue;
      const real = await realpath(childAbsolute).catch(() => undefined);
      if (!real || !contains(root, real)) continue;
      state.stack.push({ path: childRelative, index: 0 });
      continue;
    }
    if (!child.isFile()) continue;
    if (!matcher.match(childRelative)) continue;

    const info = await stat(childAbsolute).catch(() => undefined);
    throwIfGlobAborted(input.signal);
    if (!info?.isFile()) continue;
    state.scannedFiles += 1;
    state.scannedBytes += info.size;
    paths.push(childRelative);
  }

  await authorizeResults();
  return result(false);
}

export async function watchWorkspaceFiles(
  workspaceRoot: string,
  onChange: (change: {
    path: string;
    operation: "added" | "modified" | "deleted" | "renamed";
  }) => void,
) {
  const root = await realpath(workspaceRoot);
  let watchers: FSWatcher[] = [];
  let closed = false;
  const watchedDirectories = new Set([root]);
  // Watcher pruning is a scheduling optimization for runtime-internal and
  // known-heavy directories. It never hides files from access APIs.
  const ignoreRules: IgnoreRule[] = [];
  const trigger = (directory: string, eventType: string, filename?: string) => {
    if (closed) return;
    const changedPath = filename
      ? resolve(directory, filename.toString())
      : directory;
    const relativePath = relative(root, changedPath).split(sep).join("/");
    if (relativePath === NATALIA_IGNORE_FILE) return;
    if (relativePath && isIgnored(relativePath, false, ignoreRules)) return;
    invalidateWorkspaceFiles(root);
    // The change detail is a hint: the auditor reconciles it into a confirmed
    // change (§56.9). `rename` is mapped to the coarse operation the watcher
    // can prove; a full path/operation determination belongs to reconciliation.
    onChange({
      path: relativePath || ".",
      operation: eventType === "rename" ? "renamed" : "modified",
    });
    // Existing directory watchers observe ordinary file writes. Rebuilding the
    // full recursive watcher tree after every event self-scans large devref
    // trees forever. Attach only genuinely new directories incrementally.
    if (eventType === "rename" && filename)
      void attachNewDirectory(changedPath);
  };
  const attachNewDirectory = async (path: string) => {
    const info = await stat(path).catch(() => undefined);
    if (closed || !info?.isDirectory()) return;
    const real = await realpath(path).catch(() => undefined);
    const relativePath = real ? relative(root, real).split(sep).join("/") : "";
    if (
      !real ||
      !contains(root, real) ||
      isIgnored(relativePath, true, ignoreRules)
    )
      return;
    if (watchedDirectories.has(real)) return;
    watchedDirectories.add(real);
    watchers.push(
      ...(await watchDirectories(
        root,
        real,
        trigger,
        ignoreRules,
        watchedDirectories,
      )),
    );
  };
  watchers = await watchDirectories(
    root,
    root,
    trigger,
    ignoreRules,
    watchedDirectories,
  );
  return () => {
    closed = true;
    watchers.forEach((watcher) => watcher.close());
    watchers = [];
  };
}

const DEFAULT_GREP_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".natalia",
  ".next",
  ".turbo",
  "__pycache__",
  "build",
  "coverage",
  "devref",
  "dist",
  "node_modules",
  "target",
]);

const maxGrepScannedFiles = 500;
const maxGrepScannedBytes = 4 * 1024 * 1024;
const maxGrepDeadlineMs = 8_000;

export type WorkspaceGrepMatch = {
  path: string;
  line: number;
  text: string;
};

export type WorkspaceGrepResult = {
  matches: WorkspaceGrepMatch[];
  truncated: boolean;
  nextCursor?: string;
  scannedFiles: number;
  scannedBytes: number;
  timedOut?: boolean;
};

export type WorkspaceGrepInput = {
  workspaceRoot: string;
  pattern: string;
  path?: string;
  include?: string;
  limit?: number;
  cursor?: string;
  maxScannedFiles?: number;
  maxScannedBytes?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  authorize?: (input: { toolName: "grep"; paths: string[] }) => Promise<void>;
};

type GrepFrame = { path: string; index: number };

type GrepCursorState = {
  v: 1;
  root: string;
  pattern: string;
  scope: string;
  include: string;
  stack: GrepFrame[];
  file?: { path: string; line: number };
  scannedFiles: number;
  scannedBytes: number;
};

function grepCursorQueryMatches(
  state: GrepCursorState,
  input: { root: string; pattern: string; scope: string; include: string },
) {
  return (
    state.v === 1 &&
    state.root === input.root &&
    state.pattern === input.pattern &&
    state.scope === input.scope &&
    state.include === input.include
  );
}

function encodeGrepCursor(state: GrepCursorState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeGrepCursor(cursor: string): GrepCursorState {
  try {
    return JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as GrepCursorState;
  } catch {
    throw new RuntimeInvalidParams("grep cursor is invalid");
  }
}

function throwIfGrepAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("grep aborted");
}

/**
 * Bounded, cursor-paginated grep.
 *
 * Traversal is deterministic DFS: each directory's children are sorted by
 * name before walking, and the cursor stores that frame's next child index
 * plus an optional in-file line offset. Heavy/derived directories are skipped
 * by default; pointing `path` at the workspace root cannot be skipped away.
 */
export async function grepWorkspaceFilesBounded(
  input: WorkspaceGrepInput,
): Promise<WorkspaceGrepResult> {
  if (!input.pattern)
    throw new RuntimeInvalidParams("grep pattern is required");
  let expression: RegExp;
  try {
    expression = new RegExp(input.pattern, "u");
  } catch {
    throw new RuntimeInvalidParams(
      "grep pattern must be a valid regular expression",
    );
  }

  const root = await realpath(input.workspaceRoot);
  const scopeArg = input.path?.trim() || ".";
  const scopeAbs = await realpath(resolve(root, scopeArg)).catch(() => {
    throw new RuntimeInvalidParams(`grep path does not exist: ${scopeArg}`);
  });
  if (!contains(root, scopeAbs))
    throw new RuntimeInvalidParams("grep path must remain inside workspace");
  if (!(await stat(scopeAbs)).isDirectory())
    throw new RuntimeInvalidParams(`grep path is not a directory: ${scopeArg}`);
  const scope = relative(root, scopeAbs).split(sep).join("/");
  const include = input.include?.trim() || "**/*";
  const limit = Math.min(1_000, Math.max(1, input.limit ?? 200));
  const maxScannedFiles = Math.max(
    1,
    input.maxScannedFiles ?? maxGrepScannedFiles,
  );
  const maxScannedBytes = Math.max(
    1,
    input.maxScannedBytes ?? maxGrepScannedBytes,
  );
  const deadline =
    Date.now() + Math.max(1, input.deadlineMs ?? maxGrepDeadlineMs);

  let state: GrepCursorState;
  if (input.cursor) {
    state = decodeGrepCursor(input.cursor);
    if (
      !grepCursorQueryMatches(state, {
        root,
        pattern: input.pattern,
        scope,
        include,
      })
    )
      throw new RuntimeInvalidParams("grep cursor does not match the query");
  } else {
    state = {
      v: 1,
      root,
      pattern: input.pattern,
      scope,
      include,
      stack: [{ path: scope, index: 0 }],
      scannedFiles: 0,
      scannedBytes: 0,
    };
  }

  const matches: WorkspaceGrepMatch[] = [];
  let timedOut = false;

  const result = (truncated: boolean, nextState?: GrepCursorState) => ({
    matches,
    truncated,
    ...(truncated && nextState
      ? { nextCursor: encodeGrepCursor(nextState) }
      : {}),
    scannedFiles: state.scannedFiles,
    scannedBytes: state.scannedBytes,
    ...(timedOut ? { timedOut } : {}),
  });

  const budgetReached = () =>
    matches.length >= limit ||
    state.scannedFiles >= maxScannedFiles ||
    state.scannedBytes >= maxScannedBytes;

  const saveCursorAfterStop = () =>
    result(true, {
      ...state,
      stack: state.stack.map((frame) => ({ ...frame })),
      ...(state.file ? { file: { ...state.file } } : {}),
    });

  const processFile = async (
    displayPath: string,
    startLine: number,
    countBytes: boolean,
  ): Promise<{ done: boolean; nextLine: number }> => {
    const absolutePath = resolve(root, displayPath);
    const info = await stat(absolutePath).catch(() => undefined);
    if (!info?.isFile() || info.size > maxSearchFileBytes)
      return { done: true, nextLine: startLine };
    await input.authorize?.({ toolName: "grep", paths: [displayPath] });
    throwIfGrepAborted(input.signal);
    const bytes = new Uint8Array(await readFile(absolutePath));
    if (countBytes) state.scannedBytes += bytes.byteLength;
    if (bytes.includes(0)) return { done: true, nextLine: startLine };
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { done: true, nextLine: startLine };
    }
    const lines = text.split(/\r?\n/u);
    if (text.endsWith("\n") && lines.at(-1) === "") lines.pop();
    for (let index = startLine; index < lines.length; index += 1) {
      throwIfGrepAborted(input.signal);
      if (Date.now() >= deadline) {
        timedOut = true;
        state.file = { path: displayPath, line: index };
        return { done: false, nextLine: index };
      }
      if (budgetReached()) {
        state.file = { path: displayPath, line: index };
        return { done: false, nextLine: index };
      }
      const line = lines[index] ?? "";
      expression.lastIndex = 0;
      if (expression.test(line)) {
        matches.push({
          path: displayPath,
          line: index + 1,
          text: line.length > 2_000 ? `${line.slice(0, 2_000)}...` : line,
        });
        if (matches.length >= limit) {
          if (index + 1 < lines.length) {
            state.file = { path: displayPath, line: index + 1 };
            return { done: false, nextLine: index + 1 };
          }
          return { done: true, nextLine: lines.length };
        }
      }
    }
    return { done: true, nextLine: lines.length };
  };

  while (state.stack.length > 0) {
    throwIfGrepAborted(input.signal);
    if (Date.now() >= deadline) {
      timedOut = true;
      return saveCursorAfterStop();
    }
    if (state.file) {
      const file = state.file;
      const outcome = await processFile(file.path, file.line, false);
      if (!outcome.done) return saveCursorAfterStop();
      state.file = undefined;
      continue;
    }

    const frame = state.stack[state.stack.length - 1]!;
    const directory = resolve(root, frame.path || ".");
    const children = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    children.sort((left, right) => left.name.localeCompare(right.name));
    if (frame.index >= children.length) {
      state.stack.pop();
      continue;
    }
    if (budgetReached()) return saveCursorAfterStop();
    const child = children[frame.index]!;
    frame.index += 1;
    const childRelative = frame.path
      ? `${frame.path}/${child.name}`
      : child.name;
    const childAbsolute = resolve(directory, child.name);

    if (child.isDirectory()) {
      if (
        DEFAULT_GREP_IGNORED_DIRECTORIES.has(child.name) &&
        childRelative !== scope &&
        !includeMayEnterDirectory(childRelative, include)
      )
        continue;
      const real = await realpath(childAbsolute).catch(() => undefined);
      if (!real || !contains(root, real)) continue;
      state.stack.push({ path: childRelative, index: 0 });
      continue;
    }
    if (!child.isFile()) continue;
    if (!matchesInclude(childRelative, include)) continue;
    state.scannedFiles += 1;
    const outcome = await processFile(childRelative, 0, true);
    if (!outcome.done) return saveCursorAfterStop();
  }

  return result(false);
}

export async function searchWorkspaceFiles(input: {
  workspaceRoot: string;
  query: string;
  include?: string;
  limit?: number;
}) {
  if (!input.query.trim())
    throw new RuntimeInvalidParams("workspace search query is required");
  let expression: RegExp;
  try {
    expression = new RegExp(input.query, "u");
  } catch {
    throw new RuntimeInvalidParams(
      "workspace search query must be a valid regular expression",
    );
  }
  const root = await realpath(input.workspaceRoot);
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  // Access/search intentionally does not apply .gitignore or the snapshot
  // ignore file. Those rules are not a visibility policy for users or tools.
  const ignoreRules: IgnoreRule[] = [];
  const entries: RuntimeWorkspaceFileEntry[] = [];
  await collectSearchFiles(
    root,
    root,
    entries,
    maxSearchFiles,
    ignoreRules,
    new Set([root]),
  );
  const files = entries
    .filter((entry) => matchesInclude(entry.path, input.include))
    .sort(
      (left, right) =>
        left.path.length - right.path.length ||
        left.path.localeCompare(right.path),
    );
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const file of files) {
    if (matches.length >= limit) break;
    const content = await readSearchText(resolve(root, file.path));
    if (content === undefined) continue;
    for (const [index, line] of content.split(/\r?\n/u).entries()) {
      expression.lastIndex = 0;
      if (!expression.test(line)) continue;
      matches.push({
        path: file.path,
        line: index + 1,
        text: line.length > 2_000 ? `${line.slice(0, 2_000)}...` : line,
      });
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

async function collectSearchFiles(
  root: string,
  directory: string,
  output: RuntimeWorkspaceFileEntry[],
  maxFiles: number,
  ignoreRules: IgnoreRule[],
  visited: Set<string>,
) {
  if (output.length >= maxFiles) return;
  const children = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  for (const child of children) {
    if (output.length >= maxFiles) return;
    const path = resolve(directory, child.name);
    const real = await realpath(path).catch(() => undefined);
    if (!real || !contains(root, real)) continue;
    const relativePath = relative(root, path).split(sep).join("/");
    if (!relativePath) continue;
    if (child.isDirectory()) {
      if (visited.has(real)) continue;
      visited.add(real);
      await collectSearchFiles(
        root,
        real,
        output,
        maxFiles,
        ignoreRules,
        visited,
      );
      continue;
    }
    if (child.isFile()) output.push({ path: relativePath, type: "file" });
  }
}

async function refreshWorkspaceFiles(root: string) {
  // The access catalog is intentionally ignore-free. Watchers may still prune
  // expensive subtrees for scheduling reasons, but that is not visibility.
  const entries: RuntimeWorkspaceFileEntry[] = [];
  await collect(root, root, entries, 10_000, [], new Set([root]));
  const catalog = { entries, expiresAt: Date.now() + 1_000, ignoreRules: [] };
  catalogs.set(root, catalog);
  return catalog;
}

async function workspaceCatalog(root: string) {
  const cached = catalogs.get(root);
  if (cached && cached.expiresAt > Date.now()) return cached;
  return await refreshWorkspaceFiles(root);
}

async function collect(
  root: string,
  directory: string,
  output: RuntimeWorkspaceFileEntry[],
  maxEntries: number,
  ignoreRules: IgnoreRule[],
  visited: Set<string>,
): Promise<void> {
  if (output.length >= maxEntries) return;
  const children = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  for (const child of children) {
    if (output.length >= maxEntries) return;
    const path = resolve(directory, child.name);
    const real = await realpath(path).catch(() => undefined);
    if (!real || !contains(root, real)) continue;
    const relativePath = relative(root, path).split(sep).join("/");
    if (!relativePath) continue;
    if (child.isDirectory()) {
      output.push({ path: `${relativePath}/`, type: "directory" });
      if (!visited.has(real)) {
        visited.add(real);
        await collect(root, real, output, maxEntries, ignoreRules, visited);
      }
      continue;
    }
    if (child.isFile()) output.push({ path: relativePath, type: "file" });
  }
}

async function watchDirectories(
  root: string,
  directory: string,
  onChange: (directory: string, eventType: string, filename?: string) => void,
  ignoreRules: IgnoreRule[],
  visited: Set<string>,
): Promise<FSWatcher[]> {
  const watchers: FSWatcher[] = [];
  const children = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  // A watcher that cannot be established must not come back looking healthy:
  // the caller relies on `onChange` for catalog invalidation, and a silently
  // missing watcher turns stale data into a silent lie. `watch` fails with
  // ENOSPC when the system's inotify budget is exhausted (per-user
  // fs.inotify.max_user_watches), which is exactly the situation that must
  // surface. The runtime caller tolerates the failure explicitly with its own
  // `.catch`; it does not rely on this one.
  watchers.push(
    watch(directory, { persistent: false }, (eventType, filename) =>
      onChange(directory, eventType, filename?.toString()),
    ),
  );
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const path = resolve(directory, child.name);
    const real = await realpath(path).catch(() => undefined);
    if (!real || !contains(root, real) || visited.has(real)) continue;
    const relativePath = relative(root, path).split(sep).join("/");
    // Pruned purely by the collected rules. A negated rule never disables
    // this pruning: isIgnored evaluates negations with their base scope, and
    // git semantics forbid re-including anything under an excluded
    // directory anyway. Without this, one vendored subtree whose own
    // .gitignore contains a `!` pattern disables pruning for the whole
    // workspace and the watcher lands on every devref directory.
    if (isIgnored(relativePath, true, ignoreRules)) continue;
    visited.add(real);
    watchers.push(
      ...(await watchDirectories(root, real, onChange, ignoreRules, visited)),
    );
  }
  return watchers;
}

function contains(root: string, target: string) {
  return target === root || target.startsWith(`${root}${sep}`);
}

export async function writeWorkspaceFile(input: {
  workspaceRoot: string;
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}): Promise<{ written: boolean }> {
  const root = await realpath(input.workspaceRoot);
  const path = await resolveWorkspacePath(root, input.path);
  const bytes =
    input.encoding === "base64"
      ? Buffer.from(input.content, "base64")
      : Buffer.from(input.content, "utf8");
  await writeFile(path, bytes, { mode: 0o600 });
  invalidateWorkspaceFiles(root);
  return { written: true };
}

export async function createWorkspaceFile(input: {
  workspaceRoot: string;
  path: string;
  content?: string;
  encoding?: "utf8" | "base64";
  directory?: boolean;
}): Promise<{ created: boolean }> {
  const root = await realpath(input.workspaceRoot);
  const path = await resolveWorkspacePath(root, input.path);
  if (input.directory) {
    await mkdir(path, { recursive: true });
    invalidateWorkspaceFiles(root);
    return { created: true };
  }
  await mkdir(dirname(path), { recursive: true });
  const bytes =
    input.encoding === "base64"
      ? Buffer.from(input.content ?? "", "base64")
      : Buffer.from(input.content ?? "", "utf8");
  await writeFile(path, bytes, { mode: 0o600 });
  invalidateWorkspaceFiles(root);
  return { created: true };
}

export async function renameWorkspaceFile(input: {
  workspaceRoot: string;
  path: string;
  newPath: string;
}): Promise<{ renamed: boolean }> {
  const root = await realpath(input.workspaceRoot);
  const source = await resolveWorkspacePath(root, input.path);
  const destination = await resolveWorkspacePath(root, input.newPath);
  if (source === destination)
    throw new RuntimeRefusal(
      "workspace rename source and destination are identical",
    );
  await mkdir(dirname(destination), { recursive: true });
  await rename(source, destination);
  invalidateWorkspaceFiles(root);
  return { renamed: true };
}

export async function deleteWorkspaceFile(input: {
  workspaceRoot: string;
  path: string;
}): Promise<{ deleted: boolean; trash: boolean }> {
  const root = await realpath(input.workspaceRoot);
  const path = await resolveWorkspacePath(root, input.path);
  await moveToTrash(path);
  invalidateWorkspaceFiles(root);
  return { deleted: true, trash: true };
}

async function moveToTrash(path: string): Promise<void> {
  if (process.platform === "win32") {
    const quoted = path.replace(/'/gu, "''");
    const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${quoted}','OnlyErrorDialogs','SendToRecycleBin')`;
    await runTrashCommand("powershell.exe", ["-NoProfile", "-Command", script]);
    return;
  }
  if (process.platform === "darwin") {
    const quoted = path.replace(/'/gu, "'\''");
    const script = `tell application "Finder" to delete POSIX file '${quoted}'`;
    await runTrashCommand("osascript", ["-e", script]);
    return;
  }
  // Linux: prefer GLib's gio, fall back to trash-put.
  try {
    await runTrashCommand("gio", ["trash", path]);
  } catch {
    await runTrashCommand("trash-put", [path]);
  }
}

async function runTrashCommand(command: string, args: string[]) {
  const child = Bun.spawn([command, ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await child.exited;
  if (code !== 0)
    throw new RuntimeRefusal(`failed to move to trash: ${command}`);
}
async function resolveWorkspacePath(root: string, input: string) {
  // Refusals, not failures: the caller asked for something policy does not allow,
  // which a remote consumer must be able to tell apart from a broken runtime. The
  // reason names the rule and never the resolved path — the absolute path is the
  // one thing that must not travel back out of here.
  if (!input || input.startsWith("/") || input.split(/[\\/]/u).includes(".."))
    throw new RuntimeRefusal("workspace path must remain inside workspace");
  const path = resolve(root, input);
  if (!contains(root, path))
    throw new RuntimeRefusal("workspace path must remain inside workspace");
  // Resolve through the deepest EXISTING ancestor's realpath, then re-attach the
  // not-yet-existing suffix. A create/rename target may not exist — possibly
  // several levels deep — and a symlinked directory anywhere in the path must
  // not smuggle the write outside the workspace (a lexical-only resolve let
  // `newdir` that is really a symlink escape the containment check).
  const segments = relative(root, path).split(sep);
  let resolved = root;
  let index = 0;
  for (; index < segments.length; index += 1) {
    const real = await realpath(join(resolved, segments[index]!)).catch(
      () => undefined,
    );
    if (real === undefined) break;
    resolved = real;
  }
  const finalPath = join(resolved, ...segments.slice(index));
  if (!contains(root, finalPath))
    throw new RuntimeRefusal("workspace path must remain inside workspace");
  return finalPath;
}

function normalizeWorkspacePathForPolicy(path: string) {
  return path.split(/[\\/]/u).join("/");
}

function isIgnored(path: string, directory: boolean, rules: IgnoreRule[]) {
  const normalized = normalizeWorkspacePathForPolicy(path);
  if (
    normalized === ".natalia/plans" ||
    normalized.startsWith(".natalia/plans/")
  )
    return false;
  if (normalized.split("/").some((part) => ignoredDirectories.has(part)))
    return true;
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

function decodeUtf8(bytes: Uint8Array) {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function mimeType(path: string) {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (extension === "json") return "application/json";
  if (extension === "ts" || extension === "tsx") return "text/typescript";
  if (extension === "js" || extension === "jsx") return "text/javascript";
  if (extension === "md") return "text/markdown";
  if (extension === "html") return "text/html";
  if (extension === "css") return "text/css";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  return "text/plain";
}

function imageMime(bytes: Uint8Array) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes.slice(8), [0x57, 0x45, 0x42, 0x50])
  )
    return "image/webp";
}

function startsWith(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value);
}

async function readSearchText(path: string) {
  try {
    const file = Bun.file(path);
    if ((await file.size) > maxSearchFileBytes) return undefined;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.includes(0)) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Binary/invalid-UTF-8 files and files removed during the walk are simply
    // not searchable; one bad entry must not abort the whole query.
    return undefined;
  }
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

function matchesInclude(path: string, include?: string) {
  if (!include) return true;
  const prefix = include.includes("/") ? "" : "(?:.*/)?";
  return new RegExp(`^${prefix}${globExpression(include)}$`, "u").test(path);
}

/**
 * Returns true when a default-ignored directory is explicitly addressed by a
 * glob include prefix such as `devref/...` or `**\/devref/...`.
 * `**\/*` alone intentionally does not make every heavy directory walkable.
 */
function includeMayEnterDirectory(directory: string, include?: string) {
  if (!include) return false;
  const normalized = include.replace(/\\/gu, "/").replace(/^\.\//u, "");
  const withoutLeadingGlob = normalized.startsWith("**/")
    ? normalized.slice(3)
    : normalized;
  return withoutLeadingGlob.startsWith(`${directory}/`);
}
