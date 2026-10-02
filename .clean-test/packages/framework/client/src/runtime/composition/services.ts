import { createPluginLifecycle } from "../plugin-lifecycle";
import { createEnsureReady } from "../ensure-ready";
import { createSessionExecution } from "../session-execution";
import { createSessionAttach } from "../session-attach";
import { createToolPolicySurface } from "../tool-execution/policy";
import { boundToolOutput, validateToolParameters } from "@anthelia/tools";
import {
  parseToolArguments,
  tryParseToolArguments,
} from "../../tool-arguments";
import type { RuntimeContext } from "@anthelia/substrate";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";
import {
  isManagedResourceTool,
  waitForToolExecution,
} from "@anthelia/substrate";
import type { RuntimeContextLedger } from "@natalia/context-ledger";
import { collaborationWaiter } from "@natalia/collaboration";

export function wireServices(
  ctx: RuntimeContext,
  options: RealRuntimeClientOptions,
) {
  const { state, ports } = ctx;
  let runtimeContext: RuntimeContextLedger | undefined;
  ports.runPluginLifecyclePostReconcile =
    createPluginLifecycle(ctx).runPluginLifecyclePostReconcile;
  ports.setReady = (value) => {
    state.ready = value;
  };
  const ensureReady = createEnsureReady(ctx).ensureReady;
  const sessionExecution = createSessionExecution(ctx, options);
  ports.ensureExecution = sessionExecution.ensureExecution;
  ports.persistInboxPromotion = sessionExecution.persistInboxPromotion;
  ports.drainSessionFor = sessionExecution.drainSessionFor;
  ports.setLastSubmitted = (value) => {
    state.lastSubmitted = value;
  };
  ports.setSessionID = (value) => {
    state.sessionID = value;
  };
  ports.setSession = (value) => {
    state.session = value;
  };
  ports.setRuntimeContext = (value) => {
    runtimeContext = value;
  };
  ports.getRuntimeContext = () => {
    const context = state.activeExec?.context ?? runtimeContext;
    if (!context) throw new Error("runtime context is not initialized");
    return context;
  };
  ports.setActiveExec = (value) => {
    state.activeExec = value;
  };
  ports.setAttachmentReferences = (value) => {
    state.attachmentReferences = value;
  };
  ports.setToolCalls = (value) => {
    state.toolCalls = value;
  };
  ports.setPauseWaiters = (value) => {
    state.pauseWaiters = value;
  };
  ports.setActiveSkill = (value) => {
    state.activeSkill = value;
  };
  ports.setLastProviderUsage = (value) => {
    state.lastProviderUsage = value;
  };
  ports.clearRuntimeDiagnostics = () => {
    state.runtimeDiagnostics.splice(0);
  };
  ports.getRuntimeDiagnosticsBySession = () =>
    state.runtimeDiagnosticsBySession;
  ports.getRuntimeDiagnostics = () => state.runtimeDiagnostics;
  ports.attachSession = createSessionAttach(ctx).attachSession;
  ports.setActiveAbort = (value) => {
    state.activeAbort = value;
  };
  ports.setActiveTurnID = (value) => {
    state.activeTurnID = value;
  };
  ports.setSelectedAgent = (value) => {
    state.selectedAgent = value;
  };
  ports.setPendingAgent = (value) => {
    state.pendingAgent = value;
  };

  const policy = createToolPolicySurface(ctx);
  ports.waitIfPaused = policy.waitIfPaused;
  ports.toolSettings = policy.toolSettings;
  ports.authorizeWorkspaceRead = policy.authorizeWorkspaceRead;
  ports.authorizeSandboxMerge = policy.authorizeSandboxMerge;
  ports.authorizeSandboxManagement = policy.authorizeSandboxManagement;
  ports.getInteractive = () =>
    ctx.state.serviceDirectory.get(collaborationWaiter);
  ports.getTerminalCommandBuffer = () => state.terminalCommandBuffer;
  ports.getSandboxResourcesByID = () => state.sandboxResourcesByID;
  ports.getEndTurnWaitingHuman = () => state.endTurnWaitingHuman;
  ports.setEndTurnWaitingHuman = (value) => {
    state.endTurnWaitingHuman = value;
  };
  ports.waitForToolExecution = waitForToolExecution;
  ports.boundToolOutput = boundToolOutput;
  ports.isManagedResourceTool = isManagedResourceTool;
  ports.tryParseToolArguments = (input) => {
    const parsed = tryParseToolArguments(input);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  };
  ports.parseToolArguments = parseToolArguments;
  ports.validateToolParameters = validateToolParameters;
  return { ensureReady, sessionExecution };
}
