import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  foregroundProcessForTTY,
  globalConfigHome,
  userRuntimeHome,
} from "@anthelia/platform";
import { resolveStatePath } from "@anthelia/platform";
import { TerminalCommandBuffer } from "@anthelia/tools";
import {
  skillService,
  teamBehavior,
  terminalController,
} from "@anthelia/runtime-services";
import { workLedgerController } from "@natalia/work-ledger";
import { statusSnapshotController } from "@anthelia/runtime-status";
import { createPluginsController } from "@anthelia/substrate";
import type { RuntimeContext } from "@anthelia/substrate";
import type { ProductRuntimeContext } from "@natalia/collab";
import type { StatusSnapshotController } from "@anthelia/runtime-status";
import type { WorkLedgerController } from "@natalia/work-ledger";

function userSkillRoot() {
  // The live state directory's skills, falling back to the legacy
  // `natalia-cli` one an existing install already filled.
  const root = resolveStatePath(globalConfigHome(), existsSync, "skills");
  return isAbsolute(root.path) ? root.path : undefined;
}

function redactToolOutput(output: string, redact: boolean | undefined) {
  if (!redact) return output;
  return output.replace(
    /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s]+/giu,
    (match) =>
      `${match.slice(0, match.indexOf("=") >= 0 ? match.indexOf("=") + 1 : match.indexOf(":") + 1)}[REDACTED]`,
  );
}

export function wireFoundation(ctx: ProductRuntimeContext) {
  const { state, ports } = ctx;
  const pluginsController = createPluginsController({
    pluginStoreRoot: state.pluginStoreRoot,
    workspaceRoot: state.workspaceRoot,
    tools: state.tools,
    capabilityRegistry: state.capabilityRegistry,
    publish: (event) => ports.publish(event),
  });
  state.terminalCommandBuffer = new TerminalCommandBuffer({
    foregroundProgram: async (paneID) => {
      try {
        const terminal =
          ctx.state.serviceDirectory.getOptional(terminalController);
        const ttyName = await terminal?.ttyName(paneID);
        if (!ttyName)
          return {
            supported: false as const,
            reason: `pane ${paneID} has no terminal device`,
          };
        return foregroundProcessForTTY(ttyName);
      } catch (error) {
        return {
          supported: false as const,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
  state.waiterDeps = {
    publish: (event) => ports.publish(event),
    sessionID: () => state.sessionID,
    permissionMode: (turnID) =>
      (turnID ? ports.executionForTurn(turnID) : state.activeExec)
        ?.permissionMode ?? state.permissionMode,
    abortSignal: (turnID) =>
      state.executionBySession.get(
        state.turnSession.get(turnID) ?? state.sessionID,
      )?.activeAbort?.signal,
    activeTurnID: () => state.activeExec?.activeTurnID,
    isPending: (sessionID, id, kind) =>
      ports.isPendingInteractiveRequest(sessionID, id, kind),
    sessionIDForTurn: (turnID) =>
      state.turnSession.get(turnID) ?? state.sessionID,
    agentIDForTurn: (turnID) => state.turnAgent.get(turnID),
    capabilityOwnerForTool: (toolName) =>
      state.capabilityRegistry.ownerOf("tools", toolName),
    workLedger: () => {
      return ctx.state.serviceDirectory.get(workLedgerController);
    },
    publishForSession: (sessionID, event) =>
      ports.publishForSession(state.executionBySession.get(sessionID), event),
    // The project-grant restore fold's source: the collab slice when the
    // fact state is complete, the fast-attach tail when it is not — the
    // same accessor the collaboration snapshot path uses.
    sessionEvents: (sessionID) => {
      const exec = state.executionBySession.get(sessionID);
      if (!exec) return undefined;
      return exec.factStateComplete === true && exec.factState
        ? exec.factState.collaborationEvents
        : exec.session.events;
    },
  };

  ports.isDisposed = () => state.runtimeDisposed;
  ports.setDisposed = (disposed) => {
    state.runtimeDisposed = disposed;
  };
  ports.resolveService = <T>(serviceID: string) =>
    state.capabilityRegistry.service<T>(serviceID);
  ports.getSession = () => state.session;
  ports.getReplayMode = () => state.replayMode;
  ports.setReplayMode = (mode) => {
    state.replayMode = mode;
  };
  ports.getSessionPersistence = () => state.sessionPersistence;
  ports.getSessionPersistenceForSession = (sessionID) =>
    state.sessionPersistenceBySession.get(sessionID) ?? Promise.resolve();
  ports.setSessionPersistenceForSession = (sessionID, next) => {
    state.sessionPersistenceBySession.set(sessionID, next);
  };
  ports.getProviderConcurrencyLimiter = () => state.providerConcurrencyLimiter;
  ports.getExecutionBySession = () => state.executionBySession;
  ports.getTurnSession = () => state.turnSession;
  ports.getActiveSkill = () => state.activeSkill;
  ports.getTurnAgent = () => state.turnAgent;
  ports.getAttachmentReferences = () => state.attachmentReferences;
  ports.getToolCalls = () => state.toolCalls;
  ports.getRetryPolicy = () => state.retryPolicy;
  ports.executionForTurn = (turnID) =>
    state.executionBySession.get(
      state.turnSession.get(turnID) ?? state.sessionID,
    );
  ports.getSessionID = () => state.sessionID;
  ports.getProvider = () => state.provider;
  ports.getChatDefaultProvider = () => state.chatDefaultProvider;
  ports.getActiveExec = () => state.activeExec;
  ports.getActiveTurnID = () => state.activeTurnID;
  ports.getPauseWaiters = () => state.pauseWaiters;
  ports.getWorkspaceCapabilityView = () => state.workspaceCapabilityView;
  ports.getTools = () => state.tools;
  ports.scheduleRuntimeStatusSnapshot = () =>
    ctx.state.serviceDirectory
      .getOptional(statusSnapshotController)
      ?.schedule();
  ports.runtimeStatusSnapshot = () => {
    const status = ctx.state.serviceDirectory.get(statusSnapshotController);
    return status.snapshot();
  };
  // Both surfaces tolerate an absent plugin: resolution states the tolerance
  // instead of every call site re-checking.
  ports.skillService = () =>
    ctx.state.serviceDirectory.getOptional(skillService);
  ports.skillsList = () => ports.skillService()?.list() ?? [];
  ports.teamBehavior = () =>
    ctx.state.serviceDirectory.getOptional(teamBehavior);
  ports.getProviderSource = () => state.providerSource;
  ports.getWorkspaceRoot = () => state.workspaceRoot;
  ports.getAgentRegistry = () => state.agentRegistry;
  ports.setPaused = (value) => {
    state.paused = value;
  };
  ports.getPaused = () => state.paused;
  ports.getCapabilityRegistry = () => state.capabilityRegistry;
  ports.getTsRuntimeConfig = () => state.tsRuntimeConfig;
  ports.getSelectedAgent = () => state.selectedAgent;
  ports.getSelectedModel = () => state.selectedModel;
  ports.getMaxSteps = () => state.maxSteps;
  ports.getReady = () => state.ready;
  ports.getContextWindowResolver = () => state.contextWindowResolver;
  ports.setProvider = (value) => {
    state.provider = value;
  };
  ports.setSelectedModel = (value) => {
    state.selectedModel = value;
  };
  ports.setRuntimeContextConfig = (value) => {
    state.runtimeContextConfig = value;
  };
  ports.getRuntimeContextConfig = () => state.runtimeContextConfig;
  ports.nextMailboxSequence = () => state.mailboxSequence++;
  ports.nextDecisionSequence = () => state.decisionSequence++;
  ports.nextEvidenceSequence = () => state.evidenceSequence++;
  ports.nextCompletionSequence = () => state.completionSequence++;
  ports.nextChatSequence = () => state.chatSequence++;
  ports.getInternalWakeTasks = () => state.internalWakeTasks;
  ports.setSessionPersistence = (next) => {
    state.sessionPersistence = next;
  };
  ports.redactToolOutput = redactToolOutput;
  ports.getSink = () => state.sink;
  ports.setSink = (next) => {
    state.sink = next;
  };
  ports.getPerformanceTrace = () => state.performanceTrace;
  ports.getNativeRuntimeID = () => state.nativeRuntimeID;
  ports.getUserRuntimeHome = () => userRuntimeHome();
  ports.getUserSkillRoot = () => userSkillRoot();
  ports.setProviderSource = (source) => {
    state.providerSource = source;
  };
  ports.getPluginsController = () => pluginsController;
}
