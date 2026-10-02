/**
 * RuntimePorts — every cross-module function of the runtime.
 *
 * The composition root assigns each as its owning module is created; modules
 * read them at call time so construction order never matters. Defined in its
 * own file so `context.ts` stays within the source line limit.
 */
import type { AgentDefinition, AgentRegistry } from "@anthelia/agent";
import type { CapabilityRegistryHost } from "@anthelia/capability";
import type {
  CollaborationParticipant,
  ConfigV3,
  RuntimeEvent,
  SessionID,
} from "@anthelia/contracts";
import type {
  ProviderRunnerInput,
  SkillMetadata,
  SkillService,
  TeamBehaviorService,
  ToolPolicyHookLayer,
} from "@anthelia/runtime-services";
import type {
  ContextWindowResolver,
  ProviderConcurrencyLimiter,
  StreamingProvider,
} from "@anthelia/runtime";
import type { RuntimeContextStatusConfig } from "./status-config";
import type { SessionExecutionState } from "./context";
import type { WorkspaceWriteLock } from "@anthelia/workspace";
import type { CheckpointController } from "@anthelia/checkpoint";
import type { ContextLedger } from "@anthelia/runtime";
import type { PlanDocRuntime } from "./plan-doc-port";

export type RuntimePorts = {
  resolveService: <T>(serviceID: string) => T | undefined;
  publish: (event: RuntimeEvent) => void;
  publishForSession: (
    exec: SessionExecutionState | undefined,
    event: RuntimeEvent,
  ) => void;
  scheduleRuntimeStatusSnapshot: () => void;
  runtimeStatusSnapshot: () => Promise<
    Extract<RuntimeEvent, { type: "status.snapshot" }>
  >;
  ensureExecution: (id: SessionID) => Promise<SessionExecutionState>;
  commandCatalogEntries: () => import("@anthelia/plugin").PluginCommand[];
  skillService: () => SkillService | undefined;
  skillsList: () => SkillMetadata[];
  teamBehavior: () => TeamBehaviorService | undefined;
  providerRunnerInput: (sessionID: SessionID) => ProviderRunnerInput;
  setInFlightOperation: (
    operation: import("@anthelia/session").DurableInFlightOperation | undefined,
  ) => Promise<void>;
  setInFlightOperationFor: (
    exec: SessionExecutionState,
    operation: import("@anthelia/session").DurableInFlightOperation | undefined,
  ) => Promise<void>;
  isDisposed: () => boolean;
  getSessionPersistence: () => Promise<void>;
  setSessionPersistence: (next: Promise<void>) => void;
  getSessionPersistenceForSession: (sessionID: SessionID) => Promise<void>;
  setSessionPersistenceForSession: (
    sessionID: SessionID,
    next: Promise<void>,
  ) => void;
  redactToolOutput: (output: string, redact: boolean | undefined) => string;
  getSink: () => ((event: RuntimeEvent) => void) | undefined;
  setPendingHumanTerminal: (
    forSessionID: SessionID,
    input: { terminalID: string; reason: string },
  ) => Promise<void>;
  maybeContinueAfterHumanInput: (
    terminalID: string,
    forSessionID?: SessionID,
  ) => Promise<void>;
  settleMailboxAtBoundary: (exec?: SessionExecutionState) => void;
  takeLiveUserMessages: (
    exec?: SessionExecutionState,
  ) => Array<{ source: "user" | "navi"; text: string }>;
  reconcileWorkspaceObservation: (
    exec?: SessionExecutionState,
  ) => ReturnType<
    NonNullable<
      import("@anthelia/contracts").RuntimeClient["confirmedWorkspaceChanges"]
    >
  >;
  toolEventTurnID: (event: { id: string; callID?: string }) => string;
  isSessionSnapshotTrigger: (event: RuntimeEvent) => boolean;
  publishSessionSnapshot: (exec?: SessionExecutionState) => void;
  currentSessionSnapshot: (
    exec: SessionExecutionState,
    id: string,
  ) => Extract<RuntimeEvent, { type: "session.snapshot" }>;
  nextCollabSequence: () => number;
  wakeMainForCollaboration: (
    exec: SessionExecutionState,
    id: string,
    kind: string,
    source: "Navi" | "Nia",
  ) => void;
  createCollabChatTool: (
    from: CollaborationParticipant,
    exec: SessionExecutionState | undefined,
  ) => import("@anthelia/tools").RuntimeTool;
  enqueueMailboxMessage: (
    input: {
      source?: "user_via_live_chat" | "system";
      priority?: "normal" | "high" | "urgent";
      intent: string;
      text: string;
      safeSummary?: string;
      relatedPlanID?: string;
      deliveryPolicy?: string;
    },
    targetExec?: SessionExecutionState,
  ) => Promise<unknown>;
  cancelMailboxMessage: (
    messageID: string,
    reason?: string,
    targetExec?: SessionExecutionState,
  ) => Promise<unknown>;
  getProviderConcurrencyLimiter: () => ProviderConcurrencyLimiter;
  getExecutionBySession: () => Map<SessionID, SessionExecutionState>;
  executionForTurn: (turnID: string) => SessionExecutionState | undefined;
  getTurnSession: () => Map<string, SessionID>;
  getActiveExec: () => SessionExecutionState | undefined;
  getActiveTurnID: () => string | undefined;
  getPauseWaiters: () => Array<() => void>;
  getRuntimeContext: () => ContextLedger;
  currentModelImageInput: (exec: SessionExecutionState | undefined) => boolean;
  modelCapabilitiesForExecution: (
    exec: SessionExecutionState | undefined,
  ) => import("@anthelia/contracts").ModelCapabilities;
  mediaTypeForImage: (
    path: string,
  ) => "image/png" | "image/jpeg" | "image/webp" | "image/gif" | undefined;
  publishWorkGraphToolCall: (
    turnID: string,
    callID: string,
    toolName: string,
    status: string,
  ) => void;
  executeOneTool: (
    turnID: string,
    call: import("@anthelia/runtime").ProviderToolCall,
    tool: import("@anthelia/tools").RuntimeTool,
    attachImage?: (path: string) => Promise<void>,
  ) => Promise<string>;
  executeToolCalls: (
    turnID: string,
    calls: import("@anthelia/runtime").ProviderToolCall[],
    assistant: string,
    materialized: import("@anthelia/tools").ToolMaterialization,
  ) => Promise<import("@anthelia/runtime").ProviderMessage[]>;
  toolResultContent: (
    content: string,
    callID: string,
    moduleContext: unknown,
  ) => string;
  checkConstitutionForTool: (
    turnID: string,
    callID: string,
    toolName: string,
    toolAction: string,
    toolResource: string,
    commandText?: string,
  ) => Promise<string | undefined>;
  isToolAllowed: (
    toolName: string,
    exec: SessionExecutionState | undefined,
  ) => boolean;
  extensionToolPermission: (
    toolName: string,
    profile?: import("@anthelia/contracts").PermissionProfile,
  ) => { allowed: boolean; diagnostics: string[] };
  getWorkspaceRoot: () => string;
  nextMailboxSequence: () => number;
  getWorkspaceWriteLock: () => WorkspaceWriteLock | undefined;
  getWorkspaceCapabilityView: () =>
    | import("@anthelia/capability").CapabilityRegistryView
    | undefined;
  getTools: () => import("@anthelia/tools").ToolRegistry;
  getAgentRegistry: () => AgentRegistry | undefined;
  setPaused: (paused: boolean) => void;
  getPaused: () => boolean;
  initializeCheckpointController: (
    exec: SessionExecutionState,
  ) => Promise<CheckpointController | undefined>;
  clientModelCatalog: () => Promise<
    Array<{ id: string; name: string; provider: string; variants: string[] }>
  >;
  selectRuntimeModel: (
    modelID: string | undefined,
    variant: string | undefined,
    exec?: SessionExecutionState,
  ) => Promise<void>;
  submitInput: (
    input: import("@anthelia/contracts").SubmitInput & { internal?: boolean },
    forSessionID?: SessionID,
  ) => Promise<import("@anthelia/contracts").SubmittedTurn>;
  /** Direct human goal control (status bar / RPC); bypasses the model. */
  goalControl?: (
    action: "pause" | "resume" | "clear",
    sessionID?: SessionID,
  ) => Promise<{ ok: boolean; action: string; message?: string }>;
  /** Direct human goal edit (status bar inline editor); bypasses the model. */
  goalEdit?: (
    input: import("@anthelia/contracts").GoalEditInput,
    sessionID?: SessionID,
  ) => Promise<{ ok: boolean; action: string; message?: string }>;
  /**
   * Cancels the session's active/pending turn through the standard cancel path.
   * Used by the goal pause control so "pause" actually stops the running round.
   */
  cancelTurn?: (
    reason: string,
    sessionID?: SessionID,
  ) => void | Promise<unknown>;
  /** Re-seed and re-publish the live goal status on attach / reconnect. */
  syncGoalStatus?: (sessionID: SessionID) => Promise<void>;
  /** Flush in-flight streaming text into its durable partial batch. */
  flushPendingPartialOutput?: () => void;
  applyAgentPolicy: () => void;
  applyAgentProvider: (exec?: SessionExecutionState) => void;
  refreshExecutionContextConfig: (exec: SessionExecutionState) => Promise<void>;
  getCapabilityRegistry: () => CapabilityRegistryHost;
  getTsRuntimeConfig: () => ConfigV3 | undefined;
  nextChatSequence: () => number;
  nextPlanSequence: () => number;
  nextSettlementSequence: () => number;
  /**
   * The settlement spine's delivery: publish the notice fact and steer
   * (a running turn's next step) or queue (an idle session's new turn).
   * A false is a degrade — the thing that settled must not fail.
   */
  deliverSettlement: (
    exec: import("./session-execution-state").SessionExecutionState,
    notice: import("@anthelia/contracts").SettlementNotice,
    options?: { sessionID?: string },
  ) => boolean;
  /** A subagent's mid-run message to its parent session. */
  deliverSubagentMessage: (
    exec: import("./session-execution-state").SessionExecutionState,
    message: { agentId: string; text: string },
  ) => boolean;
  requestNaviWake: (exec: SessionExecutionState) => void;
  requestNiaWake: (exec: SessionExecutionState) => void;
  wakeNia: (exec: SessionExecutionState) => Promise<void>;
  scheduleInternalWake: (
    exec: SessionExecutionState,
    input: import("@anthelia/contracts").SubmitInput,
  ) => void;
  /**
   * Navi's static system prompt (ADR D1): persona, policies and tool-usage
   * rules only — byte-identical across sessions and workspaces.
   */
  naviChatPersona: () => string;
  /**
   * Navi's dynamic runtime context (main agent status, plans, mailbox, collab
   * messages). Appended as a `<runtime_context>` user message by the chat
   * turn, never in the static system prompt (ADR D2).
   */
  naviChatLiveContext: (exec?: SessionExecutionState) => string;
  /** Nia's static system prompt (ADR D1). */
  niaChatPersona: () => string;
  /** Nia's dynamic runtime context (ADR D2). */
  niaChatLiveContext: (exec?: SessionExecutionState) => string;
  naviChatTools: (
    exec?: SessionExecutionState,
  ) => import("@anthelia/tools").RuntimeTool[];
  niaChatTools: (
    exec?: SessionExecutionState,
  ) => import("@anthelia/tools").RuntimeTool[];
  effectiveMaxSteps: (exec: SessionExecutionState | undefined) => number;
  waitIfPaused: (exec?: SessionExecutionState) => Promise<void>;
  chatToolSummary: (
    toolName: string,
    args: Record<string, unknown>,
    result: string,
  ) => string;
  planDocRuntime: PlanDocRuntime;
  getSelectedAgent: () => AgentDefinition | undefined;
  getSelectedModel: () => { modelID?: string; variant?: string } | undefined;
  getProviderSource: () =>
    | "explicit"
    | "environment"
    | "ts_config"
    | "unconfigured";
  getMaxSteps: () => number | undefined;
  getReady: () => Promise<void> | undefined;
  getContextWindowResolver: () => ContextWindowResolver;
  setProvider: (provider: StreamingProvider | undefined) => void;
  setSelectedModel: (
    model: { modelID?: string; variant?: string } | undefined,
  ) => void;
  setRuntimeContextConfig: (config: RuntimeContextStatusConfig) => void;
  getRuntimeContextConfig: () => RuntimeContextStatusConfig;
  getSessionID: () => SessionID;
  getProvider: () => StreamingProvider | undefined;
  getChatDefaultProvider: () => StreamingProvider | undefined;
  createToolPolicyLayer: (
    exec: SessionExecutionState | undefined,
  ) => ToolPolicyHookLayer;
  getPermissionMode: () => "ask" | "auto" | "read_only";
  setPermissionMode: (mode: "ask" | "auto" | "read_only") => void;
  getSelectedPermissionProfile: () =>
    | import("@anthelia/contracts").PermissionProfile
    | undefined;
  setSelectedPermissionProfile: (
    profile: import("@anthelia/contracts").PermissionProfile | undefined,
  ) => void;
  getDefaultPermissionMode: () => "ask" | "auto" | "read_only";
  setDefaultPermissionMode: (mode: "ask" | "auto" | "read_only") => void;
  getDefaultPermissionProfile: () =>
    | import("@anthelia/contracts").PermissionProfile
    | undefined;
  setDefaultPermissionProfile: (
    profile: import("@anthelia/contracts").PermissionProfile | undefined,
  ) => void;
  setActiveAbort: (controller: AbortController | undefined) => void;
  setActiveTurnID: (id: string | undefined) => void;
  setSelectedAgent: (agent: AgentDefinition | undefined) => void;
  setPendingAgent: (agent: AgentDefinition | undefined) => void;
  persistInboxPromotion: (targetSessionID?: SessionID) => Promise<void>;
  reloadConfigFromDisk: () => Promise<{
    read: boolean;
    providerReconfigured: boolean;
    reason?: string;
  }>;
  /**
   * The global config path THIS runtime read from — set at every config
   * read, so a writer (the generation tools' apply seam) lands global-model
   * rows in the same file the reader used instead of guessing.
   */
  configGlobalPath?: () => string;
};
