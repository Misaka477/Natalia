/**
 * `@anthelia/sandbox` — the sandbox backends and their governance.
 *
 * `WorkspaceSandboxManager` is the directory-copy backend; `WorktreeSandboxManager`
 * extends it with git worktree/candidate/promotion/rollback semantics and is the
 * production backend when the workspace is a git repo. Both share the operational
 * surface (execute, resources, file ops, persistence).
 */
export * from "./workspace-manager";
export {
  requiresApproval,
  riskTierForChanges,
  riskTierForPath,
  type SandboxRiskTier,
} from "./governance";
export {
  WorktreeSandboxManager,
  type WorktreePromotion,
} from "./worktree-sandbox";
export { SnapshotSandboxManager } from "./snapshot-sandbox";
export { SandboxPromotionConflict } from "./snapshot-store";
export { createSandboxController } from "./sandbox-controller";
export {
  SnapshotStore,
  type IndexedFile,
  type SnapshotIndex,
} from "./snapshot-store";
export { sandboxToolFamily, sandboxTools } from "./tools";
