/**
 * The contract a tool implements, and the context it is handed.
 *
 * Kept in its own module so a tool family can depend on the contract without
 * depending on the barrel that assembles every family — the alternative is every
 * file importing types from `index.ts` while `index.ts` imports them back.
 *
 * `ToolExecutionBoundary` is the policy-relevant part: a name, whether the action
 * needs a human's approval, and how long it may run. It is separate from the
 * implementation so a caller can reason about what a tool is allowed to do without
 * holding the code that does it.
 */
import type {
  ConfinementMode,
  EscalationApprover,
} from "@anthelia/confinement";
import type {
  ExecutionTarget,
  RuntimeEvent,
  RuntimeTerminalRead,
  SandboxDiffKind,
  SandboxStatus,
  ToolCard,
} from "@anthelia/contracts";

export type SubagentStatusView =
  | "idle"
  | "running"
  | "paused"
  | "stopped"
  | "completed"
  | "failed";

export type SubagentPhaseView =
  | "idle"
  | "queued"
  | "provider"
  | "tool"
  | "retrying"
  | "finalizing"
  | "waiting";

export type SubagentOutputView = {
  step: number;
  text: string;
  timestamp: number;
};

export type SubagentRecordView = {
  id: string;
  task: string;
  mode: string;
  /** Configured agent this subagent was spawned as, when any. */
  agentType?: string;
  /** Whether the subagent inherits its parent's conversation. */
  context?: "fresh" | "fork";
  /** Messages queued for delivery when the subagent next starts. */
  pendingMessages?: string[];
  status: SubagentStatusView;
  attached: boolean;
  modelProfile: string;
  allowedTools: string[];
  excludeTools: string[];
  writePaths?: string[];
  outputs: SubagentOutputView[];
  createdAt: number;
  updatedAt: number;
  parentSessionID?: string;
  parentAgentID?: string;
  continuation?: number;
  phase: SubagentPhaseView;
  lastActivityAt: number;
  activityDetail: string;
  startedAt: number;
  endedAt?: number;
  /**
   * The child's accumulated usage, persisted on its record. Optional: a
   * record written before the usage existed reads as "none recorded yet".
   */
  usage?: SubagentUsageView;
  /** The child's last context projection, persisted on its record. */
  contextSnapshot?: {
    usedTokens: number;
    contextWindow?: number;
    pressureTokens?: number;
    projectedTokens?: number;
    systemTokens?: number;
    toolsTokens?: number;
    messageTokens?: number;
    source: string;
    at: string;
  };
};

/** One subagent's accumulated usage — the fields the agent bars read. */
export type SubagentUsageView = {
  turns: number;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  llmMs: number;
  ttftMs: number;
  ttftSteps: number;
  decodeMs: number;
  toolMs: number;
};

export type SubagentEventView = {
  agentId: string;
  event: string;
  status: string;
  attached: boolean;
  text?: string;
  timestamp: number;
  parentSessionID?: string;
  parentAgentID?: string;
  continuation?: number;
  phase?: SubagentPhaseView;
  activityDetail?: string;
  stopReason?: string;
  requestedBy?: "model" | "user" | "parent" | "runtime";
  force?: boolean;
};

export type SubagentSpawnOptions = {
  mode?: string;
  /** Whether the child inherits the parent's conversation. Defaults to fresh. */
  context?: "fresh" | "fork";
  modelProfile?: string;
  allowedTools?: string[];
  excludeTools?: string[];
  writePaths?: string[];
  signal?: AbortSignal;
  parentSessionID?: string;
  parentAgentID?: string;
  maxDepth?: number;
};

export type SubagentStopResult =
  | { outcome: "stopped"; id: string }
  | { outcome: "not_found"; id: string }
  | { outcome: "not_running"; id: string; status: SubagentStatusView }
  | {
      outcome: "protected";
      id: string;
      health: "active" | "quiet";
      retryAfterMs: number;
    };

export type SubagentRunnerContext = {
  agentId: string;
  log(text: string): void;
  setStatus(status: string): void;
  signal: AbortSignal;
  reportActivity(phase: SubagentPhaseView, detail: string): void;
  /** The child's live channel to its spawning session. */
  sendToParent(text: string): void;
};

/** Operational subagent surface consumed by tools and hosts. */
export type SubagentToolService = {
  spawn(
    task: string,
    options?: SubagentSpawnOptions,
  ): Promise<SubagentRecordView>;
  list(): SubagentRecordView[];
  runningCount(): number;
  get(id: string): SubagentRecordView | undefined;
  status(id: string): SubagentStatusView | undefined;
  health(id: string): "active" | "quiet" | "stalled" | "terminal";
  requestStop(id: string, reason: string, force?: boolean): SubagentStopResult;
  stop(id: string): boolean;
  resume(id: string): Promise<boolean>;
  /** Replace the messages queued for a subagent. */
  setPendingMessages(id: string, messages: string[]): boolean;
  /**
   * Accumulates one provider step's usage into the child's DURABLE bucket.
   *
   * The live events a child publishes carry its `agentID` and fold into its
   * isolated view state, but the event sink keeps `agentID`-tagged events out
   * of the parent's journal by design — so without this the numbers died
   * with the process and the pane read zeroes after any restart. The bucket
   * is persisted with the record and hydrated on attach.
   */
  recordSubagentUsage(id: string, delta: Partial<SubagentUsageView>): boolean;
  /**
   * Reads the child's durable conversation checkpoint, or undefined when it
   * has none. Optional: a backend without durable ledgers answers undefined
   * and every continuation starts fresh.
   */
  loadLedger?(id: string): Promise<unknown>;
  /** Persists the child's durable conversation checkpoint. */
  saveLedger?(id: string, checkpoint: unknown): Promise<void>;
  /** Records the child's last context projection on its durable record. */
  recordSubagentContext(
    id: string,
    snapshot: {
      usedTokens: number;
      contextWindow?: number;
      pressureTokens?: number;
      projectedTokens?: number;
      systemTokens?: number;
      toolsTokens?: number;
      messageTokens?: number;
      source: string;
      at: string;
    },
  ): boolean;
  /**
   * Deliver a parent message to a subagent, routing by its live state.
   * Rejects a caller that is not the subagent's parent.
   */
  sendMessage(
    id: string,
    message: string,
    callerSession?: string,
  ): Promise<{ route: string }>;
  retry(id: string): Promise<SubagentRecordView | undefined>;
  attach(id: string): boolean;
  detach(id: string): boolean;
  cleanup(dryRun?: boolean): string[];
  audit(tail?: number, format?: string): string;
  subscribe(fn: (event: SubagentEventView) => void): () => void;
  formatList(): Promise<string>;
  formatOutput(id: string, verbose?: boolean): Promise<string>;
  formatStatus(id: string): Promise<string>;
  wait(
    ids: string[],
    until: "all_terminal" | "any_terminal",
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<
    Record<string, { status: SubagentStatusView; phase: SubagentPhaseView }>
  >;
};

export type TerminalSessionView = {
  id: string;
  host: "wezterm" | "pty";
  paneID: number;
  windowID: number;
  muxWindowID: number;
  tabID: number;
  command: string;
  cwd: string;
  status: "running" | "exited";
  startedAt: string;
};

/** Operational terminal surface consumed by tools, independent of its backend. */
export type TerminalToolService = {
  start(input: {
    command: string;
    cwd: string;
    id?: string;
    sessionID?: string;
  }): Promise<TerminalSessionView>;
  list(): TerminalSessionView[] | Promise<TerminalSessionView[]>;
  /**
   * Reclaim the exited panes that have been idle past the TTL (P2-19),
   * returning the ids it dropped. Optional: a backend that does not own pane
   * lifetimes (wezterm) leaves it out and the tool says so.
   */
  collectExited?(input: { maxIdleMinutes: number }): Promise<string[]>;
  reconcile(): Promise<TerminalSessionView[]>;
  read(
    id: string,
    options?: {
      maxLines?: number;
      startLine?: number;
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
  /**
   * The command-level read.
   *
   * Optional, because not every backend can answer it: the pty-backed controller
   * reads the shell-integration markers out of its own stream, while the mux
   * facade drives a pane in another process whose command lifecycle it never
   * sees. A caller must treat absence as "this pane cannot tell you".
   */
  lastCommand?(
    id: string,
    options?: { sessionID?: string },
  ): {
    commandLine: string | undefined;
    exitCode: number | undefined;
    atPrompt: boolean;
    output: string | undefined;
    revision: number;
    /**
     * Whether this pane's shell emits the shell-integration markers this
     * read is folded from ("markers"), or never has ("missed"). A missed
     * pane still runs commands; the answer names the difference instead of
     * claiming nothing ran.
     */
    integration?: "markers" | "missed";
    /** The pane's last non-empty screen line, when there is one. */
    screenTail?: string;
  };
  snapshot(id: string): Promise<{
    text: string;
    cursorX: number;
    cursorY: number;
    rows: number;
    cols: number;
    revision: number;
    status: "running" | "exited";
    inputOwner: "model" | "human";
    highlightRanges: unknown[];
  }>;
  observe(
    id: string,
    afterRevision: number,
    options?: { maxLines?: number; timeoutMs?: number },
  ): Promise<{
    session: { revision: number };
    text: string;
    cursorX: number;
    cursorY: number;
    rows: number;
    cols: number;
    afterRevision: number;
    changed: boolean;
    reason: "exited" | "screen_changed" | "session_activity" | "timeout";
  }>;
  session(id: string): { lastObservedText?: string };
  markObserved(id: string, text: string, revision: number): void;
  /** The revision the model last observed (the observe default's base). */
  lastObservedRevision(id: string): number | undefined;
  write(
    id: string,
    value: string,
    options?: { idempotencyKey?: string; sessionID?: string },
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
  ): Promise<TerminalSessionView>;
  requestHuman(
    id: string,
    reason: string,
    sessionID?: string,
  ): Promise<TerminalSessionView>;
  stop(
    id: string,
    actor: "model" | "human" | "system",
    sessionID?: string,
  ): Promise<TerminalSessionView>;
};

export type SandboxChangeView = {
  kind: SandboxDiffKind;
  path: string;
  oldPath?: string;
  mode?: string;
  content?: string;
  patch?: string;
  before?: string;
  after?: string;
  additions?: number;
  deletions?: number;
  structured?: import("@anthelia/contracts").RuntimeStructuredDiff;
};

export type SandboxManifestView = {
  id: string;
  root: string;
  isolationLevel: "workspace" | "container" | "vm";
  changedFiles: SandboxChangeView[];
  runningResources: string[];
  envAllowlist: string[];
};

export type SandboxResourceView = {
  id: string;
  sandboxID: string;
  command: string;
  pid: number;
  status: "running" | "exited" | "failed" | "stopped";
  outputPath: string;
  startedAt: string;
  endedAt?: string;
};

/** Operational sandbox surface consumed by tools, independent of its backend. */
export type SandboxToolService = {
  create(id: string): Promise<SandboxManifestView>;
  list(): Promise<SandboxManifestView[]>;
  /**
   * Collect the sandboxes the TTL and the cap name (P2-18), returning the ids
   * it deleted. A sandbox with unmerged changes or running resources is never
   * collected.
   */
  collectIdle(input: {
    maxIdleHours: number;
    maxSandboxes?: number;
  }): Promise<string[]>;
  execute(
    id: string,
    command: string,
    options?: { signal?: AbortSignal; env?: NodeJS.ProcessEnv },
  ): Promise<{
    exitCode: number;
    output: string;
    target: ExecutionTarget;
    /**
     * What the sandbox actually did, when the run was confined: the mode
     * requested and whether the runner declined before the command could
     * run. Reported independently of the exit code, so a caller never has
     * to tell "the command failed" from "the policy refused" from "the
     * sandbox could not run at all" by guessing.
     */
    sandbox?: { mode: ConfinementMode; runnerFailed: boolean };
  }>;
  write(
    id: string,
    path: string,
    content: string,
    mode?: string,
  ): Promise<void>;
  previewMerge(id: string): Promise<SandboxChangeView[]>;
  merge(
    id: string,
    hostRoot: string,
    authorize?: (paths: string[]) => Promise<void>,
  ): Promise<SandboxChangeView[]>;
  promoteWithValidation(
    id: string,
    input: {
      command: string;
      authorize?: (paths: string[]) => Promise<void>;
      hostRoot?: string;
    },
  ): Promise<{
    sandboxID: string;
    changedFiles: SandboxChangeView[];
    lastKnownGood?: string;
    /**
     * The gate's own result. The caller used to run the same command once
     * more before calling this — which paid for the validation twice and let
     * the first run's build output survive the artifact cleanup as a
     * "before" path — so the promotion now reports the one run it did.
     */
    validation: { ok: boolean; exitCode: number; output: string };
  }>;
  delete(id: string): Promise<{
    /** The operation's own fact: the sandbox is gone (this call deleted it). */
    deleted: boolean;
    /**
     * The pending changes that died with the sandbox — the fact a caller
     * needs before approving the deletion: an unmerged candidate's work is
     * discarded here, not merged (T-10).
     */
    discardedChanges: number;
    discardedPaths: string[];
    /** The full change list the discard refers to. */
    pendingChanges: SandboxChangeView[];
    runningResources: string[];
  }>;
  /**
   * Undoes one sandbox's promotion, restoring the host to what it was before.
   *
   * `restored: false` means there was nothing to undo — no recorded rollback
   * point, or the recorded one belongs to a different sandbox. A backend that
   * cannot reach a rollback point says false rather than reporting a success it
   * did not achieve.
   */
  rollback(id: string): Promise<{ restored: boolean; reason?: string }>;
  startResource(
    id: string,
    command: string,
    resourceID?: string,
  ): Promise<SandboxResourceView>;
  resourcesFor(id: string): SandboxResourceView[];
  resourceOutput(
    id: string,
    resourceID: string,
    maxBytes?: number,
  ): Promise<string>;
  stopResource(id: string, resourceID: string): Promise<SandboxResourceView>;
  validate(
    id: string,
    command: string,
  ): Promise<{ ok: boolean; exitCode: number; output: string }>;
  /**
   * The sandbox's status event. `status` names a transition the manifest cannot
   * describe, such as a merge that was previewed, landed or conflicted.
   */
  updateEvent(id: string, status?: SandboxStatus): RuntimeEvent;
  diffEvent(id: string): RuntimeEvent;
  auditEvent(
    id: string,
    action: string,
    approvalRequired?: boolean,
  ): RuntimeEvent;
};

export type ToolExecutionBoundary = {
  name: string;
  requiresApproval: boolean;
  /** Default timeout for one tool call. */
  timeoutSec?: number;
  /**
   * Optional upper bound for a per-call `timeoutSec` argument. When present,
   * the runtime lets the model extend the call up to this many seconds; when
   * absent, the static `timeoutSec` remains the exact boundary.
   */
  maxTimeoutSec?: number;
};

export type ToolSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

/**
 * The UI-facing card a tool draws for a call or a result.
 *
 * This is the kernel's name for the contract's `ToolCard` union: a
 * projection, not presentation — the tool says what the call or result
 * means (a file to read, a terminal session, a diff, a search) and a client
 * renders that however it likes. A card is a suggestion; a client that
 * cannot draw the kind falls back to the plain text.
 */
export type ToolRenderIntent = ToolCard;

/** The card union, re-exported under its contract name. */
export type { ToolCard };

/**
 * How a tool's call and result are projected. Optional: a tool without one
 * keeps the plain-string contract — its call and result are still shown
 * verbatim, just not projected.
 */
export type ToolOutputDefinition = {
  /**
   * JSON schema of the tool's output value.
   *
   * `execute` returns the model-facing string rather than a value, so this is a
   * contract only for the tools whose result is JSON: the execution boundary
   * validates those against it and skips text results. It is also what a client
   * reads to draw the result, so it has to describe the shape faithfully — a
   * schema that disagrees with the JSON fails the call.
   */
  schema: ToolSchema;
  /**
   * Whether `execute` returns a STRUCTURED value that the schema can describe.
   *
   * False (the default) means the tool returns content — file bytes, command
   * output, a page body — and the schema is a description for a client, not a
   * contract to validate. Validating a content-returning tool is actively
   * wrong: `read_file` returns the file's text, so `read_file` on a
   * `package.json` hands the validator that file's JSON, and every key in it
   * ($schema, name, version, ...) is reported as an unexpected property while
   * the real `content` field is reported missing. That is the
   * "returned output that does not match its declared schema" the file tools
   * were failing every JSON read with.
   *
   * True is for tools whose `execute` returns JSON as its model-facing string.
   */
  structured?: boolean;
  /**
   * Projects the call arguments into a card, shown while the tool runs and as
   * the call's own presentation.
   */
  presentCall?(args: unknown): ToolCard | undefined;
  /**
   * Projects the arguments, the result and the call's STRUCTURED FACTS into
   * a card.
   *
   * `meta` is what this tool's `presentationMeta` just computed over the same
   * (args, value) — the runtime computes it once and hands it here, so a
   * structured presenter composes its card from those facts instead of
   * parsing the result string a second time (a structured presenter reads
   * `result.meta` for exactly this reason). It is `undefined` when the tool
   * declares no `presentationMeta`; a presenter that needs the text reads
   * `value`.
   */
  presentResult?(
    args: unknown,
    value: string,
    meta?: Record<string, unknown>,
  ): ToolCard | undefined;
  /**
   * The call's STRUCTURED facts, persisted beside the result (the
   * `presentationMeta`): what a client needs to draw the result without
   * re-parsing the result string — a read window's numbers, a search's
   * cursor, a diff's counts. Pure: the same arguments and result always
   * earn the same meta.
   */
  presentationMeta?(args: unknown, value: string): Record<string, unknown>;
  /**
   * The tool's own final content invariant, called exactly once on the raw
   * result before it is redacted and bounded — e.g. stripping page scripts a
   * fetched page carries, or compacting a screen dump. Pure: the content the
   * model sees is the content this returns.
   */
  finalizeContent?(content: string): string;
};

export type RuntimeTool = ToolExecutionBoundary & {
  description: string;
  parameters: ToolSchema;
  output?: ToolOutputDefinition;
  execute(input: unknown, context: ToolExecutionContext): Promise<string>;
};

export type ToolExecutionContext = {
  workspaceRoot: string;
  /** Session that owns the turn invoking this tool. */
  sessionID?: string;
  /**
   * The confinement mode this call runs under (sandbox study: policy rides
   * the call — two callers may run under different modes simultaneously).
   * Per-call truth: `undefined` and `danger-full-access` both run
   * unconfined today; the tool layer resolves the effective mode
   * (session override ?? composition default) before handing the call down.
   */
  confinement?: ConfinementMode;
  /**
   * The sandbox escalation channel for this call, closed over the runtime's
   * tool/call/turn identity (askQuestion's shape: the tool asks, the runtime
   * owns the ids). Present when the runtime resolved one; a tool that
   * receives a `sandbox_permissions` argument without it escalations fail
   * closed as `unavailable`.
   */
  sandboxApprover?: EscalationApprover;
  /**
   * Effective timeout the runtime is enforcing for this call. Tools that also
   * run their own child-process timer use this so the two layers cannot drift.
   */
  timeoutSec?: number;
  signal?: AbortSignal;
  askQuestion?: (input: {
    title: string;
    questions: Array<{
      id: string;
      header: string;
      question: string;
      options: Array<{ label: string; description?: string }>;
      multiple?: boolean;
      custom?: boolean;
    }>;
  }) => Promise<string[][]>;
  /**
   * Issues a plugin/tool-defined interactive request and waits for its answer.
   * The runtime treats payload/response as opaque JSON; `validate` is the tool's
   * own authoritative business check.
   */
  askInteractive?: (input: {
    kind: string;
    title: string;
    payload: unknown;
    responseSchema?: Record<string, unknown>;
    expiresAt?: string;
    priority?: number;
    requestID?: string;
    validate?(response: unknown): string[] | void;
  }) => Promise<{ response: unknown; rejected?: boolean }>;
  subagents?: SubagentToolService;
  terminal?: TerminalToolService;
  sandboxes?: SandboxToolService;
  /**
   * The caller's OWN sandbox candidate, read-only (T6-4). Present only for a
   * sandboxed subagent, whose worktree this runtime created: it can read the
   * diff it is about to hand back, and nothing else — no merge, no promote,
   * no other candidate's id.
   */
  sandboxSelf?: {
    id: string;
    preview(): Promise<SandboxChangeView[]>;
  };
  workspaceReadAuthorize?: (input: {
    toolName: string;
    paths: string[];
  }) => Promise<void>;
  /**
   * Path-domain write authorization: a host that narrows a tool's write scope
   * (the ownership map for a fan-out sub-agent) rejects a write outside the
   * domain here. Absent = no domain restriction beyond the workspace boundary.
   */
  workspaceWriteAuthorize?: (input: {
    toolName: string;
    path: string;
  }) => Promise<void>;
  /**
   * Attaches an image file to the current turn so the model sees it on the
   * next provider step — the "model takes a screenshot and looks at it" path
   * (self-verifying a rendered page). Gated by the model's image input
   * capability; absent = images cannot be attached.
   */
  attachImage?: (path: string) => Promise<void>;
  sandboxMergeAuthorize?: (input: {
    id: string;
    paths: string[];
  }) => Promise<void>;
  onSandboxEvent?: (event: { type: string; [key: string]: unknown }) => void;
  onWorkspaceChange?: (changes: SandboxChangeView[]) => void;
  /**
   * The runtime's resolved config, by name (the D2 `runtime.config` service),
   * refreshed in place on config reload. A tool family reads values the
   * `settings` subset does not carry.
   */
  runtimeConfig?: () => unknown;
  settings?: {
    webSearchEndpoint?: string;
    webSearchProviderPriority?: string[];
    browserBinary?: string;
    browserEnabled?: boolean;
    browserUserAgent?: string;
    browserHeaders?: Record<string, string>;
    browserPersistentProfile?: boolean;
    browserProfileDir?: string;
    browserLocale?: string;
    browserTimezone?: string;
    allowedHosts?: string[];
    allowedHostGroups?: string[][];
    allowedSchemes?: string[];
    allowLocalhost?: boolean;
    allowPrivate?: boolean;
    deniedHosts?: string[];
    envAllowlist?: string[];
  };
  parentSessionID?: string;
  parentAgentID?: string;
  maxSubagentDepth?: number;
};

/**
 * One managed process reaching a terminal state, for whoever is watching.
 *
 * `workspaceRoot` alone cannot address a notice — a workspace may hold several
 * sessions — so the starter's session travels with it. A notice that landed in
 * every session of a workspace would tell agents about work they never did.
 */
export interface ManagedProcessNotice {
  id: string;
  command: string;
  status: "exited" | "stopped" | "failed";
  exitCode?: number;
  workspaceRoot: string;
  /** The session that started the process, when it was started by one. */
  sessionID?: string;
  startedAt: string;
  endedAt: string;
}

/** Service name the managed-process observer is published under. */
export const PROCESS_OBSERVER_SERVICE = "natalia:process-observer";

/**
 * The observing half of the managed-process registry.
 *
 * Declared here rather than in the plugin that implements it because both sides
 * need it and only the lower layer is shared: the plugin provides the observer,
 * the runtime subscribes to it, and neither has to depend on the other.
 */
export interface ProcessObserverService {
  subscribe(listener: (notice: ManagedProcessNotice) => void): () => void;
}
