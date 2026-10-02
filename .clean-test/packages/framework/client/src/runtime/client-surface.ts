import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import type { ProductRuntimeContext } from "@natalia/collab";
import type { SessionID } from "@anthelia/contracts";
import { createChatSurface } from "@natalia/collab";
import { createMailboxSurface } from "@natalia/collab";
import { createPlanDocRuntime } from "@natalia/collab";
import { createExtensionsRuntime } from "./commands/extensions-runtime";
import type { RuntimeContext } from "@anthelia/substrate";
import {
  createIntelligenceSurface,
  createFeedbackSurface,
} from "@natalia/engineering-intelligence";
import { createAttachmentRuntime } from "./attachment-runtime";
import { createSubagentRuntime } from "./subagent-runtime";
import { createMcpRuntime } from "./mcp-runtime";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";
import { createSelectionSurface } from "./provider-selection/selection";
import { createSandboxRuntime } from "./sandbox-runtime";
import { createTeamRuntime } from "./team-runtime";
import { createCoreSurface } from "./session-execution/core";
import { createLifecycleSurface } from "./session-execution/lifecycle";
import { createManagementSurface } from "./session-execution/management";
import { createObservabilitySurface } from "./session-execution/observability";
import { createSessionsSurface } from "./session-execution/sessions";
import { createSettingsSurface } from "./session-execution/settings";
import { createTranscriptSurface } from "./session-execution/transcript";
import { createTurnControlSurface } from "./session-execution/turn-control";
import { createNativeTerminalSurface } from "./terminal-runtime/native-terminal";
import { createWorkGraphRuntime } from "./work-graph";
import { createWorkspaceRuntime } from "./workspace-runtime";
import { createPluginRuntime } from "./plugin-runtime";

export function createClientSurface(
  ctx: ProductRuntimeContext,
  options: RealRuntimeClientOptions,
): RuntimeServiceClient {
  const checkpoint = ctx.ports.getCheckpointRuntime();
  const surface: RuntimeServiceClient = {
    ...createCoreSurface(ctx, options),
    ...createTranscriptSurface(ctx, options),
    ...createTurnControlSurface(ctx, options),
    ...createLifecycleSurface(ctx, options),
    ...createSettingsSurface(ctx, options),
    ...createSelectionSurface(ctx, options),
    ...createWorkspaceRuntime(ctx),
    ...createPluginRuntime(ctx),
    ...createNativeTerminalSurface(ctx, options),
    checkpointList: checkpoint.checkpointList,
    checkpointListByKind: checkpoint.checkpointListByKind,
    auditRounds: checkpoint.auditRounds,
    roundDiff: checkpoint.roundDiff,
    checkpointPreview: checkpoint.checkpointPreview,
    checkpointRollback: checkpoint.checkpointRollback,
    checkpointRename: checkpoint.checkpointRename,
    workspaceDiff: checkpoint.workspaceDiff,
    ...createSandboxRuntime(ctx, options.episodeID),
    ...createTeamRuntime(ctx),
    ...createSubagentRuntime(ctx),
    ...createAttachmentRuntime(ctx),
    ...createSessionsSurface(ctx, options),
    ...createMcpRuntime(ctx, options.globalConfigPath),
    ...createExtensionsRuntime(ctx),
    ...createManagementSurface(ctx, options),
    ...createObservabilitySurface(ctx, options),
    ...createWorkGraphRuntime(ctx),
    ...createIntelligenceSurface(ctx, options),
    ...createFeedbackSurface(ctx),
    ...createMailboxSurface(ctx),
    ...createPlanDocRuntime(ctx),
    ...createChatSurface(ctx),
    // Direct status-bar goal controls (pause/resume/clear/edit); bypass the
    // model. Read the ports at call time — they are installed by the event sink
    // during composition, and the workspace proxy forwards these per workspace.
    goalControl: async (action, sessionID) =>
      (await ctx.ports.goalControl?.(
        action,
        sessionID as SessionID | undefined,
      )) ?? {
        ok: false,
        action,
        message: "goal control unavailable",
      },
    goalEdit: async (input, sessionID) =>
      (await ctx.ports.goalEdit?.(
        input,
        sessionID as SessionID | undefined,
      )) ?? {
        ok: false,
        action: "edit",
        message: "goal edit unavailable",
      },
  };
  // Goal `pause` hard-stops the in-flight goal round through the standard cancel
  // path, so it must be reachable from the goal runtime (event sink).
  ctx.ports.cancelTurn = (reason, sessionID) =>
    surface.cancel(reason, sessionID as SessionID | undefined);
  return surface;
}
