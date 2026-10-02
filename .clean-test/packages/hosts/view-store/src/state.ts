/**
 * The projected state an external UI renders, and the primitives every
 * projection module shares.
 *
 * Kept separate from the projection logic so adding a new surface means adding a
 * slice here plus one module, not editing a single growing switch.
 */
import type {
  ProjectionContribution,
  RuntimeEvent,
  RuntimeSessionSummary,
  SessionID,
  SubmittedTurn,
  WorkspaceSummary,
} from "@anthelia/contracts";
/**
 * Character budget for forced segmentation. Semantic boundaries (tools,
 * thinking phases, durable content.done) still split; a long contiguous answer
 * no longer splits just because it crossed an arbitrary character count.
 */
export const streamSegmentChars = Number.POSITIVE_INFINITY;
/**
 * Bounds on the histories a long session accumulates. A projection that grows
 * without limit is a leak in every consumer that holds it.
 */
export const terminalTimelineLimit = 200;
export const subagentHistoryLimit = 100;
export const policyDecisionLimit = 200;
export const checkpointLimit = 200;
export const evidenceLimit = 200;
/** Open invariant findings are edge-lifecycle objects; bounded like evidence. */
export const invariantFindingLimit = 200;

/** A journal invariant finding, projected for display (D2). */
export type InvariantFindingView = {
  /** owner|invariant|code|detail — the identity the edges key on. */
  key: string;
  at: string;
  owner: string;
  invariant: string;
  code: string;
  detail: string;
  sessionID?: string;
  resolved: boolean;
};
export const completionLimit = 100;
export const decisionLimit = 200;
export const driftFindingLimit = 200;
export const constitutionConflictLimit = 50;
export const constitutionOverrideLimit = 100;
/**
 * A terminal's transcript grows for as long as the pane lives, so the projection
 * keeps a bounded tail with an explicit note about what was dropped. Storing the
 * event as-is would grow without limit for the whole session.
 */
export const terminalTranscriptChars = 12_000;

export type MessageBlock = {
  id: string;
  role: "user" | "assistant" | "thinking" | "system" | "tool";
  /** Text the runtime has confirmed. Safe to keep in a transcript. */
  text: string;
  attachments?: import("@anthelia/contracts").LocalAttachment[];
  /**
   * Text streamed but not yet confirmed. A UI renders `text + pendingText`; a
   * transcript keeps only `text`. Cancelling a turn drops the pending part,
   * because unconfirmed partial output is not part of the record.
   */
  pendingText: string;
  status?: string;
  /** Present only on thinking blocks the provider allows a UI to render. */
  reasoningVisible?: boolean;
  tool?: ToolBlock;
  taskID?: string;
};

export type ToolBlock = {
  name: string;
  callID?: string;
  status: string;
  summary: string;
  result?: string;
  startedAt?: number;
  endedAt?: number;
  metadata?: Record<string, unknown>;
  /** Accumulated raw arguments, so a consumer can show what was requested. */
  argumentsRaw: string;
};

/**
 * An admitted-but-unstarted input, projected from the `input.*` events and
 * cleared by `turn.submitted`/`turn.input`. `status` is `queued` for a
 * `next-turn` waiting for its turn and `steering` for a `next-step` waiting to
 * be claimed by the running one.
 */
export type PendingInteractiveView = Extract<
  RuntimeEvent,
  { type: "interactive.request" }
>;

export type PendingInputView = {
  id: string;
  text: string;
  delivery: "next-turn" | "next-step";
  internal: boolean;
  admittedAt: string;
  admittedSeq: number;
  status: "queued" | "steering";
};

export type StreamState = {
  /** Text already confirmed into a block. */
  committed: string;
  /** Text streamed but not yet confirmed. */
  tail: string;
  /**
   * Text a retry is expected to send again. A provider that retries restarts its
   * stream, so the overlap has to be skipped or the response renders twice.
   */
  retrySkip: string;
  attempt: number;
  segmentIndex: number;
};

export type TerminalView = Extract<RuntimeEvent, { type: "terminal.update" }>;
export type TerminalTimelineEntry = Extract<
  RuntimeEvent,
  { type: "terminal.timeline" }
>;
export type TerminalApprovalView = Extract<
  RuntimeEvent,
  { type: "terminal.approval" }
>;
export type SandboxView = Extract<RuntimeEvent, { type: "sandbox.update" }>;
export type SandboxDiffView = Extract<RuntimeEvent, { type: "sandbox.diff" }>;
export type SubagentView = Extract<RuntimeEvent, { type: "subagent.update" }>;
export type McpView = Extract<RuntimeEvent, { type: "mcp.status" }>;
export type PluginView = Extract<RuntimeEvent, { type: "plugin.update" }>;
export type CapabilityView = Extract<
  RuntimeEvent,
  { type: "capability.loaded" }
>;
export type CheckpointView = Extract<
  RuntimeEvent,
  { type: "checkpoint.created" }
>;
export type ContextUsageView = {
  used: number;
  max?: number;
  source?: string;
  thresholdPercent?: number;
  reserved?: number;
  trigger?: string;
  pressureTokens?: number;
  projectedTokens?: number;
  contextWindow?: number;
};
export type PolicyDecisionView = Extract<
  RuntimeEvent,
  { type: "policy.decision" }
>;

/**
 * Stable identity for one subagent history row. `subagent.update.id` is the
 * subagent id, not a unique event id, so using it directly collapses a whole
 * history into one row. This key keeps every status/log event distinct while
 * staying stable across replayed pages.
 */
export function subagentHistoryRowKey(
  event: Extract<RuntimeEvent, { type: "subagent.update" }>,
): string {
  return JSON.stringify([
    event.id,
    event.event,
    event.status,
    event.phase ?? "",
    event.continuation ?? "",
    event.lastActivityAt ?? event.startedAt ?? "",
    event.activityDetail ?? "",
    event.text ?? "",
    event.task ?? "",
  ]);
}

/**
 * Accumulated session token / latency totals, folded from
 * `runtime.step_usage` events. Pure sums — the display figures (cache hit
 * rate, tokens/sec, average first-token latency) are derived by
 * `deriveSessionUsageView`, never stored.
 */
export type SessionUsageChannel = "main" | "navi" | "nia";

export function emptySessionUsageStats(): SessionUsageStats {
  return {
    steps: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
  };
}

export type SessionUsageStats = {
  /** Provider steps counted (each emits one `runtime.step_usage`). */
  steps: number;
  /** Turns counted (each emits one durable `turn.finished`). */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Model stream wall time, ms. */
  llmMs: number;
  /** Tool-execution wall time, ms. */
  toolMs: number;
  /** Summed first-token latency, ms. */
  ttftMs: number;
  /** Steps that carried a first token (throughput/latency denominator). */
  ttftSteps: number;
  /** Decode wall time, ms (first token → stream end). */
  decodeMs: number;
};

/** Display figures derived from the raw sums (never persisted). */
export type SessionUsageView = SessionUsageStats & {
  /** Total input incl. cache traffic (uncached input + cache read + cache write). */
  totalInputTokens: number;
  /** Cache read / total input, 0..1; 0 when no input yet. */
  cacheHitRate: number;
  /** Average first-token latency, ms; 0 when no step reported one. */
  avgTtftMs: number;
  /** Output tokens per second of decode time; 0 when no decode time. */
  tokensPerSecond: number;
};

/**
 * A projected WorkContract per plan (EI §8.2), folded into the view-store so
 * any UI (e.g. the plan tab's contract summary bar) reads it without rescanning
 * the journal. `current` is the user-approved R; `draft` is the latest
 * unapproved proposal; `stale` marks a draft whose plan document changed after
 * it was extracted. Mirrors the session projection, kept self-contained so
 * view-store stays independent of @anthelia/session.
 */
export type WorkContractView = {
  planID: string;
  version: number;
  scope?: string[];
  verification?: string[];
  constraints?: string[];
  status: "current" | "draft";
  stale?: boolean;
  unverifiable?: boolean;
  acceptedBy?: "user";
  acceptedAt?: string;
};
export type WorkGraphNodeView = Extract<
  RuntimeEvent,
  { type: "workgraph.node_added" }
>;
export type WorkGraphEdgeView = Extract<
  RuntimeEvent,
  { type: "workgraph.edge_added" }
>;
export type SessionIntelligenceView = Extract<
  RuntimeEvent,
  { type: "session.snapshot" }
>;
export type PendingApproval = Extract<
  RuntimeEvent,
  { type: "approval.request" }
>;
export type PendingQuestion = Extract<
  RuntimeEvent,
  { type: "question.request" }
>;

/**
 * A live unit of runtime work. Consumers render these facts in their own visual
 * language rather than reinterpreting the complete runtime event stream.
 */
export type ActivityKind =
  | "planning"
  | "thinking"
  | "generating"
  | "tool"
  | "command"
  | "workflow"
  | "subagent"
  | "compacting"
  | "retrying"
  | "waiting_for_user"
  | "paused";

export type ActivityState = "active" | "waiting" | "paused";

export type ActivityView = {
  /** Stable source identity, so replaying an event updates instead of duplicates. */
  id: string;
  kind: ActivityKind;
  state: ActivityState;
  /** The turn that owns this work, when the runtime exposes one. */
  turnID?: string;
  /** Runtime-provided name or title, deliberately not UI-localized prose. */
  label?: string;
  /** Runtime-provided detail such as a command or tool summary. */
  detail?: string;
};

export type StreamActivityView = {
  messageID: string;
  phase: "waiting" | "thinking" | "generating" | "using_tool";
  startedAt: number;
  toolName?: string;
  error?: string;
};

/** State owned by one runtime stream, never selected by a channel argument. */
export type AgentStreamState = {
  messages: MessageBlock[];
  streams: Record<string, StreamState>;
  streamPhases: Record<string, "thinking" | "assistant">;
  activity?: StreamActivityView;
  /** Latest shared context measurement for this independent stream. */
  context?: ContextUsageView;
  /** Baseline captured immediately before an asynchronous durable snapshot. */
  hydrationBaseline?: MessageBlock[];
};

/** Natalia's independent transcript and turn state. */
export type NataliaStreamState = AgentStreamState & {
  activeTurn?: string;
  paused: boolean;
  tools: Record<string, ToolBlock>;
  pendingApprovals: PendingApproval[];
  pendingQuestions: PendingQuestion[];
  activities: Record<string, ActivityView>;
};

export type SubagentStreamState = {
  active: Record<string, SubagentView>;
  history: Record<string, SubagentView[]>;
  states: Record<string, AppState>;
};

/** An advisory line a UI shows while something transient is happening. */
export type Banner = { text: string; kind: string };

/** Rollback is a workspace-wide operation, so at most one is in flight. */
/**
 * A projected drift finding. Drift findings are journal facts like decisions
 * and evidence; the view-store keeps them so any UI can render the complete
 * finding list without re-querying the runtime on every render.
 */
export type DriftFindingView = Omit<
  Extract<RuntimeEvent, { type: "drift.finding_opened" }>,
  "type" | "id"
> & {
  status:
    | "open"
    | "explained"
    | "disputed"
    | "dismissed"
    | "corrected"
    | "detour_declared";
  rationale?: string;
  reopenedCount: number;
};

export type RollbackView = {
  checkpointID: string;
  safetyCheckpointID?: string;
  state: "previewed" | "running" | "completed" | "failed";
  dryRun?: boolean;
  restoredFiles?: number;
  deletedFiles?: number;
  message?: string;
  recovered?: boolean;
};

export type AppState = {
  // workspace / session navigation
  workspaces: WorkspaceSummary[];
  sessions: RuntimeSessionSummary[];
  activeWorkspaceID?: string;
  activeSessionID?: string;

  // conversation
  sessionID?: SessionID;
  title: string;
  status: string;
  footer: string;
  statusSegments: string[];
  messages: MessageBlock[];
  activeTurn?: string;
  paused: boolean;
  lastSubmission?: SubmittedTurn;
  lastStopReason?: "done" | "cancelled" | "error" | "waiting_human";
  streams: Record<string, StreamState>;
  streamPhases: Record<string, "thinking" | "assistant">;
  tools: Record<string, ToolBlock>;
  pendingApprovals: PendingApproval[];
  pendingQuestions: PendingQuestion[];
  /** Durable admissions that have not started a turn or been claimed yet. */
  pendingInputs: PendingInputView[];
  /** Plugin/tool-defined interactive requests waiting for a response. */
  pendingInteractives: PendingInteractiveView[];
  /** All currently live work; settled activities are removed by the projection. */
  activities: Record<string, ActivityView>;

  // Independent runtime stream projections. These must not be routed by a
  // `channel` field: their event namespaces identify the owning stream.
  natalia: NataliaStreamState;
  navi: AgentStreamState;
  nia: AgentStreamState;

  // resources
  terminals: Record<string, TerminalView>;
  terminalTimeline: Record<string, TerminalTimelineEntry[]>;
  terminalApprovals: Record<string, TerminalApprovalView>;
  sandboxes: Record<string, SandboxView>;
  sandboxDiffs: Record<string, SandboxDiffView>;
  subagents: Record<string, SubagentView>;
  subagentHistory: Record<string, SubagentView[]>;
  /** Per-subagent projected state for isolated message/tool streams. */
  subagentStates: Record<string, AppState>;
  subagentStream: SubagentStreamState;
  mcp: Record<string, McpView>;
  plugins: Record<string, PluginView>;
  capabilities: Record<string, CapabilityView>;
  checkpoints: CheckpointView[];
  rollback?: RollbackView;

  // status and advisories
  context?: ContextUsageView;
  compactionBanner?: Banner;
  retryBanner?: Banner;
  agentSelection?: { name?: string; pending: boolean };
  modelSelection?: { modelID?: string; variant?: string };
  /**
   * Projected runtime notices (ADR Phase C): the latest prompt-level
   * instruction change per kind. Consumed through the `notices` client
   * contract (dual ingestion) AND the `context.instructions` event stream, so
   * a live session and a replayed session converge on the same view.
   */
  runtimeNotices: Array<import("@anthelia/contracts").RuntimeProjectedNotice>;
  /**
   * Accumulated per-session token / latency usage (folded from
   * `runtime.step_usage` events). Session-scoped like the Work Graph: each
   * session's state carries its own totals, so switching sessions switches the
   * dashboard. `deriveSessionUsageView` computes the display figures (hit rate,
   * throughput, average first-token latency).
   */
  sessionUsage: SessionUsageStats;
  /**
   * Per-stream usage totals. `sessionUsage` stays the session-wide aggregate
   * (all providers) for backwards compatibility; the UI bars read the stream
   * they belong to so Natalia, Navi and Nia do not show each other's tokens.
   */
  usageByChannel: Record<SessionUsageChannel, SessionUsageStats>;
  /**
   * Projected WorkContracts per plan (EI §8.2), consumed by the plan tab's
   * contract summary bar. Session-scoped like the rest of the state.
   */
  workContracts: Record<string, WorkContractView>;
  /** Recent policy outcomes, so a UI can explain why a tool did not run. */
  policyDecisions: PolicyDecisionView[];
  workGraphNodes: Record<string, WorkGraphNodeView>;
  workGraphEdges: Record<string, WorkGraphEdgeView>;
  intelligence?: SessionIntelligenceView;
  pluginProjections: ProjectionContribution[];
  constitutionRules: Record<
    string,
    Extract<RuntimeEvent, { type: "constitution.rule_added" }>
  >;
  constitutionOverrides: Array<
    Extract<RuntimeEvent, { type: "constitution.override_granted" }>
  >;
  constitutionConflicts: Array<
    Extract<RuntimeEvent, { type: "constitution.check" }>
  >;
  decisions: Array<Extract<RuntimeEvent, { type: "decision.recorded" }>>;
  evidence: Array<Extract<RuntimeEvent, { type: "evidence.recorded" }>>;
  invariantFindings: InvariantFindingView[];
  completions: Array<Extract<RuntimeEvent, { type: "completion.recorded" }>>;
  driftFindings: DriftFindingView[];
  mailbox: Record<string, MailboxMessageView>;
  plans: Record<string, PlanDocView>;
  /** Current same-session goal, folded from the journal for the status bar. */
  goal?: GoalStatusView;
};

/** Durable goal facts the status bar renders (activation is process-local). */
export type GoalStatusView = {
  goalID: string;
  revision: number;
  objective: string;
  phase: "active" | "paused" | "blocked" | "complete";
  roundsStarted: number;
  /** 0 means unlimited. */
  maxGoalRounds: number;
  planID?: string;
  blockedReason?: { code: string; message: string };
  lastStop?: { code: string; at: number; message?: string };
};

export type MailboxMessageView = {
  messageID: string;
  source: "user_via_live_chat" | "system";
  priority: "normal" | "high" | "urgent";
  intent: Extract<RuntimeEvent, { type: "mailbox.queued" }>["intent"];
  text: string;
  safeSummary: string;
  relatedPlanID?: string;
  deliveryPolicy: Extract<
    RuntimeEvent,
    { type: "mailbox.queued" }
  >["deliveryPolicy"];
  createdAt: string;
  status: "queued" | "delivered" | "acknowledged" | "deferred" | "superseded";
  reason?: string;
};

export type PlanDocView = {
  planID: string;
  title: string;
  documentPath: string;
  createdBy: "user" | "live_chat" | "main_agent";
  createdAt: string;
  updatedAt: string;
  markedAt?: string;
  status: string;
};

export function initialState(): AppState {
  const messages: MessageBlock[] = [];
  const streams: Record<string, StreamState> = {};
  const streamPhases: Record<string, "thinking" | "assistant"> = {};
  const tools: Record<string, ToolBlock> = {};
  const pendingApprovals: PendingApproval[] = [];
  const pendingQuestions: PendingQuestion[] = [];
  const pendingInputs: PendingInputView[] = [];
  const pendingInteractives: PendingInteractiveView[] = [];
  const activities: Record<string, ActivityView> = {};
  const subagents: Record<string, SubagentView> = {};
  const subagentHistory: Record<string, SubagentView[]> = {};
  const subagentStates: Record<string, AppState> = {};
  return {
    workspaces: [],
    sessions: [],
    title: "New session",
    status: "booting",
    footer: "Ready",
    statusSegments: [
      "mode:runtime",
      "model:not-connected",
      "provider:not-connected",
    ],
    messages,
    paused: false,
    streams,
    streamPhases,
    tools,
    pendingApprovals,
    pendingQuestions,
    pendingInputs,
    pendingInteractives,
    activities,
    natalia: {
      messages,
      streams,
      streamPhases,
      tools,
      pendingApprovals,
      pendingQuestions,
      activities,
      paused: false,
    },
    navi: { messages: [], streams: {}, streamPhases: {} },
    nia: { messages: [], streams: {}, streamPhases: {} },
    terminals: {},
    terminalTimeline: {},
    terminalApprovals: {},
    sandboxes: {},
    sandboxDiffs: {},
    subagents,
    subagentHistory,
    subagentStates,
    subagentStream: {
      active: subagents,
      history: subagentHistory,
      states: subagentStates,
    },
    mcp: {},
    plugins: {},
    capabilities: {},
    checkpoints: [],
    policyDecisions: [],
    workGraphNodes: {},
    workGraphEdges: {},
    pluginProjections: [],
    constitutionRules: {},
    constitutionOverrides: [],
    constitutionConflicts: [],
    decisions: [],
    evidence: [],
    invariantFindings: [],
    completions: [],
    driftFindings: [],
    mailbox: {},
    plans: {},
    runtimeNotices: [],
    sessionUsage: emptySessionUsageStats(),
    usageByChannel: {
      main: emptySessionUsageStats(),
      navi: emptySessionUsageStats(),
      nia: emptySessionUsageStats(),
    },
    workContracts: {},
  };
}

/**
 * Copies enough of the state that `applyEvent` cannot mutate the previous one.
 * Explicit rather than `structuredClone` because cloning a reactive proxy is
 * what broke the first attempt at this layer.
 */
export function cloneState(state: AppState): AppState {
  return {
    ...state,
    workspaces: state.workspaces.map((entry) => ({ ...entry })),
    sessions: state.sessions.map((entry) => ({ ...entry })),
    statusSegments: [...state.statusSegments],
    messages: state.messages.map((block) => ({
      ...block,
      ...(block.tool ? { tool: { ...block.tool } } : {}),
    })),
    streams: mapRecord(state.streams, (value) => ({ ...value })),
    streamPhases: { ...state.streamPhases },
    tools: mapRecord(state.tools, (value) => ({ ...value })),
    pendingApprovals: [...state.pendingApprovals],
    pendingQuestions: [...state.pendingQuestions],
    pendingInputs: state.pendingInputs.map((input) => ({ ...input })),
    pendingInteractives: state.pendingInteractives.map((input) => ({
      ...input,
    })),
    activities: mapRecord(state.activities, (value) => ({ ...value })),
    natalia: cloneNataliaStream(state.natalia),
    navi: cloneAgentStream(state.navi),
    nia: cloneAgentStream(state.nia),
    terminals: { ...state.terminals },
    terminalTimeline: mapRecord(state.terminalTimeline, (value) => [...value]),
    terminalApprovals: { ...state.terminalApprovals },
    sandboxes: { ...state.sandboxes },
    sandboxDiffs: { ...state.sandboxDiffs },
    subagents: { ...state.subagents },
    subagentHistory: mapRecord(state.subagentHistory, (value) => [...value]),
    subagentStates: mapRecord(state.subagentStates, (value) =>
      cloneState(value),
    ),
    subagentStream: {
      active: { ...state.subagentStream.active },
      history: mapRecord(state.subagentStream.history, (value) => [...value]),
      states: mapRecord(state.subagentStream.states, (value) =>
        cloneState(value),
      ),
    },
    mcp: { ...state.mcp },
    plugins: { ...state.plugins },
    capabilities: { ...state.capabilities },
    checkpoints: [...state.checkpoints],
    policyDecisions: [...state.policyDecisions],
    workGraphNodes: { ...state.workGraphNodes },
    workGraphEdges: { ...state.workGraphEdges },
    pluginProjections: [...state.pluginProjections],
    constitutionRules: { ...state.constitutionRules },
    constitutionOverrides: [...state.constitutionOverrides],
    constitutionConflicts: [...state.constitutionConflicts],
    decisions: [...state.decisions],
    evidence: [...state.evidence],
    invariantFindings: [...state.invariantFindings],
    completions: [...state.completions],
    driftFindings: state.driftFindings.map((finding) => ({
      ...finding,
      ...(finding.ruleHits
        ? { ruleHits: finding.ruleHits.map((hit) => ({ ...hit })) }
        : {}),
    })),
    mailbox: mapRecord(state.mailbox, (value) => ({ ...value })),
    plans: mapRecord(state.plans, (value) => ({ ...value })),
    runtimeNotices: state.runtimeNotices.map((notice) => ({ ...notice })),
    sessionUsage: { ...state.sessionUsage },
    usageByChannel: {
      main: { ...state.usageByChannel.main },
      navi: { ...state.usageByChannel.navi },
      nia: { ...state.usageByChannel.nia },
    },
    workContracts: mapRecord(state.workContracts, (value) => ({ ...value })),
    ...(state.goal
      ? {
          goal: {
            ...state.goal,
            ...(state.goal.blockedReason
              ? { blockedReason: { ...state.goal.blockedReason } }
              : {}),
            ...(state.goal.lastStop
              ? { lastStop: { ...state.goal.lastStop } }
              : {}),
          },
        }
      : {}),
    ...(state.rollback ? { rollback: { ...state.rollback } } : {}),
  };
}

function cloneNataliaStream(state: NataliaStreamState): NataliaStreamState {
  return {
    ...cloneAgentStream(state),
    paused: state.paused,
    tools: mapRecord(state.tools, (value) => ({ ...value })),
    pendingApprovals: [...state.pendingApprovals],
    pendingQuestions: [...state.pendingQuestions],
    activities: mapRecord(state.activities, (value) => ({ ...value })),
  };
}

/** Keeps legacy projector internals and the public stream slices coherent. */
export function synchronizeStreamSlices(state: AppState): void {
  Object.assign(state.natalia, {
    messages: state.messages,
    streams: state.streams,
    streamPhases: state.streamPhases,
    activeTurn: state.activeTurn,
    paused: state.paused,
    tools: state.tools,
    pendingApprovals: state.pendingApprovals,
    pendingQuestions: state.pendingQuestions,
    activities: state.activities,
    context: state.context,
  });
  Object.assign(state.subagentStream, {
    active: state.subagents,
    history: state.subagentHistory,
    states: state.subagentStates,
  });
}

function cloneAgentStream(state: AgentStreamState): AgentStreamState {
  return {
    ...state,
    messages: state.messages.map((block) => ({
      ...block,
      ...(block.tool ? { tool: { ...block.tool } } : {}),
    })),
    streams: mapRecord(state.streams, (value) => ({ ...value })),
    streamPhases: { ...state.streamPhases },
    ...(state.activity ? { activity: { ...state.activity } } : {}),
    ...(state.hydrationBaseline
      ? {
          hydrationBaseline: state.hydrationBaseline.map((block) => ({
            ...block,
          })),
        }
      : {}),
  };
}

/** What a UI should display for a block: confirmed text plus streaming tail. */
export function displayText(block: MessageBlock): string {
  return block.text + block.pendingText;
}

export function upsertBlock(
  state: AppState,
  id: string,
  role: MessageBlock["role"],
  text: string,
  status?: string,
  extra?: Partial<MessageBlock>,
): void {
  const block = state.messages.find((item) => item.id === id);
  if (block) {
    block.text = text;
    if (status !== undefined) block.status = status;
    if (extra) Object.assign(block, extra);
    return;
  }
  state.messages.push({ id, role, text, pendingText: "", status, ...extra });
}

/** Appends to a bounded history, dropping the oldest entries past the cap. */
export function appendBounded<T>(list: T[], entry: T, limit: number): T[] {
  const next = [...list, entry];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function mapRecord<T>(
  record: Record<string, T>,
  map: (value: T) => T,
): Record<string, T> {
  const next: Record<string, T> = {};
  for (const key in record) next[key] = map(record[key] as T);
  return next;
}

/**
 * Transcript eviction.
 *
 * `messages` is deliberately unbounded: a transcript is the record, and silently
 * dropping conversation is a policy decision that belongs to the consumer, not to
 * a shared projection. A long-lived UI does need to evict, so the rule that makes
 * eviction safe lives here rather than being re-derived by every consumer:
 * **evict whole user turns only**. Dropping a partial turn leaves an assistant
 * reply with no prompt above it, which reads as the assistant answering nothing.
 *
 * Durable history stays reloadable by cursor, so eviction loses nothing permanent.
 */
export const transcriptLimit = 300;
export const transcriptWatermark = 240;

export type TranscriptBound<T> = {
  messages: T[];
  evicted: boolean;
};

/**
 * Generic over the row type: eviction only needs to know which rows begin a user
 * turn, so a consumer with a richer block shape can use this without converting.
 */
export function boundTranscript<T extends { role: string }>(
  messages: T[],
  direction: "older" | "newer",
  limit = transcriptLimit,
  watermark = transcriptWatermark,
): TranscriptBound<T> {
  if (messages.length <= limit) return { messages, evicted: false };
  const excess = messages.length - watermark;
  if (direction === "older") {
    // Trimming the oldest end: walk back to a user turn boundary.
    let start = messages.length;
    let removed = 0;
    while (start > 0) {
      start--;
      removed++;
      if (removed >= excess && messages[start]?.role === "user") break;
    }
    if (start === 0 && removed === messages.length)
      // No user turn boundary exists. Fall back to ordinary bounded trimming:
      // keep the newest watermark rows instead of wiping the transcript.
      return {
        messages: messages.slice(Math.max(0, messages.length - watermark)),
        evicted: true,
      };
    return { messages: messages.slice(0, start), evicted: true };
  }
  // Keep the newest end while allowing the rendered window to breathe between
  // `watermark` and `limit` rows. Search backwards from the target removal
  // point for a user-turn boundary inside that range. Walking *forward* for
  // the next user can overshoot badly (a tool-heavy turn can leave far fewer
  // than `watermark` rendered rows), which made history appear missing.
  const minCut = Math.max(0, messages.length - limit);
  let cut = Math.min(Math.max(0, excess), messages.length);
  while (cut > minCut && messages[cut]?.role !== "user") cut -= 1;
  if (cut < minCut || messages[cut]?.role !== "user")
    return {
      messages: messages.slice(Math.max(0, messages.length - watermark)),
      evicted: true,
    };
  return { messages: messages.slice(cut), evicted: true };
}
