/**
 * A git-free snapshot store — the "类 git" layer that gives every workspace
 * candidate/promotion/rollback semantics without requiring git.
 *
 * Git is a content-addressed store of snapshots with branches and merges. For
 * the sandbox we need a subset: a base snapshot to diff a candidate against,
 * a promotion that applies the candidate's changes to the host with a
 * last-known-good backup, and a rollback that restores it. That subset has no
 * reason to depend on git, and the worktree backend's `candidate/<id>`
 * branches are just one implementation of it.
 *
 * Performance: an index records content id and filesystem metadata for each
 * path, so re-capturing a tree that changed a few files hashes and stores only
 * those — untouched files reuse their object by a size/mtime/ctime match.
 *
 *   - capture/diff  → content-hash index of the candidate vs the base.
 *   - promote       → copy the changed files into the host, backing up the
 *     targets to `<id>.lkg` first (the last-known-good).
 *   - rollback      → restore the last-known-good backup.
 */
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { SandboxDiffKind } from "@anthelia/contracts";
import type { SandboxChange } from "./workspace-manager";
import { DiffCache, ObjectStore } from "@anthelia/object-store";
import { diffTextAsync, type TextDiffResult } from "./diff";

export type IndexedFile = {
  objectID: string;
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
};
export type SnapshotIndex = Map<string, IndexedFile>;

async function walkFiles(
  root: string,
  ignore?: (relPath: string, directory: boolean) => boolean,
): Promise<string[]> {
  const files: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).split("/").join("/");
      if (ignore?.(rel, entry.isDirectory())) continue;
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

/**
 * A promotion whose candidate was built from a snapshot the host has moved past.
 *
 * Typed rather than a message, because the caller's response differs: a conflict
 * is a state to report (`sandbox.update` with `conflicted`) and a candidate to
 * rebase, not a failed operation to retry.
 */
export class SandboxPromotionConflict extends Error {
  readonly paths: string[];
  constructor(paths: string[]) {
    super(
      `promotion conflicts with changes already on the host: ${paths.join("; ")}. ` +
        `The candidate was built from a snapshot that no longer matches, so ` +
        `promoting it would discard the newer work. Rebase the candidate onto ` +
        `the current host and review it again.`,
    );
    this.name = "SandboxPromotionConflict";
    this.paths = paths;
  }
}

/**
 * Resolves a snapshot-relative path against a root, refusing anything that
 * escapes it.
 *
 * Shared by `materialize` and `promote`: both write at paths that came from a
 * walk, and both must fail closed if that ever stops being true.
 */
function containPath(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(resolve(root), target);
  if (rel.startsWith("..") || rel === "" || isAbsolute(rel))
    throw new Error(`snapshot path escapes worktree: ${path}`);
  return target;
}

/**
 * What a promotion did, so a rollback can undo it exactly.
 *
 * Restoring backups is not enough on its own: a file the promote *created* has
 * an empty backup, so writing the backups back leaves a zero-byte file where
 * the promote put real content. Recording which paths existed before is what
 * lets a rollback delete those instead.
 */
type PromotionRecord = {
  version: 1;
  /** Host-relative path, in the order the promote applied it. */
  applied: Array<{
    path: string;
    kind: SandboxDiffKind;
    existedBefore: boolean;
  }>;
};

export class SnapshotStore {
  constructor(
    private readonly objects: ObjectStore,
    private readonly storeDir: string,
  ) {}

  /**
   * Indexes every file under a root, reusing the previous index's object ids
   * for files whose size, mtime and ctime are unchanged (an `ignore` rel-path
   * filter excluded). Older indices without ctime are conservatively re-hashed.
   */
  async capture(
    root: string,
    previous?: SnapshotIndex,
    ignore?: (relPath: string, directory: boolean) => boolean,
  ): Promise<SnapshotIndex> {
    const index: SnapshotIndex = new Map();
    for (const path of await walkFiles(root, ignore)) {
      const rel = relative(root, path).split("/").join("/");
      const info = await stat(path);
      const prior = previous?.get(rel);
      if (
        prior &&
        prior.ctimeMs !== undefined &&
        prior.size === info.size &&
        prior.mtimeMs === info.mtimeMs &&
        prior.ctimeMs === info.ctimeMs
      ) {
        index.set(rel, prior);
        continue;
      }
      index.set(rel, {
        objectID: await this.objects.put(await readFile(path)),
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
      });
    }
    return index;
  }

  /** Checks out an index into an empty candidate worktree. */
  async materialize(
    root: string,
    index: SnapshotIndex,
  ): Promise<SnapshotIndex> {
    const candidate: SnapshotIndex = new Map();
    for (const [path, entry] of index) {
      const target = containPath(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await this.objects.get(entry.objectID));
      const info = await stat(target);
      candidate.set(path, {
        objectID: entry.objectID,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
      });
    }
    return candidate;
  }

  /** The candidate's changes against the base, by content hash. */
  async diff(
    _candidateRoot: string,
    base: SnapshotIndex,
    candidateIndex: SnapshotIndex,
  ): Promise<SandboxChange[]> {
    const changes: SandboxChange[] = [];
    for (const [path, candidateEntry] of candidateIndex) {
      const baseEntry = base.get(path);
      if (!baseEntry) {
        const content = await this.objectText(candidateEntry.objectID);
        const text = await this.diffTextCached(path, undefined, content);
        changes.push({
          kind: "add" as SandboxDiffKind,
          path,
          ...(content !== undefined ? { after: content } : {}),
          ...(text.patch ? { patch: text.patch } : {}),
          ...(text.structured ? { structured: text.structured } : {}),
          additions: text.additions,
          deletions: text.deletions,
        });
        continue;
      }
      if (candidateEntry.objectID !== baseEntry.objectID) {
        const before = await this.objectText(baseEntry.objectID);
        const after = await this.objectText(candidateEntry.objectID);
        const text = await this.diffTextCached(path, before, after);
        changes.push({
          kind: "modify" as SandboxDiffKind,
          path,
          ...(before !== undefined ? { before } : {}),
          ...(after !== undefined ? { after } : {}),
          ...(text.patch ? { patch: text.patch } : {}),
          ...(text.structured ? { structured: text.structured } : {}),
          additions: text.additions,
          deletions: text.deletions,
        });
      }
    }
    for (const path of base.keys()) {
      if (!candidateIndex.has(path)) {
        const before = await this.objectText(base.get(path)!.objectID);
        const text = await this.diffTextCached(path, before, undefined);
        changes.push({
          kind: "delete" as SandboxDiffKind,
          path,
          ...(before !== undefined ? { before } : {}),
          ...(text.patch ? { patch: text.patch } : {}),
          ...(text.structured ? { structured: text.structured } : {}),
          additions: text.additions,
          deletions: text.deletions,
        });
      }
    }
    return changes;
  }

  private async objectText(objectID: string): Promise<string | undefined> {
    try {
      return (await this.objects.get(objectID)).toString("utf8");
    } catch {
      return undefined;
    }
  }

  private async diffTextCached(
    path: string,
    before: string | undefined,
    after: string | undefined,
  ): Promise<TextDiffResult> {
    const oldText = before ?? "";
    const newText = after ?? "";
    const cache = new DiffCache(this.objects, "snapshot-diff");
    const cached = await cache.get(oldText, newText);
    if (cached)
      return {
        additions: cached.additions,
        deletions: cached.deletions,
        structured: cached.structured,
      };
    const result = await diffTextAsync(path, before, after);
    if (result.structured)
      await cache.set(oldText, newText, {
        additions: result.additions,
        deletions: result.deletions,
        structured: result.structured,
      });
    return result;
  }

  async saveIndex(id: string, index: SnapshotIndex): Promise<void> {
    await mkdir(this.storeDir, { recursive: true });
    await writeFile(
      join(this.storeDir, `${id}.base.json`),
      JSON.stringify([...index]),
    );
  }

  async loadIndex(id: string): Promise<SnapshotIndex | undefined> {
    return this.load(`${id}.base.json`);
  }

  async saveCandidateIndex(id: string, index: SnapshotIndex): Promise<void> {
    await mkdir(this.storeDir, { recursive: true });
    await writeFile(
      join(this.storeDir, `${id}.candidate.json`),
      JSON.stringify([...index]),
    );
  }

  async loadCandidateIndex(id: string): Promise<SnapshotIndex | undefined> {
    return this.load(`${id}.candidate.json`);
  }

  private async load(name: string): Promise<SnapshotIndex | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(join(this.storeDir, name), "utf8"),
      ) as Array<[string, IndexedFile]>;
      return new Map(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** Where one sandbox's last-known-good backups and their record live. */
  private lkgDir(id: string): string {
    return join(this.storeDir, `${id}.lkg`);
  }

  private lkgRecordPath(id: string): string {
    // Beside the directory rather than inside it: a change path could be any
    // name, and the record must not be able to collide with a backed-up file.
    return join(this.storeDir, `${id}.lkg.json`);
  }

  /**
   * Promotes the candidate's changes into the host: backs each target up to
   * `<id>.lkg` (the last-known-good), applies the candidate file, and removes
   * the target for a deletion. Authorize runs on the changed paths before
   * anything is touched.
   *
   * A promote is a sequence of filesystem writes with no transaction behind it,
   * so a failure part-way is undone from the record before the error is
   * rethrown. Without that, a caller reporting "the host is unchanged" after a
   * failed promote would be describing something that is not true.
   */
  async promote(
    id: string,
    candidateRoot: string,
    hostRoot: string,
    changes: SandboxChange[],
    authorize?: (paths: string[]) => Promise<void>,
    base?: SnapshotIndex,
  ): Promise<void> {
    const paths = changes
      .filter((change) => change.kind !== "delete")
      .map((change) => change.path);
    await authorize?.(paths);
    // Checked before anything is written, so a conflict leaves the host exactly
    // as it was.
    if (base) await this.assertNoConflict(hostRoot, changes, base);
    const lkgDir = this.lkgDir(id);
    await mkdir(lkgDir, { recursive: true });
    const record: PromotionRecord = { version: 1, applied: [] };
    for (const change of changes) {
      const target = containPath(hostRoot, change.path);
      const backupPath = containPath(lkgDir, change.path);
      const existedBefore = await this.pathExists(target);
      try {
        await mkdir(dirname(backupPath), { recursive: true });
        if (existedBefore) await writeFile(backupPath, await readFile(target));
        if (change.kind === "delete") {
          // A deletion is an operation, not an absence of one: the file the
          // candidate removed must leave the host, or approving a PR that
          // deletes a file silently does nothing.
          await rm(target, { force: true });
        } else {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(
            target,
            await readFile(containPath(candidateRoot, change.path)),
          );
        }
      } catch (error) {
        // The record covers what already landed, and this change is undone from
        // its backup: a change that failed after removing the target would
        // otherwise leave the host missing a file it never agreed to lose.
        await this.undoPromotion(hostRoot, id, record);
        if (change.kind === "delete" && existedBefore)
          await this.restoreFromBackup(lkgDir, hostRoot, change.path);
        else if (change.kind !== "delete" && existedBefore)
          await this.restoreFromBackup(lkgDir, hostRoot, change.path);
        else if (change.kind !== "delete" && !existedBefore)
          await rm(target, { force: true });
        throw error;
      }
      record.applied.push({
        path: change.path,
        kind: change.kind,
        existedBefore,
      });
    }
    await writeFile(this.lkgRecordPath(id), JSON.stringify(record));
  }

  /** Undoes everything a promotion record lists, newest first. */
  private async undoPromotion(
    hostRoot: string,
    id: string,
    record: PromotionRecord,
  ): Promise<void> {
    const lkgDir = this.lkgDir(id);
    for (const applied of [...record.applied].reverse()) {
      const target = containPath(hostRoot, applied.path);
      try {
        if (!applied.existedBefore) {
          await rm(target, { force: true });
          continue;
        }
        await this.restoreFromBackup(lkgDir, hostRoot, applied.path);
      } catch {
        // Best effort: the caller is already failing, and the backups remain on
        // disk for a manual rollback.
      }
    }
  }

  private async restoreFromBackup(
    lkgDir: string,
    hostRoot: string,
    path: string,
  ): Promise<void> {
    const backup = containPath(lkgDir, path);
    const target = containPath(hostRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(backup));
  }

  /**
   * Refuses a promotion whose base no longer matches the host.
   *
   * A candidate is built from a snapshot, and a promotion used to assume the
   * host was still at that snapshot. Two candidates taken from the same base and
   * both editing one file break that assumption: the first lands, and the second
   * overwrites it — the first candidate's work disappearing with nothing
   * reported. This is the case the ownership map is meant to prevent, and the
   * check is here because the map is a declaration, not a guarantee.
   */
  private async assertNoConflict(
    hostRoot: string,
    changes: SandboxChange[],
    base: SnapshotIndex,
  ): Promise<void> {
    const conflicts: string[] = [];
    for (const change of changes) {
      const expected = base.get(change.path)?.objectID;
      const target = containPath(hostRoot, change.path);
      const raw = await readFile(target).catch(() => undefined);
      const actual = raw
        ? createHash("sha256").update(raw).digest("hex")
        : undefined;
      // `add` expects nothing on the host; `modify` and `delete` expect exactly
      // the base blob. Anything else means the host moved under the candidate.
      if (actual !== expected)
        conflicts.push(
          `${change.path} (host is ${actual ? "modified" : "missing"}, ` +
            `candidate was built from ${expected ? "an earlier revision" : "nothing"})`,
        );
    }
    if (conflicts.length) throw new SandboxPromotionConflict(conflicts);
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Restores the host to the last-known-good state recorded by the last
   * promote: backed-up files are written back and files the promote created are
   * removed.
   *
   * Removing the created ones is the half that a restore-only rollback misses.
   * Their backups are empty, so writing the backups back leaves zero-byte files
   * where the promote had put real content — a rollback that leaves the host
   * changed in a way nothing ever reported.
   */
  async rollback(hostRoot: string, id: string): Promise<boolean> {
    const lkgDir = this.lkgDir(id);
    if (!(await this.pathExists(lkgDir))) return false;
    const record = await this.loadPromotionRecord(id);
    if (record) {
      for (const applied of [...record.applied].reverse()) {
        const target = containPath(hostRoot, applied.path);
        if (!applied.existedBefore) {
          await rm(target, { force: true });
          continue;
        }
        await this.restoreFromBackup(lkgDir, hostRoot, applied.path);
      }
      return true;
    }
    // A last-known-good written before records existed: restoring the backups is
    // the most that can be done, since which paths were additions is not
    // recoverable from an empty backup.
    for (const path of await walkFiles(lkgDir)) {
      const rel = relative(lkgDir, path).split("/").join("/");
      await this.restoreFromBackup(lkgDir, hostRoot, rel);
    }
    return true;
  }

  /** The record a promote wrote, or undefined for a pre-record last-known-good. */
  private async loadPromotionRecord(
    id: string,
  ): Promise<PromotionRecord | undefined> {
    try {
      const raw = await readFile(this.lkgRecordPath(id), "utf8");
      const parsed = JSON.parse(raw) as PromotionRecord;
      return parsed?.applied ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** Whether a last-known-good exists for the sandbox. */
  async hasLastKnownGood(id: string): Promise<boolean> {
    try {
      await stat(join(this.storeDir, `${id}.lkg`));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Every object id the snapshot indices reference — the union of every base
   * and candidate index under the store. The shared object library's GC uses
   * this so one owner never prunes another's live objects.
   */
  async referencedObjectIDs(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const name of await readdir(this.storeDir).catch(
      () => [] as string[],
    )) {
      if (!name.endsWith(".json")) continue;
      const index = await this.load(name);
      for (const entry of index?.values() ?? []) ids.add(entry.objectID);
    }
    return ids;
  }
}
