import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { CacheKindDefinition } from "./cache";

/**
 * The first consumable on the fabric: L1 read caching for tool execution
 * (RINA study — the tool pipeline executes fs-read/search cold on every
 * call today, and a subagent re-reads files its parent already read).
 *
 * The classification is the explicit list law 1 asks for: tools named here
 * are deterministic reads whose inputs fully determine their output;
 * everything else (shell, web, ask, todo, process…) is not listed and
 * therefore never caches. `shell` additionally *flushes* the tree kinds when
 * it finishes — it is the opaque writer the hooks cannot see into.
 */

/** tool name -> cache kind. Anything absent is executed every time. */
export const READ_CACHE_TOOL_KINDS: Readonly<Record<string, string>> = {
  read_file: "tool.fs-read",
  glob: "tool.glob",
  grep: "tool.search",
};

/**
 * Tools that may write into the workspace without declaring paths (their
 * writes are opaque to the mutation hooks): after they run, tree-scoped
 * results are dropped — the study's invalidate-on-write, extended to the
 * one writer the declarations cannot see.
 */
export const OPAQUE_WORKSPACE_WRITERS: ReadonlySet<string> = new Set([
  "run_shell",
]);

interface FsReadKeyShape {
  path?: unknown;
}

function pathFromKey(key: string): string {
  let parsed: FsReadKeyShape;
  try {
    parsed = JSON.parse(key) as FsReadKeyShape;
  } catch {
    throw new Error(`fs-read cache key is not JSON tool input: ${key}`);
  }
  if (typeof parsed.path !== "string")
    throw new Error(`fs-read cache key carries no path: ${key}`);
  return parsed.path;
}

/**
 * Evidence for a read: the canonical path plus the file's own size and
 * nanosecond mtime — the fs's record of "this is what was true when the
 * value was computed". A hit whose stat disagrees is a miss (external
 * writers are seen), which is law 2: evidence beats TTL guessing.
 */
async function captureFsReadEvidence(key: string) {
  const canonical = realpathSync.native(resolve(pathFromKey(key)));
  const info = await stat(canonical, { bigint: true });
  return {
    path: canonical,
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
  };
}

async function validFsReadEvidence(
  evidence: unknown,
  key: string,
): Promise<boolean> {
  const captured = evidence as {
    path?: string;
    size?: string;
    mtimeNs?: string;
  };
  if (!captured || typeof captured.path !== "string") return false;
  try {
    const info = await stat(captured.path, { bigint: true });
    return (
      String(info.size) === captured.size &&
      String(info.mtimeNs) === captured.mtimeNs
    );
  } catch {
    // Gone or unreadable: the old value must not answer again.
    return false;
  }
}

export const toolFsReadKind: CacheKindDefinition = {
  id: "tool.fs-read",
  deterministic: true,
  invalidation: "path",
  captureEvidence: captureFsReadEvidence,
  validEvidence: validFsReadEvidence,
};

/**
 * Tree-scoped kinds: a listing or a search describes the whole tree, so any
 * workspace write (or an opaque shell write) drops every entry — cheap,
 * conservative, and never wrong in the dangerous direction.
 */
export const toolGlobKind: CacheKindDefinition = {
  id: "tool.glob",
  deterministic: true,
  invalidation: "tree",
};

export const toolSearchKind: CacheKindDefinition = {
  id: "tool.search",
  deterministic: true,
  invalidation: "tree",
};

export const L1_CACHE_KINDS: readonly CacheKindDefinition[] = [
  toolFsReadKind,
  toolGlobKind,
  toolSearchKind,
];
