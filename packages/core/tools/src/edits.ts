/**
 * The friendly batch editor's planning core: verify every edit against the
 * files it touches, compute every final content IN MEMORY, and return the
 * writes and deletes — or throw a named failure before anything is
 * written. All-or-nothing is the point: a bad edit anywhere changes
 * nothing anywhere, which is what makes a model's batch safe to attempt.
 *
 * Extracted from the `apply_edits` tool so the generation switch's `edits`
 * lane lands code through the SAME planner — one verification, one set of
 * error messages, whether the caller is a model's tool call or a human's
 * approved generation. The errors name the file and the reason (a
 * half-diff used to fail a whole patch while naming nothing); the label
 * prefix is the caller's, so each surface's failures read as its own.
 */

import type { GenerationEdit } from "@anthelia/contracts";
import { readFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { workspacePath } from "./arguments";

export type EditPlan = {
  writes: Array<{ abs: string; content: string }>;
  deletes: Array<{ abs: string }>;
};

export type PlanEditsInput = {
  /** The root the edit paths resolve against (the workspace). */
  root: string;
  edits: readonly GenerationEdit[];
  /** The failure prefix — the caller's own name for its surface. */
  label?: string;
  /**
   * Judged per touched path before its content is read. The tool passes its
   * domain fence here; the generation switch passes none (the human's
   * approval already happened).
   */
  authorize?: (input: {
    toolName: string;
    path: string;
  }) => void | Promise<void>;
  /** The name the authorize call carries (defaults to the label). */
  toolName?: string;
};

export async function planEdits(input: PlanEditsInput): Promise<EditPlan> {
  const label = input.label ?? "apply_edits";
  const toolName = input.toolName ?? label;
  const order: string[] = [];
  const states = new Map<
    string,
    {
      original: string | undefined;
      content: string | undefined;
      deleted: boolean;
    }
  >();
  for (const edit of input.edits) {
    const abs = workspacePath(input.root, edit.path);
    await input.authorize?.({ toolName, path: abs });
    if (!states.has(abs)) {
      let original: string | undefined;
      try {
        original = await readFile(abs, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      states.set(abs, { original, content: original, deleted: false });
      order.push(abs);
    }
    const state = states.get(abs)!;
    if (edit.operation === "replace") {
      if (state.deleted || state.content === undefined)
        throw new Error(`${label}: file does not exist: ${edit.path}`);
      const oldText = edit.oldText;
      if (!oldText)
        throw new Error(
          `${label}: replace requires non-empty oldText for ${edit.path}`,
        );
      const count = countOccurrences(state.content, oldText);
      if (count === 0)
        throw new Error(`${label}: oldText not found in ${edit.path}`);
      if (count > 1)
        throw new Error(
          `${label}: oldText is ambiguous (${count} occurrences) in ${edit.path}; include more context or use write_file`,
        );
      state.content = state.content.replace(oldText, edit.newText ?? "");
    } else if (edit.operation === "create") {
      if (state.content !== undefined || state.deleted)
        throw new Error(`${label}: file already exists: ${edit.path}`);
      state.content = edit.newText ?? "";
    } else {
      if (state.content === undefined || state.deleted)
        throw new Error(`${label}: file does not exist: ${edit.path}`);
      state.content = undefined;
      state.deleted = true;
    }
  }
  const writes: EditPlan["writes"] = [];
  const deletes: EditPlan["deletes"] = [];
  for (const abs of order) {
    const state = states.get(abs)!;
    if (state.deleted) {
      deletes.push({ abs });
      continue;
    }
    if (state.content === undefined) continue;
    // A no-op edit (the replacement produced identical text) is not a write.
    if (state.content === state.original) continue;
    writes.push({ abs, content: state.content });
  }
  return { writes, deletes };
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** The edit's path relative to the root, for a report line. */
export function editDisplayPath(root: string, abs: string): string {
  return relative(root, abs) || ".";
}

/** The parent directory a write needs (the caller mkdirs it). */
export function editParent(abs: string): string {
  return dirname(abs);
}
