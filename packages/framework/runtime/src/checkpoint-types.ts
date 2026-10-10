/**
 * The checkpoint manifest's shared types (T5-5).
 *
 * These live in their own module so both the store (`checkpoint.ts`) and the
 * tree builder (`manifest-tree.ts`) can name them without an import cycle:
 * the tree is derived FROM a manifest, and a manifest carries a tree.
 */
export type ManifestEntry = {
  path: string;
  kind: "regular" | "symlink";
  objectHash?: string;
  size?: number;
  mode: number;
  linkTarget?: string;
};

export type WorkspaceManifest = {
  root: string;
  entries: Record<string, ManifestEntry>;
  complete: boolean;
  errors: string[];
  ignoredFiles: number;
  totalBytes: number;
  /**
   * The directory tree over `entries`, with an identity hash per directory
   * (T5-5). `entries` stays the flat view every consumer already reads
   * (apply, GC, the UI); the tree is what makes "did anything change" and
   * "what changed" cheap: two manifests with the same root hash describe
   * the same workspace, and a diff only has to descend into the directories
   * whose identity differs.
   */
  tree?: ManifestTree;
};

/** One node of the manifest's directory tree. */
export type ManifestTreeNode =
  | { kind: "file"; hash: string; size: number; mode: number }
  | { kind: "symlink"; target: string; mode: number }
  | { kind: "tree"; hash: string; tree: ManifestTree };

export type ManifestTree = {
  /**
   * sha256 over this directory's sorted children (name, kind, identity).
   * Two directories with the same hash hold the same names with the same
   * contents — the same property a git tree object gives a directory.
   */
  hash: string;
  entries: Record<string, ManifestTreeNode>;
};
