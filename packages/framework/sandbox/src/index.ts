/**
 * `@anthelia/sandbox` — the sandbox backends and their governance.
 *
 * `WorkspaceSandboxManager` is the directory-copy backend, used when the
 * workspace is not a git repository; `WorktreeSandboxManager` extends it with
 * git worktree/candidate/promotion/rollback semantics and is the backend a
 * git repository gets by default (T6-1). Both share the operational surface
 * (execute, resources, file ops, persistence).
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
export {
  dependencyRootsFor,
  isDependencyLinkPath,
  linkDependencyRoots,
} from "./dependency-links";
export { createSandboxController } from "./sandbox-controller";
export {
  SnapshotStore,
  type IndexedFile,
  type SnapshotIndex,
} from "./snapshot-store";
export {
  detectPromoteCommand,
  sandboxSelfDiffTool,
  sandboxToolFamily,
  sandboxTools,
} from "./tools";
// The diff engine the sandbox family draws its hunks with. The write family
// (write_file/edit_file/apply_edits) composes its diff card from the same
// engine, so a write's hunks are real (context lines, correct line numbers)
// rather than a naive "all removed, then all added" block (S5).
export { diffText, unifiedPatchToStructured } from "./diff";
