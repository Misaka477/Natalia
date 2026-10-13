/**
 * The workspace baseline — "what changed since THEN" without git.
 *
 * The workspace's move/change faces used to read their BEFORE side from
 * `git show <ref>:<path>` and `git diff --name-only`, so a workspace that
 * is not a git repository could not answer "what moved" at all: no ref, no
 * before side, an empty answer that looks like "nothing changed".
 *
 * The machinery to answer it honestly already exists — the sandbox's
 * SnapshotStore is a content-addressed capture of a tree over the object
 * store. This module points that machine at the WORKSPACE: a baseline is a
 * captured index (path → content hash, the content already in the store),
 * and reading one back gives exactly the two primitives the faces need, in
 * the same shapes the git path produced:
 *
 *   - `show(path)`   — the file's content at the baseline (or undefined)
 *   - `deletedFiles()` — the paths the baseline has that the tree no longer does
 *
 * A git workspace keeps its ref path (a human naming a ref is richer than a
 * captured index); a git-less workspace gets the same answer from here.
 */

import { ObjectStore } from "@anthelia/object-store";
import { SnapshotStore, type SnapshotIndex } from "@anthelia/sandbox";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

/** The baseline's recorded identity: the index and where its store lives. */
export type WorkspaceBaseline = {
  id: string;
  at: string;
  /** The tracked tree's file count at capture time. */
  files: number;
};

export type WorkspaceBaselineStore = {
  /** Captures the workspace's tracked tree as a content-addressed baseline. */
  capture(input?: {
    ignore?: (rel: string, directory: boolean) => boolean;
  }): Promise<WorkspaceBaseline>;
  /** The recorded baselines, newest last. */
  list(): Promise<WorkspaceBaseline[]>;
  /** Reads a baseline's index, or undefined when the id is unknown. */
  load(id: string): Promise<SnapshotIndex | undefined>;
  /** The file's content at the baseline — the git-show primitive's shape. */
  show(id: string, path: string): Promise<Buffer | undefined>;
  /** The paths the baseline holds that the working tree no longer does. */
  deletedFiles(id: string): Promise<string[]>;
};

export function workspaceBaselineStore(input: {
  workspaceRoot: string;
  /** The baselines' root (the workspace's own .natalia area). */
  dir: string;
}): WorkspaceBaselineStore {
  // Three flat subdirectories, each with ONE job: `records` holds the
  // baseline indices (this module's own), `store` is the SnapshotStore's
  // working area, `objects` the content-addressed bytes. They used to share
  // one directory, which made a record and a store index the same kind of
  // file in the same place — a reader and a writer could disagree about
  // where a baseline lives.
  const objects = new ObjectStore(resolve(input.dir, "objects"));
  const store = new SnapshotStore(objects, resolve(input.dir, "store"));
  const recordsDir = resolve(input.dir, "records");
  const indexPath = (id: string) => resolve(recordsDir, `${id}.json`);

  return {
    async capture(captureInput) {
      // The store's own records are not workspace content: without the
      // exclusion the second capture would index the first baseline's
      // record (and the objects beneath it), and a baseline would grow
      // itself. The sandbox's snapshot machine has the same internal-path
      // rule for the same reason.
      const ignore = (rel: string, directory: boolean) =>
        rel === ".natalia/baselines" ||
        rel.startsWith(".natalia/baselines/") ||
        (captureInput?.ignore?.(rel, directory) ?? false);
      const index = await store.capture(input.workspaceRoot, undefined, ignore);
      // Unique per capture: two baselines taken in the same millisecond are
      // two different answers to "since THEN", and a timestamp alone made
      // the second overwrite the first's record.
      const id = `baseline-${randomUUID().slice(0, 8)}-${Date.now().toString(36)}`;
      // The index itself is the durable record: the content it names is
      // already in the object store (content-addressed, deduplicated), so
      // a baseline costs the hashes, not the bytes.
      await mkdir(recordsDir, { recursive: true });
      await writeFile(
        indexPath(id),
        JSON.stringify({
          id,
          at: new Date().toISOString(),
          files: index.size,
          entries: [...index.entries()].map(([path, file]) => [
            path,
            { objectID: file.objectID, size: file.size },
          ]),
        }),
        "utf8",
      );
      return { id, at: new Date().toISOString(), files: index.size };
    },

    async list() {
      if (!existsSync(recordsDir)) return [];
      const { readdir } = await import("node:fs/promises");
      const names = (await readdir(recordsDir)).filter((name) =>
        name.endsWith(".json"),
      );
      const records: WorkspaceBaseline[] = [];
      for (const name of names.sort()) {
        try {
          const parsed = JSON.parse(
            await readFile(resolve(recordsDir, name), "utf8"),
          ) as WorkspaceBaseline;
          records.push(parsed);
        } catch {
          // A torn record is skipped, never fatal: the baselines are a
          // convenience surface, and one unreadable file must not blind
          // the others.
        }
      }
      return records;
    },

    async load(id) {
      const file = indexPath(id);
      if (!existsSync(file)) return undefined;
      const parsed = JSON.parse(await readFile(file, "utf8")) as {
        entries: Array<[string, { objectID: string; size: number }]>;
      };
      return new Map(
        parsed.entries.map(([path, entry]) => [
          path,
          { objectID: entry.objectID, size: entry.size, mtimeMs: 0 },
        ]),
      );
    },

    async show(id, path) {
      const index = await this.load(id);
      const entry = index?.get(
        relative(input.workspaceRoot, resolve(input.workspaceRoot, path)),
      );
      if (!entry) return undefined;
      return Buffer.from(await objects.get(entry.objectID));
    },

    async deletedFiles(id) {
      const index = await this.load(id);
      if (!index) return [];
      const gone: string[] = [];
      for (const path of index.keys())
        if (!existsSync(resolve(input.workspaceRoot, path))) gone.push(path);
      return gone.sort();
    },
  };
}

/** Drops a baseline's index (the content it names stays for the store's GC). */
export async function dropWorkspaceBaseline(
  input: { dir: string },
  id: string,
): Promise<void> {
  await rm(resolve(input.dir, "records", `${id}.json`), { force: true });
}
