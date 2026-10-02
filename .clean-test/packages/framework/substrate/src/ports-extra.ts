/**
 * RuntimePortsExtra — the overflow of the cross-module runtime ports.
 *
 * Split out of `ports.ts` to stay within the source line limit; merged into the
 * `RuntimeContext.ports` type through an intersection in `context.ts`.
 */
import type { AgentRegistry } from "@anthelia/agent";
import type { ConfigV3, RuntimeEvent, SessionID } from "@anthelia/contracts";
import type {
  ContextWindowResolver,
  ProviderConcurrencyLimiter,
  StreamingProvider,
} from "@anthelia/runtime";
import type { RuntimeContextStatusConfig } from "./status-config";
import type { SessionExecutionState } from "./context";

export type RuntimePortsExtra = {
  isPendingInteractiveRequest: (
    sessionID: SessionID,
    id: string,
    kind: string,
  ) => boolean;
  scheduleCollabSnapshot?: (exec: SessionExecutionState) => void;
  setLastSubmitted: (
    turn: import("@anthelia/contracts").SubmittedTurn | undefined,
  ) => void;
  rememberTitleInput: (id: SessionID, text: string) => void;
  drainSessionFor: (
    sessionID: SessionID,
  ) => (signal: AbortSignal) => Promise<void>;
  setSessionID: (id: SessionID) => void;
  setSession: (session: import("@anthelia/session").SessionRecord) => void;
  setRuntimeContext: (
    context: import("@anthelia/runtime").ContextLedger,
  ) => void;
  setActiveExec: (exec: SessionExecutionState | undefined) => void;
  setAttachmentReferences: (
    refs: Map<string, import("@anthelia/contracts").LocalAttachment[]>,
  ) => void;
  setToolCalls: (calls: Map<string, number[]>) => void;
  setPauseWaiters: (waiters: Array<() => void>) => void;
  setActiveSkill: (
    skill: import("@anthelia/runtime-services").SkillMetadata | undefined,
  ) => void;
  setLastProviderUsage: (
    usage: { inputTokens: number; outputTokens: number } | undefined,
  ) => void;
  clearRuntimeDiagnostics: () => void;
  getRuntimeDiagnosticsBySession: () => Map<
    SessionID,
    Array<Extract<RuntimeEvent, { type: "diagnostic" }> & { at: string }>
  >;
  getRuntimeDiagnostics: () => Array<
    Extract<RuntimeEvent, { type: "diagnostic" }> & { at: string }
  >;
  getPerformanceTrace: () => import("./performance-trace").RuntimePerformanceTrace;
  getNativeRuntimeID: () => string;
  getUserRuntimeHome: () => string | undefined;
  getUserSkillRoot: () => string | undefined;
  extensionEnabled: (
    extension: "skills" | "mcp",
    profile?: import("@anthelia/contracts").PermissionProfile,
  ) => boolean;
  hotReloadToolFamily: (familyID: string) => Promise<{ reloaded: boolean }>;
  setProviderSource: (
    source: "explicit" | "environment" | "ts_config" | "unconfigured",
  ) => void;
  providerFromEnvironment: () =>
    | import("@anthelia/runtime").StreamingProvider
    | undefined;
  runNaviChatTurn: (
    input: {
      text: string;
      responseMessageID: string;
      exec: SessionExecutionState;
      internal?: boolean;
      model?: { modelID?: string; variant?: string };
      reasoningEffort?: import("@anthelia/contracts").RuntimeReasoningEffort;
      attachments?: import("@anthelia/contracts").LocalAttachment[];
    },
    signal: AbortSignal,
  ) => Promise<{ text: string }>;
  runNiaChatTurn: (
    input: {
      text: string;
      responseMessageID: string;
      exec: SessionExecutionState;
      internal?: boolean;
      model?: { modelID?: string; variant?: string };
      reasoningEffort?: import("@anthelia/contracts").RuntimeReasoningEffort;
      attachments?: import("@anthelia/contracts").LocalAttachment[];
    },
    signal: AbortSignal,
  ) => Promise<{ text: string }>;
  wakeNavi: (exec: SessionExecutionState) => Promise<void>;
  wakeNia: (exec: SessionExecutionState) => Promise<void>;
  setTsRuntimeConfig: (config: ConfigV3 | undefined) => void;
  setMaxSteps: (steps: number | undefined) => void;
  setRetryPolicy: (
    policy: import("@anthelia/runtime").RetryRunnerOptions["policy"],
  ) => void;
  setProviderConcurrencyLimiter: (limiter: ProviderConcurrencyLimiter) => void;
  setAgentRegistry: (registry: AgentRegistry) => void;
  getPluginsController: () => ReturnType<
    typeof import("./plugins-controller").createPluginsController
  >;
  runPluginLifecyclePostReconcile: (
    selectedSkills?: Map<SessionID, string>,
  ) => Promise<void>;
  publishToolCatalogChanges: (before: Set<string>) => void;
  reloadPermissionSettings: (config: ConfigV3) => void;
  resolveContextStatusConfig: (
    config: ConfigV3,
    provider: StreamingProvider | undefined,
    resolver: ContextWindowResolver,
    selectedRef?: string,
  ) => Promise<RuntimeContextStatusConfig>;
  modelRefKeyForSelection: (
    agent: import("@anthelia/agent").AgentDefinition | undefined,
    model: { modelID?: string; variant?: string } | undefined,
  ) => string | undefined;
  configReloadBlockedReason: () => string | undefined;
  setReady: (ready: Promise<void> | undefined) => void;
  initialize: () => Promise<void>;
  getCheckpointRuntime: () => Pick<
    import("@anthelia/runtime-services").RuntimeServiceClient,
    | "checkpointList"
    | "checkpointListByKind"
    | "auditRounds"
    | "roundDiff"
    | "checkpointPreview"
    | "checkpointRollback"
    | "checkpointRename"
    | "workspaceDiff"
  > & {
    createSafetyCheckpoint(): Promise<string | undefined>;
  };
  toolSettings: (exec?: SessionExecutionState) => Record<string, unknown>;
  authorizeWorkspaceRead: (
    input: { toolName: string; paths: string[] },
    exec?: SessionExecutionState,
  ) => Promise<void>;
  authorizeSandboxMerge: (
    input: { id: string; paths: string[] },
    exec?: SessionExecutionState,
  ) => Promise<void>;
  authorizeSandboxManagement: (
    toolName: "sandbox_merge" | "sandbox_delete" | "sandbox_resource_stop",
    arguments_: Record<string, string>,
    exec: SessionExecutionState,
  ) => Promise<void>;
  getInteractive: () => import("@anthelia/runtime-services").InteractiveWaiter;
  getTerminalCommandBuffer: () => import("@anthelia/tools").TerminalCommandBuffer;
  getSandboxResourcesByID: () => Map<string, number>;
  getEndTurnWaitingHuman: () =>
    | { terminalID: string; reason: string }
    | undefined;
  setEndTurnWaitingHuman: (marker: {
    terminalID: string;
    reason: string;
  }) => void;
  redactToolOutputEnabled: (exec: SessionExecutionState | undefined) => boolean;
  waitForToolExecution: <T>(
    execution: Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
  boundToolOutput: (
    workspaceRoot: string,
    text: string,
  ) => Promise<import("@anthelia/tools").BoundedToolOutput>;
  isManagedResourceTool: (toolName: string) => boolean;
  tryParseToolArguments: (arguments_: string) => Record<string, unknown>;
  parseToolArguments: (arguments_: string) => unknown;
  validateToolParameters: (
    schema: import("@anthelia/tools").ToolSchema,
    input: unknown,
  ) => Array<{ path: string; message: string }>;
};
