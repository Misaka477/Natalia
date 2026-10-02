import {
  API_VERSION,
  RuntimeRPCError,
  RuntimeVersionMismatchError,
} from "@anthelia/contracts";
import type {
  ApprovalResponse,
  QuestionResponse,
  RuntimeClient,
  RuntimeEvent,
  SubmittedTurn,
} from "@anthelia/contracts";

export type NataliaSDKOptions = {
  baseURL: string;
  token?: string;
  fetch?: typeof fetch;
};

export type NataliaSDK = {
  prompt(
    text: string,
    options?: {
      delivery?: "next-turn" | "next-step";
      attachments?: string[];
      resources?: import("@anthelia/contracts").PromptResourceMention[];
      agents?: import("@anthelia/contracts").PromptAgentMention[];
    },
  ): Promise<SubmittedTurn>;
  cancel(reason?: string): Promise<void>;
  /**
   * These report what the runtime did rather than resolving on the assumption it
   * worked. Nothing running, already paused, an unknown agent, or a selection
   * deferred until the current turn ends are all ordinary answers, and a caller
   * that cannot see them will render the wrong thing.
   */
  pause(
    reason?: string,
    sessionID?: string,
  ): Promise<import("@anthelia/contracts").PauseOutcome>;
  resume(
    sessionID?: string,
  ): Promise<import("@anthelia/contracts").ResumeOutcome>;
  selectAgent(
    name?: string,
    sessionID?: string,
  ): Promise<import("@anthelia/contracts").AgentSelectionOutcome>;
  agents(input?: {
    workspaceID?: string;
  }): Promise<import("@anthelia/contracts").RuntimeAgentCatalogEntry[]>;
  modelCatalog(input?: {
    workspaceID?: string;
  }): Promise<import("@anthelia/contracts").RuntimeModelCatalogEntry[]>;
  modelSelection(
    sessionID?: string,
  ): Promise<import("@anthelia/contracts").RuntimeModelSelection>;
  setDefaultModel(
    modelID: string,
  ): Promise<{ saved: boolean; reason?: string }>;
  selectModel(
    modelID?: string,
    variant?: string,
    sessionID?: string,
  ): Promise<void>;
  reasoningEffort(
    sessionID?: string,
  ): Promise<import("@anthelia/contracts").RuntimeReasoningEffort | undefined>;
  setReasoningEffort(
    effort?: import("@anthelia/contracts").RuntimeReasoningEffort,
    sessionID?: string,
  ): Promise<void>;
  skills(input?: {
    workspaceID?: string;
  }): Promise<import("@anthelia/contracts").RuntimeSkillCatalogEntry[]>;
  workspaceFiles(input?: {
    workspaceID?: string;
    query?: string;
    type?: "file" | "directory";
    limit?: number;
  }): Promise<import("@anthelia/contracts").RuntimeWorkspaceFileEntry[]>;
  workspaceSearch(input: {
    workspaceID?: string;
    query: string;
    include?: string;
    limit?: number;
  }): Promise<import("@anthelia/contracts").RuntimeWorkspaceMatch[]>;
  workspaceList(input?: {
    workspaceID?: string;
    path?: string;
    offset?: number;
    limit?: number;
  }): Promise<import("@anthelia/contracts").RuntimeWorkspaceListPage>;
  workspaceRead(input: {
    workspaceID?: string;
    path: string;
    offset?: number;
    limit?: number;
  }): Promise<import("@anthelia/contracts").RuntimeWorkspaceContent>;
  resourceRead(input: {
    workspaceID?: string;
    resource: string;
    params?: Record<string, string>;
    reader?: string;
  }): Promise<import("@anthelia/contracts").RuntimeWorkspaceContent>;
  workspaceWriteConflicts(input?: {
    workspaceID?: string;
  }): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["workspaceWriteConflicts"]>>>
  >;
  workspaceGlob(input: {
    workspaceID?: string;
    pattern: string;
    path?: string;
    limit?: number;
  }): Promise<import("@anthelia/contracts").RuntimeWorkspaceFileEntry[]>;
  sessions(): Promise<import("@anthelia/contracts").RuntimeSessionSummary[]>;
  touchSession(id: string): Promise<void>;
  renameSession(
    id: string,
    title: string,
  ): Promise<import("@anthelia/contracts").RuntimeSessionSummary>;
  pinSession(
    id: string,
    pinned: boolean,
  ): Promise<import("@anthelia/contracts").RuntimeSessionSummary>;
  duplicateSession(
    id: string,
    title?: string,
  ): Promise<import("@anthelia/contracts").RuntimeSessionSummary>;
  forkSession(
    id: string,
    turnID: string,
    title?: string,
  ): Promise<import("@anthelia/contracts").RuntimeSessionSummary>;
  deleteSession(
    id: string,
  ): Promise<{ id: string; removedAttachments: number }>;
  /**
   * Creates a session record. Idempotent by id: an existing id answers
   * `created: false`. A write.
   */
  newSession(
    input?: Parameters<NonNullable<RuntimeClient["sessionNew"]>>[0],
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["sessionNew"]>>>>;
  /** Archives a session record. A write; idempotent. */
  archiveSession(
    id: string,
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["sessionArchive"]>>>>;
  /** Exports a session's journal, every event in sequence. Read-only. */
  exportSession(
    id: string,
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["sessionExport"]>>>>;
  /** Makes an existing durable session active in this hosted runtime. A write. */
  attachSession(
    id: string,
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["sessionAttach"]>>>>;
  /** Lists permission profiles with the active default. Read-only. */
  permissionList(): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["permissionList"]>>>
  >;
  /** Creates or replaces a permission profile. A write. */
  permissionSave(
    input: Parameters<NonNullable<RuntimeClient["permissionSave"]>>[0],
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["permissionSave"]>>>>;
  /** Deletes a permission profile. A write; idempotent; the default refuses. */
  permissionDelete(
    name: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["permissionDelete"]>>>
  >;
  /** Adds or replaces an MCP server and reconnects it. A write. */
  mcpServerAdd(
    input: Parameters<NonNullable<RuntimeClient["mcpServerAdd"]>>[0],
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["mcpServerAdd"]>>>>;
  /** Removes an MCP server and disconnects it. A write; idempotent. */
  mcpServerRemove(
    name: string,
    workspaceID?: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["mcpServerRemove"]>>>
  >;
  /** Creates an agent definition. A write. */
  createAgent(
    input: Parameters<NonNullable<RuntimeClient["agentCreate"]>>[0],
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["agentCreate"]>>>>;
  /** Replaces an agent definition. A write. */
  updateAgent(
    input: Parameters<NonNullable<RuntimeClient["agentUpdate"]>>[0],
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["agentUpdate"]>>>>;
  /** Deletes an agent definition. A write; idempotent; the default refuses. */
  deleteAgent(
    name: string,
    workspaceID?: string,
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["agentDelete"]>>>>;
  /** Discovers the models a provider endpoint offers. Read-only. */
  discoverProvider(
    input: Parameters<NonNullable<RuntimeClient["providerDiscover"]>>[0],
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["providerDiscover"]>>>
  >;
  /** Adds or replaces a provider. A write. */
  addProvider(
    input: Parameters<NonNullable<RuntimeClient["providerAdd"]>>[0],
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["providerAdd"]>>>>;
  /** Removes a provider. A write; idempotent; referenced providers refuse. */
  removeProvider(
    name: string,
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["providerRemove"]>>>>;
  /** Unloads a plugin. A write; idempotent. */
  unloadPlugin(
    id: string,
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["pluginUnload"]>>>>;
  /** Reloads a plugin from its manifest path. A write. */
  reloadPlugin(
    id: string,
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["pluginReload"]>>>>;
  /**
   * Answering a request that already timed out or was answered elsewhere is
   * dropped by the runtime, and `accepted: false` is how a UI learns that — the
   * model was told the call did not run, so re-rendering it as approved would be
   * wrong.
   */
  respondApproval(
    response: ApprovalResponse,
  ): Promise<import("@anthelia/contracts").InteractiveResponseOutcome>;
  respondQuestion(
    response: QuestionResponse,
  ): Promise<import("@anthelia/contracts").InteractiveResponseOutcome>;
  /** Answers a generic interactive request; response stays opaque to the runtime. */
  respondInteractive(
    response: import("@anthelia/contracts").InteractiveResponse,
  ): Promise<import("@anthelia/contracts").InteractiveResponseOutcome>;
  pendingInteractive(input?: {
    sessionID?: string;
    workspaceID?: string;
  }): Promise<{
    approvals: Array<Extract<RuntimeEvent, { type: "approval.request" }>>;
    questions: Array<Extract<RuntimeEvent, { type: "question.request" }>>;
  }>;
  checkpoint(): Promise<SubmittedTurn>;
  checkpoints(limit?: number): Promise<SubmittedTurn>;
  rollback(
    checkpointID: string,
    options?: { dryRun?: boolean },
  ): Promise<SubmittedTurn>;
  checkpointList(
    sessionID?: string,
  ): Promise<import("@anthelia/contracts").RuntimeCheckpoint[]>;
  checkpointListByKind(
    kind?: import("@anthelia/contracts").CheckpointKind,
    sessionID?: string,
  ): Promise<import("@anthelia/contracts").RuntimeCheckpoint[]>;
  auditRounds(
    planID?: string,
    workspaceID?: string,
  ): Promise<import("@anthelia/contracts").AuditRoundRecord[]>;
  roundDiff(input: {
    workspaceID?: string;
    from: import("@anthelia/contracts").CheckpointRef;
    to: import("@anthelia/contracts").CheckpointRef;
    paths?: string[];
    includePatch?: boolean;
    includeContent?: boolean;
    maxFiles?: number;
    maxPatchChars?: number;
  }): Promise<import("@anthelia/contracts").RuntimeWorkspaceDiffChange[]>;
  checkpointPreview(
    id: string,
    sessionID?: string,
    options?: { includePatch?: boolean },
  ): Promise<import("@anthelia/contracts").CheckpointPreview>;
  checkpointRollback(input: {
    id: string;
    dryRun?: boolean;
    sessionID?: string;
  }): Promise<import("@anthelia/contracts").CheckpointPreview>;
  checkpointRename(input: {
    id: string;
    name: string;
    sessionID?: string;
  }): Promise<import("@anthelia/contracts").RuntimeCheckpoint>;
  sandboxList(
    sessionID?: string,
  ): Promise<import("@anthelia/contracts").RuntimeSandbox[]>;
  sandboxDiff(
    id: string,
    sessionID?: string,
    options?: { includePatch?: boolean },
  ): Promise<import("@anthelia/contracts").RuntimeSandboxChange[]>;
  sandboxResources(
    id: string,
    sessionID?: string,
  ): Promise<import("@anthelia/contracts").RuntimeSandboxResource[]>;
  sandboxResourceOutput(input: {
    id: string;
    resourceID: string;
    maxBytes?: number;
    sessionID?: string;
  }): Promise<string>;
  sandboxMerge(
    id: string,
    sessionID?: string,
  ): Promise<import("@anthelia/contracts").RuntimeSandboxChange[]>;
  sandboxDelete(
    id: string,
    sessionID?: string,
  ): Promise<{
    pendingChanges: import("@anthelia/contracts").RuntimeSandboxChange[];
    runningResources: string[];
  }>;
  sandboxResourceStop(input: {
    id: string;
    resourceID: string;
    sessionID?: string;
  }): Promise<import("@anthelia/contracts").RuntimeSandboxResource>;
  snapshot(input?: {
    sessionID?: string;
    workspaceID?: string;
  }): Promise<RuntimeEvent>;
  history(options?: {
    sessionID?: string;
    after?: number;
    offset?: number;
    limit?: number;
  }): Promise<{
    events: Array<{ seq: number; event: RuntimeEvent }>;
    hasMore: boolean;
  }>;
  messages(options?: {
    sessionID?: string;
    limit?: number;
    order?: "asc" | "desc";
    cursor?: string;
  }): Promise<import("@anthelia/contracts").RuntimeMessagePage>;
  mcpCatalog(input?: {
    workspaceID?: string;
  }): Promise<import("@anthelia/contracts").MCPCatalogSnapshot>;
  mcpPrompt(
    server: string,
    name: string,
    arguments_?: Record<string, string>,
    workspaceID?: string,
  ): Promise<unknown>;
  mcpResource(
    server: string,
    uri: string,
    workspaceID?: string,
  ): Promise<unknown>;
  plugins(): Promise<import("@anthelia/contracts").PluginStatus[]>;
  pluginInstall(input: {
    spec: string;
  }): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["pluginInstall"]>>>>;
  pluginUninstall(input: {
    pluginID: string;
  }): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["pluginUninstall"]>>>
  >;
  pluginSetEnabled(input: {
    pluginID: string;
    enabled: boolean;
  }): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["pluginSetEnabled"]>>>
  >;
  pluginCatalog(): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["pluginCatalog"]>>>
  >;
  /**
   * Unattended work, read-only. Each entry reports its own problems rather than
   * failing the whole list, so a broken document does not blank the view.
   */
  /** Commands contributed by capabilities and plugins. */
  commandCatalog(input?: {
    workspaceID?: string;
  }): Promise<import("@anthelia/contracts").ContributedCommand[]>;
  commandExecute(
    input: import("@anthelia/contracts").ContributedCommandExecution,
  ): Promise<void>;
  /** Replayable causal facts, including the existing epi_* correlation id. */
  workGraphNodes(input?: {
    sessionID?: string;
    workspaceID?: string;
  }): Promise<import("@anthelia/contracts").WorkGraphNodeView[]>;
  workGraphEdges(input?: {
    sessionID?: string;
    workspaceID?: string;
  }): Promise<import("@anthelia/contracts").WorkGraphEdgeView[]>;
  /** The native terminal host. P0-D scopes the secure-input members. */
  nativeTerminalList(
    sessionID?: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["nativeTerminalList"]>>>
  >;
  nativeTerminalRead(
    id: string,
    sessionID?: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["nativeTerminalRead"]>>>
  >;
  nativeTerminalStop(
    id: string,
    sessionID?: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["nativeTerminalStop"]>>>
  >;
  nativeTerminalOpenHub(): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["nativeTerminalOpenHub"]>>>
  >;
  nativeTerminalRevokeApprovalScope(
    id: string,
    sessionID?: string,
  ): Promise<
    Awaited<
      ReturnType<
        NonNullable<RuntimeClient["nativeTerminalRevokeApprovalScope"]>
      >
    >
  >;
  nativeTerminalReleaseHumanControl(
    id: string,
    sessionID?: string,
  ): Promise<
    Awaited<
      ReturnType<
        NonNullable<RuntimeClient["nativeTerminalReleaseHumanControl"]>
      >
    >
  >;
  nativeTerminalBeginSecureInput(
    id: string,
    sessionID?: string,
  ): Promise<
    Awaited<
      ReturnType<NonNullable<RuntimeClient["nativeTerminalBeginSecureInput"]>>
    >
  >;
  nativeTerminalEndSecureInput(
    id: string,
    sessionID?: string,
  ): Promise<
    Awaited<
      ReturnType<NonNullable<RuntimeClient["nativeTerminalEndSecureInput"]>>
    >
  >;
  /**
   * Starts a native terminal session. A write: the host must enable terminal
   * writes (`terminalWrite: true`), otherwise this is refused. Remote callers
   * are model-side actors for ownership and secure-input arbitration.
   */
  nativeTerminalStart(
    input: Parameters<NonNullable<RuntimeClient["nativeTerminalStart"]>>[0],
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["nativeTerminalStart"]>>>
  >;
  /**
   * Writes input bytes (control bytes included) to a native terminal session.
   * Refused while a human holds input or secure input is active; a replayed
   * `idempotencyKey` answers `delivery: "duplicate"` instead of writing again.
   */
  nativeTerminalWrite(
    input: Parameters<NonNullable<RuntimeClient["nativeTerminalWrite"]>>[0],
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["nativeTerminalWrite"]>>>
  >;
  /** Resizes a native terminal session. Subject to the secure-input interlock. */
  nativeTerminalResize(
    input: Parameters<NonNullable<RuntimeClient["nativeTerminalResize"]>>[0],
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["nativeTerminalResize"]>>>
  >;
  /** Intelligence queries. Routed and reachable; answer empty until there are writers. */
  constitutionRules(
    sessionID?: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["constitutionRules"]>>>
  >;
  decisionRecords(
    sessionID?: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["decisionRecords"]>>>
  >;
  /** Records a durable decision fact (CST3 writer). */
  recordDecision(
    input: {
      decision: string;
      rationale?: string[];
      alternatives?: { option: string; rejectedReason?: string }[];
      consequences?: string[];
      linkedPlans?: string[];
      linkedConstraints?: string[];
    },
    sessionID?: string,
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["recordDecision"]>>>>;
  evidenceRecords(
    sessionID?: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["evidenceRecords"]>>>
  >;
  /** Runs a validation command and records the outcome as durable evidence. */
  recordValidation(
    input: {
      taskID: string;
      objective: string;
      command: string;
      timeoutSec?: number;
      knownGaps?: string[];
    },
    sessionID?: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["recordValidation"]>>>
  >;
  /** The completion cards, projected from the journal (P2 E4). */
  completions(
    sessionID?: string,
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["completions"]>>>>;
  /** Records a completion card and its validated_by Work Graph edges. */
  recordCompletion(
    input: {
      taskID: string;
      objective: string;
      changeSummary: string;
      behaviorImpact?: string;
      validations?: Array<{
        command: string;
        result: "passed" | "failed" | "skipped";
        safeSummary: string;
      }>;
      humanValidation?: string;
      knownGaps?: string[];
      externalSideEffects?: string[];
      rollbackState?: "clean" | "available" | "none" | "needs_promotion";
      evidenceIDs?: string[];
      changePaths?: string[];
    },
    sessionID?: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["recordCompletion"]>>>
  >;
  /** The durable Live Work Chat mailbox, projected from the journal. */
  mailboxList(
    sessionID?: string,
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["mailboxList"]>>>>;
  /** Enqueues a Live Work Chat intent as a durable mailbox message. */
  mailboxSend(input: {
    source?: "user_via_live_chat" | "system";
    priority?: "normal" | "high" | "urgent";
    intent: string;
    text: string;
    safeSummary?: string;
    relatedPlanID?: string;
    deliveryPolicy?: string;
    sessionID?: string;
  }): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["mailboxSend"]>>>>;
  /** Marks a queued mailbox message delivered at a safe boundary. */
  mailboxDeliver(
    messageID: string,
    sessionID?: string,
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["mailboxDeliver"]>>>>;
  /** Acknowledges a delivered mailbox message. */
  mailboxAcknowledge(
    messageID: string,
    sessionID?: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["mailboxAcknowledge"]>>>
  >;
  /** Defers a queued mailbox message with a safe reason. */
  mailboxDefer(
    messageID: string,
    reason?: string,
    sessionID?: string,
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["mailboxDefer"]>>>>;
  /** Supersedes a queued mailbox message with a safe reason. */
  mailboxSupersede(
    messageID: string,
    reason?: string,
    sessionID?: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["mailboxSupersede"]>>>
  >;
  /** Lists persisted workspace plan documents (P8 C4 replacement). */
  planDocList(
    sessionID?: string,
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["planDocList"]>>>>;
  /** Reads a Markdown plan document by planID or path. */
  planDocRead(input: {
    planID?: string;
    path?: string;
    sessionID?: string;
  }): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["planDocRead"]>>>>;
  /** Writes a Markdown plan document inside `.natalia/plans/`. */
  planDocWrite(input: {
    path: string;
    content: string;
    title?: string;
    planID?: string;
    sessionID?: string;
  }): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["planDocWrite"]>>>>;
  /** Marks a plan document as a formal Plan and returns its stable planID. */
  planDocMark(input: {
    path: string;
    title?: string;
    sessionID?: string;
  }): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["planDocMark"]>>>>;
  /** Deletes a plan registry record (does not delete the Markdown file). */
  planDocDelete(
    planID: string,
    sessionID?: string,
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["planDocDelete"]>>>>;
  /** Reads the current lifecycle status of a marked plan. */
  planDocStatus(
    planID: string,
    sessionID?: string,
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["planDocStatus"]>>>>;
  /** Updates a plan document lifecycle status. */
  planDocUpdateStatus(input: {
    planID: string;
    status: string;
    sessionID?: string;
  }): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["planDocUpdateStatus"]>>>
  >;
  /** Reads the session-scoped active plan pointer. */
  planDocActive(
    sessionID?: string,
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["planDocActive"]>>>>;
  /** Sets the session-scoped active plan pointer. */
  planDocActivate(
    planID: string,
    sessionID?: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["planDocActivate"]>>>
  >;
  /** Clears the session-scoped active plan pointer. */
  planDocDeactivate(
    sessionID?: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["planDocDeactivate"]>>>
  >;
  driftFindings(
    sessionID?: string,
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["driftFindings"]>>>>;
  /** Runs the DriftEvaluator against safe signals and publishes findings. */
  evaluateDrift(
    input: {
      objective: string;
      currentActivity: string;
      applicableConstraints?: string[];
      changes?: Array<{
        path?: string;
        action?: string;
        target?: string;
        summary?: string;
      }>;
      evidenceRefs?: string[];
    },
    sessionID?: string,
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["evaluateDrift"]>>>>;
  /** Acknowledges an open drift finding (P7 D3). */
  acknowledgeDriftFinding(
    input: {
      findingID: string;
      status: "explained" | "dismissed" | "corrected";
      rationale?: string;
    },
    sessionID?: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["acknowledgeDriftFinding"]>>>
  >;
  /** Reconciles watcher hints and returns the confirmed changes (WG4 Phase 3). */
  confirmedWorkspaceChanges(
    sessionID?: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["confirmedWorkspaceChanges"]>>>
  >;
  /** Returns the object-store backed global workspace diff. */
  workspaceDiff(input?: {
    workspaceID?: string;
    includePatch?: boolean;
  }): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["workspaceDiff"]>>>>;
  /** Returns the git backed workspace diff for optional ref/worktree ranges. */
  workspaceGitDiff(input?: {
    workspaceID?: string;
    from?: string;
    to?: string;
    path?: string;
  }): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["workspaceGitDiff"]>>>
  >;
  /** Lists branches, tags and worktrees for Git diff selection. */
  gitRefs(input?: {
    workspaceID?: string;
  }): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["gitRefs"]>>>>;
  /** Lists the current session's sandboxed sub-agent PRs. */
  teamPRList(
    sessionID?: string,
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["teamPRList"]>>>>;
  registeredTools(
    sessionID?: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["registeredTools"]>>>
  >;
  projectionContributions(input?: {
    workspaceID?: string;
  }): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["projectionContributions"]>>>
  >;
  requestOverride(
    input: Parameters<NonNullable<RuntimeClient["requestOverride"]>>[0],
    sessionID?: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["requestOverride"]>>>
  >;
  approveOverride(
    input: Parameters<NonNullable<RuntimeClient["approveOverride"]>>[0],
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["approveOverride"]>>>
  >;
  /** Loaded capability records, distinct from `availability()` (what is implemented). */
  capabilities(input?: {
    workspaceID?: string;
  }): Promise<Awaited<ReturnType<NonNullable<RuntimeClient["capabilities"]>>>>;
  sessionSnapshot(
    sessionID?: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeClient["sessionSnapshot"]>>>
  >;
  /** Submits a turn with attachments, resources and agent mentions. */
  submitInput(
    input: import("@anthelia/contracts").SubmitInput,
  ): Promise<import("@anthelia/contracts").SubmittedTurn>;
  /**
   * Cancels a queued inbox input that has not started. Refusal is a value:
   * removing something already claimed returns `ok: false`.
   */
  removeInput(
    input: import("@anthelia/contracts").InputTarget,
  ): Promise<import("@anthelia/contracts").InputMutationResult>;
  /** Edits the text of a queued inbox input that has not started. */
  replaceInput(
    input: import("@anthelia/contracts").InputTarget & { text: string },
  ): Promise<import("@anthelia/contracts").InputMutationResult>;
  /** Promotes a queued `next-turn` input so the running turn claims it. */
  promoteInput(
    input: import("@anthelia/contracts").InputTarget,
  ): Promise<import("@anthelia/contracts").InputMutationResult>;
  /** Writes a config patch (the TUI settings menu path) and applies it. */
  updateConfig(input: {
    patch: Record<string, unknown>;
    scope?: "project" | "global";
  }): Promise<{ applied: boolean; reason?: string }>;
  /** Reads the effective interface-preference settings and their sources. */
  settingsGet(): Promise<{
    config: Record<string, unknown>;
    sources: Array<{
      scope: "defaults" | "global" | "project";
      path?: string;
      applied: boolean;
      diagnostic?: string;
    }>;
  }>;
  /** Writes an interface-preference patch to the given scope's file. */
  settingsSet(
    patch: Record<string, unknown>,
    scope: "global" | "project",
  ): Promise<{ applied: boolean }>;
  /**
   * What this runtime implements: the required members it has, which capability
   * groups are complete, and which queries answer with nothing because their facts
   * have no producer yet. Ask this instead of feature-detecting member by member —
   * it is the only way to tell "not supported" from "not implemented yet" from
   * "nothing recorded".
   */
  /**
   * Applies the configuration on disk. Refusal is a value, not an exception: a
   * turn running or a prompt pending is an ordinary reason to be told "not now",
   * and re-checked at the moment of application rather than trusted from
   * `canReloadConfig()`, which a turn can invalidate between the two calls.
   */
  reloadConfig(): Promise<{ applied: boolean; reason?: string }>;
  canReloadConfig(): Promise<{ allowed: boolean; reason?: string }>;
  availability(): Promise<
    import("@anthelia/contracts").RuntimeCapabilityReport
  >;
  runtimeStatus(
    sessionID?: string,
  ): Promise<import("@anthelia/contracts").RuntimeStatusSnapshot>;
  diagnostics(
    limit?: number,
    sessionID?: string,
  ): Promise<import("@anthelia/contracts").RuntimeDiagnostic[]>;
  health(): Promise<{ ok: boolean; apiVersion: number }>;
  events(options?: {
    since?: number;
    signal?: AbortSignal;
  }): AsyncIterable<RuntimeEvent>;
};

export function createNataliaSDK(options: NataliaSDKOptions): NataliaSDK {
  const baseURL = options.baseURL.replace(/\/+$/u, "");
  const fetchImpl = options.fetch ?? fetch;
  let nextID = 1;
  let versionCheck: Promise<void> | undefined;

  /**
   * One check per SDK instance, before the first call: ask /healthz what API
   * version this runtime speaks, and refuse to guess when it is newer than
   * this SDK knows. A consumer that keeps going would silently misread a
   * changed protocol; the error names both versions instead.
   */
  async function ensureProtocolVersion() {
    try {
      const response = await fetchImpl(`${baseURL}/healthz`);
      if (!response.ok)
        throw new Error(`protocol check failed: ${response.status}`);
      const body = (await response.json()) as { apiVersion?: number };
      const serverVersion = body.apiVersion;
      if (typeof serverVersion === "number" && serverVersion > API_VERSION)
        throw new RuntimeVersionMismatchError({
          serverVersion,
          supportedVersion: API_VERSION,
        });
    } catch (error) {
      // A version mismatch is permanent; a failed probe is not. Only the
      // former stays cached, so a transient network blip does not poison the
      // SDK for the rest of its life.
      if (error instanceof RuntimeVersionMismatchError) throw error;
      versionCheck = undefined;
      throw error;
    }
  }

  async function call<T>(method: string, params: Record<string, unknown>) {
    versionCheck ??= ensureProtocolVersion();
    await versionCheck;
    const response = await fetchImpl(`${baseURL}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextID++, method, params }),
    });
    const body = (await response.json()) as {
      result?: T;
      error?: {
        code: number;
        message: string;
        data?: import("@anthelia/contracts").RuntimeFailureData;
      };
    };
    // A failure arrives as a `RuntimeRPCError` carrying the JSON-RPC code and its
    // structured data, so a consumer can tell "this runtime cannot do it" from
    // "my arguments are wrong" from "policy says no" with `failureKind(error)`
    // instead of matching on message text.
    if (body.error)
      throw new RuntimeRPCError({
        code: body.error.code,
        message: body.error.message,
        method,
        data: body.error.data,
      });
    if (!response.ok) throw new Error(`SDK request failed: ${response.status}`);
    return body.result as T;
  }
  return {
    prompt: async (text, promptOptions = {}) =>
      await call<SubmittedTurn>("prompt", { text, ...promptOptions }),
    cancel: async (reason) => {
      await call("cancel", reason ? { reason } : {});
    },
    pause: async (reason, sessionID) =>
      await call("pause", {
        ...(reason ? { reason } : {}),
        ...(sessionID ? { sessionID } : {}),
      }),
    resume: async (sessionID) =>
      await call("resume", sessionID ? { sessionID } : {}),
    selectAgent: async (name, sessionID) =>
      await call("agent.select", {
        ...(name === undefined ? {} : { name }),
        ...(sessionID ? { sessionID } : {}),
      }),
    agents: async (input) => await call("agent.list", input ?? {}),
    modelCatalog: async (input) => await call("model.catalog", input ?? {}),
    modelSelection: async (sessionID) =>
      await call("model.selection", sessionID ? { sessionID } : {}),
    setDefaultModel: async (modelID) =>
      await call("model.setDefault", { modelID }),
    selectModel: async (modelID, variant, sessionID) => {
      await call("model.select", {
        ...(modelID === undefined ? {} : { modelID }),
        ...(variant === undefined ? {} : { variant }),
        ...(sessionID ? { sessionID } : {}),
      });
    },
    reasoningEffort: async (sessionID) =>
      (await call("model.reasoning", sessionID ? { sessionID } : {})) ??
      undefined,
    setReasoningEffort: async (effort, sessionID) => {
      await call("model.reasoning.set", {
        ...(effort === undefined ? {} : { effort }),
        ...(sessionID ? { sessionID } : {}),
      });
    },
    skills: async (input) => await call("skills.list", input ?? {}),
    workspaceFiles: async (input = {}) => await call("workspace.files", input),
    workspaceSearch: async (input) => await call("workspace.search", input),
    workspaceList: async (input = {}) => await call("workspace.list", input),
    workspaceRead: async (input) => await call("workspace.read", input),
    resourceRead: async (input) => await call("resource.read", input),
    workspaceGlob: async (input) => await call("workspace.glob", input),
    workspaceWriteConflicts: async (input) =>
      await call("workspace.writeConflicts", input ?? {}),
    sessions: async () => await call("session.list", {}),
    touchSession: async (id) => {
      await call("session.touch", { id });
    },
    renameSession: async (id, title) =>
      await call("session.rename", { id, title }),
    newSession: async (input = {}) => await call("session.new", input),
    archiveSession: async (id) => await call("session.archive", { id }),
    exportSession: async (id) => await call("session.export", { id }),
    attachSession: async (id) => await call("session.attach", { id }),
    permissionList: async () => await call("permission.list", {}),
    permissionSave: async (input) => await call("permission.save", input),
    permissionDelete: async (name) => await call("permission.delete", { name }),
    mcpServerAdd: async (input) => await call("mcp.server.add", input),
    mcpServerRemove: async (name, workspaceID) =>
      await call("mcp.server.remove", {
        name,
        ...(workspaceID ? { workspaceID } : {}),
      }),
    createAgent: async (input) => await call("agent.create", input),
    updateAgent: async (input) => await call("agent.update", input),
    deleteAgent: async (name, workspaceID) =>
      await call("agent.delete", {
        name,
        ...(workspaceID ? { workspaceID } : {}),
      }),
    discoverProvider: async (input) => await call("provider.discover", input),
    addProvider: async (input) => await call("provider.add", input),
    removeProvider: async (name) => await call("provider.remove", { name }),
    unloadPlugin: async (id) => await call("plugin.unload", { name: id }),
    reloadPlugin: async (id) => await call("plugin.reload", { name: id }),
    pinSession: async (id, pinned) => await call("session.pin", { id, pinned }),
    duplicateSession: async (id, title) =>
      await call(
        "session.duplicate",
        title === undefined ? { id } : { id, title },
      ),
    forkSession: async (id, turnID, title) =>
      await call(
        "session.fork",
        title === undefined ? { id, turnID } : { id, turnID, title },
      ),
    deleteSession: async (id) => await call("session.delete", { id }),
    respondApproval: async (response) =>
      await call(
        "approval.respond",
        response as unknown as Record<string, unknown>,
      ),
    respondQuestion: async (response) =>
      await call(
        "question.respond",
        response as unknown as Record<string, unknown>,
      ),
    respondInteractive: async (response) =>
      await call("interactive.respond", response),
    pendingInteractive: async (input) =>
      await call("interactive.pending", input ?? {}),
    checkpoint: async () =>
      await call<SubmittedTurn>("prompt", { text: "/checkpoint" }),
    checkpoints: async (limit) =>
      await call<SubmittedTurn>("prompt", {
        text: limit ? `/checkpoints --limit ${limit}` : "/checkpoints",
      }),
    rollback: async (checkpointID, rollbackOptions = {}) =>
      await call<SubmittedTurn>("prompt", {
        text: `/rollback ${checkpointID}${rollbackOptions.dryRun ? " --dry-run" : ""}`,
      }),
    checkpointList: async (sessionID) =>
      await call("checkpoint.list", sessionID ? { sessionID } : {}),
    checkpointListByKind: async (kind, sessionID) =>
      await call("checkpoint.listByKind", {
        ...(kind ? { kind } : {}),
        ...(sessionID ? { sessionID } : {}),
      }),
    auditRounds: async (planID, workspaceID) =>
      await call("audit.rounds", {
        ...(planID ? { planID } : {}),
        ...(workspaceID ? { workspaceID } : {}),
      }),
    roundDiff: async (input) => await call("workspace.round.diff", input),
    checkpointPreview: async (id, sessionID, options) =>
      await call("checkpoint.preview", {
        id,
        ...(sessionID ? { sessionID } : {}),
        ...(options ? { options } : {}),
      }),
    checkpointRollback: async (input) =>
      await call("checkpoint.rollback", input),
    checkpointRename: async (input) => await call("checkpoint.rename", input),
    sandboxList: async (sessionID) =>
      await call("sandbox.list", sessionID ? { sessionID } : {}),
    sandboxDiff: async (id, sessionID, options) =>
      await call("sandbox.diff", {
        id,
        ...(sessionID ? { sessionID } : {}),
        ...(options ? { options } : {}),
      }),
    sandboxResources: async (id, sessionID) =>
      await call("sandbox.resources", {
        id,
        ...(sessionID ? { sessionID } : {}),
      }),
    sandboxResourceOutput: async (input) =>
      await call("sandbox.resource.output", input),
    sandboxMerge: async (id, sessionID) =>
      await call("sandbox.merge", { id, ...(sessionID ? { sessionID } : {}) }),
    sandboxDelete: async (id, sessionID) =>
      await call("sandbox.delete", { id, ...(sessionID ? { sessionID } : {}) }),
    sandboxResourceStop: async (input) =>
      await call("sandbox.resource.stop", input),
    snapshot: async (input) =>
      await call<RuntimeEvent>("snapshot", input ?? {}),
    history: async (historyOptions = {}) =>
      await call("session.history", historyOptions),
    messages: async (messageOptions = {}) =>
      await call("session.messages", messageOptions),
    mcpCatalog: async (input) => await call("mcp.catalog", input ?? {}),
    mcpPrompt: async (server, name, arguments_ = {}, workspaceID) =>
      await call("mcp.prompt", {
        server,
        name,
        arguments: arguments_,
        ...(workspaceID ? { workspaceID } : {}),
      }),
    mcpResource: async (server, uri, workspaceID) =>
      await call("mcp.resource", {
        server,
        uri,
        ...(workspaceID ? { workspaceID } : {}),
      }),
    plugins: async () => await call("plugin.list", {}),
    pluginInstall: async (input) => await call("plugin.install", input),
    pluginUninstall: async (input) => await call("plugin.uninstall", input),
    pluginSetEnabled: async (input) => await call("plugin.set-enabled", input),
    pluginCatalog: async () => await call("plugin.catalog", {}),
    commandCatalog: async (input) => await call("command.catalog", input ?? {}),
    commandExecute: async (input) => {
      await call("command.execute", input);
    },
    workGraphNodes: async (input) => await call("workgraph.nodes", input ?? {}),
    workGraphEdges: async (input) => await call("workgraph.edges", input ?? {}),
    nativeTerminalList: async (sessionID) =>
      await call("nativeTerminal.list", sessionID ? { sessionID } : {}),
    nativeTerminalRead: async (id) => await call("nativeTerminal.read", { id }),
    nativeTerminalStop: async (id) => await call("nativeTerminal.stop", { id }),
    nativeTerminalOpenHub: async () => await call("nativeTerminal.openHub", {}),
    nativeTerminalRevokeApprovalScope: async (id, sessionID) =>
      await call("nativeTerminal.revokeApprovalScope", {
        id,
        ...(sessionID ? { sessionID } : {}),
      }),
    nativeTerminalReleaseHumanControl: async (id, sessionID) =>
      await call("nativeTerminal.releaseHumanControl", {
        id,
        ...(sessionID ? { sessionID } : {}),
      }),
    nativeTerminalBeginSecureInput: async (id, sessionID) =>
      await call("nativeTerminal.beginSecureInput", {
        id,
        ...(sessionID ? { sessionID } : {}),
      }),
    nativeTerminalEndSecureInput: async (id, sessionID) =>
      await call("nativeTerminal.endSecureInput", {
        id,
        ...(sessionID ? { sessionID } : {}),
      }),
    nativeTerminalStart: async (input) =>
      await call("nativeTerminal.start", input),
    nativeTerminalWrite: async (input) =>
      await call("nativeTerminal.write", input),
    nativeTerminalResize: async (input) =>
      await call("nativeTerminal.resize", input),
    constitutionRules: async (sessionID) =>
      await call("constitution.rules", sessionID ? { sessionID } : {}),
    decisionRecords: async (sessionID) =>
      await call("decision.records", sessionID ? { sessionID } : {}),
    recordDecision: async (input, sessionID) =>
      await call("decision.record", {
        decision: input.decision,
        rationale: input.rationale ?? [],
        alternatives: input.alternatives ?? [],
        consequences: input.consequences ?? [],
        linkedPlans: input.linkedPlans ?? [],
        linkedConstraints: input.linkedConstraints ?? [],
        ...(sessionID ? { sessionID } : {}),
      }),
    evidenceRecords: async (sessionID) =>
      await call("evidence.records", sessionID ? { sessionID } : {}),
    recordValidation: async (input, sessionID) =>
      await call("evidence.record", {
        taskID: input.taskID,
        objective: input.objective,
        command: input.command,
        timeoutSec: input.timeoutSec,
        knownGaps: input.knownGaps ?? [],
        ...(sessionID ? { sessionID } : {}),
      }),
    completions: async (sessionID) =>
      await call("completion.records", sessionID ? { sessionID } : {}),
    recordCompletion: async (input, sessionID) =>
      await call("completion.record", {
        taskID: input.taskID,
        objective: input.objective,
        changeSummary: input.changeSummary,
        behaviorImpact: input.behaviorImpact,
        validations: input.validations ?? [],
        humanValidation: input.humanValidation,
        knownGaps: input.knownGaps ?? [],
        externalSideEffects: input.externalSideEffects ?? [],
        rollbackState: input.rollbackState,
        evidenceIDs: input.evidenceIDs ?? [],
        changePaths: input.changePaths ?? [],
        ...(sessionID ? { sessionID } : {}),
      }),
    mailboxList: async (sessionID) =>
      await call("mailbox.list", sessionID ? { sessionID } : {}),
    mailboxSend: async (input) =>
      await call("mailbox.send", {
        source: input.source,
        priority: input.priority,
        intent: input.intent,
        text: input.text,
        safeSummary: input.safeSummary,
        relatedPlanID: input.relatedPlanID,
        deliveryPolicy: input.deliveryPolicy,
        ...(input.sessionID ? { sessionID: input.sessionID } : {}),
      }),
    mailboxDeliver: async (messageID, sessionID) =>
      await call("mailbox.deliver", {
        messageID,
        ...(sessionID ? { sessionID } : {}),
      }),
    mailboxAcknowledge: async (messageID, sessionID) =>
      await call("mailbox.acknowledge", {
        messageID,
        ...(sessionID ? { sessionID } : {}),
      }),
    mailboxDefer: async (messageID, reason, sessionID) =>
      await call("mailbox.defer", {
        messageID,
        reason,
        ...(sessionID ? { sessionID } : {}),
      }),
    mailboxSupersede: async (messageID, reason, sessionID) =>
      await call("mailbox.supersede", {
        messageID,
        reason,
        ...(sessionID ? { sessionID } : {}),
      }),
    planDocList: async (sessionID) =>
      await call("planDoc.list", sessionID ? { sessionID } : {}),
    planDocRead: async (input) =>
      await call("planDoc.read", {
        planID: input.planID,
        path: input.path,
        ...(input.sessionID ? { sessionID: input.sessionID } : {}),
      }),
    planDocWrite: async (input) =>
      await call("planDoc.write", {
        path: input.path,
        content: input.content,
        title: input.title,
        planID: input.planID,
        ...(input.sessionID ? { sessionID: input.sessionID } : {}),
      }),
    planDocMark: async (input) =>
      await call("planDoc.mark", {
        path: input.path,
        title: input.title,
        ...(input.sessionID ? { sessionID: input.sessionID } : {}),
      }),
    planDocDelete: async (planID, sessionID) =>
      await call("planDoc.delete", {
        planID,
        ...(sessionID ? { sessionID } : {}),
      }),
    planDocStatus: async (planID, sessionID) =>
      await call("planDoc.status", {
        planID,
        ...(sessionID ? { sessionID } : {}),
      }),
    planDocUpdateStatus: async (input) =>
      await call("planDoc.updateStatus", {
        planID: input.planID,
        status: input.status,
        ...(input.sessionID ? { sessionID: input.sessionID } : {}),
      }),
    planDocActive: async (sessionID) =>
      await call("planDoc.active", sessionID ? { sessionID } : {}),
    planDocActivate: async (planID, sessionID) =>
      await call("planDoc.activate", {
        planID,
        ...(sessionID ? { sessionID } : {}),
      }),
    planDocDeactivate: async (sessionID) =>
      await call("planDoc.deactivate", sessionID ? { sessionID } : {}),
    driftFindings: async (sessionID) =>
      await call("drift.findings", sessionID ? { sessionID } : {}),
    evaluateDrift: async (input, sessionID) =>
      await call("drift.evaluate", {
        objective: input.objective,
        currentActivity: input.currentActivity,
        applicableConstraints: input.applicableConstraints ?? [],
        changes: input.changes ?? [],
        evidenceRefs: input.evidenceRefs ?? [],
        ...(sessionID ? { sessionID } : {}),
      }),
    acknowledgeDriftFinding: async (input, sessionID) =>
      await call("drift.acknowledge", {
        findingID: input.findingID,
        status: input.status,
        rationale: input.rationale,
        ...(sessionID ? { sessionID } : {}),
      }),
    confirmedWorkspaceChanges: async (sessionID) =>
      await call("observation.confirmed", sessionID ? { sessionID } : {}),
    workspaceDiff: async (input) => await call("workspace.diff", input ?? {}),
    workspaceGitDiff: async (input) =>
      await call("workspace.git.diff", input ?? {}),
    gitRefs: async (input) => await call("git.refs", input ?? {}),
    teamPRList: async (sessionID) =>
      await call("team.pr.list", sessionID ? { sessionID } : {}),
    registeredTools: async (sessionID) =>
      await call("tools.registered", sessionID ? { sessionID } : {}),
    projectionContributions: async (input) =>
      await call("projections.list", input ?? {}),
    requestOverride: async (input, sessionID) =>
      await call("constitution.override.request", {
        ...input,
        ...(sessionID ? { sessionID } : {}),
      }),
    approveOverride: async (input) =>
      await call("constitution.override.approve", input),
    capabilities: async (input) => await call("capabilities", input ?? {}),
    sessionSnapshot: async (sessionID) =>
      await call("session.snapshot", sessionID ? { sessionID } : {}),
    submitInput: async (input) => await call("submit.input", input),
    removeInput: async (input) => await call("input.remove", input),
    replaceInput: async (input) => await call("input.replace", input),
    promoteInput: async (input) => await call("input.promote", input),
    updateConfig: async (input) => await call("config.update", input),
    settingsGet: async () => await call("settings.get", {}),
    settingsSet: async (patch, scope) =>
      await call("settings.set", { patch, scope }),
    reloadConfig: async () => await call("config.reload", {}),
    canReloadConfig: async () => await call("config.canReload", {}),
    availability: async () => await call("runtime.availability", {}),
    runtimeStatus: async (sessionID) =>
      await call("runtime.status", sessionID ? { sessionID } : {}),
    diagnostics: async (limit, sessionID) =>
      await call(
        "diagnostics.list",
        limit === undefined
          ? sessionID
            ? { sessionID }
            : {}
          : sessionID
            ? { limit, sessionID }
            : { limit },
      ),
    health: async () => {
      const response = await fetchImpl(`${baseURL}/healthz`);
      if (!response.ok) throw new Error(`health failed: ${response.status}`);
      return (await response.json()) as { ok: boolean; apiVersion: number };
    },
    events: (eventOptions = {}) =>
      eventStream({
        baseURL,
        fetchImpl,
        token: options.token,
        ...eventOptions,
      }),
  };
}

async function* eventStream(input: {
  baseURL: string;
  fetchImpl: typeof fetch;
  token?: string;
  since?: number;
  signal?: AbortSignal;
}): AsyncIterable<RuntimeEvent> {
  const response = await input.fetchImpl(
    `${input.baseURL}/events${input.since !== undefined ? `?since=${input.since}` : ""}`,
    {
      headers: input.token ? { authorization: `Bearer ${input.token}` } : {},
      signal: input.signal,
    },
  );
  if (!response.ok) throw new Error(`events failed: ${response.status}`);
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const event = parseRuntimeEvent(part);
        if (event) yield event;
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function parseRuntimeEvent(part: string) {
  for (const line of part.split("\n")) {
    if (!line.startsWith("data:")) continue;
    return JSON.parse(line.slice("data:".length).trim()) as RuntimeEvent;
  }
  return undefined;
}
