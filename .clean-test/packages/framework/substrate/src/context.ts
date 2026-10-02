/**
 * RuntimeContext — the single shared port between every runtime module.
 *
 * Architecture convergence plan §3.1: modules under `packages/framework/client/src/runtime/`
 * receive the same `RuntimeContext` and may communicate with each other only
 * through it. They never import one another's implementations.
 *
 * `state` holds every mutable value the runtime shares; `ports` holds every
 * cross-module function. Modules read what they need at call time (destructured
 * at the top of each function), so construction order never matters.
 */
import type { RuntimeContextStatusConfig } from "./status-config";
import type { RuntimePorts } from "./ports";
import type { RuntimePortsExtra } from "./ports-extra";
import type { RuntimeInitializePorts } from "./ports-initialize";
import type { RuntimeClientSurfacePorts } from "./ports-client-surface";
import type { InitializeDependencies } from "./initialize-types";
export type {
  InitializeCatalogResult,
  InitializeOptions,
  SubagentSupport,
} from "./initialize-types";
export type { RuntimeEvent, SessionID } from "@anthelia/contracts";
export type { ProviderToolCall, StreamingProvider } from "@anthelia/runtime";

import type { StatusSnapshotController } from "@anthelia/runtime-status";
export type { StatusSnapshotController } from "@anthelia/runtime-status";
export type {
  RuntimeTool,
  SubagentRunnerContext,
  ToolHookEvent,
} from "@anthelia/tools";
import type {
  CapabilityHost,
  CapabilityRegistryHost,
} from "@anthelia/capability";
import type { AgentDefinition, AgentRegistry } from "@anthelia/agent";
import type {
  RuntimeEvent,
  SessionID,
  SubmittedTurn,
  ConfigV3,
  LocalAttachment,
} from "@anthelia/contracts";
import type { SessionRecord } from "@anthelia/session";
import type {
  ServiceDirectory,
  SkillMetadata,
} from "@anthelia/runtime-services";
export type {
  McpService,
  SandboxService,
  SubagentsService,
  TerminalController,
  ToolPolicyService,
} from "@anthelia/runtime-services";
export type { PermissionProfileCommandRules } from "@anthelia/tools";
import type {
  ContextWindowResolver,
  ProviderConcurrencyLimiter,
  StreamingProvider,
} from "@anthelia/runtime";
import type {
  TerminalCommandBuffer,
  ToolRegistry as ToolRegistryType,
} from "@anthelia/tools";
import type { RuntimePerformanceTrace } from "./performance-trace";
import type { SessionExecutionState } from "./session-execution-state";
import type {
  AttachmentService,
  CompactionService,
  ProviderUsage,
  RetryService,
} from "@anthelia/runtime";
import type { ProviderModelController } from "@anthelia/provider-model";
import type { CheckpointFactory } from "@anthelia/checkpoint";
import type { SessionStoreController } from "@anthelia/session-store";
import type {
  MutationRegistry,
  WorkspaceFilesController,
  WorkspaceWriteLock,
} from "@anthelia/workspace";
export type {
  MutationRegistry,
  WorkspaceFilesController,
  WorkspaceWriteLock,
} from "@anthelia/workspace";
export type { SessionExecutionState } from "./session-execution-state";
import type {
  InteractiveWaiter,
  InteractiveWaiterDeps,
} from "@anthelia/runtime-services";
import type { TurnController } from "@anthelia/turn-orchestration";

type PermissionProfile = import("@anthelia/contracts").PermissionProfile;
type RuntimeDiagnostic = Extract<RuntimeEvent, { type: "diagnostic" }> & {
  at: string;
};

/**
 * The host-owned lifecycle of the framework subsystems wired by
 * `initialize/framework-services.ts`. `refreshRuntimeConfig` re-contributes the
 * config and plugin input services after a config reload; `close` releases the
 * framework resources at dispose.
 */
export type FrameworkServices = {
  /**
   * Re-applies config INCLUDING the composition profile's drop-in
   * layers (the profile load is asynchronous) — callers await it so a
   * reload never reports done before the composition it reloaded.
   */
  refreshRuntimeConfig(): Promise<void>;
  close(): void;
};

/**
 * Every mutable and shared value the runtime carries. The composition root
 * (`runtime/main.ts`) creates this once; modules read it through `ctx.state`.
 */
export type RuntimeState = {
  runtimeDisposed: boolean;
  initialize: InitializeDependencies;
  workspaceRoot: string;
  pluginStoreRoot?: string;
  sessionID: SessionID;
  provider?: StreamingProvider;
  /** Immutable host/test provider injection for the independent chat streams. */
  readonly chatDefaultProvider?: StreamingProvider;
  providerSource: "explicit" | "environment" | "ts_config" | "unconfigured";
  capabilityRegistry: CapabilityRegistryHost;
  /** Typed service resolution over the registry's service channel. */
  serviceDirectory: ServiceDirectory;
  capabilityHost?: CapabilityHost;
  workspaceCapabilityView?:
    | import("@anthelia/capability").CapabilityRegistryView
    | undefined;
  tools: ToolRegistryType;
  terminalCommandBuffer: TerminalCommandBuffer;
  permissionMode: "ask" | "auto" | "read_only";
  selectedPermissionProfile?: PermissionProfile;
  defaultPermissionMode: "ask" | "auto" | "read_only";
  defaultPermissionProfile?: PermissionProfile;
  maxSteps?: number;
  toolCalls: Map<string, number[]>;
  waiterDeps: InteractiveWaiterDeps;
  sink?: (event: RuntimeEvent) => void;
  replayMode: "all" | "none";
  session?: SessionRecord;
  lastSubmitted?: SubmittedTurn;
  activeAbort?: AbortController;
  activeTurnID?: string;
  endTurnWaitingHuman?: { terminalID: string; reason: string };
  turnSession: Map<string, SessionID>;
  liveMainOutputByTurn: Map<string, string>;
  turnAgent: Map<string, string>;
  executionBySession: Map<SessionID, SessionExecutionState>;
  activeExec?: SessionExecutionState;
  paused: boolean;
  pauseWaiters: Array<() => void>;
  ready?: Promise<void>;
  activeSkill?: SkillMetadata;
  attachmentReferences: Map<string, LocalAttachment[]>;
  runtimeDiagnosticsBySession: Map<SessionID, RuntimeDiagnostic[]>;
  runtimeDiagnostics: RuntimeDiagnostic[];
  selectedAgent?: AgentDefinition;
  selectedModel?: { modelID?: string; variant?: string };
  pendingAgent?: AgentDefinition;
  agentRegistry?: AgentRegistry;
  /**
   * The latest provider usage sample. Typed by the shared `ProviderUsage`
   * rather than an inline `{inputTokens, outputTokens}`: a narrower local
   * declaration compiles while dropping the cache fields, and the loss only
   * shows up as an implausible hit rate.
   */
  lastProviderUsage?: ProviderUsage;
  sessionPersistence: Promise<void>;
  sessionPersistenceBySession: Map<SessionID, Promise<void>>;
  nativeRuntimeID: string;
  tsRuntimeConfig?: ConfigV3;
  frameworkServices?: FrameworkServices;
  contextWindowResolver: ContextWindowResolver;
  runtimeContextConfig: RuntimeContextStatusConfig;
  retryPolicy: import("@anthelia/runtime").RetryRunnerOptions["policy"];
  providerConcurrencyLimiter: ProviderConcurrencyLimiter;
  terminalStatusByID: Map<string, string>;
  performanceTrace: RuntimePerformanceTrace;
  sandboxResourcesByID: Map<string, number>;
  activeToolByTurn: Map<string, string>;
  sessionSnapshotSequence: number;
  /** Title generation owned state (title-generation module). */
  titleGenerationTasks: Map<
    SessionID,
    {
      input: string;
      timer?: ReturnType<typeof setTimeout>;
      controller?: AbortController;
      promise?: Promise<void>;
    }
  >;
};

/**
 * Every cross-module function. The composition root assigns each as its owning
 * module is created; modules read them at call time so cycles are fine.
 */
export type RuntimeContext = {
  state: RuntimeState;
  ports: RuntimePorts &
    RuntimePortsExtra &
    RuntimeInitializePorts &
    RuntimeClientSurfacePorts;
};

/** The resolved context window status carried by the runtime and each exec. */
export type { TurnController } from "@anthelia/turn-orchestration";
export type {
  InteractiveWaiter,
  InteractiveWaiterDeps,
} from "@anthelia/runtime-services";
