/**
 * The git-free sandbox backend — the "类 git" layer.
 *
 * `WorktreeSandboxManager` needs git because worktrees are git concepts. This
 * backend gives every workspace the same candidate/promotion/rollback surface
 * without git: at create it captures a content-addressed snapshot of the host
 * and checks it out into the candidate worktree, `previewMerge` diffs the real
 * candidate against the base by content hash, and `merge` promotes the changed
 * files into the host with a last-known-good backup that `rollback` restores.
 * Git, when present, upgrades to the worktree backend's real commit history;
 * here the semantics are the same, the store is ours.
 */
import { resolve } from "node:path";
import {
  ensureNataliaIgnoreFile,
  isSnapshotIgnored,
  loadNataliaIgnore,
  NATALIA_IGNORE_FILE,
  type SnapshotIgnoreRule,
} from "@anthelia/platform";
import {
  WorkspaceSandboxManager,
  type SandboxChange,
} from "./workspace-manager";
import { ObjectStore } from "@anthelia/object-store";
import { SnapshotStore, type SnapshotIndex } from "./snapshot-store";

/**
 * Structural exclusions for a snapshot candidate: these are the sandbox's own
 * stores, not user content. They cannot be disabled through .nataliaignore.
 */
function isSnapshotInternalPath(rel: string): boolean {
  return (
    rel === NATALIA_IGNORE_FILE ||
    rel === ".natalia-manifest.json" ||
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

export class SnapshotSandboxManager extends WorkspaceSandboxManager {
  private readonly hostRoot: string;
  private readonly store: SnapshotStore;

  constructor(hostRoot: string) {
    super(resolve(hostRoot, ".natalia", "sandboxes"));
    this.hostRoot = hostRoot;
    this.store = new SnapshotStore(
      new ObjectStore(resolve(hostRoot, ".natalia", "objects")),
      resolve(hostRoot, ".natalia", "snapshots"),
    );
  }

  /** The backup a promotion leaves, when it left one. */
  protected override async rollbackPoint(
    id: string,
  ): Promise<string | undefined> {
    return (await this.store.hasLastKnownGood(id))
      ? `snapshot:${id}`
      : undefined;
  }

  private async snapshotIgnoreRules(): Promise<readonly SnapshotIgnoreRule[]> {
    await ensureNataliaIgnoreFile(this.hostRoot);
    return (await loadNataliaIgnore(this.hostRoot)).rules;
  }

  private candidateIgnore(
    rules: readonly SnapshotIgnoreRule[],
  ): (rel: string, directory: boolean) => boolean {
    return (rel, directory) =>
      isSnapshotInternalPath(rel) || isSnapshotIgnored(rel, directory, rules);
  }

  /**
   * Creates the isolated worktree, captures the host as its base, then checks
   * that base out into the candidate. The candidate index records the checkout
   * metadata so later diffs can reuse unchanged objects by size/mtime.
   */
  override async create(id: string) {
    const manifest = await super.create(id);
    const rules = await this.snapshotIgnoreRules();
    const base = await this.store.capture(
      this.hostRoot,
      undefined,
      this.candidateIgnore(rules),
    );
    await this.store.saveIndex(id, base);
    const candidate = await this.store.materialize(manifest.root, base);
    await this.store.saveCandidateIndex(id, candidate);
    return manifest;
  }

  /** The candidate's real changes against the base, by content hash. */
  override async previewMerge(id: string): Promise<SandboxChange[]> {
    const base = await this.store.loadIndex(id);
    if (!base) return await super.previewMerge(id);
    const candidateIndex = await this.captureCandidate(id);
    // Persist the candidate index so the live worktree's objects count as
    // referenced for the shared library's GC — a reviewed-but-unmerged
    // candidate is still an owner.
    await this.store.saveCandidateIndex(id, candidateIndex);
    return await this.store.diff(this.candidateRoot(id), base, candidateIndex);
  }

  /**
   * Promotes the candidate's changes into the host with a last-known-good
   * backup. Base-compatible return: the changed files.
   */
  override async promoteWithValidation(
    id: string,
    input: {
      command: string;
      authorize?: (paths: string[]) => Promise<void>;
      hostRoot?: string;
    },
  ) {
    return await super.promoteWithValidation(id, {
      ...input,
      hostRoot: input.hostRoot ?? this.hostRoot,
    });
  }

  override async merge(
    id: string,
    _hostRoot?: string,
    authorize?: (paths: string[]) => Promise<void>,
  ): Promise<SandboxChange[]> {
    const base = await this.store.loadIndex(id);
    if (!base) return await super.merge(id, this.hostRoot, authorize);
    const candidateIndex = await this.captureCandidate(id);
    const changes = await this.store.diff(
      this.candidateRoot(id),
      base,
      candidateIndex,
    );
    if (!changes.length)
      throw new Error(`candidate ${id} has no changes to promote`);
    await this.store.promote(
      id,
      this.candidateRoot(id),
      this.hostRoot,
      changes,
      authorize,
      // The base the candidate was built from: the promotion checks the host
      // still matches it before writing, which is what stops a second candidate
      // taken from the same base from silently overwriting the first.
      base,
    );
    await this.store.saveCandidateIndex(id, candidateIndex);
    return changes;
  }

  /** Restores the host to the last-known-good state of the last promote. */
  override async rollback(id: string): Promise<{ restored: boolean }> {
    return { restored: await this.store.rollback(this.hostRoot, id) };
  }

  /** Whether a last-known-good exists for the sandbox. */
  async hasLastKnownGood(id: string): Promise<boolean> {
    return this.store.hasLastKnownGood(id);
  }

  /**
   * Every object id this manager's snapshot indices reference — for the shared
   * object library's GC, so checkpoint's gc can never prune a live sandbox
   * object.
   */
  async referencedObjectIDs(): Promise<Set<string>> {
    return await this.store.referencedObjectIDs();
  }

  /** The candidate's current index, reusing the previous one by size/mtime. */
  private async captureCandidate(id: string): Promise<SnapshotIndex> {
    const rules = await this.snapshotIgnoreRules();
    return await this.store.capture(
      this.candidateRoot(id),
      await this.store.loadCandidateIndex(id),
      this.candidateIgnore(rules),
    );
  }

  private candidateRoot(id: string): string {
    return resolve(this["baseRoot"], id);
  }
}
