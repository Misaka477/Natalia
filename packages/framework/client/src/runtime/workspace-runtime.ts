import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ObjectStore } from "@anthelia/object-store";
import {
  isSnapshotIgnored,
  loadNataliaIgnore,
  resolveWorkspaceObjectsRoot,
  createWorkspaceFile,
  deleteWorkspaceFile,
  findWorkspaceFiles,
  globWorkspaceFiles,
  listWorkspaceFiles,
  readWorkspaceFile,
  renameWorkspaceFile,
  searchWorkspaceFiles,
  writeWorkspaceFile,
} from "@anthelia/platform";
import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import {
  RuntimeRefusal,
  type RuntimeAstNode,
  type RuntimeGitRef,
  type RuntimeWorkspaceDiffChange,
} from "@anthelia/contracts";
import type { RuntimeContext } from "@anthelia/substrate";
import { detectMoves } from "@anthelia/rina";
import { resolveNamedPluginWorkspaceResource } from "./plugin-workspace-resources";

type WorkspaceRuntime = Pick<
  RuntimeServiceClient,
  | "astMove"
  | "workspaceAstMove"
  | "workspaceFiles"
  | "workspaceSearch"
  | "workspaceList"
  | "workspaceRead"
  | "resourceRead"
  | "workspaceGlob"
  | "workspaceWrite"
  | "workspaceCreate"
  | "workspaceRename"
  | "workspaceDelete"
  | "workspaceWriteConflicts"
  | "workspaceGitDiff"
  | "gitRefs"
  | "astDiff"
  | "astDiffBatch"
  | "astRefactorPreview"
  | "astService"
  | "astRefactorPlan"
  | "astApplyRefactor"
>;

type MutationRecord = {
  id: string;
  at: string;
  workspaceRoot: string;
  sessionID?: string;
  path: string;
  oldPath?: string;
  operation: "add" | "modify" | "delete" | "rename";
  origin:
    | "tool"
    | "sandbox_merge"
    | "checkpoint_rollback"
    | "refactor"
    | "external"
    | "unknown";
};

async function appendWorkspaceMutation(
  ctx: RuntimeContext,
  record: MutationRecord,
) {
  try {
    const logPath = resolve(
      ctx.ports.getWorkspaceRoot(),
      ".natalia",
      "workspace-mutations.json",
    );
    await mkdir(dirname(logPath), { recursive: true });
    let rows: MutationRecord[] = [];
    try {
      rows = JSON.parse(await readFile(logPath, "utf8")) as MutationRecord[];
    } catch {
      rows = [];
    }
    rows.push(record);
    await writeFile(logPath, JSON.stringify(rows, null, 2));
  } catch {
    // Mutation log is best-effort; never block workspace writes.
  }
}

async function astDiffWithWorkerFallback(
  oldText: string,
  newText: string,
  language: string,
) {
  try {
    const { astDiffInWorker } = await import("./runtime-ast-client");
    return await astDiffInWorker(oldText, newText, language);
  } catch {
    const { diffWasmAst } = await import("@anthelia/diff-wasm/ast");
    return diffWasmAst(oldText, newText, language);
  }
}

/**
 * The workspace's SOURCE files: a recursive walk under the workspace's own
 * ignore rules (`.nataliaignore` — the same machinery the snapshots use),
 * pruned to the files that have an AST language. The plan's Phase C needs
 * the workspace as a SET (the move face's before/after); the access
 * catalog in platform is intentionally ignore-free (a picker must see
 * everything), so this walk is its own.
 */
async function walkSourceFiles(
  root: string,
): Promise<{ paths: string[]; ignored: number }> {
  const ignore = await loadNataliaIgnore(root);
  const paths: string[] = [];
  let ignored = 0;
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relative = stack.pop()!;
    const directory = relative ? join(root, relative) : root;
    const children = await readdir(directory, {
      withFileTypes: true,
    }).catch(() => []);
    for (const child of children) {
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      if (child.isDirectory()) {
        if (isSnapshotIgnored(childRelative, true, ignore.rules)) {
          ignored += 1;
          continue;
        }
        stack.push(childRelative);
        continue;
      }
      if (isSnapshotIgnored(childRelative, false, ignore.rules)) {
        ignored += 1;
        continue;
      }
      paths.push(childRelative);
    }
  }
  paths.sort();
  return { paths, ignored };
}

async function astIndexWithWorkerFallback(source: string, language: string) {
  try {
    const { astIndexInWorker } = await import("./runtime-ast-client");
    return await astIndexInWorker(source, language);
  } catch {
    const { indexWasmAst } = await import("@anthelia/diff-wasm/ast");
    return indexWasmAst(source, language);
  }
}

export function createWorkspaceRuntime(ctx: RuntimeContext): WorkspaceRuntime {
  /**
   * One file set through the AST index (the worker pool + the object
   * store's cache). A closure rather than a surface method: it is the
   * shared path for `astService` and `astMove`, not a member of the
   * RuntimeClient — a second index walk for the move face would be a
   * second implementation of a thing that exists.
   */
  const indexAstFiles = async (
    files: Array<{
      path?: string;
      source: string;
      language: string;
    }>,
    filter?: { nodeKind?: string; textIncludes?: string },
  ): Promise<
    Array<{
      path?: string;
      language: string;
      nodes: RuntimeAstNode[];
      error?: string;
    }>
  > => {
    await ctx.ports.getReady();
    const astIndexStore = new ObjectStore(
      resolveWorkspaceObjectsRoot(ctx.ports.getWorkspaceRoot()),
    );
    // The 50-file cap is GONE: a workspace's move detection was blind
    // past the fiftieth file (a move in the hundredth file was
    // undetectable — a correctness hole at exactly the scale the plan's
    // Phase C exists for). The cost it guarded against does not exist:
    // the index is content-addressed in the object store's metadata, so
    // the marginal cost of the whole set is per-NEW-file (~0.5ms cold,
    // ~0 measured warm — 2000 files indexed in 1ms on the second pass).
    const cap = files;
    const results: Array<{
      path?: string;
      language: string;
      nodes: RuntimeAstNode[];
      error?: string;
    }> = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < cap.length) {
        const file = cap[cursor++]!;
        try {
          const cacheKey = `ast-index:${file.language}:${createHash("sha256")
            .update(file.source)
            .digest("hex")}`;
          const cached = await astIndexStore.getMeta<{
            nodes: RuntimeAstNode[];
          }>(cacheKey);
          let indexed: { language: string; nodes: RuntimeAstNode[] };
          if (cached) {
            indexed = { language: file.language, nodes: cached.nodes };
          } else {
            indexed = await astIndexWithWorkerFallback(
              file.source,
              file.language,
            );
            await astIndexStore.putMeta(cacheKey, { nodes: indexed.nodes });
          }
          const lower = filter?.textIncludes?.toLowerCase();
          const nodes = indexed.nodes.filter((node) => {
            if (filter?.nodeKind && node.nodeKind !== filter.nodeKind)
              return false;
            if (lower && !node.text.toLowerCase().includes(lower)) return false;
            return true;
          });
          results.push({
            path: file.path,
            language: indexed.language,
            nodes,
          });
        } catch (error) {
          results.push({
            path: file.path,
            language: file.language,
            nodes: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, cap.length) }, () => worker()),
    );
    return results;
  };

  return {
    async workspaceFiles(input) {
      await ctx.ports.getReady();
      return await findWorkspaceFiles({
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
        ...input,
      });
    },
    async workspaceSearch(input) {
      await ctx.ports.getReady();
      return await searchWorkspaceFiles({
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
        ...input,
      });
    },
    async workspaceList(input) {
      await ctx.ports.getReady();
      return await listWorkspaceFiles({
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
        ...input,
      });
    },
    async workspaceRead(input) {
      await ctx.ports.getReady();
      return await readWorkspaceFile({
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
        ...input,
      });
    },
    async resourceRead(input) {
      await ctx.ports.getReady();
      const resource = resolveNamedPluginWorkspaceResource({
        registry: ctx.ports.getCapabilityRegistry(),
        resource: input.resource,
        params: input.params ?? {},
        sessionID: ctx.ports.getSessionID(),
        reader: input.reader,
      });
      if (!resource)
        throw new RuntimeRefusal(
          "plugin resource is unavailable or not authorized",
        );
      const result = await readWorkspaceFile({
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
        path: resource.relativePath,
      });
      if (resource.audit) {
        ctx.ports.publish({
          type: "resource.read",
          id: `resource:${resource.pluginID}:${randomUUID()}`,
          resource: resource.contributionName,
          owner: resource.pluginID,
          ...(input.reader ? { reader: input.reader } : {}),
          path: resource.relativePath,
          at: new Date().toISOString(),
        });
      }
      return result;
    },
    async workspaceGlob(input) {
      await ctx.ports.getReady();
      return await globWorkspaceFiles({
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
        ...input,
      });
    },
    async workspaceWrite(input) {
      await ctx.ports.getReady();
      const result = await writeWorkspaceFile({
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
        ...input,
      });
      void appendWorkspaceMutation(ctx, {
        id: `mut_${Date.now().toString(36)}`,
        at: new Date().toISOString(),
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
        sessionID: ctx.ports.getSessionID(),
        path: input.path,
        operation: "modify",
        origin: "tool",
      });
      return result;
    },
    async workspaceCreate(input) {
      await ctx.ports.getReady();
      const result = await createWorkspaceFile({
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
        ...input,
      });
      void appendWorkspaceMutation(ctx, {
        id: `mut_${Date.now().toString(36)}`,
        at: new Date().toISOString(),
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
        sessionID: ctx.ports.getSessionID(),
        path: input.path,
        operation: "add",
        origin: "tool",
      });
      return result;
    },
    async workspaceRename(input) {
      await ctx.ports.getReady();
      const result = await renameWorkspaceFile({
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
        ...input,
      });
      void appendWorkspaceMutation(ctx, {
        id: `mut_${Date.now().toString(36)}`,
        at: new Date().toISOString(),
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
        sessionID: ctx.ports.getSessionID(),
        path: input.newPath,
        oldPath: input.path,
        operation: "rename",
        origin: "tool",
      });
      return result;
    },
    async workspaceDelete(input) {
      await ctx.ports.getReady();
      const result = await deleteWorkspaceFile({
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
        ...input,
      });
      void appendWorkspaceMutation(ctx, {
        id: `mut_${Date.now().toString(36)}`,
        at: new Date().toISOString(),
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
        sessionID: ctx.ports.getSessionID(),
        path: input.path,
        operation: "delete",
        origin: "tool",
      });
      return result;
    },
    async workspaceWriteConflicts() {
      await ctx.ports.getReady();
      return ctx.ports.getWorkspaceWriteLock()?.snapshot() ?? [];
    },
    async workspaceGitDiff(input?: {
      from?: string;
      to?: string;
      path?: string;
      includePatch?: boolean;
      includeContent?: boolean;
      ignoreWhitespace?: boolean;
    }) {
      await ctx.ports.getReady();
      return await collectWorkspaceGitDiff(ctx.ports.getWorkspaceRoot(), input);
    },
    async astDiff(input: {
      oldText: string;
      newText: string;
      language: string;
    }) {
      await ctx.ports.getReady();
      return await astDiffWithWorkerFallback(
        input.oldText,
        input.newText,
        input.language,
      );
    },
    async astDiffBatch(input: {
      files: Array<{
        path?: string;
        oldText: string;
        newText: string;
        language: string;
      }>;
      options?: {
        maxChangesPerFile?: number;
      };
    }) {
      await ctx.ports.getReady();
      const { diffWasmAst } = await import("@anthelia/diff-wasm/ast");
      const files = input.files.slice(0, 50);
      const results: Array<{
        path?: string;
        language: string;
        changes: Array<{
          kind: "modified" | "added" | "removed" | "moved";
          nodeKind: string;
          oldStart: number;
          oldEnd: number;
          newStart: number;
          newEnd: number;
        }>;
        error?: string;
      }> = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < files.length) {
          const file = files[cursor++]!;
          try {
            const result = await diffWasmAst(
              file.oldText,
              file.newText,
              file.language,
            );
            results.push({
              path: file.path,
              language: result.language,
              changes: input.options?.maxChangesPerFile
                ? result.changes.slice(0, input.options.maxChangesPerFile)
                : result.changes,
            });
          } catch (error) {
            results.push({
              path: file.path,
              language: file.language,
              changes: [],
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(4, files.length) }, () => worker()),
      );
      return { files: results };
    },
    async astRefactorPreview(input: {
      operation: "rename" | "extract" | "inline" | "move" | "custom";
      files: Array<{
        path?: string;
        oldText: string;
        newText: string;
        language: string;
      }>;
    }) {
      const result = await this.astDiffBatch!({ files: input.files });
      return { operation: input.operation, files: result.files };
    },

    async astService(input: {
      operation: "index" | "query";
      files: Array<{
        path?: string;
        source: string;
        language: string;
      }>;
      query?: {
        nodeKind?: string;
        textIncludes?: string;
      };
    }) {
      const files = await indexAstFiles(input.files, input.query);
      const matches = files.filter((file) => !file.error && file.nodes.length);
      return {
        operation: input.operation,
        files,
        ...(matches.length ? { matches } : {}),
      };
    },

    /**
     * Phase C's WORKSPACE move face (the study's second face): the real
     * files — the working tree (`after`) against a git ref (`from`,
     * default HEAD) — through the very same index, answered as the
     * detected moves. The honest before: a path that does not exist at
     * the ref is a NEW file (it joins only the after set); a path whose
     * extension has no AST language is skipped, reported by name; and the
     * before set is the named paths AT THE REF plus the ref's DELETED
     * files — a move is a file that LEFT, the caller named only where it
     * landed, and without the left side the detection has nothing to
     * pair (the face's own e2e taught this). The cap matches the
     * index's own (50 files) — a workspace-wide scan is the caller's
     * `workspaceList` to narrow.
     */
    async workspaceAstMove(input?: { paths?: string[]; from?: string }) {
      await ctx.ports.getReady();
      const root = ctx.ports.getWorkspaceRoot();
      const from = input?.from ?? "HEAD";
      // No paths named: the WHOLE workspace is the move surface (the
      // plan's "按 workspace 建立索引" — the caller should not have to
      // enumerate). The walk runs under the ignore rules, so node_modules
      // and the store's own directories never enter the set.
      const named = input?.paths ?? [];
      const walked =
        named.length > 0
          ? { paths: named, ignored: 0 }
          : await walkSourceFiles(root);
      const paths = walked.paths;
      const { astLanguageForPath } = await import("@anthelia/diff-wasm/ast");
      const before: Array<{
        path?: string;
        source: string;
        language: string;
      }> = [];
      const after: Array<{
        path?: string;
        source: string;
        language: string;
      }> = [];
      const skipped: Array<{ path: string; reason: string }> = [];
      // The DELETED counterparts: a move is a file that left, and the
      // caller named only where it LANDED. The ref's deleted files join
      // the before set — otherwise a moved symbol has no left side and
      // the detection has nothing to pair. (The first cut named only the
      // paths and its own e2e caught the hole: a move detected nothing.)
      const deleted = await gitDeletedFiles(root, from);
      // No cap: the index is content-addressed in the object store's
      // metadata, so a workspace's move detection costs per CHANGED file,
      // not per file — the same reason the 50-file caps in the sibling
      // faces are gone.
      const beforePaths = [...new Set([...paths, ...deleted])];
      await Promise.all(
        beforePaths.map(async (path) => {
          const language = astLanguageForPath(path);
          if (!language) return;
          const committedText = await gitShowContentBuffer(root, from, path);
          if (committedText !== undefined)
            before.push({
              path,
              source: committedText.toString("utf8"),
              language,
            });
        }),
      );
      await Promise.all(
        paths.map(async (path) => {
          const language = astLanguageForPath(path);
          if (!language) {
            skipped.push({ path, reason: "no_ast_language" });
            return;
          }
          const current = await readWorkspaceContentBuffer(root, path);
          if (current === undefined) {
            skipped.push({ path, reason: "not_in_worktree" });
            return;
          }
          after.push({ path, source: current.toString("utf8"), language });
        }),
      );
      const moves = await this.astMove!({ before, after });
      return {
        from,
        scanned: paths.length,
        ...(skipped.length ? { skipped } : {}),
        moves: moves.moves,
      };
    },

    /**
     * Phase C's move face (the object-store study's acceptance 3): the
     * cross-file detection over the SAME index — before and after sets,
     * one shared path. Each detected move's `from`/`to` are the existing
     * rename plan's fields verbatim, so an `astRefactorPlan({rename})`
     * call consumes a detection result directly (the study's 打通).
     */
    async astMove(input: {
      before: Array<{ path?: string; source: string; language: string }>;
      after: Array<{ path?: string; source: string; language: string }>;
    }) {
      await ctx.ports.getReady();
      const [before, after] = await Promise.all([
        indexAstFiles(input.before),
        indexAstFiles(input.after),
      ]);
      // (the detection's shape — see move-detect: the same run the
      // workspace face performs over real files)
      const symbols = (set: typeof before) =>
        set.flatMap((file) =>
          file.error
            ? []
            : file.nodes.map((node) => ({
                file: file.path ?? "(unnamed)",
                nodeKind: node.nodeKind,
                text: node.text,
              })),
        );
      const moves = detectMoves({
        before: symbols(before),
        after: symbols(after),
      });
      return { moves };
    },
    async astRefactorPlan(input: {
      operation: "rename" | "extract" | "inline" | "move" | "custom";
      files: Array<{
        path?: string;
        source: string;
        language: string;
      }>;
      rename?: {
        from: string;
        to: string;
      };
      query?: {
        nodeKind?: string;
        textIncludes?: string;
      };
    }) {
      await ctx.ports.getReady();
      const indexed = await this.astService!({
        operation: "index",
        files: input.files,
      });
      const targets: Array<{
        path?: string;
        language: string;
        nodeKind: string;
        text: string;
        start: number;
        end: number;
        suggestedText?: string;
      }> = [];
      const fileErrors: Array<{
        path?: string;
        language: string;
        error?: string;
      }> = [];
      for (const file of indexed.files) {
        if (file.error) {
          fileErrors.push({
            path: file.path,
            language: file.language,
            error: file.error,
          });
          continue;
        }
        for (const node of file.nodes) {
          if (input.rename) {
            if (node.text !== input.rename.from) continue;
            targets.push({
              path: file.path,
              language: file.language,
              nodeKind: node.nodeKind,
              text: node.text,
              start: node.start,
              end: node.end,
              suggestedText: input.rename.to,
            });
          } else if (input.query) {
            if (input.query.nodeKind && node.nodeKind !== input.query.nodeKind)
              continue;
            if (
              input.query.textIncludes &&
              !node.text
                .toLowerCase()
                .includes(input.query.textIncludes.toLowerCase())
            )
              continue;
            targets.push({
              path: file.path,
              language: file.language,
              nodeKind: node.nodeKind,
              text: node.text,
              start: node.start,
              end: node.end,
            });
          } else {
            targets.push({
              path: file.path,
              language: file.language,
              nodeKind: node.nodeKind,
              text: node.text,
              start: node.start,
              end: node.end,
            });
          }
        }
      }
      return {
        operation: input.operation,
        targets: targets.slice(0, 2000),
        files: fileErrors,
      };
    },
    async astApplyRefactor(input: {
      operation: "rename" | "extract" | "inline" | "move" | "custom";
      files: Array<{
        path?: string;
        source: string;
        language: string;
      }>;
      rename?: {
        from: string;
        to: string;
      };
      dryRun?: boolean;
    }) {
      await ctx.ports.getReady();
      const { SUPPORTED_AST_LANGUAGES } = await import(
        "@anthelia/diff-wasm/ast"
      );
      const supported = new Set<string>(SUPPORTED_AST_LANGUAGES);
      const plan = await this.astRefactorPlan!({
        operation: input.operation,
        files: input.files,
        ...(input.rename ? { rename: input.rename } : {}),
      });
      const applied: Array<{
        path?: string;
        language: string;
        replacements: Array<{
          start: number;
          end: number;
          from: string;
          to: string;
        }>;
        before?: string;
        after?: string;
        error?: string;
      }> = [];
      for (const file of input.files) {
        if (!supported.has(file.language)) {
          applied.push({
            path: file.path,
            language: file.language,
            replacements: [],
            error: `unsupported_ast_language: ${file.language}`,
          });
          continue;
        }
        const replacements = plan.targets
          .filter((target) => target.path === file.path)
          .map((target) => ({
            start: byteOffsetToUtf16(file.source, target.start),
            end: byteOffsetToUtf16(file.source, target.end),
            from: target.text,
            to: target.suggestedText ?? target.text,
          }));
        if (!replacements.length) {
          applied.push({
            path: file.path,
            language: file.language,
            replacements: [],
            before: file.source,
            after: file.source,
          });
          continue;
        }
        const sorted = [...replacements].sort((a, b) => b.start - a.start);
        let after = file.source;
        for (const replacement of sorted) {
          after =
            after.slice(0, replacement.start) +
            replacement.to +
            after.slice(replacement.end);
        }
        if (!input.dryRun && file.path) {
          const absPath = resolve(ctx.ports.getWorkspaceRoot(), file.path);
          await writeFile(absPath, after, "utf8");
          void appendWorkspaceMutation(ctx, {
            id: `mut_${Date.now().toString(36)}`,
            at: new Date().toISOString(),
            workspaceRoot: ctx.ports.getWorkspaceRoot(),
            sessionID: ctx.ports.getSessionID(),
            path: file.path,
            operation: "modify",
            origin: "refactor",
          });
        }
        applied.push({
          path: file.path,
          language: file.language,
          replacements,
          before: file.source,
          after,
        });
      }
      return { operation: input.operation, applied };
    },

    async gitRefs() {
      await ctx.ports.getReady();
      const workspaceRoot = ctx.ports.getWorkspaceRoot();
      const [branches, tags, worktrees] = await Promise.all([
        gitCapture(workspaceRoot, ["branch", "--format=%(refname:short)"]),
        gitCapture(workspaceRoot, ["tag", "--list"]),
        gitCapture(workspaceRoot, ["worktree", "list", "--porcelain"]),
      ]);
      const refs: RuntimeGitRef[] = [];
      const seen = new Set<string>();
      const currentBranchRaw = await gitCapture(workspaceRoot, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      const currentBranch = currentBranchRaw.stdout.trim();
      for (const name of branches.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)) {
        if (seen.has(name)) continue;
        seen.add(name);
        refs.push({
          name,
          kind: "branch",
          current: name === currentBranch,
        });
      }
      for (const name of tags.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)) {
        if (seen.has(name)) continue;
        seen.add(name);
        refs.push({ name, kind: "tag" });
      }
      for (const record of worktrees.stdout.split("\n\n")) {
        const pathLine = record
          .split("\n")
          .find((line) => line.startsWith("worktree "));
        if (!pathLine) continue;
        const path = pathLine.slice("worktree ".length).trim();
        const branchLine = record
          .split("\n")
          .find((line) => line.startsWith("branch "));
        const name = branchLine
          ? branchLine.slice("branch ".length).replace("refs/heads/", "")
          : path;
        if (seen.has(name)) continue;
        seen.add(name);
        refs.push({
          name,
          kind: "worktree",
          path,
          current: path === workspaceRoot,
        });
      }
      return refs;
    },
  };
}

const gitStructuredCache = new Map<
  string,
  ReturnType<typeof patchToStructured>
>();

function patchToStructuredCached(
  patch: string,
): ReturnType<typeof patchToStructured> {
  const cached = gitStructuredCache.get(patch);
  if (cached) return cached;
  const result = patchToStructured(patch);
  gitStructuredCache.set(patch, result);
  return result;
}

function patchToStructured(patch: string): {
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

function byteOffsetToUtf16(source: string, byteOffset: number): number {
  const encoder = new TextEncoder();
  let bytes = 0;
  let utf16 = 0;
  let index = 0;
  while (index < source.length && bytes < byteOffset) {
    const codePoint = source.codePointAt(index)!;
    const char = String.fromCodePoint(codePoint);
    const charBytes = encoder.encode(char).length;
    if (bytes + charBytes > byteOffset) break;
    bytes += charBytes;
    utf16 += char.length;
    index += char.length;
  }
  return utf16;
}

function isProbablyBinary(data: Uint8Array): boolean {
  const sample = data.subarray(0, 8192);
  return sample.includes(0);
}

async function gitShowContentBuffer(
  workspaceRoot: string,
  ref: string,
  path: string,
): Promise<Buffer | undefined> {
  try {
    const process = Bun.spawn(["git", "show", `${ref}:${path}`], {
      cwd: workspaceRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(process.stdout).arrayBuffer(),
      new Response(process.stderr).arrayBuffer(),
    ]);
    const exitCode = await process.exited;
    if (exitCode !== 0) return undefined;
    void stderr;
    return Buffer.from(stdout);
  } catch {
    return undefined;
  }
}

/** The files deleted between the ref and the working tree. */
async function gitDeletedFiles(
  workspaceRoot: string,
  ref: string,
): Promise<string[]> {
  const proc = Bun.spawn(
    ["git", "diff", "--name-only", "--diff-filter=D", ref],
    {
      cwd: workspaceRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [text, code] = [
    await new Response(proc.stdout).text(),
    await proc.exited,
  ];
  return code === 0
    ? text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

async function gitShowContent(
  workspaceRoot: string,
  ref: string,
  path: string,
): Promise<string | undefined> {
  const buffer = await gitShowContentBuffer(workspaceRoot, ref, path);
  return buffer?.toString("utf8");
}

async function readWorkspaceContentBuffer(
  workspaceRoot: string,
  path: string,
): Promise<Buffer | undefined> {
  try {
    return await readFile(resolve(workspaceRoot, path));
  } catch {
    return undefined;
  }
}

async function readWorkspaceContent(
  workspaceRoot: string,
  path: string,
): Promise<string | undefined> {
  const buffer = await readWorkspaceContentBuffer(workspaceRoot, path);
  return buffer?.toString("utf8");
}

async function structuredForPatch(patch: string): Promise<{
  counts: { additions: number; deletions: number };
  structured: ReturnType<typeof patchToStructured>;
}> {
  try {
    const { parsePatchInWorker } = await import(
      "@anthelia/diff/runtime/diff-parse-client"
    );
    const result = await parsePatchInWorker(patch);
    return result;
  } catch {
    return {
      counts: countPatch(patch),
      structured: patchToStructuredCached(patch),
    };
  }
}

export async function collectWorkspaceGitDiff(
  workspaceRoot: string,
  input?: {
    from?: string;
    to?: string;
    path?: string;
    includePatch?: boolean;
    includeContent?: boolean;
    ignoreWhitespace?: boolean;
  },
): Promise<RuntimeWorkspaceDiffChange[]> {
  const from = input?.from ?? "HEAD";
  const to = input?.to ?? "WORKTREE";
  if (to === "WORKTREE") {
    const status = await gitCapture(workspaceRoot, [
      "status",
      "--porcelain=v1",
      "-uall",
    ]);
    if (status.exitCode !== 0) return [];
    const changes: RuntimeWorkspaceDiffChange[] = [];
    const lines = status.stdout.split("\n").filter(Boolean);
    for (const line of lines) {
      const parsed = parseStatusLine(line);
      if (!parsed) continue;
      if (input?.path && parsed.path !== input.path) continue;
      const path = parsed.path;
      const operation = parsed.operation;
      const oldPath = parsed.oldPath;
      let patch = "";
      if (input?.includePatch !== false) {
        try {
          patch =
            operation === "added" && parsed.untracked
              ? await gitDiffUntracked(
                  workspaceRoot,
                  path,
                  input?.ignoreWhitespace,
                )
              : await gitDiffTracked(
                  workspaceRoot,
                  from,
                  path,
                  oldPath,
                  input?.ignoreWhitespace,
                );
        } catch {
          patch = "";
        }
      }
      let before: string | undefined;
      let after: string | undefined;
      if (input?.includeContent) {
        if (operation === "deleted") {
          const buffer = await gitShowContentBuffer(
            workspaceRoot,
            from,
            oldPath ?? path,
          );
          if (buffer && !isProbablyBinary(buffer))
            before = buffer.toString("utf8");
        } else {
          if (!(operation === "added" && parsed.untracked)) {
            const buffer = await gitShowContentBuffer(
              workspaceRoot,
              from,
              oldPath ?? path,
            );
            if (buffer && !isProbablyBinary(buffer))
              before = buffer.toString("utf8");
          }
          const afterBuffer = await readWorkspaceContentBuffer(
            workspaceRoot,
            path,
          );
          if (afterBuffer && !isProbablyBinary(afterBuffer))
            after = afterBuffer.toString("utf8");
        }
      }
      const patchResult = patch ? await structuredForPatch(patch) : undefined;
      const counts = patchResult?.counts ?? { additions: 0, deletions: 0 };
      const structured = patchResult?.structured;
      changes.push({
        path,
        operation,
        ...(oldPath ? { oldPath } : {}),
        additions: counts.additions,
        deletions: counts.deletions,
        ...(patch ? { patch } : {}),
        ...(structured ? { structured } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
      });
    }
    return changes;
  }
  const rawDiff = await gitCapture(workspaceRoot, [
    "diff",
    "--unified=3",
    "--no-color",
    ...(input?.ignoreWhitespace ? ["-w"] : []),
    `${from}..${to}`,
    ...(input?.path ? ["--", input.path] : []),
  ]);
  if (rawDiff.exitCode !== 0 && !rawDiff.stdout.trim()) return [];
  const changes = await (async () => {
    try {
      const { diffChangesInWorker } = await import(
        "@anthelia/diff/runtime/diff-parse-client"
      );
      return (await diffChangesInWorker(
        rawDiff.stdout,
      )) as RuntimeWorkspaceDiffChange[];
    } catch {
      return diffToChanges(rawDiff.stdout);
    }
  })();
  if (input?.includeContent) {
    for (const change of changes) {
      const beforeBuffer = await gitShowContentBuffer(
        workspaceRoot,
        from,
        change.path,
      );
      const afterBuffer = await gitShowContentBuffer(
        workspaceRoot,
        to,
        change.path,
      );
      if (beforeBuffer && !isProbablyBinary(beforeBuffer))
        change.before = beforeBuffer.toString("utf8");
      if (afterBuffer && !isProbablyBinary(afterBuffer))
        change.after = afterBuffer.toString("utf8");
    }
  }
  return changes;
}

function unquoteGitPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return trimmed.slice(1, -1);
  }
}

export function parseStatusLine(line: string):
  | {
      path: string;
      operation: "added" | "modified" | "deleted" | "renamed";
      oldPath?: string;
      untracked: boolean;
    }
  | undefined {
  if (line.startsWith("?? ")) {
    return {
      path: unquoteGitPath(line.slice(3)),
      operation: "added",
      untracked: true,
    };
  }
  const code = line.slice(0, 2);
  const rest = line.slice(3);
  if (!rest) return undefined;
  const rename = rest.includes(" -> ");
  if (rename) {
    const [oldPath, path] = rest.split(" -> ");
    return {
      path: unquoteGitPath(path!),
      operation: "renamed",
      oldPath: unquoteGitPath(oldPath ?? ""),
      untracked: false,
    };
  }
  const operation = code.includes("D")
    ? "deleted"
    : code.includes("A") || code.includes("?")
      ? "added"
      : "modified";
  return { path: unquoteGitPath(rest), operation, untracked: false };
}

async function gitCapture(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  try {
    const process = Bun.spawn(["git", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(process.stdout).text();
    await new Response(process.stderr).text();
    const exitCode = await process.exited;
    return { stdout, exitCode };
  } catch {
    return { stdout: "", exitCode: 127 };
  }
}

async function gitDiffTracked(
  cwd: string,
  from: string,
  path: string,
  oldPath?: string,
  ignoreWhitespace?: boolean,
): Promise<string> {
  const whitespace = ignoreWhitespace ? ["-w"] : [];
  const args = oldPath
    ? [
        "diff",
        "--unified=3",
        "--no-color",
        ...whitespace,
        from,
        "--",
        oldPath,
        path,
      ]
    : ["diff", "--unified=3", "--no-color", ...whitespace, from, "--", path];
  const result = await gitCapture(cwd, args);
  return result.stdout;
}

async function gitDiffUntracked(
  cwd: string,
  path: string,
  ignoreWhitespace?: boolean,
): Promise<string> {
  const whitespace = ignoreWhitespace ? ["-w"] : [];
  const result = await gitCapture(cwd, [
    "diff",
    "--no-index",
    "--unified=3",
    "--no-color",
    ...whitespace,
    "--",
    "/dev/null",
    path,
  ]);
  return result.exitCode === 0 || result.exitCode === 1 ? result.stdout : "";
}

function diffToChanges(rawDiff: string): RuntimeWorkspaceDiffChange[] {
  const changes: RuntimeWorkspaceDiffChange[] = [];
  const sections = rawDiff.split(/(?=^diff --git )/m);
  for (const section of sections) {
    if (!section.trim()) continue;
    const header = section.split("\n")[0] ?? "";
    const match = header.match(/^diff --git a\/(.+) b\/(.+)$/u);
    if (!match) continue;
    const path = match[2]!;
    const counts = countPatch(section);
    const patch = section.trim() ? section.trimEnd() + "\n" : undefined;
    const structured = patch ? patchToStructuredCached(patch) : undefined;
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

function countPatch(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}
