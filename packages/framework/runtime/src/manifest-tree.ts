import { createHash } from "node:crypto";
import type {
  ManifestEntry,
  ManifestTree,
  ManifestTreeNode,
} from "./checkpoint-types";

export type { ManifestTree, ManifestTreeNode } from "./checkpoint-types";

/**
 * The manifest's directory tree (T5-5).
 *
 * A manifest's `entries` is a flat path → entry map, which answers "what is
 * at this path" but says nothing about a DIRECTORY's identity: "did anything
 * under src/ change" was a walk over every entry under it, and "did anything
 * change at all" was a walk over the whole tree — paid on every checkpoint,
 * which is taken per tool call, to learn that the answer was usually "no".
 *
 * A tree object gives a directory the same identity a git tree gives it: a
 * hash over its sorted children's names, kinds and identities, computed
 * bottom-up. Two directories with the same hash hold the same names with the
 * same contents, so comparing two manifests is one comparison at the root,
 * and a diff descends only into the directories whose identity differs.
 *
 * The flat `entries` map stays the source of truth every consumer reads
 * (apply, GC, the UI): the tree is DERIVED from it, never a second copy that
 * could drift.
 */

/**
 * Builds the directory tree over a manifest's flat entries and stamps every
 * directory with its identity hash.
 *
 * The hash covers the SORTED children, so it does not depend on the order the
 * filesystem handed the entries over — the same directory always gets the
 * same identity.
 */
export function buildManifestTree(
  entries: Record<string, ManifestEntry>,
): ManifestTree {
  const root: ManifestTree = { hash: "", entries: {} };
  const directories = new Map<string, ManifestTree>([["", root]]);
  for (const path of Object.keys(entries).sort()) {
    const entry = entries[path]!;
    const slash = path.lastIndexOf("/");
    const parent = slash === -1 ? "" : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    // A parent the walk has not reached yet cannot happen for a capture (it
    // walks depth-first), but a hand-assembled or migrated manifest may
    // arrive out of order: create the missing directories on the way down so
    // the tree still covers every entry.
    if (!directories.has(parent)) {
      const missing: string[] = [];
      let cursor = parent;
      while (cursor !== "" && !directories.has(cursor)) {
        missing.push(cursor);
        const cut = cursor.lastIndexOf("/");
        cursor = cut === -1 ? "" : cursor.slice(0, cut);
      }
      for (const path of missing.reverse()) {
        const created: ManifestTree = { hash: "", entries: {} };
        directories.set(path, created);
        const cut = path.lastIndexOf("/");
        const parentPath = cut === -1 ? "" : path.slice(0, cut);
        const parentTree = directories.get(parentPath);
        if (parentTree)
          parentTree.entries[path.slice(cut + 1)] = {
            kind: "tree",
            hash: "",
            tree: created,
          };
      }
    }
    const tree = directories.get(parent)!;
    const node: ManifestTreeNode =
      entry.kind === "symlink"
        ? { kind: "symlink", target: entry.linkTarget ?? "", mode: entry.mode }
        : {
            kind: "file",
            hash: entry.objectHash ?? "",
            size: entry.size ?? 0,
            mode: entry.mode,
          };
    tree.entries[name] = node;
  }
  // Bottom-up: a directory's identity covers its children's identities, so
  // the deepest directories are stamped first and a parent can read them.
  const ordered = [...directories.entries()].sort(
    (left, right) => right[0].length - left[0].length,
  );
  for (const [path, tree] of ordered) {
    tree.hash = directoryHash(tree);
    if (path === "") continue;
    const cut = path.lastIndexOf("/");
    const parentPath = cut === -1 ? "" : path.slice(0, cut);
    const parent = directories.get(parentPath);
    if (parent)
      parent.entries[path.slice(cut + 1)] = {
        kind: "tree",
        hash: tree.hash,
        tree,
      };
  }
  return root;
}

function directoryHash(tree: ManifestTree): string {
  const lines: string[] = [];
  for (const name of Object.keys(tree.entries).sort()) {
    const node = tree.entries[name]!;
    if (node.kind === "tree") lines.push(`tree\0${name}\0${node.hash}`);
    else if (node.kind === "symlink")
      lines.push(`symlink\0${name}\0${node.target}`);
    else lines.push(`file\0${name}\0${node.hash}\0${node.size}`);
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** True when two manifests describe the same workspace (O(1) at the root). */
export function sameManifestTree(
  before: { tree?: ManifestTree },
  after: { tree?: ManifestTree },
): boolean {
  return (
    before.tree !== undefined &&
    after.tree !== undefined &&
    before.tree.hash === after.tree.hash
  );
}

/**
 * The directories whose identity differs between two trees. A directory that
 * matches is skipped whole — that is the tree diff's saving: the walk
 * descends only where something actually changed. The root is `""`.
 */
export function changedDirectories(
  before: ManifestTree | undefined,
  after: ManifestTree | undefined,
  prefix: string,
  out: Set<string>,
): void {
  if (!before || !after) {
    if (after) collectDirectories(after, prefix, out);
    return;
  }
  if (before.hash === after.hash) return;
  out.add(prefix);
  const names = new Set([
    ...Object.keys(before.entries),
    ...Object.keys(after.entries),
  ]);
  for (const name of names) {
    const left = before.entries[name];
    const right = after.entries[name];
    if (left?.kind === "tree" && right?.kind === "tree")
      changedDirectories(left.tree, right.tree, `${prefix}${name}/`, out);
    else if (left?.kind === "tree")
      collectDirectories(left.tree, `${prefix}${name}/`, out);
    else if (right?.kind === "tree")
      collectDirectories(right.tree, `${prefix}${name}/`, out);
  }
}

function collectDirectories(
  tree: ManifestTree,
  prefix: string,
  out: Set<string>,
): void {
  out.add(prefix);
  for (const [name, node] of Object.entries(tree.entries))
    if (node.kind === "tree")
      collectDirectories(node.tree, `${prefix}${name}/`, out);
}
