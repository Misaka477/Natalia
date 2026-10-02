/**
 * The tool-policy framework service: the unique policy funnel.
 *
 * `executeOneTool` is the single place every tool call passes through, and this
 * package owns the policy evaluation half of it: the permission-rule evaluator,
 * the workspace write-path detection, the command-text extraction and the
 * hook-layer factory. The runtime host requires this service — a runtime
 * without policy enforcement is not a runtime — and constructs it directly.
 *
 * Keeping the funnel on the service channel is what later lets plugins
 * contribute policy rules and hooks through the same single writer, instead of
 * opening a second policy path.
 */
import {
  commandTextForTool,
  createToolPolicyHookLayer,
  evaluatePermissionRules,
  ToolExecutionPipeline,
  workspaceWritePathForTool,
  workspaceWritePathsForTool,
} from "@anthelia/tools";
import type { ToolPolicyService } from "@anthelia/runtime-services";

export function createToolPolicyService(): ToolPolicyService {
  return {
    createExecutionPipeline: () => new ToolExecutionPipeline(),
    createHookLayer: createToolPolicyHookLayer,
    evaluatePermissionRules,
    workspaceWritePathForTool,
    workspaceWritePathsForTool,
    commandTextForTool,
  };
}
