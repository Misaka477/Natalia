/**
 * The tree promotion engine — the L3 code lane, on our own infrastructure.
 *
 * Studied from git and rebuilt on what we already have: the object store
 * addresses content by sha256 (git's object model, our implementation), so
 * a code tree is a manifest of path → hash and a promotion is a per-file
 * three-way check. Nothing here shells out; a deployment without git is
 * not a degraded one, it is the same engine.
 *
 * The three-way rule per file, the part worth stealing from git:
 *
 *   workspace == base   → take the tree's content (the ordinary case)
 *   workspace == next   → already landed (idempotent re-promotion)
 *   anything else       → a NAMED CONFLICT, refused before anything moves
 *
 * A conflict means the workspace moved since the tree was cut — the one
 * case where a silent overwrite would destroy work. Refusing with the path
 * and the three hashes is what makes a promotion safe to attempt, and it
 * is why the whole plan is computed BEFORE the first write: a conflict
 * anywhere lands nothing anywhere.
 */

import type { GenerationTreeFile } from "@anthelia/contracts";
import { relative, resolve } from "node:path";

export type TreePromotionPlan = {
  writes: Array<{ abs: string; content: Buffer }>;
  deletes: Array<{ abs: string }>;
  unchanged: string[];
  conflicts: Array<{
    path: string;
    workspace: string | null;
    base?: string;
    next: string | null;
  }>;
};

export type TreePromotionInput = {
  /** The workspace root the paths resolve against. */
  root: string;
  files: readonly GenerationTreeFile[];
  /** The workspace's current bytes for a path, or undefined when absent. */
  readWorkspace: (abs: string) => Promise<Buffer | undefined>;
  /** The tree's content for a hash, from the object store. */
  readContent: (hash: string) => Promise<Buffer>;
  /** The store's addressing function (sha256 of the bytes). */
  hash: (bytes: Buffer) => string;
};

export async function planTreePromotion(
  input: TreePromotionInput,
): Promise<TreePromotionPlan> {
  const plan: TreePromotionPlan = {
    writes: [],
    deletes: [],
    unchanged: [],
    conflicts: [],
  };
  for (const file of input.files) {
    const abs = resolve(input.root, file.path);
    const current = await input.readWorkspace(abs);
    const workspaceHash = current === undefined ? null : input.hash(current);
    // Already landed: the workspace holds exactly the tree's content.
    if (workspaceHash === file.next) {
      plan.unchanged.push(file.path);
      continue;
    }
    // The base case: the workspace still holds what the tree was cut from
    // (or the file is new and the workspace has nothing there).
    const baseOk =
      file.base === undefined
        ? workspaceHash === null
        : workspaceHash === file.base;
    if (!baseOk) {
      plan.conflicts.push({
        path: file.path,
        workspace: workspaceHash,
        ...(file.base === undefined ? {} : { base: file.base }),
        next: file.next,
      });
      continue;
    }
    if (file.next === null) {
      // A deletion whose base still stands.
      if (workspaceHash === null) plan.unchanged.push(file.path);
      else plan.deletes.push({ abs });
      continue;
    }
    plan.writes.push({ abs, content: await input.readContent(file.next) });
  }
  return plan;
}

/** The refusal a conflict list produces: every path, with its three hashes. */
export function treeConflictReason(
  conflicts: TreePromotionPlan["conflicts"],
): string {
  const lines = conflicts.map(
    (conflict) =>
      `${conflict.path}: the workspace holds ${conflict.workspace ?? "(nothing)"}, ` +
      `the tree was cut from ${conflict.base ?? "(nothing)"}, and it carries ${conflict.next ?? "(deletion)"}`,
  );
  return `tree promotion refused — ${conflicts.length} file(s) moved since the tree was cut:\n${lines.join("\n")}`;
}

/** The report a successful promotion produces, through our own diff engine. */
export async function treePromotionReport(
  plan: TreePromotionPlan,
  diff: (
    path: string,
    before: string | undefined,
    after: string | undefined,
  ) => {
    additions: number;
    deletions: number;
  },
  root: string,
): Promise<string[]> {
  const lines: string[] = [];
  for (const write of plan.writes) {
    const stats = diff(
      relative(root, write.abs),
      undefined,
      write.content.toString("utf8"),
    );
    lines.push(
      `+ ${relative(root, write.abs)} (+${stats.additions} -${stats.deletions})`,
    );
  }
  for (const del of plan.deletes)
    lines.push(`- ${relative(root, del.abs)} (deleted)`);
  if (plan.unchanged.length)
    lines.push(
      `= ${plan.unchanged.length} file(s) already at the tree's content`,
    );
  return lines;
}
