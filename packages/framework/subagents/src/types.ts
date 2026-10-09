export type SubagentID = string;

export type SubagentStatus =
  | "idle"
  | "running"
  | "paused"
  | "stopped"
  | "completed"
  | "failed";

export type SubagentPhase =
  | "idle"
  | "queued"
  | "provider"
  | "tool"
  | "retrying"
  | "finalizing"
  | "waiting";

export type SubagentHealth = "active" | "quiet" | "stalled" | "terminal";

export interface OutputEntry {
  step: number;
  text: string;
  timestamp: number;
}

export interface AuditEntry {
  eventId: string;
  agentId: SubagentID;
  action: string;
  status: string;
  timestamp: number;
  attached: boolean;
  stopReason?: string;
  requestedBy?: "model" | "user" | "parent" | "runtime";
  force?: boolean;
}

export interface SubagentEvent {
  agentId: SubagentID;
  event: string;
  status: string;
  attached: boolean;
  text?: string;
  timestamp: number;
  parentSessionID?: string;
  parentAgentID?: SubagentID;
  continuation?: number;
  phase?: SubagentPhase;
  activityDetail?: string;
  stopReason?: string;
  requestedBy?: "model" | "user" | "parent" | "runtime";
  force?: boolean;
}

/**
 * One subagent's accumulated usage, the same fields the other three agents'
 * bars read — kept on the record so it survives the run, the restart and the
 * session switch (R3's "cross-session behavior matches the other three").
 *
 * The live path already folds `runtime.step_usage` events carrying the
 * child's `agentID` into its isolated view state; this is the DURABLE twin
 * that a re-attach hydrates from, which is what the event-sink's `agentID`
 * gate (live-only by design) cannot give. One writer per step, persisted by
 * the store's existing save-on-change.
 */
export interface SubagentUsage {
  turns: number;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Model stream wall time, ms. */
  llmMs: number;
  /** First-token latency, ms. */
  ttftMs: number;
  /** Steps that reported a first-token latency (the average's denominator). */
  ttftSteps: number;
  /** Decode wall time, ms (first token → stream end). */
  decodeMs: number;
  /** Tool-execution wall time, ms. */
  toolMs: number;
}

export function emptySubagentUsage(): SubagentUsage {
  return {
    turns: 0,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    llmMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    toolMs: 0,
  };
}

export interface SubagentRecord {
  id: SubagentID;
  task: string;
  mode: string;
  /**
   * Name of the configured agent this subagent was spawned as, when any. The
   * definition is resolved from the registry at run time so a config reload
   * changes what the type means without rewriting stored records.
   */
  agentType?: string;
  /**
   * Whether the subagent starts from its parent's conversation (`fork`) or from
   * nothing but its task (`fresh`). Stored rather than resolved at start, so the
   * balance of the seed is decided when the fork is requested, not whenever the
   * child happens to begin.
   */
  context?: "fresh" | "fork";
  pendingMessages?: string[];
  status: SubagentStatus;
  attached: boolean;
  modelProfile: string;
  allowedTools: string[];
  excludeTools: string[];
  writePaths?: string[];
  outputs: OutputEntry[];
  createdAt: number;
  updatedAt: number;
  parentSessionID?: string;
  parentAgentID?: SubagentID;
  continuation?: number;
  phase: SubagentPhase;
  lastActivityAt: number;
  activityDetail: string;
  startedAt: number;
  endedAt?: number;
  /**
   * The child's accumulated usage, persisted with the record. Optional so an
   * existing manifest without it reads as "no usage recorded yet" rather than
   * as a malformed record.
   */
  usage?: SubagentUsage;
  /**
   * The child's last context projection, persisted with the record and
   * replayed on attach — the ring's durable twin, the same discipline
   * navi/nia's `context.snapshot` events follow. Named `contextSnapshot`
   * because `context` already means the fresh/fork seed choice.
   */
  contextSnapshot?: SubagentContextSnapshot;
}

/** The last context projection a subagent's run produced. */
export interface SubagentContextSnapshot {
  usedTokens: number;
  contextWindow?: number;
  pressureTokens?: number;
  projectedTokens?: number;
  systemTokens?: number;
  toolsTokens?: number;
  messageTokens?: number;
  source: string;
  at: string;
}

export interface SpawnOptions {
  mode?: string;
  agentType?: string;
  /**
   * Whether the child starts from its parent's conversation (`fork`) or from
   * nothing but its task (`fresh`).
   */
  context?: "fresh" | "fork";
  /** Messages to deliver before the child's first step. */
  pendingMessages?: string[];
  modelProfile?: string;
  allowedTools?: string[];
  excludeTools?: string[];
  writePaths?: string[];
  signal?: AbortSignal;
  parentSessionID?: string;
  parentAgentID?: SubagentID;
  maxDepth?: number;
}

export interface RunnerContext {
  agentId: SubagentID;
  log(text: string): void;
  setStatus(status: string): void;
  signal: AbortSignal;
  reportActivity(phase: SubagentPhase, detail: string): void;
  /**
   * The child's channel to its parent, live during the run: a finding the
   * parent should hear NOW (one decomposed task done, a blocker, the
   * result) instead of waiting for the whole run to end. Delivered to the
   * spawning session as a `subagent.message` fact; the terminal
   * settlement still fires at the end, so a child that says nothing is
   * covered. Absent a bound hook, the call is a no-op — never a throw
   * (the run must not die on a report that could not fly).
   */
  sendToParent(text: string): void;
}

export type RunnerCallback = (
  task: string,
  context: RunnerContext,
) => void | Promise<void>;

export interface SubagentRegistryOptions {
  runner: RunnerCallback;
  workDir?: string;
  /**
   * The owning session, resolved LIVE (a thunk) rather than captured. The
   * registry is constructed before `recoverSession` runs, so a captured
   * value froze the workspace-level path into every later save whenever the
   * boot had no active session yet.
   */
  sessionID?: string | (() => string | undefined);
  /** Time source; defaults to Date.now for production. */
  clock?: () => number;
  /** Grace period before idle→stalled; 0 uses the default. */
  stallThresholdMs?: number;
  /**
   * Milliseconds one run may take before the registry stops it; 0 disables the
   * budget. The timer is armed per run, so a retry gets a fresh budget.
   */
  wallClockBudgetMs?: number;
  /**
   * The settlement hook: fires at every terminal transition (completed /
   * stopped / failed) with the record. The composition binds it to the
   * spine, so the parent that spawned the child is TOLD instead of polling
   * `agent_wait`. Absent in a bare registry (the unit tests): no notice,
   * no behavior change.
   */
  onSettled?: (record: SubagentRecord) => void;
  /**
   * Fires when a child sends a message to its parent mid-run. The
   * composition binds it to the spine, so the parent is told live instead
   * of polling or waiting for the settlement. Absent in a bare registry.
   */
  onChildMessage?: (message: { agentId: string; text: string }) => void;
}
