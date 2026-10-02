import type { AgentDefinition, AgentRegistry } from "@anthelia/agent";
import type { CapabilityRegistryHost } from "@anthelia/capability";
import type { ConfigV3, RuntimeEvent, SessionID } from "@anthelia/contracts";
import type {
  ContextEntry,
  ProviderToolCall,
  StreamingProvider,
} from "@anthelia/runtime";
import type { ServiceDirectory } from "@anthelia/runtime-services";
import type {
  PermissionProfileCommandRules,
  RuntimeTool,
  SubagentRunnerContext,
  TerminalCommandBuffer,
} from "@anthelia/tools";
import type { SessionExecutionState } from "./session-execution-state";
import type { InteractiveWaiterDeps } from "@anthelia/runtime-services";
import type { ContextLedger } from "@anthelia/runtime";

export type InitializeOptions = {
  sessionID?: SessionID;
  title?: string;
  globalConfigPath?: string;
  sessionDir?: string;
  checkpointDir?: string;
  operationLogsDir?: string;
  vaultDir?: string;
  useSqliteStore?: boolean;
  nativeTerminal?: import("@anthelia/runtime-services").TerminalControllerInput["external"];
  provider?: StreamingProvider;
  tools?: import("@anthelia/tools").ToolRegistry;
  permissionProfile?: string;
  toolPolicy?: import("@anthelia/tools").ToolPolicy;
  hooks?: import("@anthelia/tools").ToolHooks;
};

type ResolvedConfig = Awaited<
  ReturnType<typeof import("@anthelia/config").resolveConfig>
>;
export type InitializeDependencies = {
  resolveConfig: typeof import("@anthelia/config").resolveConfig;
  reloadPermissionSettings: (config: ConfigV3) => void;
  skillsPluginInput: (
    config: ConfigV3,
  ) => import("@anthelia/runtime-services").SkillsInput | undefined;
  localToolsPluginInput: (
    config: ConfigV3,
  ) => import("@anthelia/runtime-services").LocalToolsInput | undefined;
  mcpPluginInput: (
    config: ConfigV3,
  ) => import("@anthelia/runtime-services").McpInput | undefined;
  providerModelPluginInput: () => import("@anthelia/provider-model").ProviderModelControllerInput;
  wireFrameworkServices: (
    ctx: import("./context").RuntimeContext,
    options: InitializeOptions,
  ) => Promise<import("./context").FrameworkServices>;
  capabilityRegistry: CapabilityRegistryHost;
  /** Typed service resolution shared with `ctx.state.serviceDirectory`. */
  serviceDirectory: ServiceDirectory;
  workspaceCapabilityView?: import("@anthelia/capability").CapabilityRegistryView;
  waiterDeps: InteractiveWaiterDeps;
  deliverQueuedMailboxAtBoundary: (exec?: SessionExecutionState) => void;
  createRealRuntimeClient: (
    options: import("./options").RealRuntimeClientOptions,
  ) => import("@anthelia/contracts").RuntimeClient;
  handleCommand: (
    id: string,
    text: string,
    signal: AbortSignal | undefined,
    exec: SessionExecutionState,
  ) => Promise<boolean>;
  scheduleTitleGeneration: (sessionID: SessionID) => void;
  mountPlugins: typeof import("./plugin-mount").mountPlugins;
  agentPolicyLayer: (
    agent?: AgentDefinition,
  ) => import("@anthelia/runtime-services").ToolPolicyHookLayer;
  permissionProfileLayer: (
    profile?: import("@anthelia/contracts").PermissionProfile,
  ) => import("@anthelia/runtime-services").ToolPolicyHookLayer;
  terminalCommandBuffer: TerminalCommandBuffer;
  evaluatePermissionProfileCommandRules: (
    rules: PermissionProfileCommandRules | undefined,
    toolName: string,
    args: Record<string, unknown>,
    source?: string,
  ) => Promise<{ allowed: boolean; diagnostics: string[] }>;
  ensureBashCommandParser: () => Promise<unknown>;
  agentsFromConfig: (config: ConfigV3) => AgentRegistry;
  providerForModel: typeof import("@anthelia/runtime").providerForModel;
  sessionSeed: (workspaceRoot: string) => string;
  createHash: typeof import("node:crypto").createHash;
  lineCount: (text: string) => number;
  contextEntriesToProviderMessages: typeof import("@anthelia/runtime").contextEntriesToProviderMessages;
  withProviderConcurrency: typeof import("@anthelia/runtime").withProviderConcurrency;
  requireNativeToolCallProtocol: typeof import("@anthelia/runtime").requireNativeToolCallProtocol;
  normalizeRawToolCallProtocol: typeof import("@anthelia/runtime").normalizeRawToolCallProtocol;
  nativeToolCallCorrection: typeof import("@anthelia/runtime").nativeToolCallCorrection;
  MAX_PROTOCOL_CORRECTIONS: number;
  WAITING_TOOLS: ReadonlySet<string>;
  readOnlyToolMessage: (toolName: string) => string;
  cleanupToolOutput: typeof import("@anthelia/tools").cleanupToolOutput;
  settleInterruptedTurnIDs: typeof import("@anthelia/session").settleInterruptedTurnIDs;
  settleInterruptedTurns: typeof import("@anthelia/session").settleInterruptedTurns;
  projectSession: typeof import("@anthelia/session").projectSession;
  modelVisibleEvents: typeof import("@anthelia/session").modelVisibleEvents;
  turnCoordinator: () => ReturnType<
    typeof import("@anthelia/session").sessionRunCoordinator
  >;
  drainSession: (signal: AbortSignal) => Promise<void>;
  projectInteractiveRequests: typeof import("@anthelia/session").projectInteractiveRequests;
  contextStatusEvent: typeof import("@anthelia/runtime").contextStatusEvent;
  publishRuntimeCapabilities: () => void;
  publishRegisteredTools: () => void;
  MAX_STEPS_PROMPT: string;
  MISSING_FINAL_RESPONSE_FALLBACK: string;
  ProviderConcurrencyLimiter: typeof import("@anthelia/runtime").ProviderConcurrencyLimiter;
};

export type InitializeCatalogResult = {
  runtimeConfig: ConfigV3;
  tsConfig: ResolvedConfig;
};

export type SubagentSupport = {
  acquireSandboxedSubagentSlot(signal: AbortSignal): Promise<void>;
  releaseSandboxedSubagentSlot(): void;
  publishSubagentEvent(
    runner: SubagentRunnerContext,
    event: RuntimeEvent,
  ): void;
  subagentTurnID(runner: SubagentRunnerContext): string;
  beginSubagentConversation(runner: SubagentRunnerContext, task: string): void;
  finishSubagentConversation(
    runner: SubagentRunnerContext,
    reason: "done" | "cancelled" | "error",
  ): void;
  /** Register the ledger a subagent's current run is writing to. */
  registerSubagentLedger(agentId: string, ledger: ContextLedger): ContextLedger;
  /** Drop a subagent's live ledger, when its run ends. */
  unregisterSubagentLedger(agentId: string): void;
  /** Queue a parent message for a subagent with no live runner. */
  queueSubagentMessage(agentId: string, message: string): boolean;
  /** How many subagents currently hold a live ledger. */
  liveSubagentLedgerCount(): number;
  createSubagentContext(
    system: string,
    task: string,
    planPointer?: { planID: string; documentPath: string; version: number },
    forkSeed?: { entries: readonly ContextEntry[] },
  ): ContextLedger;
  runSubagentProviderStep(
    ledger: ContextLedger,
    tools: RuntimeTool[],
    runner: SubagentRunnerContext,
    step: number,
    provider: StreamingProvider,
    contextConfig: { max: number; thresholdPercent: number; reserved: number },
    allowToolCalls?: boolean,
  ): Promise<{
    output: string;
    thinking: string;
    calls: ProviderToolCall[];
    protocolViolation: string;
  }>;
  appendSubagentAssistant(
    ledger: ContextLedger,
    runner: SubagentRunnerContext,
    step: number,
    output: string,
    calls: ProviderToolCall[],
  ): void;

  appendSubagentToolResult(
    ledger: ContextLedger,
    runner: SubagentRunnerContext,
    step: number,
    call: ProviderToolCall,
    content: string,
  ): void;
};
