import type { TokenMeter } from "@anthelia/runtime";
import type { AgentDefinition, AgentRegistry } from "@anthelia/agent";
import type {
  ApprovalResponse,
  ChatModelProfile,
  CheckpointResourcePolicy,
  ConfigV3,
  ConfirmedWorkspaceChange,
  GoalSnapshot,
  InteractiveResponseOutcome,
  LocalAttachment,
  MCPCatalogSnapshot,
  PromptAgentMention,
  PromptResourceMention,
  QuestionResponse,
  RuntimeClient,
  RuntimeEvent,
  RuntimeMessagePage,
  RuntimeNativeTerminalSession,
  RuntimeReasoningEffort,
  RuntimeSessionSummary,
  RuntimeTerminalRead,
  SessionID,
  WorkspaceOperation,
} from "@anthelia/contracts";
import type {
  AttachmentService,
  CheckpointStore,
  CompactionService,
  ContextLedger,
  DurableContextCheckpoint,
  ProviderToolCall,
  ContextLedger as RuntimeContextLedgerInput,
  CreateCheckpointInput,
  ProviderUsage,
  RetryAttemptContext,
  RetryContext,
  RetryRunnerOptions,
  RetryService,
  StreamingProvider,
} from "@anthelia/runtime";
import type {
  SessionMetadata,
  SessionRecord,
  StoredContextEpoch,
  AdmittedSessionInput,
} from "@anthelia/session";
import type { ProjectDocumentSnapshot } from "./project-documents";
import type {
  RuntimeTool,
  SandboxToolService,
  SubagentRunnerContext,
  SubagentToolService,
  TerminalToolService,
  ToolExecutionPipeline,
  ToolHookEvent as RuntimeToolHookEvent,
  ToolHookResult as RuntimeToolHookResult,
  ToolHooks as RuntimeToolHooks,
  ToolPolicy as RuntimeToolPolicy,
  ToolPolicyHookLayer as RuntimeToolPolicyHookLayer,
  ToolMaterialization,
  ToolRegistry,
} from "@anthelia/tools";
export type LocalToolsInput = {
  roots: string[];
  trust?: {
    workspaceRoot: string;
    verify(
      key: string,
      entryPath: string,
    ): Promise<{ verified: boolean; expected?: string; actual?: string }>;
  };
  onError?(id: string, error: unknown): void;
  onChange?(familyID: string, entryPath: string): void;
};

export type McpInput = {
  servers(): Record<string, import("@anthelia/contracts").MCPServerConfig>;
  workspaceRoot: string;
  enabled(): boolean;
  publish(event: RuntimeEvent): void;
};

export type SkillsInput = {
  workspaceRoot: string;
  userRoot?: string;
  remoteURLs?: string[];
  /**
   * The declared skills directories of the loaded plugins (absolute), read
   * live at each discovery so an install/uninstall lands on the next
   * reload. Plugin skills are the LOWEST precedence: a project or user
   * root with the same name overrides the package's.
   */
  pluginDirs?: () => readonly string[];
  onLoad?(
    skill: SkillMetadata,
    output: string,
    context: import("@anthelia/tools").ToolExecutionContext,
  ): void;
  commandSession?: {
    active(sessionID: SessionID): SkillMetadata | undefined;
    activate(sessionID: SessionID, skill: SkillMetadata): void;
  };
};

export type TerminalInput = TerminalControllerInput;

export type SkillMetadata = {
  name: string;
  /**
   * Whether the skill may be used. A disabled skill is still discovered and
   * listed (so a settings panel can show it and switch it back on), but
   * `resolve` refuses it, so the model can neither load nor run it. The switch
   * is per-workspace and durable.
   */
  enabled: boolean;
  description: string;
  allowedTools: string[];
  requireApproval: boolean;
  sandboxRequired: boolean;
  scripts: Record<string, string>;
  resources: string[];
  qualifiedName: string;
  root: string;
  body: string;
  source: "project" | "user" | "remote" | "plugin";
  /**
   * The sha256 (hex) of the SKILL.md bytes the skill was discovered from —
   * the content's identity, computed by discovery for every source
   * (2026-09-25: the fingerprint catalog's first field; the remote index's
   * per-file declarations verify against it before use, cua's discipline).
   */
  digest: string;
};
export type SkillPolicy = {
  mode: "default" | "restricted" | "sandbox" | "full";
  allowedTools?: string[];
};
export interface SkillService {
  resolve(name: string): SkillMetadata;
  list(): SkillMetadata[];
  /**
   * The only autonomous skill write (Discovery D4): proposals are
   * validated at THIS boundary — action whitelist (create/update only),
   * name/size rules, frontmatter rebuilt by the implementation. Rejected
   * proposals throw with the reason.
   */
  upsertSkill(candidate: unknown): Promise<{ created: boolean; name: string }>;
  /**
   * The settings panel's switch: a disabled skill stays listed (so it can be
   * re-enabled) but `resolve` refuses it. Durable per workspace.
   */
  setSkillEnabled(name: string, enabled: boolean): Promise<{ name: string }>;
  /**
   * Deletes the skill's directory. Only a workspace-owned skill (project or
   * user source) can be removed: a plugin's skill ships with the plugin and a
   * remote one is pulled, so removing either is refused with the reason.
   */
  removeSkill(name: string): Promise<{ removed: string }>;
  authorizeTool(
    skill: SkillMetadata,
    tool: string,
    policy: SkillPolicy,
  ): boolean;
  readResource(skill: SkillMetadata, path: string): Promise<string>;
  runScript(
    skill: SkillMetadata,
    name: string,
    input?: { signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface TeamBehaviorService {
  directive(): string;
  sandboxedSubagentSystemPrompt(domain?: string[]): string;
}

/**
 * The work-ledger's service shape. This interface's only outside
 * consumers are engine readers (the checkpoint gate) — keeping it here
 * means @anthelia never reaches into policy for a type (the source
 * file's own note said it was "moved from runtime-services with the
 * token"; this moves the TYPE back and leaves the implementation and
 * token where policy owns them).
 */
export interface WorkLedgerController {
  buildPlanDocCreated: ServiceOperation;
  buildPlanDocUpdated: ServiceOperation;
  buildPlanDocMarked: ServiceOperation;
  buildPlanDocDeleted: ServiceOperation;
  buildPlanDocStatus: ServiceOperation;
  buildAuditRequested: ServiceOperation;
  evaluateDrift: ServiceOperation;
  evaluateBehaviorDrift: ServiceOperation;
  buildDriftFindingUpdate: ServiceOperation;
  buildWorkContractDrafted: ServiceOperation;
  buildWorkContractAccepted: ServiceOperation;
  buildDetourRequested: ServiceOperation;
  buildDetourReviewed: ServiceOperation;
  validateDetour: ServiceOperation;
  mergeDetourIntoContract: ServiceOperation;
  validateWorkContractFields: ServiceOperation;
  evaluateCompletionCard: ServiceOperation;
  agentActionNode: ServiceOperation;
  approvalEdge: ServiceOperation;
  approvalNode: ServiceOperation;
  completionNode: ServiceOperation;
  completionValidationEdge: ServiceOperation;
  checkpointNode: ServiceOperation;
  constitutionCheckEdge: ServiceOperation;
  constitutionRuleNode: ServiceOperation;
  decisionNode: ServiceOperation;
  externalWorkspaceChangeNode: ServiceOperation;
  toolCallEdge: ServiceOperation;
  toolCallNode: ServiceOperation;
  rollbackCheckpointEdge: ServiceOperation;
  workspaceChangeEdge: ServiceOperation;
  workspaceChangeNode: ServiceOperation;
}

export interface InteractiveWaiter {
  requireApproval(
    approvalID: string,
    tool: import("@anthelia/tools").RuntimeTool,
    call: import("@anthelia/runtime").ProviderToolCall,
    turnID: string,
    options?: { force?: boolean; reason?: string },
  ): Promise<{ reason: string } | undefined>;
  requireQuestion(
    requestID: string,
    turnID: string,
    request: {
      title: string;
      questions: Array<{
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description?: string }>;
        multiple?: boolean;
        custom?: boolean;
      }>;
    },
  ): Promise<string[][]>;
  restoreInteractiveState(events: RuntimeEvent[]): void;
  restoreRecoveredInteractiveState(
    approvals: Array<Extract<RuntimeEvent, { type: "approval.request" }>>,
    questions: Array<Extract<RuntimeEvent, { type: "question.request" }>>,
    interactives?: Array<
      Extract<RuntimeEvent, { type: "interactive.request" }>
    >,
  ): void;
  respondApproval(response: ApprovalResponse): InteractiveResponseOutcome;
  respondQuestion(response: QuestionResponse): InteractiveResponseOutcome;
  /**
   * Issues a generic interactive request and waits for its response. The
   * `validate` callback is the in-process business authority; the runtime only
   * checks the envelope, and the returned promise carries the raw response.
   */
  requireInteractive(input: {
    requestID: string;
    turnID: string;
    kind: string;
    title: string;
    payload: import("@anthelia/contracts").JsonValue;
    responseSchema?: import("@anthelia/contracts").JsonSchema;
    expiresAt?: string;
    priority?: number;
    validate?(
      response: import("@anthelia/contracts").JsonValue,
    ): string[] | void;
  }): Promise<{
    response: import("@anthelia/contracts").JsonValue;
    rejected?: boolean;
  }>;
  respondInteractive(
    response: import("@anthelia/contracts").InteractiveResponse,
  ): InteractiveResponseOutcome;
  revokeTerminalApprovalScope(terminalID: string): {
    id: string;
    scope: string;
    revoked: boolean;
  };
  /**
   * The project-wide standing grants (the "always allow in this project"
   * tier). Merged here by a caller that already folded the journal (the
   * waiter also folds the opening session itself, lazily).
   */
  restoreProjectGrants(families: Iterable<string>): void;
  /** The granted family ids — the observable face of the standing grants. */
  projectGrantedFamilies(): string[];
  hasPendingWaiters(): boolean;
  requirePlanAcceptance(input: {
    approvalID: string;
    planID: string;
    title: string;
    detail: string;
    preview?: string;
    scope?: string;
    sessionID?: SessionID;
    permissionMode?: "ask" | "auto" | "read_only";
    signal?: AbortSignal;
    permissionFamily?: import("@anthelia/contracts").PermissionFamily;
    /**
     * EI §3.7.1/3.7.2: a rule-class/user-safety change is confirmed per item —
     * the gate is never auto-granted in `auto` mode and never session-approved.
     */
    requireExplicit?: boolean;
  }): Promise<ApprovalResponse | undefined>;
}

export type InteractiveWaiterDeps = {
  publish(event: RuntimeEvent): void;
  sessionID(): SessionID;
  permissionMode(turnID?: string): "ask" | "auto" | "read_only";
  abortSignal(turnID: string): AbortSignal | undefined;
  activeTurnID(): string | undefined;
  isPending(sessionID: SessionID, id: string, kind: string): boolean;
  sessionIDForTurn(turnID: string): SessionID;
  agentIDForTurn?(turnID: string): string | undefined;
  publishForSession(sessionID: SessionID, event: RuntimeEvent): void;
  capabilityOwnerForTool?(toolName: string): string | undefined;
  workLedger(): WorkLedgerController;
  /**
   * The session's journal events, for the project-grant restore fold (the
   * durable `approval.response {decision:"project"}` records). The
   * fast-attach tail when the fact state is incomplete, the collab slice
   * when it is — the same accessor the snapshot path uses.
   */
  sessionEvents?(sessionID: SessionID): readonly RuntimeEvent[] | undefined;
};

export type ProviderRunnerInput = {
  /**
   * The composed static system prompt (ADR D1): persona, goal policy,
   * agent instructions — POLICY content injected by the caller. The
   * engine renders and forwards it without ever carrying a brand, a
   * persona, or a goal rule (§1.1: the engine knows no product).
   */
  staticSystemPrompt(agentPrompt?: string): string;
  provider(): StreamingProvider | undefined;
  session(): SessionRecord | undefined;
  context(): RuntimeContextLedgerInput;
  tokenMeter?(): TokenMeter;
  tools(): ToolRegistry;
  attachmentReferences(): Map<string, LocalAttachment[]>;
  attachments: AttachmentService;
  compaction: CompactionService;
  mcp(): Pick<McpService, "readResource"> | undefined;
  agentRegistry(): AgentRegistry | undefined;
  activeAbort(): AbortController | undefined;
  setActiveAbort(controller: AbortController | undefined): void;
  activeTurnID(): string | undefined;
  setActiveTurnID(id: string | undefined): void;
  selectedAgent(): AgentDefinition | undefined;
  setSelectedAgent(agent: AgentDefinition | undefined): void;
  /**
   * The session's start date, `YYYY-MM-DD`, snapshotted when its execution
   * state was built. Rendered in the environment block; absent on a runner with
   * no session to name, in which case no date is shown rather than one invented.
   */
  sessionStartedAt?: () => string | undefined;
  /** The date the session's history currently reflects, for the rollover check. */
  sessionCurrentDate?: () => string | undefined;
  /** Record a new current date, once its rollover notice has been appended. */
  recordSessionDate?: (date: string) => void;
  pendingAgent(): AgentDefinition | undefined;
  setPendingAgent(agent: AgentDefinition | undefined): void;
  selectedModel(): { modelID?: string; variant?: string } | undefined;
  modelCapabilities(): import("@anthelia/contracts").ModelCapabilities;
  setActiveModelCapabilities(
    capabilities: import("@anthelia/contracts").ModelCapabilities | undefined,
  ): void;
  refreshContextConfig?(): Promise<void>;
  permissionMode(): "ask" | "auto" | "read_only";
  workspaceRoot(): string;
  tsRuntimeConfig(): ConfigV3 | undefined;
  runtimeContextConfig(): import("@anthelia/runtime").ContextBudget;
  activeSkill(): SkillMetadata | undefined;
  skillsList(): SkillMetadata[];
  skillService?(): SkillService | undefined;
  /**
   * The project documents (AGENTS.md / .natalia/constitution.md) loaded for
   * the workspace, or undefined when none are present. Injected as a
   * `<runtime_context source="project">` block (ADR D2 / EI §8.5) — user-tier
   * authority, never in the static system prompt.
   */
  projectDocuments?(): ProjectDocumentSnapshot | undefined;
  /**
   * The session's effective file-effect mode (sandbox study §6b①), stated
   * in the per-turn environment block: the agent knows its CURRENT
   * confinement state — the tool schema advertises the escalation targets,
   * this says where the agent IS. Rides the dynamic layer, never the
   * cached prefix.
   */
  confinementMode?(): import("@anthelia/contracts").ConfinementMode;
  /**
   * The operation-log channel (T3): the runtime zone passes its logger, a
   * bare context (tests) leaves it out and the call sites degrade to
   * silence — telemetry never crashes the turn. Structural so the kit
   * needs no dependency on the log layer.
   */
  log?: {
    info(
      component: string,
      message: string,
      fields?: Record<string, unknown>,
    ): void;
    error(
      component: string,
      message: string,
      fields?: Record<string, unknown>,
    ): void;
    debug(
      component: string,
      message: string,
      fields?: Record<string, unknown>,
    ): void;
  };
  naviSuggestions(): Array<{
    id: string;
    suggestion: string;
    priority: string;
    rationale?: string;
  }>;
  naviAnswers(): Array<{ questionID: string; answer: string }>;
  naviChats?(): Array<{
    id: string;
    threadID: string;
    from: import("@anthelia/contracts").CollaborationParticipant;
    to: import("@anthelia/contracts").CollaborationParticipant;
    text: string;
    round: number;
    expectsReply: boolean;
    status: string;
  }>;
  naviIntro(): boolean;
  niaChats?(): Array<{
    id: string;
    threadID: string;
    from: import("@anthelia/contracts").CollaborationParticipant;
    to: import("@anthelia/contracts").CollaborationParticipant;
    text: string;
    round: number;
    expectsReply: boolean;
    status: string;
  }>;
  niaIntro?(): boolean;
  activePlan():
    | {
        planID: string;
        version: number;
        title: string;
        objective: string;
        steps: Array<{
          id: string;
          title: string;
          detail?: string;
          verification?: string;
        }>;
        constraints: string[];
        verification: string[];
        riskNotes: string[];
      }
    | undefined;
  retry: RetryService;
  lastProviderUsage(): ProviderUsage | undefined;
  setLastProviderUsage(usage: ProviderUsage | undefined): void;
  publish(event: RuntimeEvent): void;
  applyAgentPolicy(): void;
  applyAgentProvider(): void;
  persistInboxPromotion(sessionID?: string): Promise<void>;
  createTurnCheckpoint(input: CreateCheckpointInput): Promise<void>;
  isToolAllowed(toolName: string): boolean;
  setInFlightOperation(
    operation: import("@anthelia/session").DurableInFlightOperation | undefined,
  ): Promise<void>;
  executeToolCalls(
    turnID: string,
    calls: ProviderToolCall[],
    assistant: string,
    materialized: ToolMaterialization,
    reasoning?: {
      content?: string;
      field?: string;
      signature?: string;
      redacted?: boolean;
      blocks?: import("@anthelia/contracts").ProviderReasoningBlock[];
      parts?: import("@anthelia/contracts").ProviderContentPart[];
      providerMetadata?: Record<string, unknown>;
      textSignature?: string;
    },
  ): Promise<import("@anthelia/runtime").ProviderMessage[]>;
  takeLiveUserMessages?(): Array<{ source: "user" | "navi"; text: string }>;
  /** Claims un-promoted `next-step` inputs for one provider step. */
  takeStepInputs?(step: number): Array<{ id: string; text: string }>;
  /** Whether any `next-step` input is still waiting to be claimed. */
  hasPendingStepInputs?(): boolean;
  /** O(1) "was turn.submitted already published for this id" check. */
  isTurnAnnounced?(id: string): boolean;
  /** Records that `turn.submitted` was published for this turn. */
  markTurnAnnounced?(id: string): void;
  reloadConfig(): Promise<{ providerReconfigured: boolean }>;
  runtimeStatusSnapshot(): Promise<RuntimeEvent>;
  effectiveMaxSteps(): number;
  waitIfPaused(): Promise<void>;
  waitingHuman(): { terminalID: string; reason: string } | undefined;
};

export interface SubagentsService extends SubagentToolService {
  /**
   * Install or clear the live-delivery hook for one subagent.
   *
   * The runtime that owns the child's ledger is the only thing that can reach
   * it, so it installs a hook for the duration of the child's run and clears it
   * when the run ends — after which a message queues instead of vanishing.
   */
  setSteerHook(
    id: string,
    hook:
      | ((message: string) => "delivered" | "resumed" | undefined)
      | undefined,
  ): void;
  init(
    runner: (
      task: string,
      context: SubagentRunnerContext,
    ) => void | Promise<void>,
  ): Promise<void>;
  enabled(): boolean;
}

export type TerminalControllerInput = {
  workspaceRoot: string;
  publish(event: RuntimeEvent): void;
  onPerformance(name: string, durationMs: number): void;
  runtimeID(): string;
  userRuntimeHome(): string | undefined;
  windowMode(): "auto" | "windowless" | "window";
  /** Provider-private native registry, interpreted only by the terminal subsystem. */
  external?: unknown;
  /** Interactive terminal host. Omitted / unknown values use in-process PTY. */
  backend?: "wezterm" | "pty";
  /** Cap on concurrent PTYs for one Natalia session. PTY backend only. */
  maxPerSession?: number;
  /** Recycle a session's idle PTY when the cap is hit. PTY backend only. */
  idleMs?: number;
};
export interface SandboxService extends SandboxToolService {
  init(): Promise<void>;
  close(): Promise<void>;
  referencedObjectIDs(): Promise<Set<string> | undefined>;
  runningResourceCount(): number;
}
/** Backend-neutral terminal port. Native registry classes never cross this boundary. */
export interface TerminalController {
  init(): Promise<void>;
  list(sessionID?: string): Promise<RuntimeNativeTerminalSession[]>;
  reconcile(): Promise<RuntimeNativeTerminalSession[]>;
  read(
    id: string,
    options?: {
      maxLines?: number;
      /** The first line to return: 0 is the oldest scrollback line, negatives count from the end. */
      startLine?: number;
      /** The last line to return (inclusive). */
      endLine?: number;
      sessionID?: string;
    },
  ): Promise<
    RuntimeTerminalRead & {
      cursorX: number;
      cursorY: number;
      rows: number;
      cols: number;
    }
  >;
  openHub(): Promise<{ muxWindowID: number }>;
  releaseHumanControl(
    id: string,
    sessionID?: string,
  ): RuntimeNativeTerminalSession;
  beginSecureInput(
    id: string,
    sessionID?: string,
  ): RuntimeNativeTerminalSession;
  endSecureInput(id: string, sessionID?: string): RuntimeNativeTerminalSession;
  stop(
    id: string,
    actor: "model" | "human" | "system",
    sessionID?: string,
  ): Promise<RuntimeNativeTerminalSession>;
  start(input: {
    command: string;
    cwd: string;
    id?: string;
    sessionID?: string;
    agentID?: string;
    /** The grid to spawn at; absent means the controller's default. */
    rows?: number;
    cols?: number;
  }): Promise<RuntimeNativeTerminalSession>;
  write(
    id: string,
    value: string,
    options?: {
      idempotencyKey?: string;
      sessionID?: string;
      /**
       * Who is typing. The model's write is refused on a human-owned terminal
       * and the human's on a secure-input pane; both arrive through this one
       * call today (the browser pane's keystrokes and the model's tool
       * call), so the caller states which it is. Absent means the model.
       */
      actor?: "model" | "human";
    },
  ): Promise<{
    writtenBytes: number;
    delivery: "accepted" | "duplicate" | "cancelled";
  }>;
  resize(
    id: string,
    rows: number,
    cols: number,
    actor: "model" | "human",
    sessionID?: string,
  ): Promise<RuntimeNativeTerminalSession>;
  snapshot(id: string): ReturnType<TerminalToolService["snapshot"]>;
  /**
   * The command-level read: the pane's last command and what it produced.
   *
   * The output is a projection of the screen bounded by the command's
   * shell-integration markers, not a second capture, so it cannot disagree with
   * what the human sees. `output` is absent until a command has finished — a pane
   * whose shell emits no markers never has a command to name, and says so rather
   * than inventing one out of the screen.
   *
   * OPTIONAL because not every terminal backend can answer it. The pty-backed
   * controller reads the markers out of its own stream; the mux facade drives a
   * pane in another process whose command lifecycle it does not see. An
   * implementation that cannot read it leaves the member off rather than
   * returning a fabricated record, and a caller must treat absence as "this pane
   * cannot tell you", which is the truth.
   */
  lastCommand?(id: string): {
    commandLine: string | undefined;
    exitCode: number | undefined;
    atPrompt: boolean;
    output: string | undefined;
    revision: number;
  };
  observe(
    id: string,
    afterRevision: number,
    options?: { maxLines?: number; timeoutMs?: number },
  ): ReturnType<TerminalToolService["observe"]>;
  session(id: string): { lastObservedText?: string };
  markObserved(id: string, text: string, revision: number): void;
  /** The revision the model last observed (the observe default's base). */
  lastObservedRevision(id: string): number | undefined;
  requestHuman(
    id: string,
    reason: string,
    sessionID?: string,
  ): Promise<RuntimeNativeTerminalSession>;
  claimHumanInput?(
    id: string,
    sessionID?: string,
  ): Promise<RuntimeNativeTerminalSession>;
  ttyName(id: string): Promise<string | undefined>;
  setActiveSession(sessionID: string | undefined): void;
  subscribeOutput?(id: string, listener: (chunk: string) => void): () => void;
  /** Stop every running pane owned by a Natalia session. */
  stopForSession?(sessionID: string): Promise<void>;
  close(): Promise<void>;
}

export interface McpService {
  reload(): Promise<void>;
  catalog(): Promise<MCPCatalogSnapshot>;
  getPrompt(
    server: string,
    name: string,
    arguments_?: Record<string, string>,
  ): Promise<unknown>;
  readResource(server: string, uri: string): Promise<unknown>;
}

export interface RuntimeServiceClient extends RuntimeClient {
  service<T>(name: string): Promise<T | undefined>;
  subscribeTerminalOutput?(
    id: string,
    listener: (chunk: string) => void,
  ): () => void;
}
export type PlanLifecycleState =
  | "marked"
  | "handed_off"
  | "executing"
  | "paused"
  | "awaiting_audit"
  | "auditing"
  | "audit_pending"
  | "audit_gaps"
  | "completed";
export type ServiceOperation = (...args: any[]) => any;
export type ToolPolicy = RuntimeToolPolicy;
export type ToolHookEvent = RuntimeToolHookEvent;
export type ToolHookResult = RuntimeToolHookResult;
export type ToolHooks = RuntimeToolHooks;
export type ToolPolicyHookLayer = RuntimeToolPolicyHookLayer;
export interface ToolPolicyService {
  createExecutionPipeline(): ToolExecutionPipeline;
  createHookLayer(policy?: ToolPolicy, hooks?: ToolHooks): ToolPolicyHookLayer;
  evaluatePermissionRules: (...args: any[]) => any;
  workspaceWritePathForTool: (...args: any[]) => any;
  workspaceWritePathsForTool: (...args: any[]) => any;
  commandTextForTool: (...args: any[]) => any;
}

export type CompactionBudget = {
  max: number;
  thresholdPercent: number;
  reserved: number;
};
