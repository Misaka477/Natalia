/**
 * The Advanced Sandbox production backend (P9): a worktree-based sandbox.
 *
 * This manager extends `WorkspaceSandboxManager`, so it is a drop-in for the
 * full operational surface the sandbox tools use (execute, resources, file
 * ops, persistence) — and adds real git semantics on top: a sandbox is a
 * worktree on a candidate branch (`candidate/<id>`) off the system head, so
 * the agent's changes are commits the host can diff, preview and promote, and
 * the system slot keeps a last-known-good commit to roll back to. That is the
 * mechanism 半自迭代 requires: agent edits in the candidate worktree, a human
 * approves the preview, promotion lands them in the system branch atomically,
 * and a failed activation rolls back to last-known-good.
 *
 * The manager runs `git` in the host repo. Workspaces that are not git repos
 * fall back to the directory-copy manager; container/VM isolation is a later,
 * threat-model-driven step.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  ensureNataliaIgnoreFile,
  isSnapshotIgnored,
  loadNataliaIgnore,
  NATALIA_IGNORE_FILE,
  type SnapshotIgnoreRule,
} from "@anthelia/platform";
import type { SandboxDiffKind } from "@anthelia/contracts";
import {
  WorkspaceSandboxManager,
  type SandboxChange,
  type SandboxExecutorOptions,
} from "./workspace-manager";
import {
  requiresApproval,
  riskTierForChanges,
  type SandboxRiskTier,
} from "./governance";
import { unifiedPatchToStructured } from "./diff";
import { validationFailure } from "./workspace-manager";

/**
 * True when `target` resolves inside `root`. A conflict path arrives from git
 * (trustworthy) but a RESOLUTION's content is written at it, so the path is
 * re-checked at the write: a path that escaped the candidate would write
 * outside the sandbox.
 */
function isContained(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * What a refresh reports (T6-2). `conflicted` is a state, not a failure: the
 * candidate is mid-merge with the paths named, and {@link
 * WorktreeSandboxManager.resolveConflict} is what clears it.
 */
export type SandboxRefreshResult = {
  refreshed: boolean;
  conflicted: boolean;
  /** The conflicted paths, when `conflicted`. */
  paths?: string[];
  /** The candidate's tip before the refresh. */
  before?: string;
  detail?: string;
};

/**
 * How a conflicted candidate is resolved (T6-3): take the resolution (write
 * the content per path and commit it) or rebase (abort this merge and derive
 * it again against a named base).
 */
export type SandboxConflictResolution =
  | { kind: "resolve"; contents: Record<string, string> }
  | { kind: "rebase"; base?: string };
import { isDependencyLinkPath, linkDependencyRoots } from "./dependency-links";

export type WorktreePromotion = {
  sandboxID: string;
  /** The system-slot commit the candidate was merged onto. */
  base: string;
  /** The commit the promotion produced. */
  promoted: string;
  /** The commit that was last-known-good before the promotion. */
  lastKnownGood: string;
  changedFiles: SandboxChange[];
  /**
   * The validation gate's own result, when the promotion ran one (the
   * `promoteWithValidation` path). Absent on a bare `promote`, which runs no
   * gate.
   */
  validation?: { ok: boolean; exitCode: number; output: string };
};

/** A promotion that ran the validation gate: its result is part of the record. */
export type ValidatedWorktreePromotion = WorktreePromotion & {
  validation: { ok: boolean; exitCode: number; output: string };
};

/** Runs `git` and returns stdout trimmed; throws with stderr on failure. */
async function git(cwd: string, args: string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`,
    );
  return stdout.trim();
}

/** Like `git`, but returns the raw output untrimmed (for `-z` porcelain). */
async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`,
    );
  return stdout;
}

function extractPatchForPath(
  rawDiff: string,
  path: string,
): string | undefined {
  const sections = rawDiff.split(/(?=^diff --git )/m);
  for (const section of sections) {
    if (section.includes(`b/${path}`) || section.includes(`a/${path}`))
      return section.trimEnd() + "\n";
  }
  return undefined;
}

function patchCounts(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

/** The sandbox's own stores, shared with the snapshot manager's exclusions. */
function isSandboxStorePath(rel: string): boolean {
  return (
    rel === ".natalia" ||
    rel === ".natalia/sandboxes" ||
    rel.startsWith(".natalia/sandboxes/") ||
    rel === ".natalia/snapshots" ||
    rel.startsWith(".natalia/snapshots/") ||
    rel === ".natalia/objects" ||
    rel.startsWith(".natalia/objects/") ||
    rel === ".natalia/checkpoints" ||
    rel.startsWith(".natalia/checkpoints/")
  );
}

export class WorktreeSandboxManager extends WorkspaceSandboxManager {
  /** The commit the last promotion was built on, and whose promotion it was. */
  private lastKnownGood: { commit: string; sandboxID: string } | undefined;
  private readonly hostRoot: string;
  /** Host directories linked into each candidate (the dependency supply). */
  private readonly dependencyRoots: readonly string[];

  constructor(
    hostRoot: string,
    options?: SandboxExecutorOptions & { dependencyRoots?: readonly string[] },
  ) {
    super(resolve(hostRoot, ".natalia", "sandboxes"), options);
    this.hostRoot = hostRoot;
    this.dependencyRoots = [...(options?.dependencyRoots ?? [])];
  }

  /** The commit the host system branch is on. */
  async systemHead(): Promise<string> {
    return git(this.hostRoot, ["rev-parse", "HEAD"]);
  }

  /** The name of the host system branch. */
  async systemBranch(): Promise<string> {
    return git(this.hostRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  /** Whether a branch exists in the host repo. */
  private async branchExists(branch: string): Promise<boolean> {
    return await git(this.hostRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ])
      .then(() => true)
      .catch(() => false);
  }

  /** The worktree registered at a path, or undefined when none is. */
  private async worktreeFor(root: string): Promise<string | undefined> {
    const output = await git(this.hostRoot, [
      "worktree",
      "list",
      "--porcelain",
    ]).catch(() => "");
    for (const block of output.split("\n\n")) {
      const line = block
        .split("\n")
        .find((entry) => entry.startsWith("worktree "));
      if (line && resolve(line.slice("worktree ".length)) === resolve(root))
        return resolve(root);
    }
    return undefined;
  }

  private async snapshotIgnoreRules(): Promise<readonly SnapshotIgnoreRule[]> {
    await ensureNataliaIgnoreFile(this.hostRoot);
    return (await loadNataliaIgnore(this.hostRoot)).rules;
  }

  /**
   * The structural exclusions for a candidate: the sandbox's OWN stores and
   * version control, not user content.
   *
   * This used to exclude ALL of `.natalia/`, which made the four surfaces
   * disagree about the same write: a candidate writing
   * `.natalia/tool-smoke/from-sandbox.txt` was committed nowhere (diff
   * missed it, so sandbox_diff showed no change) while the delete surface
   * still listed it as a discardable pending change. The 2026-10-07 smoke
   * run hit exactly that. Only the stores that recurse or churn are
   * structural — a `.natalia/tool-smoke/` file is user data like any other
   * and every surface must show it the same way.
   */
  private isInternalCandidatePath(rel: string): boolean {
    return (
      rel === NATALIA_IGNORE_FILE ||
      rel === ".gitignore" ||
      rel === ".natalia-manifest.json" ||
      rel === ".git" ||
      rel.startsWith(".git/") ||
      isSandboxStorePath(rel)
    );
  }

  /**
   * Git normally hides ignored untracked files from `status`. The sandbox's
   * ignore contract is .nataliaignore, not .gitignore, so forced-add every
   * changed path that .nataliaignore did not exclude.
   */
  private async commitPendingChanges(id: string): Promise<void> {
    const root = resolve(this["baseRoot"], id);
    const rules = await this.snapshotIgnoreRules();
    const paths = new Set<string>();
    const status = await gitRaw(root, [
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude).gitignore",
      ":(exclude).natalia-manifest.json",
    ]).catch(() => "");
    for (const record of status.split("\0").filter(Boolean)) {
      const path = record.slice(3);
      if (path) paths.add(path);
    }
    const ignored = await gitRaw(root, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      ".",
      ":(exclude).gitignore",
      ":(exclude).natalia-manifest.json",
    ]).catch(() => "");
    for (const path of ignored.split("\0").filter(Boolean)) paths.add(path);
    const changed = [...paths].filter(
      (path) =>
        path &&
        !this.isInternalCandidatePath(path) &&
        // The dependency links are plumbing this manager installs, not the
        // agent's work: a `git add -f node_modules` would commit a symlink
        // into the host's history (git stores links as blobs), and the merge
        // would then write that link into the host working tree.
        !isDependencyLinkPath(path, this.dependencyRoots) &&
        !isSnapshotIgnored(path, false, rules),
    );
    if (!changed.length) return;
    await git(root, ["add", "-f", "--", ...changed]);
    await git(root, ["commit", "-m", `sandbox ${id} changes`]);
  }

  /**
   * Creates a sandbox as a worktree on a candidate branch off the system
   * head.
   *
   * The `-b` is conditional (T6-6): a restart that retries a sandboxed
   * subagent used to re-run `git worktree add -b candidate/<id>`
   * unconditionally, and the branch — and often the worktree — are still
   * there from the attempt that died. `-b` on an existing branch fails with
   * "already exists", so the retry could never come back. When the branch is
   * already present the worktree is re-attached to it (creating it only if
   * the directory is also gone), which is what makes a retry a resume.
   */
  override async create(id: string) {
    const branch = `candidate/${id}`;
    const root = resolve(this["baseRoot"], id);
    const base = await this.systemHead();
    const branchExists = await this.branchExists(branch);
    if (branchExists) {
      // The branch survived a previous attempt. Re-attach a worktree to it if
      // the directory is gone; if the worktree is still registered, reuse it
      // exactly as it is — that is the state the retry resumes from.
      const registered = await this.worktreeFor(root);
      if (registered === undefined && !existsSync(root))
        await git(this.hostRoot, ["worktree", "add", root, branch]);
      else if (registered === undefined)
        await git(this.hostRoot, ["worktree", "add", "--force", root, branch]);
    } else {
      await git(this.hostRoot, ["worktree", "add", "-b", branch, root, base]);
    }
    // The manifest record must never enter a candidate diff, even when the
    // agent runs `git add .` in the worktree.
    await writeFile(resolve(root, ".gitignore"), ".natalia-manifest.json\n", {
      flag: "a",
    });
    // The base records the manifest (resources, env allowlist, changed files)
    // at the worktree root; the record is ignored, so it never enters a diff.
    const manifest = await super.create(id);
    // The dependency supply: a worktree checks out only TRACKED files, so the
    // host's installed `node_modules` is absent and the promotion gate's
    // command would fail before testing anything. Linked, never copied, and
    // excluded from the candidate's commits by `commitPendingChanges`.
    await linkDependencyRoots({
      hostRoot: this.hostRoot,
      candidateRoot: manifest.root,
      roots: this.dependencyRoots,
    });
    return manifest;
  }

  override async delete(id: string) {
    const branch = `candidate/${id}`;
    const root = resolve(this["baseRoot"], id);
    await git(this.hostRoot, ["worktree", "remove", "--force", root]).catch(
      () => undefined,
    );
    await git(this.hostRoot, ["branch", "-D", branch]).catch(() => undefined);
    return await super.delete(id);
  }

  /** Whether a candidate branch exists for the sandbox. */
  async exists(id: string): Promise<boolean> {
    try {
      await git(this.hostRoot, ["rev-parse", "--verify", `candidate/${id}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The changes the candidate made against its base, as a diff summary. This is
   * the preview a human approves before promotion — the real worktree diff, not
   * the manifest's change list.
   */
  override async previewMerge(id: string): Promise<SandboxChange[]> {
    const base = await this.baseFor(id);
    const root = resolve(this["baseRoot"], id);
    await this.commitPendingChanges(id);
    const names = await git(root, ["diff", "--name-status", base]);
    const rawDiff = await gitRaw(root, [
      "diff",
      "--unified=3",
      "--no-color",
      base,
    ]).catch(() => "");
    const changes: SandboxChange[] = [];
    const readBase = async (path: string): Promise<string | undefined> => {
      try {
        return await gitRaw(root, ["show", `${base}:${path}`]);
      } catch {
        return undefined;
      }
    };
    const readWorktree = async (path: string): Promise<string | undefined> => {
      try {
        return await readFile(resolve(root, path), "utf8");
      } catch {
        return undefined;
      }
    };
    for (const line of names.split("\n").filter(Boolean)) {
      const [kind, path, oldPath] = line.split("\t");
      const patch = extractPatchForPath(rawDiff, path);
      if (kind === "D") {
        const before = await readBase(path);
        changes.push({
          kind: "delete" as SandboxDiffKind,
          path,
          ...(before ? { before } : {}),
          ...(patch ? { patch } : {}),
          ...(patch ? { structured: unifiedPatchToStructured(patch) } : {}),
          ...patchCounts(patch ?? ""),
        });
        continue;
      }
      if (kind === "R") {
        const before = oldPath ? await readBase(oldPath) : await readBase(path);
        const after = await readWorktree(path);
        changes.push({
          kind: "rename" as SandboxDiffKind,
          path,
          oldPath,
          ...(before ? { before } : {}),
          ...(after ? { after } : {}),
          ...(patch ? { patch } : {}),
          ...(patch ? { structured: unifiedPatchToStructured(patch) } : {}),
          ...patchCounts(patch ?? ""),
        });
        continue;
      }
      const before = kind === "A" ? undefined : await readBase(path);
      const after = await readWorktree(path);
      changes.push({
        kind: (kind === "M" ? "modify" : "add") as SandboxDiffKind,
        path,
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
        ...(patch ? { patch } : {}),
        ...(patch ? { structured: unifiedPatchToStructured(patch) } : {}),
        ...patchCounts(patch ?? ""),
      });
    }
    this.appendIgnoredRecordedChanges(id, changes);
    return changes;
  }

  /**
   * The recorded changes the git diff could not surface, appended as
   * explicitly ignored pending changes.
   *
   * A candidate can record a write (sandbox_write records every write into
   * the manifest) whose path the workspace's ignore rules then exclude from
   * the commit — so the git-derived diff never mentions it while the delete
   * surface (which reads the manifest) lists it as a discardable change. The
   * 2026-10-07 smoke run hit exactly that with `.natalia/tool-smoke/`. The
   * fix is not to hide it: it rides the preview marked `ignored`, with the
   * reason, and the promotion skips it — a caller can no longer conclude
   * "no changes" from a diff that filtered one out.
   */
  private appendIgnoredRecordedChanges(
    id: string,
    changes: SandboxChange[],
  ): void {
    const manifest = this["mustGet"](id);
    const surfaced = new Set(changes.map((change) => change.path));
    for (const recorded of manifest.changedFiles) {
      if (surfaced.has(recorded.path)) continue;
      // The sandbox's own stores are structural and stay invisible.
      if (this.isInternalCandidatePath(recorded.path)) continue;
      changes.push({
        ...recorded,
        ignored: true,
        ignoreReason:
          "the workspace's .nataliaignore rules exclude this path; a promotion will not carry it",
      });
    }
  }

  /**
   * Promotes a candidate into the system slot: the candidate branch is merged
   * into the system branch after the changed paths are authorized. The commit
   * before the merge is recorded as last-known-good, so a failed activation can
   * roll back. Base-compatible return: the changed files, as the copy-based
   * merge reports them.
   */
  override async merge(
    id: string,
    _hostRoot?: string,
    authorize?: (paths: string[]) => Promise<void>,
  ): Promise<SandboxChange[]> {
    const branch = `candidate/${id}`;
    const root = resolve(this["baseRoot"], id);
    const base = await this.baseFor(id);
    const lastKnownGood = await this.systemHead();
    // Promotion works on commits. Commit pending worktree changes first,
    // forcing in files .gitignore hides but .nataliaignore allows.
    await this.commitPendingChanges(id);
    const ahead = await git(this.hostRoot, [
      "rev-list",
      "--count",
      `${base}..${branch}`,
    ]);
    if (Number(ahead) === 0)
      throw new Error(`candidate ${id} has no changes to promote`);
    const changedFiles = await this.previewMerge(id);
    // An ignored pending change is visible in the preview but a promotion
    // never carries it — the .nataliaignore contract holds at the merge
    // boundary too, so the authorization is asked for what will land.
    const mergeable = changedFiles.filter((change) => !change.ignored);
    const paths = mergeable.map((change) => change.path);
    if (paths.length) await authorize?.(paths);
    // Recorded before the merge is attempted, not after: a merge that conflicts
    // never reaches an assignment placed after the `await`, and the commit it
    // was about to build on is exactly what a rollback needs.
    await this.setLastKnownGood({ commit: lastKnownGood, sandboxID: id });
    try {
      await git(this.hostRoot, ["merge", "--no-ff", "--no-edit", branch]);
    } catch (error) {
      // A conflicted merge leaves the host mid-merge with conflict markers and
      // MERGE_HEAD set. Aborting is what returns it to a usable state; without
      // it the next git command runs against a half-applied merge.
      await git(this.hostRoot, ["merge", "--abort"]).catch(() => undefined);
      throw error;
    }
    return changedFiles;
  }

  /** Promotes and reports the full promotion record, including the commits. */
  async promote(
    id: string,
    authorize?: (paths: string[]) => Promise<void>,
  ): Promise<WorktreePromotion> {
    const base = await this.baseFor(id);
    const lastKnownGood = await this.systemHead();
    const changedFiles = await this.merge(id, this.hostRoot, authorize);
    return {
      sandboxID: id,
      base,
      promoted: await this.systemHead(),
      lastKnownGood,
      changedFiles,
    };
  }

  /**
   * Validates the candidate and, when it passes, promotes it. When
   * `requireApprovalTier` is set, the human-approval hook runs only when the
   * candidate's governance risk tier clears the gate.
   *
   * The validation's own result rides back on the promotion, the same shape
   * the snapshot backend reports: one run, reported once.
   */
  override async promoteWithValidation(
    id: string,
    input: {
      command: string;
      authorize?: (paths: string[]) => Promise<void>;
      requireApprovalTier?: SandboxRiskTier;
      hostRoot?: string;
    },
  ): Promise<ValidatedWorktreePromotion> {
    const command = input.command.trim();
    if (!command) throw new Error("sandbox promote command must not be empty");
    const evidence = await this.validate(id, command);
    if (!evidence.ok) throw new Error(validationFailure(id, command, evidence));
    const authorize =
      input.authorize && input.requireApprovalTier
        ? async (paths: string[]) => {
            const tier = riskTierForChanges(await this.previewMerge(id));
            if (requiresApproval(tier, input.requireApprovalTier!))
              await input.authorize!(paths);
          }
        : input.authorize;
    const promotion = await this.promote(id, authorize);
    return { ...promotion, validation: evidence };
  }

  /** The recorded last-known-good commit, if any. */
  async lastKnownGoodCommit(): Promise<string | undefined> {
    return (this.lastKnownGood ?? (await this.loadLastKnownGood()))?.commit;
  }

  /**
   * Rolls the system slot back to the last-known-good commit — the rollback a
   * failed activation after promotion triggers.
   */
  override async rollback(
    id: string,
  ): Promise<{ restored: boolean; reason?: string }> {
    const recorded = this.lastKnownGood ?? (await this.loadLastKnownGood());
    if (!recorded)
      return {
        restored: false,
        reason: `no rollback point recorded for ${id} (the last promotion left none)`,
      };
    // The recorded commit belongs to the last promotion, so undoing any other
    // sandbox would revert work this rollback was never asked about.
    if (recorded.sandboxID !== id)
      return {
        restored: false,
        reason:
          `the recorded rollback point belongs to ${recorded.sandboxID} ` +
          `(a later promotion), not ${id}; undoing it would revert newer work`,
      };
    const lastKnownGood = recorded.commit;
    if (await this.mergeInProgress()) {
      // A merge left half-applied is the state a rollback exists to clear, so
      // everything dirty belongs to it and aborting is safe.
      await git(this.hostRoot, ["merge", "--abort"]).catch(() => undefined);
    } else {
      const dirty = await this.uncommittedPaths();
      if (dirty.length)
        // `reset --hard` would destroy work that predates the promotion. A
        // rollback that loses the user's uncommitted edits is worse than one
        // that refuses, so it refuses and names what is in the way.
        throw new Error(
          `cannot roll back to ${lastKnownGood}: the host has ${dirty.length} ` +
            `uncommitted path(s) that a hard reset would discard ` +
            `(${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""})`,
        );
    }
    await git(this.hostRoot, ["reset", "--hard", lastKnownGood]);
    await this.setLastKnownGood(undefined);
    return { restored: true };
  }

  /**
   * Whether a merge is half-applied. `where` defaults to the host tree (the
   * promotion path's question); a candidate's worktree is what the refresh
   * and conflict resolver ask about (T6-2/T6-3).
   */
  private async mergeInProgress(
    where: string = this.hostRoot,
  ): Promise<boolean> {
    return await git(where, ["rev-parse", "--verify", "MERGE_HEAD"])
      .then(() => true)
      .catch(() => false);
  }

  /** Host paths with uncommitted changes. */
  private async uncommittedPaths(): Promise<string[]> {
    const output = await git(this.hostRoot, [
      "status",
      "--porcelain",
      "--untracked-files=no",
    ]).catch(() => "");
    return output
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  }

  /** Where the last-known-good commit is written, so it survives a restart. */
  private lastKnownGoodPath(): string {
    return join(this["baseRoot"], "worktree-last-known-good.json");
  }

  /**
   * Brings a candidate up to date with the host's newer commits (T6-2).
   *
   * A candidate branch is cut from the head at creation time, so a long
   * running subagent works against a snapshot of the host that goes stale the
   * moment anything else lands — another candidate's promotion, the user's
   * own commit. The refresh is what lets it SEE that work instead of
   * promoting a branch whose merge-base is three promotions behind.
   *
   * The base is the host's current system head, merged INTO the candidate
   * (never the other way round: the candidate's own commits are the agent's
   * work and must survive). A conflict during the refresh is left in place
   * and REPORTED — the same conflicted state a promotion conflict produces,
   * and the same {@link resolveConflict} clears it. Aborting here would throw
   * away the information the resolver needs.
   */
  async refresh(id: string): Promise<SandboxRefreshResult> {
    await this.initialize();
    this.mustGet(id);
    const root = resolve(this["baseRoot"], id);
    // A remote is fetched when one exists; a purely local repo refreshes
    // from the host's own branch, which is where its newer commits are.
    const remote = await this.defaultRemote();
    if (remote) {
      await git(root, ["fetch", remote]).catch(() => undefined);
    }
    const base = await this.systemHead();
    const before = await git(root, ["rev-parse", "HEAD"]);
    await this.commitPendingChanges(id);
    try {
      await git(root, ["merge", "--no-edit", base]);
    } catch (error) {
      const paths = await this.conflictedPaths(root);
      // The candidate is left mid-merge on purpose: the worktree keeps the
      // conflict markers and MERGE_HEAD, which is exactly what the resolver
      // reads. `merge --abort` here would destroy both.
      return {
        refreshed: false,
        conflicted: true,
        paths,
        before,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    return { refreshed: true, conflicted: false, before };
  }

  /**
   * Resolves a conflicted candidate (T6-3).
   *
   * A conflict is a STATE, not a failure: the worktree is mid-merge with
   * conflict markers, and there are exactly two honest ways out. Take the
   * resolution — the caller (a human, or the agent after reading the
   * markers) writes the resolved content per path, and the candidate commits
   * it and carries on. Or rebase the candidate onto the current base and
   * start the merge over, which is what the old error message told the
   * operator to do by hand while providing no way to do it.
   *
   * Both paths leave the candidate on a clean commit, so a promotion
   * afterwards is an ordinary promotion.
   */
  async resolveConflict(
    id: string,
    resolution: SandboxConflictResolution,
  ): Promise<SandboxRefreshResult> {
    await this.initialize();
    this.mustGet(id);
    const root = resolve(this["baseRoot"], id);
    if (!(await this.mergeInProgress(root)))
      throw new Error(`candidate ${id} has no conflict to resolve`);
    if (resolution.kind === "rebase") {
      // Start the merge over against the base the caller names (default: the
      // host's current head). The candidate's own commits are replayed on
      // top, so the agent's work survives and the conflict is re-derived
      // against the newer base.
      await git(root, ["merge", "--abort"]).catch(() => undefined);
      const base = resolution.base ?? (await this.systemHead());
      try {
        await git(root, ["merge", "--no-edit", base]);
      } catch (error) {
        const paths = await this.conflictedPaths(root);
        return {
          refreshed: false,
          conflicted: true,
          paths,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      return { refreshed: true, conflicted: false };
    }
    // Take the resolution: every conflicted path must be answered.
    const conflicted = new Set(await this.conflictedPaths(root));
    for (const [path] of Object.entries(resolution.contents)) {
      if (!conflicted.has(path))
        throw new Error(
          `path ${path} is not conflicted in candidate ${id}; the resolution must answer the conflict, not invent one`,
        );
    }
    for (const path of conflicted) {
      const content = resolution.contents[path];
      if (content === undefined)
        throw new Error(
          `candidate ${id} still has an unresolved conflict at ${path}`,
        );
      const target = resolve(root, path);
      if (!isContained(root, target))
        throw new Error(`conflict path escapes the candidate: ${path}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      await git(root, ["add", "--", path]);
    }
    await git(root, ["commit", "--no-edit"]);
    return { refreshed: true, conflicted: false };
  }

  /** The conflicted paths in a worktree, from git's own unmerged list. */
  private async conflictedPaths(root: string): Promise<string[]> {
    const output = await git(root, ["diff", "--name-only", "--diff-filter=U"])
      .then((value) => value)
      .catch(() => "");
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /** The remote to fetch from, when the repo has one. */
  private async defaultRemote(): Promise<string | undefined> {
    const output = await git(this.hostRoot, ["remote"]).catch(() => "");
    const first = output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return first[0];
  }

  private async setLastKnownGood(
    point: { commit: string; sandboxID: string } | undefined,
  ): Promise<void> {
    this.lastKnownGood = point;
    // Persisted because an in-memory value is gone after a restart, and a
    // rollback that silently does nothing is indistinguishable from one with
    // nothing to do.
    if (!point) {
      await rm(this.lastKnownGoodPath(), { force: true }).catch(
        () => undefined,
      );
      return;
    }
    await mkdir(dirname(this.lastKnownGoodPath()), { recursive: true });
    await writeFile(this.lastKnownGoodPath(), JSON.stringify(point)).catch(
      () => undefined,
    );
  }

  private async loadLastKnownGood(): Promise<
    { commit: string; sandboxID: string } | undefined
  > {
    try {
      const raw = await readFile(this.lastKnownGoodPath(), "utf8");
      const parsed = JSON.parse(raw) as { commit?: string; sandboxID?: string };
      return parsed?.commit && parsed.sandboxID
        ? { commit: parsed.commit, sandboxID: parsed.sandboxID }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async baseFor(id: string): Promise<string> {
    return git(this.hostRoot, ["merge-base", `candidate/${id}`, "HEAD"]);
  }
}
