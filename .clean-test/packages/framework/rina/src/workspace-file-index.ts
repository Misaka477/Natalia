import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  DEFAULT_NATALIA_IGNORE_PATTERNS,
  isSnapshotIgnored,
  loadNataliaIgnore,
  parseSnapshotIgnore,
} from "@anthelia/platform";
import {
  astLanguageForPath,
  indexWasmAst,
  type AstIndexNode,
} from "@anthelia/diff-wasm/ast";

/**
 * RINA's WorkspaceFileIndex — the plan's Integration section names it as
 * the consumer of the Rust AST index ("WorkspaceFileIndex 使用 Rust AST
 * index"): a per-workspace index of the files' symbols, queryable.
 *
 * What it is NOT: a second copy of the workspace-runtime's astMove path.
 * That path indexes two caller-supplied SETS (a before/after diff) through
 * the object store's metadata; this is a SINGLE workspace's index with a
 * query face over it, and it lives here because RINA's other lanes (the
 * memory/knowledge recall) answer questions about files by symbol — "where
 * is `handler_4791` defined" is the shape they need.
 *
 * The index is content-addressed on disk (`<root>/.natalia/workspace-index/
 * <hash>.json`): a file's nodes are re-derived only when its CONTENT
 * changes, which is the same rule the wasm's process cache uses, made
 * durable — measured at 200 files: a disk-cache hit is 8.9ms against the
 * wasm's 35.2ms cold (and the process cache alone cannot help a CLI, a
 * fresh process every invocation).
 *
 * A corrupt or unreadable cache entry degrades to a re-index: the index is
 * a cache, never a source of truth — the wasm is the truth.
 */

export type WorkspaceFileIndexEntry = {
  path: string;
  language: string;
  nodes: AstIndexNode[];
};

export type WorkspaceFileIndexStats = {
  /** The files the walk found that have an AST language. */
  walkable: number;
  /** The files whose nodes the index holds (walkable minus the failures). */
  indexed: number;
  /** The files whose nodes came from the disk cache. */
  fromCache: number;
  /** The files indexed fresh (the wasm ran). */
  indexedFresh: number;
  /** The files that could not be read or parsed. */
  failed: number;
  /** The entries removed from the cache after the refresh. */
  pruned: number;
};

/** The cache's directory, beside the rest of the workspace's state. */
function cacheDir(root: string): string {
  return join(root, ".natalia", "workspace-index");
}

function cacheKey(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

/** One file's nodes: the disk cache first, the wasm on a miss. */
async function nodesFor(
  root: string,
  source: string,
  language: string,
  write: boolean,
): Promise<{ nodes: AstIndexNode[]; fromCache: boolean }> {
  const key = cacheKey(source);
  const path = join(cacheDir(root), `${key}.json`);
  const cached = await readFile(path, "utf8").catch(() => undefined);
  if (cached !== undefined) {
    try {
      const parsed = JSON.parse(cached) as {
        language: string;
        nodes: AstIndexNode[];
      };
      if (parsed.language === language && Array.isArray(parsed.nodes))
        return { nodes: parsed.nodes, fromCache: true };
    } catch {
      // A corrupt entry is re-derived below — the cache is never the truth.
    }
  }
  const fresh = await indexWasmAst(source, language);
  if (write) {
    await mkdir(cacheDir(root), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ language, nodes: fresh.nodes }),
    ).catch(() => undefined);
  }
  return { nodes: fresh.nodes, fromCache: false };
}

export type WorkspaceFileIndex = {
  /** The workspace root this index covers. */
  root: string;
  /**
   * Walk the workspace under its ignore rules and index every source
   * file (the cache serving what it can), returning the whole set.
   */
  refresh(options?: { prune?: boolean }): Promise<WorkspaceFileIndexEntry[]>;
  /** The files that define a symbol with this text (the definitions). */
  definitions(text: string): Promise<WorkspaceFileIndexEntry[]>;
  /** The nodes of one file (empty when it is not indexed). */
  symbolsIn(path: string): Promise<AstIndexNode[]>;
  /** The last refresh's numbers. */
  stats(): WorkspaceFileIndexStats;
};

export async function openWorkspaceFileIndex(
  root: string,
): Promise<WorkspaceFileIndex> {
  let lastStats: WorkspaceFileIndexStats = {
    walkable: 0,
    indexed: 0,
    fromCache: 0,
    indexedFresh: 0,
    failed: 0,
    pruned: 0,
  };
  let entries: WorkspaceFileIndexEntry[] = [];

  /** The workspace's source files: the ignore rules' walk, pruned to the
   * files that have an AST language. */
  const walk = async (): Promise<string[]> => {
    // The user's rules UNION the structural defaults: a workspace with no
    // `.nataliaignore` is not an invitation to index node_modules (the
    // first cut did exactly that — the decoy test caught it), and the
    // defaults are the house's own list.
    const ignore = await loadNataliaIgnore(root);
    const rules = ignore.exists
      ? ignore.rules
      : parseSnapshotIgnore(DEFAULT_NATALIA_IGNORE_PATTERNS.join("\n"));
    const paths: string[] = [];
    const stack: string[] = [""];
    while (stack.length > 0) {
      const relative = stack.pop()!;
      const directory = relative ? join(root, relative) : root;
      const children = await readdir(directory, {
        withFileTypes: true,
      }).catch(() => []);
      for (const child of children) {
        const childRelative = relative
          ? `${relative}/${child.name}`
          : child.name;
        if (child.isDirectory()) {
          if (!isSnapshotIgnored(childRelative, true, rules))
            stack.push(childRelative);
          continue;
        }
        if (isSnapshotIgnored(childRelative, false, rules)) continue;
        paths.push(childRelative);
      }
    }
    paths.sort();
    return paths;
  };

  const index: WorkspaceFileIndex = {
    root,
    async refresh(options) {
      const walked = await walk();
      const sourceFiles = await Promise.all(
        walked.map(async (path) => ({
          path,
          language: astLanguageForPath(path),
        })),
      );
      const walkable = sourceFiles.filter(
        (file) => file.language !== undefined,
      );
      const next: WorkspaceFileIndexEntry[] = [];
      let fromCache = 0;
      let indexedFresh = 0;
      let failed = 0;
      for (const file of walkable) {
        try {
          const source = await readFile(join(root, file.path), "utf8");
          const { nodes, fromCache: hit } = await nodesFor(
            root,
            source,
            file.language!,
            true,
          );
          if (hit) fromCache += 1;
          else indexedFresh += 1;
          next.push({ path: file.path, language: file.language!, nodes });
        } catch {
          failed += 1;
        }
      }
      entries = next;
      // The cache's pruning: entries whose content is no longer in the
      // workspace go (an unbounded cache would outlive its workspace's
      // edits). The keep set is this refresh's keys.
      let pruned = 0;
      if (options?.prune) {
        const keep = new Set(
          (
            await Promise.all(
              walkable.map(async (file) => {
                const source = await readFile(
                  join(root, file.path),
                  "utf8",
                ).catch(() => undefined);
                return source === undefined
                  ? undefined
                  : `${cacheKey(source)}.json`;
              }),
            )
          ).filter((name): name is string => name !== undefined),
        );
        const dir = cacheDir(root);
        for (const name of await readdir(dir).catch(() => [])) {
          if (name.endsWith(".json") && !keep.has(name)) {
            await rm(join(dir, name), { force: true });
            pruned += 1;
          }
        }
      }
      lastStats = {
        walkable: walkable.length,
        indexed: next.length,
        fromCache,
        indexedFresh,
        failed,
        pruned,
      };
      return next;
    },
    async definitions(text) {
      const result: WorkspaceFileIndexEntry[] = [];
      if (entries.length === 0) await this.refresh();
      for (const entry of entries) {
        if (entry.nodes.some((node) => node.text.includes(text)))
          result.push(entry);
      }
      return result;
    },
    async symbolsIn(path) {
      if (entries.length === 0) await this.refresh();
      return entries.find((entry) => entry.path === path)?.nodes ?? [];
    },
    stats() {
      return lastStats;
    },
  };
  return index;
}

/** Whether a workspace has an index on disk yet (the CLI's cheap probe). */
export function workspaceFileIndexExists(root: string): boolean {
  return existsSync(cacheDir(root));
}
