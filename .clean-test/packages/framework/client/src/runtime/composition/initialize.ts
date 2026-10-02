import { createHash } from "node:crypto";
import { agentsFromConfig } from "@anthelia/agent";
import { resolveConfig } from "@anthelia/config";
import {
  contextEntriesToProviderMessages,
  contextStatusEvent,
  MAX_STEPS_PROMPT,
  MISSING_FINAL_RESPONSE_FALLBACK,
  nativeToolCallCorrection,
  normalizeRawToolCallProtocol,
  ProviderConcurrencyLimiter,
  providerForModel,
  requireNativeToolCallProtocol,
  withProviderConcurrency,
} from "@anthelia/runtime";
import {
  modelVisibleEvents,
  projectInteractiveRequests,
  projectSession,
  sessionRunCoordinator,
  settleInterruptedTurnIDs,
  settleInterruptedTurns,
} from "@anthelia/session";
import { readOnlyToolMessage } from "@anthelia/runtime-services";
import { turnController } from "@anthelia/turn-orchestration";
import {
  cleanupToolOutput,
  ensureBashCommandParser,
  evaluatePermissionProfileCommandRules,
} from "@anthelia/tools";
import { mountPlugins } from "@anthelia/substrate";
import { wireFrameworkServices } from "../initialize/framework-services";
import { createInitialize } from "../initialize";
import type { RuntimeContext } from "@anthelia/substrate";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";
import { lineCount } from "@anthelia/substrate";

const WAITING_TOOLS = new Set(["terminal_observe"]);
const MAX_PROTOCOL_CORRECTIONS = 2;

function sessionSeed(workspaceRoot: string) {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12);
}

export function wireInitialize(
  ctx: RuntimeContext,
  options: RealRuntimeClientOptions,
  features: ReturnType<typeof import("./features").wireFeatures> &
    ReturnType<typeof import("./execution").wireExecution>,
  createRuntimeClient: typeof import("../main").createRealRuntimeClient,
) {
  const { state, ports } = ctx;
  const drainSession = async (signal: AbortSignal) => {
    const controller = state.serviceDirectory.get(turnController);
    await controller.drain(signal, state.sessionID);
  };
  state.initialize = {
    resolveConfig,
    reloadPermissionSettings: features.permissions.reloadPermissionSettings,
    skillsPluginInput: features.pluginAssembly.skillsPluginInput,
    localToolsPluginInput: features.pluginAssembly.localToolsPluginInput,
    mcpPluginInput: features.pluginAssembly.mcpPluginInput,
    providerModelPluginInput: features.pluginAssembly.providerModelPluginInput,
    wireFrameworkServices,
    capabilityRegistry: state.capabilityRegistry,
    serviceDirectory: state.serviceDirectory,
    workspaceCapabilityView: state.workspaceCapabilityView,
    waiterDeps: state.waiterDeps,
    handleCommand: features.commands.handleCommand,
    scheduleTitleGeneration: features.title.scheduleTitleGeneration,
    deliverQueuedMailboxAtBoundary:
      features.boundary.deliverQueuedMailboxAtBoundary,
    createRealRuntimeClient: (nestedOptions) =>
      createRuntimeClient({
        ...nestedOptions,
        pluginStoreRoot: options.pluginStoreRoot,
      }),
    mountPlugins,
    agentPolicyLayer: features.permissions.agentPolicyLayer,
    permissionProfileLayer: features.permissions.permissionProfileLayer,
    terminalCommandBuffer: state.terminalCommandBuffer,
    evaluatePermissionProfileCommandRules,
    ensureBashCommandParser,
    agentsFromConfig,
    providerForModel,
    sessionSeed,
    createHash,
    lineCount,
    contextEntriesToProviderMessages,
    withProviderConcurrency,
    requireNativeToolCallProtocol,
    normalizeRawToolCallProtocol,
    nativeToolCallCorrection,
    MAX_PROTOCOL_CORRECTIONS,
    WAITING_TOOLS,
    readOnlyToolMessage,
    MAX_STEPS_PROMPT,
    MISSING_FINAL_RESPONSE_FALLBACK,
    cleanupToolOutput,
    settleInterruptedTurnIDs,
    settleInterruptedTurns,
    projectSession,
    modelVisibleEvents,
    turnCoordinator: () => sessionRunCoordinator(state.sessionID),
    drainSession,
    projectInteractiveRequests,
    contextStatusEvent,
    publishRuntimeCapabilities: features.toolPublish.publishRuntimeCapabilities,
    publishRegisteredTools: features.toolPublish.publishRegisteredTools,
    ProviderConcurrencyLimiter,
  };
  ports.initialize = createInitialize(ctx, options).initialize;
  ports.applyConfigFromDisk = features.configReload.applyConfigFromDisk;
}
