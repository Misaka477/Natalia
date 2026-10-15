/**
 * The workspace a fresh install opens, and the record of a refusal.
 *
 * The rule is the reference implementation's own
 * (`packages/api/workspace-controller/src/default-directory.ts`): the
 * first-use workspace is a fixed path under the OS Documents directory —
 * `<Documents>/Natalia/default-workspace` here — resolved from the OS rather
 * than from the working directory. The working directory used to be seeded
 * instead, which for a Start Menu launch IS the install directory: the
 * program tree became a workspace, and its `<workspace>/.natalia` (object
 * store, checkpoints, session records) sat inside the tree the uninstaller
 * deletes. Deleting that workspace records the refusal in the one home, and
 * a later launch does not create it again — the user's call, kept.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  firstUseWorkspaceDeclined,
  firstUseWorkspaceDeclinedPath,
  firstUseWorkspacePath,
} from "@anthelia/platform";

/** The one manager face this needs; typed structurally to stay dependency-free. */
type WorkspaceAdder = {
  workspaceAdd(input: {
    path: string;
    title?: string;
  }): Promise<{ workspaceID: string }>;
};

export type FirstUseWorkspaceOutcome = {
  created: boolean;
  workspaceID?: string;
  /** Why nothing was created, in the terms a log line can carry. */
  reason?: string;
};

/**
 * Open the first-use workspace when this host still wants one.
 *
 * `seams` exists so a test can decide both facts (where the workspace would
 * go, whether the user refused one) without touching this machine's real
 * Documents directory or the real home.
 *
 * Returns what happened rather than throwing: a machine with no Documents
 * directory, or a user who deleted the workspace, gets a quiet no — the shell
 * then shows its empty state, whose sidebar carries the add-workspace entry.
 */
export async function ensureFirstUseWorkspace(
  manager: WorkspaceAdder,
  seams: {
    /** The path the workspace would be created at. Injected by tests. */
    resolvePath?: () => string | undefined;
    /** Whether the user has already deleted it. Injected by tests. */
    isDeclined?: () => boolean;
  } = {},
): Promise<FirstUseWorkspaceOutcome> {
  const exists = (path: string) => existsSync(path);
  // A seam that is present ANSWERS the question, including "there is none":
  // falling through to the real lookup after an injected "no" would create the
  // real directory in a test that was asserting it does not.
  const declined = seams.isDeclined
    ? seams.isDeclined()
    : firstUseWorkspaceDeclined({ exists });
  if (declined)
    return {
      created: false,
      reason: "the user deleted the first-use workspace",
    };
  const path = seams.resolvePath
    ? seams.resolvePath()
    : firstUseWorkspacePath({ exists });
  if (!path)
    return { created: false, reason: "this host has no documents directory" };
  await mkdir(path, { recursive: true });
  const added = await manager.workspaceAdd({
    path,
    title: basename(path),
  });
  return { created: true, workspaceID: added.workspaceID };
}

/**
 * Record that the user deleted the first-use workspace.
 *
 * Called when a workspace whose root IS that path is removed, so the refusal
 * is written by whoever removed it — the shell's delete button, an RPC, or a
 * test. Writing the flag is best-effort: a home that cannot be written is a
 * different problem, and failing the removal over it would be worse than
 * re-offering the workspace on the next launch.
 */
export async function recordFirstUseWorkspaceDeclined(): Promise<void> {
  const target = firstUseWorkspaceDeclinedPath();
  await writeFile(target, "deleted by the user\n", { mode: 0o600 }).catch(
    () => undefined,
  );
}
