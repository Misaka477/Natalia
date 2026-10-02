import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SandboxBackend } from "@anthelia/contracts";
import type { SandboxToolService } from "@anthelia/tools";
import { SnapshotSandboxManager } from "./snapshot-sandbox";
import { WorktreeSandboxManager } from "./worktree-sandbox";
import { WorkspaceSandboxManager } from "./workspace-manager";

/**
 * The sandbox resource controller — second cut of the resource controllers
 * split (mainline plan §15). It owns the sandbox manager and its lifecycle;
 * the runtime's members and tool contexts use this controller's operational
 * surface, and authorization stays in the shared pre-execute funnel
 * (`toolLayer.preExecute`), so there is exactly one policy path.
 *
 * The default backend is our own git-free snapshot manager: a sandbox is an
 * isolated copy with candidate/promote/rollback against a content-addressed
 * snapshot of the host — no external git needed. When the workspace is a git
 * repo and `sandbox.backend: "worktree"` is set, the worktree-based manager
 * (P9) is used instead, so a promoted sandbox change lands as a commit in the
 * user's own git history.
 *
 * Multi-session shape (plan §41.9): today the controller owns one manager.
 * When sessions become per-session maps, only this module's delegation changes.
 */
export type SandboxController = SandboxToolService & {
  init(): Promise<void>;
  close(): Promise<void>;
  referencedObjectIDs(): Promise<Set<string> | undefined>;
  runningResourceCount(): number;
};

export function createSandboxController(input: {
  workspaceRoot: string;
  /** Backend from `sandbox.backend`; absent defaults to our own snapshot. */
  backend?(): SandboxBackend | undefined;
}): SandboxController {
  let manager: WorkspaceSandboxManager | undefined;
  let initializing: Promise<void> | undefined;
  let closed = false;

  async function init() {
    if (closed) throw new Error("sandbox controller is closed");
    if (manager) return;
    // Our own git-free snapshot backend is the default; the worktree backend
    // (real git, for history integration) is a per-project opt-in that needs a
    // git repo. Both extend the shared operational surface the sandbox tools
    // call.
    if (!initializing)
      initializing = (async () => {
        const isGitRepo =
          existsSync(join(input.workspaceRoot, ".git")) ||
          existsSync(join(input.workspaceRoot, ".git", "HEAD"));
        const next =
          input.backend?.() === "worktree" && isGitRepo
            ? new WorktreeSandboxManager(input.workspaceRoot)
            : new SnapshotSandboxManager(input.workspaceRoot);
        await next.initialize();
        if (closed) await next.close();
        else manager = next;
      })();
    try {
      await initializing;
    } finally {
      initializing = undefined;
    }
    if (closed) throw new Error("sandbox controller is closed");
  }

  function requireManager(): WorkspaceSandboxManager {
    if (!manager) throw new Error("sandbox manager is not initialized");
    return manager;
  }

  return {
    init,
    create: async (id) => await requireManager().create(id),
    list: async () => await requireManager().list(),
    execute: async (id, command, options) =>
      await requireManager().execute(id, command, options),
    write: async (id, path, content, mode) =>
      await requireManager().write(id, path, content, mode),
    previewMerge: async (id) => await requireManager().previewMerge(id),
    merge: async (id, hostRoot, authorize) =>
      await requireManager().merge(id, hostRoot, authorize),
    promoteWithValidation: async (id, promoteInput) =>
      await requireManager().promoteWithValidation(id, {
        ...promoteInput,
        hostRoot: promoteInput.hostRoot ?? input.workspaceRoot,
      }),
    delete: async (id) => await requireManager().delete(id),
    rollback: async (id) => await requireManager().rollback(id),
    startResource: async (id, command, resourceID) =>
      await requireManager().startResource(id, command, resourceID),
    resourcesFor: (id) => requireManager().resourcesFor(id),
    resourceOutput: async (id, resourceID, maxBytes) =>
      await requireManager().resourceOutput(id, resourceID, maxBytes),
    stopResource: async (id, resourceID) =>
      await requireManager().stopResource(id, resourceID),
    validate: async (id, command) =>
      await requireManager().validate(id, command),
    updateEvent: (id) => requireManager().updateEvent(id),
    diffEvent: (id) => requireManager().diffEvent(id),
    auditEvent: (id, action, approvalRequired) =>
      requireManager().auditEvent(id, action, approvalRequired),
    async close() {
      if (closed) return;
      closed = true;
      await initializing;
      const current = manager;
      manager = undefined;
      await current?.close();
    },
    async referencedObjectIDs() {
      const current = requireManager();
      return current instanceof SnapshotSandboxManager
        ? await current.referencedObjectIDs()
        : undefined;
    },
    runningResourceCount() {
      return manager?.runningResourceCount() ?? 0;
    },
  };
}
