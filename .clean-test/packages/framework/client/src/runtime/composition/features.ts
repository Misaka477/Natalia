import { providerFromEnvironment } from "@anthelia/runtime";
import { createTerminalRuntime } from "../terminal-runtime";
import { createPermissions } from "../permissions";
import { createCollaborationBoundary } from "@natalia/collab";
import { createSnapshot } from "../snapshot";
import { createChatPrompt } from "@natalia/collab";
import { createChatTools } from "@natalia/collab";
import { createCollaborationWake } from "@natalia/collab";
import { createSettlement } from "@natalia/collaboration";
import { createMailboxPlans } from "@natalia/collab";
import { createPlanDocRuntime } from "@natalia/collab";
import { createNaviChatTurn } from "@natalia/collab";
import { createNiaChatTurn } from "@natalia/collab";
import { createPluginAssembly } from "../plugin-assembly";
import { createConfigReload } from "../config-reload";
import { createToolPublish } from "../tool-publish";
import type { RuntimeContext } from "@anthelia/substrate";
import type { ProductRuntimeContext } from "@natalia/collab";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";

export type FeatureAssembly = ReturnType<typeof wireFeatures>;

export function wireFeatures(
  ctx: ProductRuntimeContext,
  options: RealRuntimeClientOptions,
) {
  const { state, ports } = ctx;
  const terminalRuntime = createTerminalRuntime(ctx);
  ports.setPendingHumanTerminal = terminalRuntime.setPendingHumanTerminal;
  ports.maybeContinueAfterHumanInput =
    terminalRuntime.maybeContinueAfterHumanInput;

  ports.getPermissionMode = () => state.permissionMode;
  ports.setPermissionMode = (mode) => {
    state.permissionMode = mode;
  };
  ports.getSelectedPermissionProfile = () => state.selectedPermissionProfile;
  ports.setSelectedPermissionProfile = (profile) => {
    state.selectedPermissionProfile = profile;
  };
  ports.getDefaultPermissionMode = () => state.defaultPermissionMode;
  ports.setDefaultPermissionMode = (mode) => {
    state.defaultPermissionMode = mode;
  };
  ports.getDefaultPermissionProfile = () => state.defaultPermissionProfile;
  ports.setDefaultPermissionProfile = (profile) => {
    state.defaultPermissionProfile = profile;
  };
  const permissions = createPermissions(ctx, options);
  ports.createToolPolicyLayer = permissions.createToolPolicyLayer;
  ports.isToolAllowed = permissions.isToolAllowed;
  ports.applyAgentPolicy = permissions.applyAgentPolicy;
  ports.extensionToolPermission = permissions.extensionToolPermission;
  ports.extensionEnabled = permissions.extensionEnabled;

  const boundary = createCollaborationBoundary(ctx);
  ports.settleMailboxAtBoundary = boundary.settleMailboxAtBoundary;
  ports.takeLiveUserMessages = boundary.takeLiveUserMessages;
  ports.reconcileWorkspaceObservation = boundary.reconcileWorkspaceObservation;
  const snapshot = createSnapshot(ctx);
  ports.setInFlightOperation = snapshot.setInFlightOperation;
  ports.toolEventTurnID = snapshot.toolEventTurnID;
  ports.isSessionSnapshotTrigger = snapshot.isSessionSnapshotTrigger;
  ports.publishSessionSnapshot = snapshot.publishSessionSnapshot;
  ports.currentSessionSnapshot = snapshot.currentSessionSnapshot;
  ports.nextCollabSequence = () => state.collabSequence++;
  ports.nextPlanSequence = () => state.planSequence++;

  const chatPrompt = createChatPrompt(ctx);
  const chatTools = createChatTools(ctx);
  const collaborationWake = createCollaborationWake(ctx);
  ports.wakeMainForCollaboration = collaborationWake.wakeMainForCollaboration;
  ports.wakeNavi = collaborationWake.wakeNavi;
  ports.requestNaviWake = collaborationWake.requestNaviWake;
  ports.wakeNia = collaborationWake.wakeNia;
  ports.requestNiaWake = collaborationWake.requestNiaWake;
  ports.scheduleInternalWake = collaborationWake.scheduleInternalWake;
  const settlement = createSettlement({
    isDisposed: () => ctx.ports.isDisposed(),
    publishForSession: (exec, event) =>
      ctx.ports.publishForSession(exec, event),
    deliverInternalWake: collaborationWake.deliverInternalWake,
    nextSettlementSequence: () => state.settlementSequence++,
    serviceDirectory: ctx.state.serviceDirectory,
  });
  ports.deliverSettlement = settlement.deliver;
  ports.deliverSubagentMessage = settlement.deliverChildMessage;
  const mailboxPlans = createMailboxPlans(ctx);
  ports.createCollabChatTool = mailboxPlans.createCollabChatTool;
  ports.enqueueMailboxMessage = mailboxPlans.enqueueMailboxMessage;
  ports.cancelMailboxMessage = mailboxPlans.cancelMailboxMessage;
  ports.enqueueMailboxForClient = async (input) => {
    const sessionID = (input as { sessionID?: string }).sessionID;
    const exec = sessionID
      ? (ctx.ports
          .getExecutionBySession()
          .get(sessionID as import("@anthelia/contracts").SessionID) ??
        (await ctx.ports.ensureExecution(
          sessionID as import("@anthelia/contracts").SessionID,
        )))
      : undefined;
    return mailboxPlans.enqueueMailboxMessage(input, exec);
  };
  ports.planDocRuntime = createPlanDocRuntime(ctx);
  ports.naviChatPersona = chatPrompt.naviChatPersona;
  ports.naviChatLiveContext = chatPrompt.naviChatLiveContext;
  ports.niaChatPersona = chatPrompt.niaChatPersona;
  ports.niaChatLiveContext = chatPrompt.niaChatLiveContext;
  ports.naviChatTools = chatTools.naviChatTools;
  ports.niaChatTools = chatTools.niaChatTools;
  ports.chatToolSummary = chatTools.chatToolSummary;
  ports.runNaviChatTurn = createNaviChatTurn(ctx).runNaviChatTurn;
  ports.runNiaChatTurn = createNiaChatTurn(ctx).runNiaChatTurn;
  ports.providerFromEnvironment = providerFromEnvironment;

  const pluginAssembly = createPluginAssembly(ctx, options);
  ports.reloadPermissionSettings = permissions.reloadPermissionSettings;
  ports.setTsRuntimeConfig = (config) => {
    state.tsRuntimeConfig = config;
  };
  ports.setMaxSteps = (steps) => {
    state.maxSteps = steps;
  };
  ports.setRetryPolicy = (policy) => {
    state.retryPolicy = policy;
  };
  ports.setProviderConcurrencyLimiter = (limiter) => {
    state.providerConcurrencyLimiter = limiter;
  };
  ports.setAgentRegistry = (registry) => {
    state.agentRegistry = registry;
  };
  const configReload = createConfigReload(ctx, options);
  ports.configReloadBlockedReason = configReload.configReloadBlockedReason;
  ports.reloadConfigFromDisk = configReload.reloadConfigFromDisk;
  const toolPublish = createToolPublish(ctx, options);
  ports.publishWorkGraphToolCall = toolPublish.publishWorkGraphToolCall;
  ports.hotReloadToolFamily = toolPublish.hotReloadToolFamily;
  ports.publishToolCatalogChanges = toolPublish.publishToolCatalogChanges;
  ports.setInFlightOperationFor = snapshot.setInFlightOperationFor;

  return {
    terminalRuntime,
    permissions,
    boundary,
    snapshot,
    chatPrompt,
    toolPublish,
    pluginAssembly,
    configReload,
  };
}
