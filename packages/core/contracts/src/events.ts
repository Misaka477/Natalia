import type {
  ApprovalResponse,
  QuestionItem,
  QuestionResponse,
} from "./interactive";
import type {
  AgentConfig,
  AgentPermissionRules,
  ConfigV3,
  MCPServerConfig,
  PermissionProfile,
} from "./schemas";

export type SessionID = `ses_${string}`;
export type EpisodeID = `epi_${string}`;

/**
 * The plan lifecycle statuses that END a plan: `completed` (the audit passed)
 * and `handed_off` (a next plan took over). A plan in one of these is a closed
 * fact — `planDocUpdateStatus` refuses to move it back to a live status, which
 * is what let a pause/resume return a finished plan to `executing` in the
 * 2026-10-06 smoke run (T-20). Writers that project a terminal status spell it
 * exactly as it appears here; the set is the one vocabulary both sides read.
 */
export const PLAN_TERMINAL_STATUSES: readonly string[] = [
  "completed",
  "handed_off",
];

/** Whether a plan lifecycle status ends the plan. */
export function isTerminalPlanStatus(status: string): boolean {
  return PLAN_TERMINAL_STATUSES.includes(status);
}

export type ErrorKind =
  | "timeout"
  | "connection"
  | "rate_limit"
  | "server"
  | "auth"
  | "invalid_request"
  | "empty_response"
  | "context_limit"
  | "quota"
  | "unknown"
  | "cancel";

export type StepRetryOperation = "llm_step" | "compaction";

export type ContextStatusSource =
  | "exact_checkpoint"
  | "pending_estimate"
  | "compaction_estimate";

export type CompactionTrigger =
  | "ratio"
  | "reserved"
  | "manual"
  | "context_limit";

export type ExecutionTarget =
  | { kind: "host"; cwd: string }
  | {
      kind: "sandbox";
      sandboxID: string;
      root: string;
      isolationLevel: "workspace" | "container" | "vm";
    };

export type TerminalStatus =
  | "starting"
  | "running"
  | "waiting"
  | "awaiting_approval"
  | "exited"
  | "failed";
export type TerminalOwnership = "model" | "user";
export type TerminalAction =
  | "write"
  | "submit"
  | "resize"
  | "exit"
  | "attach"
  | "detach"
  | "secure_input"
  | "request_human"
  | "started";
export type SandboxStatus =
  | "created"
  | "running"
  | "changed"
  | "merge_previewed"
  | "merged"
  | "conflicted"
  | "stopped"
  | "deleted"
  | "failed";
export type SandboxDiffKind = "add" | "modify" | "delete" | "rename" | "mode";

export type ProviderReasoningBlock = {
  text?: string;
  field?: string;
  signature?: string;
  redacted?: boolean;
  providerMetadata?: Record<string, unknown>;
};

export type ProviderContentPart =
  | { type: "text"; text: string; textSignature?: string }
  | {
      type: "thinking";
      text?: string;
      field?: string;
      signature?: string;
      redacted?: boolean;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments: string;
      thoughtSignature?: string;
      providerMetadata?: Record<string, unknown>;
    };

export type DurableContextCheckpointRecord = {
  entries: Array<{
    id: string;
    role:
      | "system"
      | "user"
      | "assistant"
      | "tool_call"
      | "tool_result"
      | "dynamic"
      | "resource"
      | "summary";
    content: string;
    tokens?: number;
    pairID?: string;
    artifactRef?: string;
    attachments?: LocalAttachment[];
    reasoningContent?: string;
    reasoningField?: string;
    reasoningSignature?: string;
    reasoningRedacted?: boolean;
    /** Ordered Anthropic thinking blocks, including per-block signatures. */
    reasoningBlocks?: ProviderReasoningBlock[];
    /** Ordered provider-native assistant content parts. */
    contentParts?: ProviderContentPart[];
    /** Generic provider metadata carried across turns. */
    providerMetadata?: Record<string, unknown>;
    /** Gemini thought signature attached to a non-thought text part. */
    textSignature?: string;
    thoughtSignature?: string;
  }>;
  checkpoint?: {
    messageCount: number;
    tokens: number;
    inputTokens?: number;
    outputTokens?: number;
    source: "provider_usage" | "estimate";
  };
  resources: Array<{
    kind:
      | "background"
      | "process"
      | "agent"
      | "terminal"
      | "sandbox"
      | "workflow"
      | "skill";
    id: string;
    summary: string;
  }>;
  journalOffset: number;
  step: number;
  tokenEstimate: number;
  compactionGeneration: number;
};

export type CheckpointChangeKind =
  | "add"
  | "modify"
  | "delete"
  | "rename"
  | "mode"
  | "symlink";

export type RuntimeDiffLineType = "context" | "add" | "delete" | "hunk";

export type RuntimeStructuredDiffWordRange = {
  start: number;
  end: number;
  kind: "added" | "deleted";
};

export type RuntimeStructuredDiffLine = {
  type: RuntimeDiffLineType;
  text: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  wordRanges?: RuntimeStructuredDiffWordRange[];
};

export type RuntimeStructuredDiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: RuntimeStructuredDiffLine[];
};

export type RuntimeStructuredDiff = {
  hunks: RuntimeStructuredDiffHunk[];
  additions: number;
  deletions: number;
};

export type RuntimeAstNode = {
  nodeKind: string;
  text: string;
  start: number;
  end: number;
};

export type CheckpointResourcePolicy = {
  kind:
    | "subagent"
    | "process"
    | "background"
    | "terminal"
    | "sandbox"
    | "workflow"
    | "tool"
    | "pending_modal";
  id: string;
  action: "stop" | "preserve_dirty" | "cancel" | "invalidate" | "none";
  summary: string;
};

export type CheckpointPreview = {
  checkpointID: string;
  safetyCheckpointID?: string;
  dryRun: boolean;
  changes: Array<{
    kind: CheckpointChangeKind;
    path: string;
    oldPath?: string;
    mode?: string;
    patch?: string;
    before?: string;
    after?: string;
    additions?: number;
    deletions?: number;
    structured?: RuntimeStructuredDiff;
  }>;
  context: {
    truncateMessages: number;
    targetJournalOffset: number;
    targetStep: number;
    targetTokens: number;
    compactionGeneration: number;
  };
  resources: CheckpointResourcePolicy[];
  ignoredFiles: number;
  diskUsageBytes: number;
  complete: boolean;
  warnings: string[];
};
export type RuntimeCheckpoint = {
  id: string;
  sequence: number;
  turnID?: string;
  stepID?: string;
  step: number;
  reason:
    | "baseline"
    | "turn_begin"
    | "step_begin"
    | "manual"
    | "pre_tool"
    | "pre_compaction"
    | "rollback_safety"
    | "audit_round";
  name?: string;
  createdAt: string;
  complete: boolean;
  errors: string[];
  files: number;
  changes: number;
  tokenEstimate: number;
  diskUsageBytes: number;
};
export type ProjectionContribution = {
  name: string;
  title: string;
  placement: "tool-card" | "sidebar";
  text?: string;
};

export type RuntimeSandbox = {
  id: string;
  root: string;
  isolationLevel: "workspace" | "container" | "vm";
  changedFiles: number;
  runningResources: number;
  envAllowlist: string[];
};
export type RuntimeSandboxChange = {
  kind: SandboxDiffKind;
  path: string;
  oldPath?: string;
  mode?: string;
  patch?: string;
  before?: string;
  after?: string;
  additions?: number;
  deletions?: number;
  structured?: RuntimeStructuredDiff;
};

export type RuntimeWorkspaceDiffChange = {
  path: string;
  operation: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  additions: number;
  deletions: number;
  patch?: string;
  before?: string;
  after?: string;
  mode?: string;
  structured?: RuntimeStructuredDiff;
};

export type CheckpointKind =
  | "audit"
  | "manual"
  | "auto_safety"
  | "rollback_safety";

export type AuditRoundRecord = {
  checkpointID: string;
  planID: string;
  round: number;
  verdict: "gaps" | "passed";
  auditReportAt: string;
  sequence: number;
  createdAt: string;
};

export type CheckpointRef =
  | { kind: "checkpoint"; id: string }
  | { kind: "round"; planID: string; round: number }
  | { kind: "last_audit"; planID?: string }
  | { kind: "baseline" }
  | { kind: "current" };

export type DiffCheckpointsOptions = {
  paths?: string[];
  includePatch?: boolean;
  includeContent?: boolean;
  maxFiles?: number;
  maxPatchChars?: number;
};

export type RuntimeTeamPR = {
  id: string;
  sandboxID: string;
  status: string;
  task: string;
  result?: string;
  buildEvidence?: {
    ok: boolean;
    exitCode: number;
    output: string;
  };
  diff: RuntimeWorkspaceDiffChange[];
};

export type RuntimeGitRef = {
  name: string;
  kind: "branch" | "tag" | "worktree";
  path?: string;
  current?: boolean;
};
export type RuntimeSandboxResource = {
  id: string;
  sandboxID: string;
  command: string;
  pid: number;
  status: "running" | "exited" | "failed" | "stopped";
  outputPath: string;
  startedAt: string;
  endedAt?: string;
};

export type ToolStatus =
  | "receiving_arguments"
  | "queued"
  | "awaiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "rejected"
  | "cancelled";

/**
 * The header every card kind carries.
 *
 * `body` is the MIGRATION slot: until a tool's family lands its structured
 * fields (refactor batches R1-R5) the tool still projects its readable body
 * as text here, and a client renders it. The five structured kinds stop
 * carrying `body` when their structured fields land; `generic` keeps it
 * forever, because an envelope tool's result is its own document and the
 * tool owns the reading of it.
 */
export type ToolCardHeader = {
  /** Card title: a path, a command, a query. */
  title: string;
  /** One-line summary for the collapsed row. */
  summary: string;
  /** The tool's own body text (see the note above). */
  body?: string;
  /** Label/value facets: exit code, total lines, ... */
  meta?: ToolCardFacet[];
};

/**
 * The card a tool draws for one of its calls (UI refactor R0; the fourth
 * corner — the `meta` slot beside it is the `presentationMeta` sibling).
 *
 * A card is a projection, not presentation: the tool says what the call or
 * the result MEANS (a file read, a diff, a terminal run, a search) and a
 * client renders that however it likes. It travels on the `tool.update`
 * event's structured slot so a replayed event renders like a live one —
 * the card is recorded beside the result instead of being re-derived from
 * the result string by whoever happens to be looking at it.
 *
 * The union is the whole vocabulary of a card: six kinds, and a client
 * switches on `kind`, never on a tool name.
 */
export type ToolCard =
  | (ToolCardHeader & {
      kind: "read";
      /** The file the window was read from. */
      path?: string;
      /** First line shown (1-based). */
      offset?: number;
      /**
       * The window's own lines, each keeping the FILE's line number — the
       * reference implementation's shape, so a client renders a numbered
       * gutter (and can highlight by `lang`) instead of counting rows.
       */
      lines?: Array<{ number: number; text: string }>;
      /** Lines the file has. */
      totalLines?: number;
      /** Language hint for the content renderer. */
      lang?: string;
      /** Whether a cap cut the page short of the file. */
      truncated?: boolean;
      /**
       * The page itself — the file's own lines, verbatim. A client renders
       * them as content (and may colour them by `lang`); nothing re-parses
       * or flattens them, which is the whole point of the read card (a JSON
       * file used to arrive as `key: value` lines through the flatten).
       */
      content?: string;
    })
  | (ToolCardHeader & {
      kind: "diff";
      path?: string;
      hunks?: RuntimeStructuredDiffHunk[];
    })
  | (ToolCardHeader & {
      kind: "terminal";
      command?: string;
      output?: string;
      exitCode?: number;
      cwd?: string;
    })
  | (ToolCardHeader & {
      kind: "search";
      query?: string;
      /** A content search's hits: where and what matched. */
      matches?: Array<{ path: string; line: number; text: string }>;
      /**
       * A path search's listing (a glob): every path the pattern matched.
       * Not a `matches` set — a match names a line, a listing names files.
       */
      paths?: string[];
      truncated?: boolean;
      nextCursor?: string;
    })
  | (ToolCardHeader & {
      kind: "web";
      url?: string;
      answer?: string;
      sources?: Array<{ title?: string; url: string }>;
    })
  | (ToolCardHeader & {
      kind: "generic";
      /**
       * A Q&A's structure, when the tool is a question (the
       * AskQuestionCard): the question asked, the choices offered, the
       * answers picked. Composed by the TOOL, which holds both halves — the
       * arguments and the result — so no consumer re-derives them (the
       * 2026-10-08 Q&A fight: a UI deriving the question from a re-plumbed
       * arguments chain broke for a day).
       */
      question?: string;
      options?: string[];
      answers?: string[];
      /**
       * A checklist's rows, when the call's answer IS a list of things with
       * a done state (the todo card): each row's text and whether it is
       * done. A client draws `[x]`/`[ ]` rows — the way it colors a diff's
       * marks — and parses nothing. The 2026-10-08 ruling: the checklist
       * rendered from a parsed envelope body was a name-keyed special case;
       * this is the same reading as CARD DATA.
       */
      checklist?: Array<{ text: string; done: boolean }>;
    });

/** A card's label/value facets (exit code, total lines, ...). */
export type ToolCardFacet = [label: string, value: string];

/** The card kinds, in the dispatch order a renderer switches on. */
export const TOOL_CARD_KINDS = [
  "read",
  "diff",
  "terminal",
  "search",
  "web",
  "generic",
] as const;

export type ToolCardKind = ToolCard["kind"];

export type CollaborationParticipant = "main_agent" | "live_chat" | "nia";

export type ChatChannel = "navi" | "nia";

export type ChatEventNamespace = "navi" | "nia";

type ChatEventData<Namespace extends ChatEventNamespace> =
  | {
      type: `${Namespace}.chat.model.profile`;
      profile: ChatModelProfile;
    }
  | {
      type: `${Namespace}.chat.turn.started`;
      id: string;
      messageID: string;
      startedAt: number;
      internal?: boolean;
    }
  | {
      type: `${Namespace}.chat.turn.phase`;
      id: string;
      messageID: string;
      phase: "waiting" | "thinking" | "generating" | "using_tool";
      toolName?: string;
    }
  | {
      type: `${Namespace}.chat.turn.finished`;
      id: string;
      messageID: string;
      stopReason: "done" | "error" | "cancelled";
      startedAt: number;
      endedAt: number;
      error?: string;
    }
  | {
      type: `${Namespace}.chat.message.new` | `${Namespace}.chat.message.added`;
      id: string;
      messageID: string;
      role: "user" | "chat";
      text: string;
      at: string;
      attachments?: LocalAttachment[];
    }
  | {
      type: `${Namespace}.chat.message.delta`;
      id: string;
      messageID: string;
      text: string;
    }
  | {
      type: `${Namespace}.chat.thinking.delta`;
      id: string;
      messageID: string;
      text: string;
    }
  | {
      /** Durable full thinking settlement for replay after live deltas expire. */
      type: `${Namespace}.chat.thinking.done`;
      id: string;
      messageID: string;
      text: string;
    }
  | {
      type: `${Namespace}.chat.tool.used`;
      id: string;
      messageID: string;
      toolName: string;
      status: string;
      summary: string;
      result?: string;
      argumentsRaw?: string;
      /**
       * The tool's own card for this call (UI refactor R4), computed by the
       * publisher from the tool's output definition exactly as the main
       * runtime path does. A chat turn executes its tools directly, so the
       * projection is made here rather than by the shared execution stage.
       */
      card?: ToolCard;
      meta?: Record<string, unknown>;
      /**
       * The provider call's id, the ONLY thing that pairs a tool result with
       * the assistant `toolCalls` entry an OpenAI-compatible gateway requires.
       * Without it the rebuilt history either drops the tool exchange or emits
       * an unpaired `role: "tool"` message, and the gateway rejects the next
       * turn with "tool_calls.id and tool_calls.type are required".
       */
      toolCallID?: string;
      startedAt?: number;
      endedAt?: number;
      at: string;
    }
  | {
      type: `${Namespace}.chat.compaction`;
      id: string;
      state: "started" | "finished";
      beforeTokens: number;
      afterTokens?: number;
      success?: boolean;
    }
  | {
      type: `${Namespace}.chat.rollback`;
      id: string;
      toMessageID: string;
      removed: number;
      at: string;
    }
  | {
      /** Durable chat compaction: replaces messages through this boundary with a summary. */
      type: `${Namespace}.chat.compacted`;
      id: string;
      messageID: string;
      summary: string;
      compactedThroughMessageID: string;
      at: string;
    };

/**
 * Pre-namespace chat records remain readable only so persisted session journals
 * written before the stream split can be replayed. New producers use
 * `navi.chat.*` or `nia.chat.*` exclusively.
 */
type LegacyChatEventData =
  | {
      type: "chat.model.profile";
      channel: ChatChannel;
      profile: ChatModelProfile;
    }
  | {
      type: "chat.turn.started";
      id: string;
      messageID: string;
      startedAt: number;
      internal?: boolean;
      channel?: ChatChannel;
    }
  | {
      type: "chat.turn.phase";
      id: string;
      messageID: string;
      phase: "waiting" | "thinking" | "generating" | "using_tool";
      toolName?: string;
      channel?: ChatChannel;
    }
  | {
      type: "chat.turn.finished";
      id: string;
      messageID: string;
      stopReason: "done" | "error" | "cancelled";
      startedAt: number;
      endedAt: number;
      error?: string;
      channel?: ChatChannel;
    }
  | {
      type: "chat.message.added";
      id: string;
      messageID: string;
      role: "user" | "chat";
      text: string;
      at: string;
      attachments?: LocalAttachment[];
      channel?: ChatChannel;
    }
  | {
      type: "chat.message.delta";
      id: string;
      messageID: string;
      text: string;
      channel?: ChatChannel;
    }
  | {
      type: "chat.thinking.delta";
      id: string;
      messageID: string;
      text: string;
      channel?: ChatChannel;
    }
  | {
      type: "chat.tool.used";
      id: string;
      messageID: string;
      toolName: string;
      status: string;
      summary: string;
      result?: string;
      argumentsRaw?: string;
      /** The tool's own card, when the publisher projected one. */
      card?: ToolCard;
      meta?: Record<string, unknown>;
      startedAt?: number;
      endedAt?: number;
      at: string;
      channel?: ChatChannel;
    }
  | {
      type: "chat.rollback";
      id: string;
      toMessageID: string;
      removed: number;
      at: string;
      channel?: ChatChannel;
    };

export type CollaborationKind =
  | "chat"
  | "suggestion"
  | "notice"
  | "question"
  | "answer"
  | "response";

type CollaborationMessageBase = {
  id: string;
  threadID: string;
  replyToID?: string;
  from: CollaborationParticipant;
  to: CollaborationParticipant;
  kind: CollaborationKind;
  text: string;
  expectsReply: boolean;
  at: string;
};

export type CollaborationMessage =
  | (CollaborationMessageBase & {
      kind: "chat";
      round: number;
    })
  | (CollaborationMessageBase & {
      kind: "suggestion";
      expectsReply: true;
      priority: "normal" | "high";
      rationale?: string;
    })
  | (CollaborationMessageBase & {
      kind: "notice";
      expectsReply: false;
      noticeType: "step_completed" | "blocked" | "needs_input" | "risk";
    })
  | (CollaborationMessageBase & {
      kind: "question";
      expectsReply: true;
    })
  | (CollaborationMessageBase & {
      kind: "answer";
      replyToID: string;
      expectsReply: false;
      /**
       * The advisor contract's outcome (block B): `declined` means the
       * advisor refused to advise (out of remit) and the text says why —
       * a legitimate answer, not a failure. Absent on journals written
       * before the field; the consult ledger reads the absence as advised.
       */
      advisorOutcome?: "advised" | "declined";
    })
  | (CollaborationMessageBase & {
      kind: "response";
      replyToID: string;
      decision: "adopted" | "rejected" | "deferred";
      reason?: string;
      expectsReply: false;
    });

/**
 * Namespaced collaboration events. New producers must publish one of these so
 * each agent stream can project by namespace instead of filtering a shared
 * `collab.*` payload by `from`/`to` at every consumer. The legacy shared
 * `collab.*` types remain for journals written before the stream split.
 */
export type NamespacedCollabMessageEventData =
  | {
      type: "natalia.collab.message";
      message: CollaborationMessage;
    }
  | {
      type: "navi.collab.message";
      message: CollaborationMessage;
    }
  | {
      type: "nia.collab.message";
      message: CollaborationMessage;
    };

/**
 * Why a long-running thing settled — the settlement spine's closed set
 * (the stopReason taxonomy, Natalia-flavored). A notice's
 * tone and the model's next move both key off it; a free string let a
 * typo reach durable state where a consumer switching on the reason
 * would silently fall through to a default — the exact failure the
 * closed set exists to prevent. `unknown` is the honest landing for an
 * unnameable ending: reported, never silently treated as success.
 */
export type SettlementReason =
  /** The thing finished its work. */
  | "completed"
  /** It ended in failure (a non-zero exit, a thrown turn). */
  | "failed"
  /** It was stopped before finishing (abort, kill, cancel). */
  | "stopped"
  /** It reached readiness (a ready pattern matched, a service is up). */
  | "ready"
  /** A rendered screen settled (the terminal's quiescence boundary). */
  | "settled"
  /** A full screen scrolled past (the terminal's flow boundary). */
  | "scrolled"
  /** The underlying process exited (the terminal's death boundary). */
  | "exited"
  /** It ended worse than failed but short of a diagnosis. */
  | "degraded"
  /** An unnameable ending — reported, never assumed a success. */
  | "unknown";

/**
 * A subagent's mid-run message to its spawning session: a finding the
 * parent should hear NOW, delivered through the spine. It is NOT a
 * settlement — the child has not ended — so it travels its own event
 * and the settlement reason set stays what it is.
 */
export type SubagentMessageEventData = {
  type: "subagent.message";
  id: string;
  /** The child that sent it. */
  agentId: string;
  text: string;
  at: string;
};

/**
 * A settlement notice: a long-running thing (a managed process, a
 * terminal pane, a subagent, a team PR) reached a boundary, and the
 * main agent is TOLD instead of left polling. The notice is an input,
 * not a command — the model decides when to read it — and every notice
 * is a durable fact so replay and audit see what the model was told.
 */
/**
 * The settlement notice as adopters hand it to the spine: what settled,
 * why, and the one model-facing line. The event above is its durable
 * form; this is the call shape.
 */
export type SettlementNotice = {
  subject: string;
  reason: SettlementReason;
  summary: string;
  detail?: string;
  sourceKind: string;
};

export type SettlementNoticeEventData = {
  type: "settlement.notice";
  id: string;
  /** What settled: the process id, the terminal id, the task id, the PR key. */
  subject: string;
  reason: SettlementReason;
  /** The model-facing line, carried by the injected notice. */
  summary: string;
  /** Optional payload: a closing message, an exit code, a frame diff. */
  detail?: string;
  /** The producer's kind: process-exited | terminal-settled | subagent-settled | team-pr. */
  sourceKind: string;
  at: string;
};

/** Durable lifecycle phase of a same-session goal. */
export type GoalPhase = "active" | "paused" | "blocked" | "complete";

/**
 * Why a goal is blocked, as a machine code.
 *
 * A closed set rather than a free string: three sites set it — the goal driver
 * when a round cap or a turn error stops continuation, and the goal tools when
 * the model itself reports a blocker. A free string let a typo in any of them
 * reach durable state, where a consumer switching on the code would silently
 * fall through to a default and the goal would display as blocked with no
 * reason it could name.
 */
export type GoalBlockCode =
  /** The admitted goal-round cap was reached. */
  | "round-limit"
  /** A goal round's turn failed. */
  | "turn-error"
  /** The model reported a blocker from inside a goal round. */
  | "model-reported"
  /** A goal round could not be queued. */
  | "queue-failed"
  /** Automatic continuation was cancelled. */
  | "cancelled"
  /** The goal round exhausted its token budget. */
  | "max-tokens"
  /** The goal's cumulative token budget was exhausted. */
  | "token-limit"
  /** The goal's cumulative wall-clock budget was exhausted. */
  | "time-limit";

/** Stable machine code plus human text explaining a blocked goal. */
export type GoalBlockReason = { code: GoalBlockCode; message: string };

/**
 * Why automatic continuation last stopped. Explanatory only: `phase` stays the
 * authority, and a durable `lastStop` is what lets the UI explain a stop after
 * the process-local activation has been lost to a restart.
 */
export type GoalLastStop = { code: string; at: number; message?: string };

/** Operations a durable `goal.changed` mutation can carry. */
export type GoalOperation =
  | "create"
  | "edit"
  | "pause"
  | "resume"
  | "complete"
  | "blocked"
  | "clear";

/**
 * Human-initiated edit of the current goal (status-bar inline editor). The
 * `goalID`/`revision` pair is a compare-and-set guard so an edit cannot clobber
 * a concurrent round or mutation. At least one field must be present.
 */
export type GoalEditInput = {
  goalID: string;
  revision: number;
  objective?: string;
  maxGoalRounds?: number;
  planID?: string;
};

/** Full durable goal state after one accepted mutation. */
export type GoalSnapshot = {
  goalID: string;
  /** Compare-and-set revision; every durable mutation increments it. */
  revision: number;
  objective: string;
  phase: GoalPhase;
  /** Present exactly while `phase` is `blocked`. */
  blockedReason?: GoalBlockReason;
  lastStop?: GoalLastStop;
  /** Admitted goal-round cap; 0 means unlimited. */
  maxGoalRounds: number;
  /**
   * Cumulative token cap for the whole goal; 0 means unlimited.
   *
   * Separate from `maxGoalRounds` because rounds are a poor proxy for cost: ten
   * short exchanges and ten file reads are the same round count and an order of
   * magnitude apart in tokens.
   */
  maxGoalTokens: number;
  /** Cumulative goal-work wall-clock cap in ms; 0 means unlimited. */
  maxGoalWallClockMs: number;
  /**
   * Tokens the goal's rounds have spent, carried forward by settled rounds.
   *
   * Derived from the durable `goal.round.cost` events rather than stored as a
   * running total, so a restart replays to exactly the same figure instead of
   * trusting whatever the last process happened to know.
   */
  spentGoalTokens: number;
  /** Wall-clock the goal's rounds have consumed, in ms. */
  goalWallClockMs: number;
  /** Optional plan this goal works toward (goal → plan, one-way reference). */
  planID?: string;
};

/**
 * Live goal projection: the durable snapshot plus facts derived from the
 * session log. `activation` is process-local: a projection folded from the log
 * (restart, resume, fork, replay) is always `disarmed`, so opening a session
 * never starts work by itself.
 */
export type GoalView = GoalSnapshot & {
  /** Highest admitted goal round. */
  roundsStarted: number;
  /** ISO timestamp of the create mutation. */
  createdAt: string;
  /** ISO timestamp of the latest mutation. */
  updatedAt: string;
  /** Process-local continuation eligibility; never persisted. */
  activation: "armed" | "disarmed";
};

/** Round attribution stamped on a goal-sourced turn. */
export type GoalMessageSource = {
  goalID: string;
  revision: number;
  round: number;
};

type RuntimeEventData =
  | {
      type: "session.created";
      sessionID: SessionID;
      title: string;
      workspaceID?: string;
    }
  | { type: "session.title.updated"; sessionID: SessionID; title: string }
  | { type: "session.ready"; sessionID: SessionID }
  | {
      type: "turn.submitted";
      id: string;
      text: string;
      byteLength: number;
      lineCount: number;
      sha256: string;
      /** Admission intent. Queued turns are durable but have not started yet. */
      delivery?: "next-turn" | "next-step";
      /** Runtime-generated wake boundary; never human-authored input. */
      internal?: boolean;
      attachments?: LocalAttachment[];
      resources?: PromptResourceMention[];
      agents?: PromptAgentMention[];
    }
  | { type: "turn.started"; id: string }
  | {
      /**
       * Durable admission of a user/injected input. It is *not* a turn: a
       * `next-turn` (or a `next-step` admitted while idle) becomes one when the
       * turn actually starts, at which point `turn.submitted` is published with
       * the same id. A `next-step` claimed by a running turn is instead
       * announced as `turn.input`.
       */
      type: "input.admitted";
      id: string;
      text: string;
      byteLength: number;
      lineCount: number;
      sha256: string;
      delivery: "next-turn" | "next-step";
      /** Runtime-generated wake boundary; never human-authored input. */
      internal?: boolean;
      attachments?: LocalAttachment[];
      resources?: PromptResourceMention[];
      agents?: PromptAgentMention[];
      admittedAt: string;
      admittedSeq: number;
    }
  | {
      type: "input.updated";
      id: string;
      text: string;
      byteLength: number;
      lineCount: number;
      sha256: string;
    }
  | { type: "input.removed"; id: string }
  | { type: "input.promoted"; id: string }
  | {
      type: "turn.input";
      /** Turn this input was injected into. */
      turnID: string;
      /** Admitted inbox input this message came from. */
      inputID: string;
      text: string;
      /** Injection intent. Only `next-step` inputs are claimed mid-turn. */
      delivery?: "next-turn" | "next-step";
      /** Runtime-generated input; never human-authored. */
      internal?: boolean;
    }
  | { type: "turn.cancelled"; id: string; reason: string }
  | { type: "turn.paused"; id: string; reason: string }
  | { type: "turn.resumed"; id: string }
  | {
      type: "thinking.delta";
      id: string;
      text: string;
      visible?: boolean;
      attempt?: number;
    }
  | {
      type: "thinking.done";
      id: string;
      text?: string;
      visible?: boolean;
      attempt?: number;
      /** Provider-native reasoning field, e.g. reasoning_content. */
      reasoningField?: string;
      /** Anthropic thinking signature or Gemini thought signature. */
      reasoningSignature?: string;
      /** Anthropic redacted_thinking payload. */
      reasoningRedacted?: boolean;
      /** Ordered Anthropic thinking blocks, including per-block signatures. */
      reasoningBlocks?: ProviderReasoningBlock[];
    }
  | { type: "content.delta"; id: string; text: string; attempt?: number }
  | {
      /**
       * A throttled, durable batch of streamed assistant text. `content.delta`
       * stays live-only (one event per provider chunk would bloat the journal);
       * this is the durable copy, so an abrupt process death does not lose the
       * text already generated. Batches are incremental and concatenate in
       * order to the same text as the step's final `content.done`.
       */
      type: "content.partial";
      id: string;
      text: string;
      at: string;
    }
  | {
      type: "content.done";
      id: string;
      text?: string;
      /** Gemini thought signature attached to this text part. */
      textSignature?: string;
      /** Ordered provider-native assistant content parts. */
      contentParts?: ProviderContentPart[];
      /** Generic provider metadata carried across turns. */
      providerMetadata?: Record<string, unknown>;
      attempt?: number;
    }
  | {
      type: "step.retry";
      id: string;
      operation: StepRetryOperation;
      step: number;
      attempt: number;
      /** Null means the retry budget is unlimited. */
      maxAttempts: number | null;
      waitMs: number;
      reason: ErrorKind;
      statusCode?: number;
    }
  | {
      type: "step.retry.cleared";
      id: string;
      operation: StepRetryOperation;
      step: number;
      attempts: number;
    }
  | {
      type: "step.retry.exhausted";
      id: string;
      operation: StepRetryOperation;
      step: number;
      attempts: number;
      /** Null means the retry budget is unlimited. */
      maxAttempts: number | null;
      reason: ErrorKind;
      statusCode?: number;
      message: string;
      /**
       * False when the attempt budget was never the limit because the failure
       * could not be retried. Without it, stopping after one of three attempts
       * reads as if retries had been used up.
       */
      retryable?: boolean;
    }
  | {
      type: "tool.update";
      id: string;
      name: string;
      callID?: string;
      status: ToolStatus;
      summary: string;
      argumentsDelta?: string;
      result?: string;
      metadata?: Record<string, unknown>;
      /**
       * The tool's own card for this call (UI refactor R0). Set from
       * `presentCall` while the call runs and from `presentResult` once it
       * settles; a tool that declared neither leaves it absent and a client
       * falls back to the legacy `metadata.render` blob (or to the plain
       * result) — replay compatibility is what makes the migration batchable.
       */
      card?: ToolCard;
      /**
       * The tool's `presentationMeta` output: structured facts that travel
       * WITH the result rather than being re-derived from it later. A client
       * reads these instead of parsing the result string.
       */
      meta?: Record<string, unknown>;
      /** Gemini thought signature that must be replayed with this tool call. */
      thoughtSignature?: string;
      startedAt?: number;
      endedAt?: number;
    }
  | {
      type: "policy.decision";
      turnID: string;
      toolName: string;
      toolCallID?: string;
      decision: "allow" | "deny" | "approval_required" | "rejected";
      reason?: string;
    }
  | {
      type: "subagent.update";
      id: string;
      status:
        | "idle"
        | "running"
        | "paused"
        | "stopped"
        | "completed"
        | "failed";
      attached: boolean;
      event:
        | "created"
        | "status"
        | "log"
        | "done"
        | "stopped"
        | "resumed"
        | "attached"
        | "detached"
        | "activity";
      task?: string;
      text?: string;
      parentSessionID?: string;
      parentAgentID?: string;
      continuation?: number;
      phase?:
        | "idle"
        | "queued"
        | "provider"
        | "tool"
        | "retrying"
        | "finalizing"
        | "waiting";
      activityDetail?: string;
      health?: "active" | "quiet" | "stalled" | "terminal";
      lastActivityAt?: number;
      startedAt?: number;
      endedAt?: number;
      stopReason?: string;
      requestedBy?: "model" | "user" | "parent" | "runtime";
      force?: boolean;
    }
  | {
      type: "mcp.status";
      server: string;
      status: "disabled" | "connected" | "failed" | "unsupported_auth_flow";
      tools: number;
      message?: string;
    }
  | { type: "agent.selection"; name?: string; pending: boolean }
  | { type: "model.selection"; modelID?: string; variant?: string }
  | {
      type: "model.reasoning.set";
      reasoningEffort?: RuntimeReasoningEffort;
    }
  | ChatEventData<"navi">
  | ChatEventData<"nia">
  | LegacyChatEventData
  | {
      type: "session.permission.mode";
      mode: "ask" | "auto" | "read_only";
      profile?: string;
    }
  | {
      type: "projections.updated";
      contributions: ProjectionContribution[];
    }
  | {
      type: "plugin.update";
      id: string;
      status: "loaded" | "unloaded" | "denied" | "failed";
      detail?: string;
    }
  | {
      type: "session.snapshot";
      id: string;
      agentStatus: string;
      /**
       * The session's confinement posture (sandbox study §6b①): the
       * effective file-effect mode this session runs under, plus the last
       * escalation fact when one exists. The UI's danger indicator reads
       * this and the journal's `confinement.escalated` — the same source,
       * never a second state.
       */
      confinement?: {
        mode: import("./schema-types").ConfinementMode;
        escalatedAt?: string;
        escalatedTo?: import("./schema-types").ConfinementMode;
        justification?: string;
      };
      /**
       * The L1 read fabric's counters (DoD #3's "命中", made observable):
       * the aggregate hit/miss over its kinds and the per-kind split. A
       * cache nobody can read the earning of is a cache nobody can judge
       * — the same lesson the confinement posture rides.
       */
      cache?: {
        hits: number;
        misses: number;
        byKind: Record<
          string,
          { hits: number; misses: number; evictions: number }
        >;
        /**
         * The provider prefix-cache tier (RINA Phase 5's observable): the
         * session's steps and how much of their input the provider served
         * from its prefix cache. Absent when the session has run no step —
         * the fabric's law is that EVERY cache tier is independently
         * observable, and a tier with no use rides nothing, not zeros.
         */
        provider?: {
          steps: number;
          inputTokens: number;
          cacheReadTokens: number;
          /** cacheReadTokens / inputTokens, 0 when no input was billed. */
          hitShare: number;
        };
      };
      currentStep?: string;
      activeTool?: string;
      changedFiles: number;
      unvalidatedChanges: number;
      recentOutput?: string;
      hasPTY: boolean;
      hasSandbox: boolean;
    }
  | {
      type: "drift.finding_opened";
      id: string;
      findingID: string;
      severity: "advisory" | "warning" | "high";
      confidence: number;
      originalObjective: string;
      currentActivity: string;
      evidence: string[];
      applicableConstraints: string[];
      /**
       * The evaluation contract version (EI §8.6): the judgment-matrix rule
       * set that produced this finding. Bumped when the rules change so a
       * finding is always judge-able against the contract that opened it.
       */
      contractVersion: number;
      /**
       * Which rules fired, each with its confidence (EI §8.6): the explainable
       * judgment matrix behind the finding.
       */
      ruleHits?: Array<{ rule: string; confidence: number }>;
      /** The planID of the accepted contract judged against, when any. */
      planID?: string;
    }
  | {
      type: "drift.finding_updated";
      id: string;
      findingID: string;
      /**
       * The finding status transition (EI §8.6): open (detected), explained
       * (the agent acknowledged with a rationale), disputed (the agent
       * disagrees), dismissed (the user closed it), corrected (the work
       * realigned), detour_declared (the agent declared a sanctioned detour).
       */
      status:
        | "open"
        | "explained"
        | "disputed"
        | "dismissed"
        | "corrected"
        | "detour_declared";
      rationale?: string;
    }
  | {
      type: "tool.registered";
      id: string;
      name: string;
      owner: string;
      scope: "process" | "workspace" | "session";
      recovery: "none" | "retry" | "restart" | "fail_closed";
      precedence: number;
      requiresApproval: boolean;
    }
  | {
      type: "tool.unregistered";
      id: string;
      name: string;
    }
  | {
      type: "capability.loaded";
      id: string;
      apiVersion: number;
      name: string;
      version: string;
      scope: "process" | "workspace" | "session";
      grants: string[];
    }
  | {
      type: "capability.unloaded";
      id: string;
      name: string;
    }
  | {
      type: "workgraph.node_added";
      id: string;
      nodeID: string;
      kind: import("./schemas").WorkGraphNodeKind;
      summary: string;
      actor?: string;
      target?: string;
      sessionID?: string;
      turnID?: string;
      /** The plan this node belongs to (B7 provenance). */
      planID?: string;
    }
  | {
      type: "workgraph.edge_added";
      id: string;
      sourceID: string;
      targetID: string;
      kind: import("./schemas").WorkGraphEdgeKind;
      reason?: string;
    }
  | {
      type: "evidence.recorded";
      id: string;
      taskID: string;
      objective: string;
      status:
        | "planned"
        | "implemented"
        | "validated"
        | "accepted"
        | "promoted"
        | "blocked"
        | "failed"
        | "partial";
      changes?: Array<{
        path: string;
        changeType: "added" | "modified" | "deleted";
        summary: string;
      }>;
      validations?: Array<{
        command: string;
        result: "passed" | "failed" | "skipped";
        safeSummary: string;
        /** EI E2: a ref to the stored (redacted) full output of the run. */
        artifactRef?: string;
        durationMs?: number;
      }>;
      knownGaps?: string[];
      /** EI E2: when the evidence was recorded (the journal id is opaque). */
      recordedAt?: string;
      /** EI E2: a safe environment summary (platform/arch), never a path. */
      environment?: string;
      /** EI E2: repository version the evidence was recorded against. */
      repositoryVersion?: string;
      /** EI E2: git commit hash the evidence was recorded against (safe, public). */
      commit?: string;
      /** EI E2: a safe manifest ref (catalog/plugin-store id, never a path). */
      manifestRef?: string;
    }
  | {
      type: "completion.recorded";
      id: string;
      taskID: string;
      objective: string;
      /** The fixed completion-card report structure (§5). */
      changeSummary: string;
      behaviorImpact?: string;
      validations: Array<{
        command: string;
        result: "passed" | "failed" | "skipped";
        safeSummary: string;
        artifactRef?: string;
        durationMs?: number;
      }>;
      humanValidation?: string;
      knownGaps?: string[];
      externalSideEffects?: string[];
      rollbackState?: "clean" | "available" | "none" | "needs_promotion";
      evidenceIDs?: string[];
      recordedAt: string;
    }
  | {
      /**
       * A human's validation note on a completion card (EI Phase 0: "用户走 UI 补
       * humanValidation"). Durable and append-only; the `completions` read surface
       * merges the latest one for a task onto its completion card.
       */
      type: "completion.human_validation";
      id: string;
      taskID: string;
      validation: string;
      recordedAt: string;
    }
  | {
      /**
       * A model-drafted WorkContract (EI §8.2): the scope/verification/constraints
       * the proposer extracted from the plan document, bound to the plan version
       * it was extracted from. Repeatable — a rejected draft is re-proposed with
       * the user's feedback folded in. The projection keeps the latest draft per
       * plan; `work_contract_read` serves it as the "draft" state.
       */
      type: "work_contract.drafted";
      id: string;
      planID: string;
      planVersion: number;
      scope?: string[];
      verification?: string[];
      constraints?: string[];
      draftedAt: string;
      source: "model";
    }
  | {
      /**
       * The user-approved WorkContract — the R (reference frame) drift is judged
       * against. Written once per approval after a gate; a plan document change
       * invalidates the draft and forces a re-propose, it never silently
       * replaces an accepted contract. `unverifiable` marks a plan approved with
       * no extractable fields (advisory-only judgment).
       */
      type: "work_contract.accepted";
      id: string;
      planID: string;
      planVersion: number;
      scope?: string[];
      verification?: string[];
      constraints?: string[];
      acceptedBy: "user";
      acceptedAt: string;
      unverifiable?: boolean;
    }
  | {
      /**
       * A model-declared detour (EI §3.4): the agent asks to work outside the
       * accepted WorkContract's scope, carrying the increments it wants added.
       * `currentVersion` is the optimistic lock — the accepted contract version
       * the detour was declared against; a stale declaration is rejected. The
       * deltas are merged into a new accepted contract (v+1) only after the
       * user approves; a detour never silently replaces the commitment.
       */
      type: "detour.requested";
      id: string;
      detourID: string;
      planID: string;
      currentVersion: number;
      reason: string;
      scopeDelta: string[];
      verificationDelta?: string[];
      constraintDelta?: string[];
      requestedAt: string;
      requestedBy: "model";
    }
  | {
      /**
       * A detour review (EI §3.4): Nia's independent opinion on a requested
       * detour, or the user's final decision. Nia's verdict is always a
       * reference — the approval right is the user's; `unavailable` records that
       * Nia could not review (timeout / crash) and the gate proceeds without an
       * opinion. The user's approval lands as work_contract.accepted(v+1).
       */
      type: "detour.reviewed";
      id: string;
      detourID: string;
      planID: string;
      verdict: "approve" | "reject" | "unavailable";
      rationale?: string;
      reviewedBy: "nia" | "user";
      reviewedAt: string;
    }
  | {
      /**
       * A prompt-level context instruction change (ADR Phase C): the durable
       * journal record that the runtime's prompt-level instructions changed
       * (config reload, agent switch, a plan handoff notice). The projection
       * keeps the latest revision per kind, so a later change supersedes an
       * earlier one without mutating history (D3/D6 latest-win).
       */
      type: "context.instructions";
      id: string;
      /** What produced the instruction change. */
      kind: "config_reload" | "agent_switch" | "plan_handoff" | "notice";
      at: string;
      /** Monotonic per session: the highest revision is the current state. */
      revision: number;
      /** One-line summary of what changed (safe prose). */
      summary: string;
      /** Optional detail lines (safe prose). */
      detail?: string[];
    }
  | {
      /**
       * One provider step's usage and timing, accumulated per session into the
       * token/latency dashboard. Emitted once per provider step by the runner;
       * token fields are omitted when the provider reported none, and timing
       * fields are wall-clock ms measured by the runner (not derived from the
       * event stream).
       */
      type: "runtime.step_usage";
      id: string;
      /**
       * Which provider stream spent the tokens. Missing on legacy events and
       * on the main-agent runner (the safe default is main).
       */
      channel?: "main" | "navi" | "nia";
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      /** Model stream wall time, ms (step start → stream end). */
      llmMs?: number;
      /** First-token latency, ms (step start → first content/thinking chunk). */
      ttftMs?: number;
      /** Provider-reported output tokens on this step (throughput numerator). */
      decodeTokens?: number;
      /** Decode wall time, ms (first token → stream end; throughput denominator). */
      decodeMs?: number;
      /** Tool-execution wall time on this step, ms. */
      toolMs?: number;
    }
  | {
      /** Navi-owned provider step usage; replaces the shared channel tag. */
      type: "navi.runtime.step_usage";
      id: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      llmMs?: number;
      ttftMs?: number;
      decodeTokens?: number;
      decodeMs?: number;
      toolMs?: number;
    }
  | {
      /** Nia-owned provider step usage; replaces the shared channel tag. */
      type: "nia.runtime.step_usage";
      id: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      llmMs?: number;
      ttftMs?: number;
      decodeTokens?: number;
      decodeMs?: number;
      toolMs?: number;
    }
  | {
      type: "constitution.check";
      id: string;
      ruleID: string;
      statement: string;
      priority: "critical" | "high" | "medium" | "low";
      enforcement: "deny" | "approval" | "warn";
      action: string;
      resource: string;
      conflict: boolean;
      override?: { reason: string; approvedBy: string };
    }
  | {
      type: "constitution.rule_added";
      id: string;
      ruleID: string;
      statement: string;
      scope: "project" | "package" | "sandbox" | "task" | "release";
      priority: "critical" | "high" | "medium" | "low";
      source: "user" | "master_plan" | "policy" | "agent_proposed";
      enforcement: "deny" | "approval" | "warn";
      overridePolicy: "forbidden" | "user_scoped" | "user_explicit";
      /**
       * Structured anchor for hard enforcement (EI §3.8 P-1.c): `deny`/`approval`
       * rules require a non-empty appliesTo so the runtime matcher has something
       * to execute against. Prose rules without an anchor stay `warn`.
       */
      appliesTo?: {
        tools?: string[];
        paths?: string[];
        commandPattern?: string;
      };
      evidenceRefs?: string[];
      /** EI §3.7.5 provenance: who proposed an `agent_proposed` rule. */
      proposedBy?: "agent" | "navi";
      /** EI §3.7.5 provenance: a model-proposed rule always lands user-approved. */
      approvedBy?: "user";
    }
  | {
      type: "constitution.override_granted";
      id: string;
      ruleID: string;
      reason: string;
      approvedBy: "user";
      paths?: string[];
      taskID?: string;
      expiresAt?: string;
    }
  | {
      type: "constitution.rule_updated";
      id: string;
      ruleID: string;
      statement?: string;
      priority?: "critical" | "high" | "medium" | "low";
      enforcement?: "deny" | "approval" | "warn";
      overridePolicy?: "forbidden" | "user_scoped" | "user_explicit";
      /** `false` disables the rule without deleting it; the tombstone is
       * `constitution.rule_removed` (EI §3.8 P-1.c). */
      enabled?: boolean;
      appliesTo?: {
        tools?: string[];
        paths?: string[];
        commandPattern?: string;
      };
    }
  | {
      /**
       * Append-only tombstone for a deleted rule (EI §3.8 P-1.c): a disable is a
       * reversible `rule_updated(enabled:false)`, a removal is durable history —
       * `rule_removed` preserves the full audit trail. Only a user may remove;
       * a model never deletes or weakens an existing rule.
       */
      type: "constitution.rule_removed";
      id: string;
      ruleID: string;
      removedAt: string;
      removedBy: "user";
    }
  | {
      type: "decision.recorded";
      id: string;
      decision: string;
      rationale?: string[];
      alternatives?: { option: string; rejectedReason?: string }[];
      consequences?: string[];
      status: "proposed" | "accepted" | "superseded";
      linkedPlans?: string[];
      linkedConstraints?: string[];
      /** Omitted on legacy/model-tool facts, which are session-scoped. */
      scope?: "session" | "workspace";
    }
  | {
      type: "mailbox.queued";
      id: string;
      messageID: string;
      source: "user_via_live_chat" | "system";
      priority: "normal" | "high" | "urgent";
      intent:
        | "clarification"
        | "constraint"
        | "reprioritize"
        | "pause"
        | "cancel"
        | "request_report"
        | "proposed_change"
        | "next_plan_handoff";
      text: string;
      safeSummary: string;
      relatedPlanID?: string;
      deliveryPolicy:
        | "next_safe_boundary"
        | "before_next_tool"
        | "before_next_side_effect"
        | "immediate_control";
      createdAt: string;
    }
  | {
      type: "mailbox.delivered";
      id: string;
      messageID: string;
      deliveredAt: string;
    }
  | {
      type: "mailbox.acknowledged";
      id: string;
      messageID: string;
      acknowledgedAt: string;
    }
  | {
      type: "mailbox.deferred";
      id: string;
      messageID: string;
      reason: string;
      deferredAt: string;
    }
  | {
      type: "mailbox.superseded";
      id: string;
      messageID: string;
      reason: string;
      supersededAt: string;
    }
  | {
      type: "plan.doc.created";
      id: string;
      planID: string;
      title: string;
      documentPath: string;
      createdBy: "user" | "live_chat" | "main_agent";
      status: string;
      createdAt: string;
    }
  | {
      /**
       * A plan document content edit (EI §3.4 / Phase -1.a). Carries the plan
       * document's new `revision` so the WorkContract projection can tell that
       * a draft extracted from an older revision is stale and must be
       * re-proposed. Revisions are monotonic per plan; an accepted contract is
       * never invalidated by an edit — only an unapproved draft is.
       */
      type: "plan.doc.updated";
      id: string;
      planID: string;
      revision: number;
      updatedAt: string;
      reason?: string;
    }
  | {
      type: "plan.doc.marked";
      id: string;
      planID: string;
      markedAt: string;
    }
  | {
      type: "plan.doc.deleted";
      id: string;
      planID: string;
      deletedAt: string;
    }
  | {
      type: "plan.doc.status";
      id: string;
      planID: string;
      status: string;
      at: string;
      reason?: string;
    }
  | {
      /**
       * Durable audit request (EI §3.9). This is the shadow the runtime wakes
       * Nia from: a trigger event requested an independent audit of this plan
       * version, and the request survives restart/dedup.
       */
      type: "audit.requested";
      id: string;
      planID: string;
      planVersion: number;
      triggerEventID: string;
      round: number;
      checkpointID?: string;
      scope: string;
      at: string;
    }
  | {
      type: "goal.changed";
      id: string;
      operation: GoalOperation;
      /** Full post-mutation snapshot; absent for a `clear` tombstone. */
      snapshot?: GoalSnapshot;
      /** Cleared identity, present for `clear`. */
      cleared?: { goalID: string; revision: number };
      /** Admitted goal-round count at the mutation. */
      roundsStarted: number;
      at: string;
    }
  | {
      /**
       * Live projection of the current goal, published when a session attaches.
       * Not durable: it only re-seeds the client projection from the recovery
       * row so the status bar shows an existing goal on startup.
       */
      type: "goal.status";
      goal?: GoalSnapshot & {
        roundsStarted: number;
        activation: "armed" | "disarmed";
      };
      at: string;
    }
  | {
      /**
       * One admitted goal round. Written by the round driver when it admits the
       * `<goal_round>` turn, so replay advances the counter only for rounds the
       * driver actually started (never for a rejected reservation).
       */
      type: "goal.round";
      id: string;
      goalID: string;
      revision: number;
      round: number;
      at: string;
    }
  | {
      type: "goal.round.cost";
      id: string;
      goalID: string;
      revision: number;
      round: number;
      at: string;
      /** Tokens the round spent, input plus output. */
      tokens: number;
      /** Wall-clock the round consumed, ms. */
      durationMs: number;
    }
  | { type: "status.update"; status: string; detail?: string }
  | {
      type: "status.snapshot";
      model: string;
      provider: string;
      context: string;
      step: string;
      permissions: string;
      cwd: string;
      background: string;
      /**
       * The host platform (NodeJS.Platform). Optional so a journal written
       * before this field still parses; the settings surface reads it to
       * decide whether a host-only setting row applies at all — the Git
       * Bash path, which is Windows-only by design (POSIX's shell is bash
       * and needs no configuration).
       */
      platform?: string;
    }
  | {
      type: "context.status";
      channel?: ChatChannel;
      used: number;
      max: number;
      source: ContextStatusSource;
      thresholdPercent: number;
      reserved: number;
      trigger?: CompactionTrigger;
      /** Model-visible message/tool surface tokens (the message bucket). */
      surfaceTokens?: number;
      /** Conservative full-request tokens (header + surface). */
      requestTokens?: number;
      /** systemTokens + toolsTokens. */
      headerTokens?: number;
      /** System-prompt tokens, counted once in the header only. */
      systemTokens?: number;
      /** Tool-definition tokens, counted once in the header only. */
      toolsTokens?: number;
    }
  | {
      /** Durable shared TokenMeter projection for one stream. */
      type: "context.snapshot";
      channel?: ChatChannel;
      usedTokens: number;
      pressureTokens?: number;
      projectedTokens?: number;
      contextWindow?: number;
      source: "estimate" | "provider_usage";
      at: string;
      /** Three-bucket header breakdown, when the request was measured. */
      systemTokens?: number;
      toolsTokens?: number;
      messageTokens?: number;
    }
  | {
      /** Navi-owned TokenMeter projection. */
      type: "navi.context.snapshot";
      usedTokens: number;
      pressureTokens?: number;
      projectedTokens?: number;
      contextWindow?: number;
      source: "estimate" | "provider_usage";
      at: string;
      /** Three-bucket header breakdown, when the request was measured. */
      systemTokens?: number;
      toolsTokens?: number;
      messageTokens?: number;
    }
  | {
      /** Nia-owned TokenMeter projection. */
      type: "nia.context.snapshot";
      usedTokens: number;
      pressureTokens?: number;
      projectedTokens?: number;
      contextWindow?: number;
      source: "estimate" | "provider_usage";
      at: string;
      /** Three-bucket header breakdown, when the request was measured. */
      systemTokens?: number;
      toolsTokens?: number;
      messageTokens?: number;
    }
  | {
      /**
       * Durable session usage snapshot: the per-channel totals a restarting UI
       * needs before any live step arrives. Folded from the whole session log
       * by the session projection and published at attach, so paging,
       * compaction and the fast path's truncated exec surface cannot change
       * it — the numbers are the session's, not a window's. Live
       * `runtime.step_usage` / `*.chat.turn.finished` events keep accumulating
       * afterwards. Field names mirror the UI's per-channel stats so the two
       * swap wholesale.
       */
      type: "session.usage";
      channels: Record<
        "main" | "navi" | "nia",
        {
          steps: number;
          turns: number;
          inputTokens: number;
          outputTokens: number;
          cacheReadInputTokens: number;
          cacheCreationInputTokens: number;
          llmMs: number;
          toolMs: number;
          ttftMs: number;
          ttftSteps: number;
          decodeMs: number;
        }
      >;
    }
  | {
      type: "compaction.begin";
      id: string;
      trigger: CompactionTrigger;
      beforeTokens: number;
      maxTokens: number;
      thresholdPercent: number;
      reservedTokens: number;
      instruction?: string;
      attempt: number;
      startedAt: string;
    }
  | {
      type: "compaction.end";
      id: string;
      trigger: CompactionTrigger;
      success: boolean;
      beforeTokens: number;
      afterTokens?: number;
      durationMs: number;
      attempts: number;
      error?: string;
    }
  | {
      type: "context.limit.recovery";
      id: string;
      step: number;
      attempted: boolean;
      compacted: boolean;
      reason: "context_limit";
    }
  | {
      type: "context.checkpoint";
      id: string;
      snapshot: DurableContextCheckpointRecord;
    }
  | {
      type: "terminal.update";
      id: string;
      command: string;
      cwd: string;
      status: TerminalStatus;
      attached: boolean;
      rows: number;
      cols: number;
      prompt?: string;
      activity: "waiting" | "running";
      tail: string;
      transcript?: string;
      lastAction?: TerminalAction;
      target: ExecutionTarget;
      ownership?: TerminalOwnership;
      approvalID?: string;
      screen?: TerminalScreenSnapshot;
      revision?: number;
      lastOutputAt?: string;
      viewers?: TerminalViewer[];
      inputOwner?: TerminalOwner;
      geometryOwner?: TerminalOwner;
    }
  | {
      type: "terminal.action";
      id: string;
      action: TerminalAction;
      redacted?: boolean;
      target: ExecutionTarget;
    }
  | {
      type: "terminal.timeline";
      id: string;
      actor: "model" | "user" | "system";
      action: TerminalAction | "created" | "approval";
      status:
        | "requested"
        | "awaiting_approval"
        | "approved"
        | "executed"
        | "rejected";
      summary: string;
      at: string;
    }
  | {
      type: "terminal.approval";
      id: string;
      approvalID: string;
      state: "awaiting" | "approved" | "rejected";
      action: TerminalAction;
      reason: string;
      target: ExecutionTarget;
    }
  | {
      type: "terminal.viewer";
      id: string;
      viewerID: string;
      viewerKind?: "external" | "embedded";
      action:
        | "registered"
        | "takeover"
        | "release"
        | "unregistered"
        | "expired";
      inputOwner: TerminalOwner;
      geometryOwner: TerminalOwner;
      at: string;
    }
  | { type: "terminal.pane.select"; id: string }
  | {
      /**
       * A call was approved to run under a confinement mode WIDER than the
       * effective one (sandbox study §6b①): the audit fact the danger
       * indicator and the audit trail share as one source. The grant is
       * per-call — the event records the entry, the call's own events bound
       * it — and the UI indicator reads this, never a second state.
       */
      type: "confinement.escalated";
      at: string;
      from: import("./schema-types").ConfinementMode;
      to: import("./schema-types").ConfinementMode;
      justification: string;
      toolID: string;
      sessionID?: SessionID;
    }
  | {
      type: "sandbox.update";
      id: string;
      status: SandboxStatus;
      root: string;
      isolationLevel: "workspace" | "container" | "vm";
      changedFiles: number;
      runningResources: number;
      target: ExecutionTarget;
      resourcePolicy: string;
    }
  | {
      type: "sandbox.diff";
      id: string;
      changes: Array<{
        kind: SandboxDiffKind;
        path: string;
        oldPath?: string;
        mode?: string;
      }>;
    }
  | {
      type: "sandbox.audit";
      id: string;
      action: string;
      target: ExecutionTarget;
      approvalRequired: boolean;
      checkpointPolicy:
        | "sandbox_manifest"
        | "host_checkpoint"
        | "not_available";
      message: string;
    }
  | {
      type: "checkpoint.created";
      id: string;
      workspaceID?: string;
      reason: string;
      turnID?: string;
      stepID?: string;
      sequence: number;
      complete: boolean;
      files: number;
      changes: number;
      contextJournalOffset: number;
      step: number;
      tokenEstimate: number;
      diskUsageBytes: number;
    }
  | {
      type: "checkpoint.failed";
      reason: string;
      message: string;
      incomplete?: boolean;
      errors?: string[];
    }
  | {
      type: "checkpoint.unavailable";
      reason: string;
      suggestion: string;
      disabledByConfig?: boolean;
    }
  | { type: "rollback.previewed"; preview: CheckpointPreview }
  | {
      type: "rollback.begin";
      checkpointID: string;
      safetyCheckpointID: string;
      dryRun?: boolean;
      sessionID?: string;
    }
  | {
      type: "rollback.end";
      checkpointID: string;
      safetyCheckpointID: string;
      restoredFiles: number;
      deletedFiles: number;
      contextJournalOffset: number;
      step: number;
      sessionID?: string;
    }
  | {
      type: "rollback.failed";
      checkpointID: string;
      safetyCheckpointID?: string;
      message: string;
      recovered: boolean;
      sessionID?: string;
    }
  | {
      type: "diagnostic";
      level: "info" | "warning" | "error";
      message: string;
      at?: string;
      /**
       * Which capability, plugin or namespace the diagnostic belongs to, so a
       * consumer can attribute it ("which tool package failed") and filter by
       * owner. Capability-scoped values use the capability id (e.g.
       * `plugin:demo.plugin`, `mcp:server`, `natalia-tool-fs-write`); a runtime-level
       * diagnostic without a meaningful owner omits the field.
       */
      owner?: string;
    }
  | {
      type: "resource.read";
      id: string;
      resource: string;
      owner: string;
      reader?: string;
      path: string;
      at: string;
    }
  | {
      type: "dialog.open";
      dialog:
        | "palette"
        | "approval"
        | "question"
        | "sessions"
        | "settings"
        | "status";
    }
  | { type: "dialog.close" }
  | {
      type: "approval.request";
      id: string;
      title: string;
      preview: string;
      detail?: string;
      keyArguments?: string[];
      sensitive?: boolean;
      risk?: "terminal_low" | "terminal_high";
      scope?: string;
      expiresAt?: string;
      revocable?: boolean;
      /** False when the approval cannot be granted for the whole session. */
      allowSession?: boolean;
      /** False when the approval cannot be granted for the whole project. */
      allowProject?: boolean;
      permissionFamily?: import("./permission-families").PermissionFamily;
    }
  | {
      type: "approval.response";
      id: string;
      decision: ApprovalResponse["decision"];
      feedback?: string;
    }
  | {
      type: "question.request";
      id: string;
      title: string;
      options?: string[];
      questions?: QuestionItem[];
    }
  | {
      type: "question.response";
      id: string;
      answers: string[][];
      rejected?: boolean;
    }
  | {
      /**
       * A plugin/tool-defined interactive request. The runtime treats `payload`
       * and `response` as opaque JSON: it validates the envelope (kind non-empty,
       * id match, size) and leaves business validation to the initiator's
       * in-process `validate` callback.
       */
      type: "interactive.request";
      id: string;
      kind: string;
      title: string;
      payload: JsonValue;
      responseSchema?: JsonSchema;
      expiresAt?: string;
      priority?: number;
    }
  | {
      type: "interactive.response";
      id: string;
      kind: string;
      response: JsonValue;
      rejected?: boolean;
    }
  | { type: "snapshot.created"; id: string; files: string[] }
  | {
      type: "turn.finished";
      id: string;
      stopReason: "done" | "cancelled" | "error" | "waiting_human";
      reason?: "missing_final_response";
      model?: string;
      profile?: string;
      durationMs?: number;
      inputTokens?: number;
      outputTokens?: number;
    }
  | {
      type: "collab.suggestion";
      id: string;
      from: "live_chat";
      to: "main_agent";
      suggestion: string;
      rationale?: string;
      priority: "normal" | "high";
      status: "proposed";
      at: string;
    }
  | {
      type: "collab.notice";
      id: string;
      from: "main_agent";
      to: "live_chat";
      notice: string;
      noticeType: "step_completed" | "blocked" | "needs_input" | "risk";
      at: string;
    }
  | {
      type: "collab.question";
      id: string;
      from: "main_agent";
      to: "live_chat";
      question: string;
      at: string;
    }
  | {
      type: "collab.answer";
      id: string;
      questionID: string;
      from: "live_chat";
      to: "main_agent";
      answer: string;
      at: string;
    }
  | {
      type: "collab.chat";
      id: string;
      threadID: string;
      from: CollaborationParticipant;
      to: CollaborationParticipant;
      text: string;
      /** Direct reply to the preceding open chat message, when present. */
      replyToID?: string;
      /** One-based automatic exchange number within the thread. */
      round: number;
      /** Whether the recipient owes a direct `collab_chat` reply. */
      expectsReply: boolean;
      at: string;
    }
  | {
      type: "collab.response";
      id: string;
      messageID: string;
      from: "live_chat" | "main_agent";
      decision: "adopted" | "rejected" | "deferred";
      reason?: string;
      at: string;
    }
  | {
      type: "collab.message";
      message: CollaborationMessage;
    }
  | NamespacedCollabMessageEventData
  | SettlementNoticeEventData
  | SubagentMessageEventData
  | {
      type: "settings.updated";
      scope: "global" | "project";
    }
  | {
      type: "workspace.added";
      workspace: WorkspaceSummary;
      workspaceID: string;
    }
  | {
      type: "workspace.activated";
      workspace: WorkspaceSummary;
      workspaceID: string;
    }
  | {
      type: "workspace.removed";
      workspaceID: string;
    }
  | {
      type: "composition.proposed";
      /** The staged candidate: a content id from the object store. */
      candidateID: string;
      /** What staged it (config.reload, plugin.reconcile, agent.proposal...). */
      reason: string;
      workspaceID?: string;
      sessionID?: SessionID;
    }
  | {
      type: "composition.cancelled";
      /**
       * The candidate this abandonment is about (a content id). A candidate
       * nobody will ever apply is a fact worth its own event: without it the
       * pointer chain carried every proposal forever and the model had no
       * way to say "not this one" (T-22).
       */
      candidateID: string;
      /** Why it was abandoned — the journal records why, like a proposal. */
      reason: string;
      workspaceID?: string;
      sessionID?: SessionID;
    }
  | {
      type: "composition.switched";
      /** The generation that was running before this switch, if any. */
      from?: string;
      /** The generation now running: a content id from the object store. */
      to: string;
      /**
       * §6.6: the composition profile's canonical hash at switch time
       * (rows sorted by id, origins stripped, SHA-256) — content-
       * addressed, never a sequence number. The §4.4 draft nested this
       * inside to/from objects; `from`/`to` shipped as generation
       * STRINGS and §4.1's freeze says replayable-forever, so the hash
       * lands as this additive top-level field (events emitted before
       * it simply lack it — absent, never wrong).
       */
      compositionHash?: string;
      /** What caused the switch (config.reload, plugin.reconcile, rollback...). */
      reason: string;
      workspaceID?: string;
      sessionID?: SessionID;
    }
  | {
      type: "composition.verified";
      /** The candidate generation this verdict is about (a content id). */
      candidateID: string;
      verdict: "passed" | "failed";
      /** Every gate face's outcome — the evidence the switch decision rests on. */
      checks: Array<{ check: string; ok: boolean; detail?: string }>;
      workspaceID?: string;
      sessionID?: SessionID;
    }
  | {
      type: "invariant.violation";
      /**
       * A domain-invariant finding as a FIRST-CLASS FACT (Discovery D2):
       * edge-triggered — published when a violation opens, not per tick,
       * so a persistent problem cannot flood the journal.
       */
      at: string;
      owner: string;
      invariant: string;
      code: string;
      detail: string;
      workspaceID?: string;
      sessionID?: SessionID;
    }
  | {
      type: "invariant.resolved";
      /** The same key the violation opened with — the closing edge. */
      at: string;
      owner: string;
      invariant: string;
      code: string;
      detail: string;
      workspaceID?: string;
      sessionID?: SessionID;
    }
  | {
      type: "self_review.completed";
      /**
       * Discovery D4: a side-channel self-review finished (hermes'
       * background_review paradigm — replays a session digest, never
       * touches the main conversation or its prompt cache). Safe refs
       * only: skill names and counts, never the model's prose or the
       * skill bodies.
       */
      at: string;
      sessionID?: SessionID;
      workspaceID?: string;
      skillsCreated: string[];
      skillsUpdated: string[];
      /** Proposals the write boundary rejected (whitelist/validation). */
      rejected: number;
      /**
       * The growth lanes' proposals recorded this review (a
       * `growth.proposed` fact's suggestions, when any): how many, and
       * the split by lane — a deficiency is evidence of something wrong,
       * an aspiration a capability the task wished for. Zero when the
       * review found nothing to propose (the honest empty).
       */
      proposals: number;
      deficiencies: number;
      aspirations: number;
    }
  | {
      type: "self_review.skipped";
      /** Why no review ran (or it did not finish) — the honest edge. */
      at: string;
      sessionID?: SessionID;
      workspaceID?: string;
      reason:
        | "disabled"
        | "superseded"
        | "no_provider"
        | "no_skills"
        | "no_input"
        | "error";
    }
  | {
      /**
       * Discovery G-a: a growth proposal was derived from the journal's
       * completed/failed distribution (the capability curriculum). The
       * proposal is a FACT — the audit trail, the NGM proposal interface
       * and the human's review read this one event, and growth 默认
       * 不自授权 (the study's approval policy): recording a proposal
       * applies nothing.
       */
      type: "growth.proposed";
      id: string;
      at: string;
      sessionID?: SessionID;
      workspaceID?: string;
      /** The suggestions, strongest first (the curriculum's shape). */
      suggestions: Array<{
        kind: "tool" | "skill" | "rule" | "policy";
        capability: string;
        observations: number;
        sources: string[];
        reason: string;
      }>;
      /** What the derivation read (the proposal's provenance). */
      considered: {
        tasks: number;
        gaps: number;
      };
    }
  | {
      /**
       * Block ②: a growth trigger promoted to a PROPOSAL through the
       * constitution's class policy. The fact records where it lands
       * and what approval it needs; it APPLIES NOTHING — the
       * composition's apply_generation keeps its own approval floor
       * (the study's growth 默认不自授权).
       */
      type: "growth.promoted";
      id: string;
      at: string;
      sessionID?: SessionID;
      workspaceID?: string;
      /** The trigger it came from (its provenance, verbatim). */
      trigger: {
        rule: string;
        capability: string;
        evidence: Record<string, number | string>;
        reason: string;
      };
      /** Where the proposal lands (the class policy's destination). */
      destination: "skill" | "policy" | "generation";
      /** What the approval requires (the study's class policy). */
      approval: "auto" | "human" | "human_plus_verification";
      /** The face that applies it (named, never this one). */
      appliedBy: string;
      next: string;
      reason: string;
    }
  | {
      /**
       * Discovery G-c's join: one of OUR runs against an external
       * benchmark task (the study's adapter layer). The turn's score is
       * read from the journal (the G-b scorer — no new telemetry); the
       * task id is the join's explicit key, so the per-task comparison
       * is a fact, not a hash coincidence.
       */
      type: "external_run.recorded";
      id: string;
      at: string;
      sessionID?: SessionID;
      /** The external task (the eval's own id, e.g. terminal-bench/x). */
      externalTaskID: string;
      /** The benchmark's name the task belongs to. */
      benchmark: string;
      /** The turn that ran the task's instruction. */
      turnID: string;
      /** The scored outcome (the journal's own fold). */
      success?: boolean;
      stopReason?: string;
      durationMs?: number;
      /** The external task's baseline rate at record time. */
      baselineSuccessRate: number;
    }
  | {
      type: "feedback.recorded";
      /**
       * D6a: human feedback about the OUTPUT, recorded without ever
       * reaching the model (design law 3 — the feedback group:
       * signals about output, never input to it). The only route into
       * model-visible material is governance (constitution / AGENTS.md
       * / skills) with its hash-change notifications.
       */
      id: string;
      at: string;
      sessionID?: SessionID;
      workspaceID?: string;
      scope: "session" | "message";
      /** Required for message scope: the assistant message this rates. */
      messageID?: string;
      verdict: "up" | "down";
      /** From the fixed category taxonomy (a code change to extend, on purpose). */
      category?: string;
      note?: string;
    };

/**
 * An episode groups all events emitted by one isolated execution without
 * changing the durable workspace-level session identity used by interactive
 * clients. It is intentionally a correlation field, not a Work Graph event.
 *
 * `sessionID` is stamped by the runtime on every event published while a
 * session is active, so a transport subscriber can isolate one session's
 * stream server-side (the D6 rule: an event carrying a session id belongs to
 * that session and no other; one without it is runtime-level and reaches every
 * subscriber). Events that already carry a session id (`session.created`,
 * `session.ready`, work-graph nodes) keep their own.
 */
export type RuntimeEvent = RuntimeEventData & {
  episodeID?: EpisodeID;
  sessionID?: SessionID;
  /** Owning workspace for multi-workspace runtime hosts. */
  workspaceID?: string;
  /** Owning subagent for events projected into a child conversation. */
  agentID?: string;
};

/**
 * Hidden per-session durable order carried alongside a runtime event.
 *
 * This is deliberately non-enumerable: it must survive the process boundary
 * for windowed delivery, but it is transport metadata rather than a business
 * event field. Exact event comparisons and persisted JSON stay unchanged.
 */
const RUNTIME_EVENT_SESSION_SEQ = "__nataliaSessionSeq";

/** Attach the per-session durable order without changing the event's shape. */
export function markRuntimeEventSessionSeq(
  event: RuntimeEvent,
  sessionSeq: number,
): RuntimeEvent {
  Object.defineProperty(event, RUNTIME_EVENT_SESSION_SEQ, {
    value: sessionSeq,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return event;
}

/** Read the per-session durable order when one was attached. */
export function runtimeEventSessionSeq(
  event: RuntimeEvent,
): number | undefined {
  const value = (
    event as RuntimeEvent & { [RUNTIME_EVENT_SESSION_SEQ]?: unknown }
  )[RUNTIME_EVENT_SESSION_SEQ];
  return typeof value === "number" ? value : undefined;
}

export type SubmittedTurn = Extract<RuntimeEvent, { type: "turn.submitted" }>;
export type LocalAttachment = {
  id: string;
  path: string;
  filename: string;
  mediaType:
    | "image/png"
    | "image/jpeg"
    | "image/webp"
    | "image/gif"
    | "video/mp4"
    | "video/webm"
    | "text/plain"
    | "text/markdown"
    | "application/json"
    | "text/csv";
  byteLength: number;
  sha256: string;
  /** Decoded image dimensions, when the media type is an image. */
  width?: number;
  height?: number;
};
export type PromptResourceMention = {
  server: string;
  uri: string;
  name: string;
  mimeType?: string;
};
export type PromptAgentMention = { name: string };
export type SubmitInput = {
  text: string;
  delivery?: "next-turn" | "next-step";
  id?: string;
  attachments?: string[];
  resources?: PromptResourceMention[];
  agents?: PromptAgentMention[];
  /** Target a specific session. When omitted, the runtime uses the active UI session. */
  sessionID?: string;
};

/** Identifies one durable inbox input for an `input.*` mutation. */
export type InputTarget = { id: string; sessionID?: string };

/**
 * Result of an `input.*` mutation. Refusal is a value: a caller that removes an
 * input which was already claimed (or never existed) learns that instead of
 * getting a false success.
 */
export type InputMutationResult = {
  ok: boolean;
  reason?:
    | "session-not-found"
    | "input-not-found"
    | "already-claimed"
    | "already-step";
  input?: {
    id: string;
    text: string;
    delivery: "next-turn" | "next-step";
    promotedAt?: string;
  };
};
export type RuntimeHistoryEvent = {
  seq: number;
  /** Per-session durable order for windowed consumers. */
  sessionSeq?: number;
  event: RuntimeEvent;
};
export type RuntimeHistory = {
  events: RuntimeHistoryEvent[];
  hasMore: boolean;
};

/** One contiguous page of the shared per-session event window. */
export type RuntimeEventWindow = {
  events: RuntimeHistoryEvent[];
  hasMore: boolean;
};
export type RuntimeProjectedMessageRowKind =
  | "user"
  | "thinking"
  | "assistant"
  | "tool"
  | "approval"
  | "question"
  | "system";
export type RuntimeProjectedMessageRow = {
  id: string;
  turnID: string;
  kind: RuntimeProjectedMessageRowKind;
  event: RuntimeEvent;
};
export type RuntimeProjectedMessage = {
  id: string;
  turnID: string;
  submitted: SubmittedTurn;
  rows: RuntimeProjectedMessageRow[];
  stopReason?: Extract<RuntimeEvent, { type: "turn.finished" }>["stopReason"];
};
export type RuntimeMessageCursor = {
  previous?: string;
  next?: string;
};
export type RuntimeMessagePage = {
  data: RuntimeProjectedMessage[];
  cursor: RuntimeMessageCursor;
};
/** Opaque, source-owned cursors shared by every transcript page surface. */
export type TranscriptPageCursor = {
  previous?: string;
  next?: string;
};
/**
 * Uniform one-page result for transcript-like streams. Natalia turns, Chat
 * rows and subagent history all use this shape so the UI can share one paging
 * controller instead of reimplementing cursor semantics per panel.
 */
export type TranscriptPage<T> = {
  data: T[];
  cursor: TranscriptPageCursor;
};
export type PendingInteractiveRequests = {
  approvals: Array<Extract<RuntimeEvent, { type: "approval.request" }>>;
  questions: Array<Extract<RuntimeEvent, { type: "question.request" }>>;
  interactives: Array<Extract<RuntimeEvent, { type: "interactive.request" }>>;
};

/** Serialisable JSON, the only shape an `interactive.*` payload may use. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** An opaque JSON Schema for a generic interactive response (hint, not kernel). */
export type JsonSchema = { readonly [key: string]: unknown };

/**
 * A reply to an `interactive.request`. `response` stays opaque to the runtime;
 * the initiator's in-process `validate` callback is the business authority.
 */
export type InteractiveResponse = {
  requestID: string;
  kind: string;
  response: JsonValue;
  rejected?: boolean;
  sessionID?: string;
};
export type MCPPromptCatalog = {
  server: string;
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
};
export type MCPResourceCatalog = {
  server: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
};
export type MCPCatalogSnapshot = {
  prompts: MCPPromptCatalog[];
  resources: MCPResourceCatalog[];
};
/** A command a capability or plugin contributed, as a UI sees it. */
export type ContributedCommand = {
  name: string;
  title: string;
  description?: string;
  acceptsArguments?: boolean;
  category?: string;
};
export type ContributedCommandExecution = {
  workspaceID?: string;
  name: string;
  raw: string;
  args: string[];
  sessionID?: string;
};

/** A panel visibility requirement. */
export type UiPanelRequirement =
  | { type: "plugin"; id: string }
  | { type: "capability"; id: string }
  | { type: "method"; name: string };

/** Panel metadata a plugin can declare for its renderer-side UI. */
export type UiPanelMeta = {
  id: string;
  title: string;
  region?: "main" | "side" | "bottom" | "topbar" | "settings";
  group?: string;
  icon?: string;
  order?: number;
  description?: string;
  requires?: UiPanelRequirement[];
};

/** Renderer-side UI declaration carried by a plugin manifest / catalog entry. */
export type PluginUiManifest = {
  entry: string;
  css?: string;
  panels?: UiPanelMeta[];
};

/** A plugin as seen through the runtime's plugin catalog. */
export type PluginCatalogEntry = {
  id: string;
  name: string | null;
  version: string;
  enabled: boolean;
  installed: boolean;
  packageName: string | null;
  ui?: PluginUiManifest;
};

/** Host-owned runtime ports exposed to a mounted UI adapter. */
export type UiAdapterMountInput = {
  runtime: RuntimeClient;
  events: {
    subscribe(listener: (event: RuntimeEvent) => void): () => void;
  };
  commands: {
    list(): Promise<ContributedCommand[]>;
    execute(input: ContributedCommandExecution): Promise<void>;
  };
};

/**
 * Work Graph read models exposed over RuntimeClient/RPC/SDK.
 *
 * Derived from the canonical `workGraphNodeSchema` / `workGraphEdgeSchema` rather
 * than redeclared, so the query surface cannot drift from the vocabulary the
 * writer emits. Only `episodeID` is added: it is the correlation id the runtime
 * already stamps on every event, and a consumer needs it to group facts by
 * execution.
 */
export type WorkGraphNodeView = {
  nodeID: string;
  kind: import("./schemas").WorkGraphNodeKind;
  summary: string;
  actor?: string;
  target?: string;
  sessionID?: string;
  turnID?: string;
  episodeID?: EpisodeID;
};

export type WorkGraphEdgeView = {
  sourceID: string;
  targetID: string;
  kind: import("./schemas").WorkGraphEdgeKind;
  reason?: string;
  episodeID?: EpisodeID;
};
export type PluginStatus = {
  id: string;
  version: string;
  name: string;
  description: string;
  capabilities: string[];
};
export type RuntimeStatusSnapshot = Extract<
  RuntimeEvent,
  { type: "status.snapshot" }
>;
export type RuntimeDiagnostic = Extract<
  RuntimeEvent,
  { type: "diagnostic" }
> & { at: string };
export type RuntimeModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  variants: string[];
  limits?: {
    contextWindow?: number | "auto";
    maxOutputTokens?: number | "auto";
  };
};
export type RuntimeModelSelection = {
  modelID?: string;
  variant?: string;
};
export type RuntimeReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type RuntimeAgentCatalogEntry = {
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  hidden: boolean;
  color?: string;
  model?: string;
  variant?: string;
  maxSteps?: number;
  allowedTools?: string[];
  excludedTools?: string[];
  mcpServers?: string[];
  permissions?: AgentPermissionRules;
};
export type RuntimeSkillCatalogEntry = {
  name: string;
  /** The workspace's switch; a disabled skill is listed but refused by resolve. */
  enabled: boolean;
  qualifiedName: string;
  description: string;
  source: "project" | "user" | "remote" | "plugin";
  requireApproval: boolean;
  sandboxRequired: boolean;
};
export type RuntimeWorkspaceFileEntry = {
  path: string;
  type: "file" | "directory";
};
export type RuntimeWorkspaceListPage = {
  entries: RuntimeWorkspaceFileEntry[];
  truncated: boolean;
  next?: number;
};
export type RuntimeWorkspaceMatch = {
  path: string;
  line: number;
  text: string;
};
export type RuntimeWorkspaceContent = {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  mime: string;
  offset?: number;
  truncated?: boolean;
  next?: number;
};
/** Color encoding: undefined=default, 0..255=palette, 0x1000000+RGB=truecolor. */
export type TerminalColor = number | null | undefined;
/** Compact wire cell: chars, width, fg, bg, style bitmask. */
export type TerminalCell = [
  chars: string,
  width: number,
  fg?: TerminalColor,
  bg?: TerminalColor,
  attributes?: number,
];
export type TerminalScreenSnapshot = {
  rows: number;
  cols: number;
  buffer: "normal" | "alternate";
  cursor: { row: number; col: number; visible: boolean };
  cursorX?: number;
  cursorY?: number;
  lines: TerminalCell[][];
  text: string;
  modes?: { bracketedPaste: boolean };
  highlightRanges?: Array<{
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  }>;
};

export type TerminalViewer = {
  id: string;
  kind: "external" | "embedded";
  connectedAt: string;
  lastSeenAt: string;
};
export type TerminalOwner =
  | { type: "model" }
  | { type: "viewer"; viewerID: string };
export type RuntimeTerminalSession = {
  id: string;
  command: string;
  cwd: string;
  status: TerminalStatus;
  attached: boolean;
  rows: number;
  cols: number;
  transcript: string;
  tail: string;
  startedAt: string;
  endedAt?: string;
  screen?: TerminalScreenSnapshot;
  revision?: number;
  lastOutputAt?: string;
  prompt?: string;
  activity?: "waiting" | "running";
  viewers?: TerminalViewer[];
  inputOwner?: TerminalOwner;
  geometryOwner?: TerminalOwner;
  secretAudit: Array<{
    at: string;
    action: "write" | "prompt_detected";
    summary: string;
    sha256?: string;
  }>;
};

/**
 * One input-ownership transition on a native terminal pane: the state it
 * moved between, who moved it (the human, the model or the runtime), the
 * action that moved it, and when. `action` names the RPC/method so the
 * trigger source is visible — a focus event is not a trigger, because
 * takeover has no implicit path.
 */
export type NativeTerminalOwnershipChange = {
  from: "model" | "human";
  to: "model" | "human";
  actor: "model" | "human" | "system";
  action: "claim" | "release" | "stop" | "request_human" | "secure_input";
  at: string;
};

export type RuntimeNativeTerminalSession = {
  id: string;
  host: "wezterm" | "pty";
  paneID: number;
  windowID: number;
  muxWindowID: number;
  tabID: number;
  command: string;
  cwd: string;
  status: "running" | "exited";
  inputOwner: "model" | "human";
  geometryOwner: "human";
  secureInput: boolean;
  /**
   * The pane's most recent input-ownership transition (TERM-M.3 route 4).
   *
   * Ownership is an EXPLICIT state change — a claim (a human taking the pane)
   * or a release (giving it back) — never a side effect of focus or activity.
   * The last transition rides the session so a reader sees WHO moved the pane
   * and WHEN, and so a refused model write can name it instead of saying "a
   * human" and leaving the model to guess.
   */
  lastOwnershipChange?: NativeTerminalOwnershipChange;
  rows?: number;
  cols?: number;
  startedAt: string;
  attached: boolean;
  /** Natalia session that owns this pane. Present for PTY and I3 WezTerm panes. */
  sessionID?: string;
  /** Agent that started/owns this terminal, when the terminal was created by a subagent. */
  agentID?: string;
  /**
   * TERM-M.3 route 3: a conservative "this pane may be waiting for a human"
   * weak fact. True only when the model wrote, the pane produced output after
   * that write, and no new output or model write has happened for the grace
   * period. It never inspects content — a long computation also reads true.
   */
  mayWaitForHuman?: boolean;
};

export type RuntimeTerminalObservationSession = Omit<
  RuntimeTerminalSession,
  "screen" | "transcript"
> & {
  screen?: TerminalScreenSnapshot;
  transcript?: string;
};

/**
 * What one pane read serves: the text, and the extent that makes the read
 * pageable. `startLine` is the first line served (inclusive), `endLine` is one
 * past the last line served, and `totalLines` is how much document there is to
 * walk — a successor window is addressed from its predecessor's `endLine`, never
 * from an arithmetic offset.
 *
 * Null when the backend cannot report it: the WezTerm host's read returns text,
 * the cursor and the geometry from a separate process, and the numbers cannot be
 * recovered on this side of that boundary. A null is an honest "this read cannot
 * be paged"; zeros would look like a one-line document and quietly mislead the
 * walker.
 *
 * `cursorX`/`cursorY` are the pane's caret (0-based, screen-relative), same null
 * idiom: the pty host reports them, a host that owns no screen does not. They
 * are what a reconnect needs — a replay that restores the buffer but drops the
 * caret repaints it at the origin, and the next keystroke lands where the human
 * did not choose.
 *
 * ONE declaration, referenced by every surface that serves or consumes a pane
 * read — the runtime client, the controller port and the tool service. The
 * second copy of this shape (the tool service's) lagged the first by a full
 * feature once: the controller reported the extent and the tools, typed against
 * their own narrower literal, could not see a field of it.
 */
export type RuntimeTerminalRead = {
  text: string;
  startLine: number | null;
  endLine: number | null;
  totalLines: number | null;
  /**
   * The same window addressed in BYTES, for the two cases lines cannot serve:
   * a single huge line (a minified bundle `cat`-ed into the pane) has no bound
   * a line window can give, and exact resume wants the successor window to
   * start at this one's `endByte` with no arithmetic in between. Same null
   * idiom: a host that cannot count bytes says so rather than guessing.
   */
  startByte: number | null;
  endByte: number | null;
  totalBytes: number | null;
  cursorX: number | null;
  cursorY: number | null;
};
export type WorkspaceSummary = {
  workspaceID: string;
  root: string;
  title: string;
  status: "active" | "idle" | "stopped" | "error";
  sessionCount: number;
  runningSessionCount: number;
};

export type WorkspacePermissionSettings = {
  permissionProfile: string;
  approval: "ask" | "auto" | "read_only";
};

export type WorkspaceToolSettings = {
  enabledTools: string[];
  disabledTools: string[];
};

export type RuntimeSessionSummary = {
  id: string;
  workspaceID?: string;
  title: string;
  createdAt: string;
  lastAccessedAt?: string;
  pinned: boolean;
  archived?: boolean;
  events: number;
  pendingInputs: number;
  cancelled: boolean;
  resumable: boolean;
  status?: "idle" | "running" | "error" | "stopped";
  /**
   * Session-scoped active plan pointer. Plan documents and their lifecycle
   * status are workspace-level, but activation is per session so different
   * sessions can work on different plans.
   */
  activePlanID?: string;
  /**
   * TERM-M.3 (c): a terminal the model asked a human to take over, with the
   * turn ended. Present while the runtime is waiting for the human to finish
   * input before it resumes the task, so any consumer (session list, remote
   * UI) can see the session is waiting for a human instead of inferring it
   * from the timeline.
   */
  pendingHumanTerminal?: {
    terminalID: string;
    reason: string;
    since: string;
  };
};
/** Projected subagent view as exposed to clients by the runtime read surface. */
export type RuntimeSubagentView = Extract<
  RuntimeEvent,
  { type: "subagent.update" }
>;

/** Streaming fragments are transport-live; their completed settlements are durable. */
export function runtimeEventDurability(
  event: RuntimeEvent,
): "durable" | "live" {
  switch (event.type) {
    case "content.delta":
    case "thinking.delta":
    case "context.status":
    case "status.update":
    case "terminal.update":
    case "navi.chat.turn.started":
    case "navi.chat.turn.phase":
    case "navi.chat.turn.finished":
    case "nia.chat.turn.started":
    case "nia.chat.turn.phase":
    case "nia.chat.turn.finished":
    // Session intelligence snapshots are reconstructible from the journal and
    // are published on every work-state boundary. Persisting each one bloats
    // long sessions and makes every full-session clone larger; keep them live
    // and derive the latest snapshot on demand.
    // A live re-seed of the current goal; the durable record is `goal.changed`.
    case "goal.status":
    case "session.snapshot":
    // Rollback previews are a transient dry-run response. The Markdown/change
    // data can be large, and the UI can re-request a preview instead of loading
    // every historical preview back from the journal.
    case "rollback.previewed":
    case "navi.chat.message.delta":
    case "navi.chat.thinking.delta":
    case "nia.chat.message.delta":
    case "nia.chat.thinking.delta":
    // Legacy chat lifecycle records are accepted only for existing journals.
    case "chat.turn.started":
    case "chat.turn.phase":
    case "chat.turn.finished":
    case "projections.updated":
    // Synthetic runtime declarations are re-published on every boot. Storing
    // them in the session DB only multiplies startup writes and bloats the
    // session history; they are reconstructible and do not need durability.
    case "capability.loaded":
    case "capability.unloaded":
    case "tool.registered":
    case "plugin.update":
    case "resource.read":
      return "live";
    case "tool.update":
      return ["succeeded", "failed", "rejected", "cancelled"].includes(
        event.status,
      )
        ? "durable"
        : "live";
    default:
      return "durable";
  }
}

/**
 * Outcomes of operations that can decline for an ordinary reason.
 *
 * `Promise<void>` and `void` cannot say "I did not do that, and here is why", so
 * a caller was left inferring success from the absence of an exception — and over
 * RPC, from a hard-coded `{ok: true}`. Which members must answer this way is
 * recorded per member in `refusals.ts`.
 */
export type PauseOutcome = { paused: boolean; reason?: string };
export type ResumeOutcome = { resumed: boolean; reason?: string };

export type AgentSelectionOutcome = {
  /**
   * `pending` means a turn is running and the selection applies when it ends:
   * changing the agent underneath a running turn would change the rules it
   * started under.
   */
  outcome: "applied" | "pending" | "rejected";
  selected?: string;
  reason?: string;
};

/**
 * These outcomes may arrive synchronously or over a hop: the in-process runtime
 * answers immediately, while the worker channel has to ask the runtime thread.
 * A channel that cannot see the outcome must not invent one, so the type admits
 * a promise rather than forcing a guess.
 */
export type InteractiveResponseOutcome = {
  /** False when the request was no longer pending, with the reason. */
  accepted: boolean;
  reason?: string;
};

/**
 * One loaded capability as reported by the `capabilities` query: what it
 * declares it may do, and the effective contributions it owns. Contributions
 * are metadata only — payloads never leave the runtime — and a contribution
 * that lost an override is not effective and is omitted.
 */
export type CapabilityRecordView = {
  id: string;
  name: string;
  version: string;
  scope: string;
  grants: string[];
  dependencies?: string[];
  precedence?: number;
  contributions: Array<{ kind: string; name: string }>;
};

/**
 * A projected runtime notice (ADR Phase C): the latest prompt-level
 * instruction change per kind, projected from `context.instructions` events.
 * The highest revision per kind is the current state; earlier same-kind
 * notices are superseded (D6 latest-win) and never mutate history.
 */
export type RuntimeProjectedNotice = {
  noticeID: string;
  kind: "config_reload" | "agent_switch" | "plan_handoff" | "notice";
  revision: number;
  at: string;
  summary: string;
  detail?: string[];
};

export type RuntimeWorkspaceResourceReadInput = {
  /** Optional routing hint for multi-workspace clients. */
  workspaceID?: string;
  /** Resource contribution name declared by a plugin. */
  resource: string;
  /** Template parameters such as sessionID or workspaceID. */
  params?: Record<string, string>;
  /**
   * Optional reader plugin id used by reader allowlists.
   *
   * The in-process UI host supplies its plugin id. The runtime treats this as
   * attribution for the trusted plugin model, not as a sandbox boundary.
   */
  reader?: string;
};

/**
 * A paged governance read (EI Phase 1). Mirrors the mailbox_status page shape
 * (`returned` / `total` / `truncated` / `nextCursor`) so every list surface
 * paginates identically. `nextCursor` is opaque — pass it back to read the
 * next page; it is absent when the page is the last.
 */
export type GovernancePage<T> = {
  items: T[];
  returned: number;
  total: number;
  truncated: boolean;
  nextCursor?: string;
};

export type ChatStreamSurface = {
  submit(input: {
    text: string;
    model?: { modelID?: string; variant?: string };
    reasoningEffort?: RuntimeReasoningEffort;
    attachments?: string[];
    sessionID?: string;
  }): Promise<{ messageID: string }>;
  abort?(sessionID?: string): Promise<{ aborted: boolean }>;
  modelProfile?(sessionID?: string): Promise<ChatModelProfile>;
  setModelProfile?(
    profile: ChatModelProfile,
    sessionID?: string,
  ): Promise<{ saved: boolean }>;
  messages?(sessionID?: string): Promise<ChatMessageRow[]>;
  messagesPage?(input: {
    sessionID?: string;
    cursor?: string;
    limit?: number;
  }): Promise<TranscriptPage<ChatMessageRow>>;
  rollback?(
    input: { toMessageID: string },
    sessionID?: string,
  ): Promise<{ rolledBackTo: string; removed: number }>;
};

export type FeedbackInput = {
  scope: "session" | "message";
  sessionID: string;
  /** Required for message scope. */
  messageID?: string;
  verdict: "up" | "down";
  /** From the fixed category taxonomy. */
  category?: string;
  note?: string;
};

export type FeedbackResult = { recorded: boolean; id: string };

export type RuntimeClient = {
  start(
    onEvent: (event: RuntimeEvent) => void,
    options?: { replay?: "all" | "none" },
  ): void;
  submit(text: string, sessionID?: string): Promise<SubmittedTurn>;
  /**
   * Record human feedback about the session or an assistant message
   * (D6a). Structurally model-free: recording publishes a journal event
   * and nothing else — no provider, no prompt, no tool path. Optional
   * like submitAndWait: the stable required surface (and the API
   * version) does not move for additive surface members.
   */
  feedback?(input: FeedbackInput): Promise<FeedbackResult>;
  /**
   * End the process gracefully. A window that hides on close (the minimise
   * policy) leaves the runtime alive, so SOMETHING has to be able to stop it —
   * otherwise the only way out is a signal or a task manager, which is the trap
   * minimise mode exists to avoid. Idempotent, and answers before the process
   * actually goes away so the caller can tell the user it worked.
   */
  shutdown?(): void | Promise<void>;
  /**
   * D3b step 1 — wait until NO execution has an active turn (the plan's
   * 排空在途: in-flight turns finish; admitted-but-unstarted inputs are
   * durable by construction — the inbox survives restarts, so only
   * RUNNING turns are waited on). Deliberately a WAIT, not an admission
   * lock: nothing sticky can outlive the caller. Throws on timeout with
   * the count still active (an error, never a partial value).
   */
  drainForUpdate?(input?: {
    timeoutMs?: number;
  }): Promise<{ waitedMs: number }>;
  /**
   * Submit a turn and wait until the turn reaches a durable terminal state
   * (`turn.finished` or `turn.cancelled`). The normal `submit` method remains
   * non-blocking; this is the explicit blocking variant for callers/tests that
   * need to observe the completed turn before continuing.
   */
  submitAndWait?(input: string | SubmitInput): Promise<SubmittedTurn>;
  submitInput?(input: SubmitInput): Promise<SubmittedTurn>;
  /**
   * Cancels a durable inbox input that has not been claimed or promoted yet.
   * Removing an already-started input returns `ok: false`; use `cancel` for the
   * running turn.
   */
  removeInput?(input: InputTarget): Promise<InputMutationResult>;
  /** Edits the text of a durable inbox input that has not started yet. */
  replaceInput?(
    input: InputTarget & { text: string },
  ): Promise<InputMutationResult>;
  /**
   * Promotes a queued `next-turn` input to `next-step` so the running turn
   * claims it before starting another turn.
   */
  promoteInput?(input: InputTarget): Promise<InputMutationResult>;
  history?(options?: {
    sessionID?: string;
    after?: number;
    offset?: number;
    limit?: number;
  }): Promise<RuntimeHistory>;
  /**
   * One contiguous window page ordered by per-session durable sequence.
   *
   * Omitting `beforeSeq` returns the newest page; passing it returns the page
   * immediately before that cursor. This is the single paging contract shared
   * by every transcript and window consumer.
   */
  eventWindow?(options?: {
    sessionID?: string;
    beforeSeq?: number;
    limit?: number;
  }): Promise<RuntimeEventWindow>;
  messages?(options?: {
    sessionID?: string;
    limit?: number;
    order?: "asc" | "desc";
    cursor?: string;
  }): Promise<RuntimeMessagePage>;
  /**
   * Uploads a raw attachment (base64) into the runtime attachment store and
   * returns a durable LocalAttachment path usable in submit attachments.
   */
  uploadAttachment?(input: {
    workspaceID?: string;
    name: string;
    mediaType: string;
    data: string;
  }): Promise<LocalAttachment>;
  attachmentDataUrl?(input: {
    workspaceID?: string;
    /** Legacy path mode. New callers use `attachmentID` + `sessionID`. */
    path?: string;
    mediaType?: string;
    attachmentID?: string;
    sessionID?: string;
  }): Promise<string>;
  pendingInteractive?(input?: {
    sessionID?: string;
    workspaceID?: string;
  }): Promise<PendingInteractiveRequests>;
  /**
   * Reconcile the workspace watcher hints against the current workspace and
   * return the confirmed changes (WG4 Phase 3 read surface). Confirmed changes
   * are not written to the Work Graph yet (Phase 4).
   */
  confirmedWorkspaceChanges?(sessionID?: string): Promise<
    Array<{
      id: string;
      workspaceRoot: string;
      path: string;
      operation: "added" | "modified" | "deleted" | "renamed";
      origin:
        | "tool"
        | "sandbox_merge"
        | "checkpoint_rollback"
        | "external"
        | "unknown";
      attribution: "attributed" | "unattributed" | "indeterminate";
      correlation: {
        sessionID?: string;
        episodeID?: string;
        turnID?: string;
        callID?: string;
        operationID?: string;
      };
      health: "healthy" | "degraded" | "unavailable";
      at: string;
    }>
  >;
  /**
   * Returns the workspace's current changes against the earliest complete
   * checkpoint (the object-store based global diff). Unlike
   * `confirmedWorkspaceChanges`, this covers changes from every source,
   * including manual edits and edits made before the runtime noticed them.
   */
  workspaceDiff?(input?: {
    workspaceID?: string;
    includePatch?: boolean;
  }): Promise<RuntimeWorkspaceDiffChange[]>;
  /**
   * Returns the git-backed workspace diff (`git status` + `git diff`). This is
   * the real VCS view and is only available inside a git repository; non-git
   * workspaces should use `workspaceDiff`.
   */
  workspaceGitDiff?(input?: {
    workspaceID?: string;
    from?: string;
    to?: string;
    path?: string;
    includePatch?: boolean;
    includeContent?: boolean;
    ignoreWhitespace?: boolean;
  }): Promise<RuntimeWorkspaceDiffChange[]>;
  /**
   * Lists git refs (branches, tags and worktrees) for the Git diff tab.
   */
  gitRefs?(input?: { workspaceID?: string }): Promise<RuntimeGitRef[]>;
  /**
   * Computes a structural AST diff in the runtime. The runtime owns the
   * tree-sitter grammars; renderer only receives AstChange summaries.
   */
  astDiff?(input: {
    workspaceID?: string;
    oldText: string;
    newText: string;
    language: string;
  }): Promise<{
    language: string;
    changes: Array<{
      kind: "modified" | "added" | "removed" | "moved";
      nodeKind: string;
      oldStart: number;
      oldEnd: number;
      newStart: number;
      newEnd: number;
    }>;
  }>;
  /**
   * Computes structural AST diffs for many files in one runtime-side request.
   * Each file is processed independently so a parse failure in one file does
   * not discard the rest of the batch.
   */
  astDiffBatch?(input: {
    workspaceID?: string;
    files: Array<{
      path?: string;
      oldText: string;
      newText: string;
      language: string;
    }>;
    options?: {
      maxChangesPerFile?: number;
    };
  }): Promise<{
    files: Array<{
      path?: string;
      language: string;
      changes: Array<{
        kind: "modified" | "added" | "removed" | "moved";
        nodeKind: string;
        oldStart: number;
        oldEnd: number;
        newStart: number;
        newEnd: number;
      }>;
      error?: string;
    }>;
  }>;
  /**
   * Refactor-preview surface for IDE-style operations. The runtime does not
   * apply the refactor; it structurally validates/reports what a supplied
   * old/new file set would change. Transformations are produced by callers
   * (agent/tool/IDE) and submitted here for a safe AST-level preview.
   */
  astRefactorPreview?(input: {
    workspaceID?: string;
    operation: "rename" | "extract" | "inline" | "move" | "custom";
    files: Array<{
      path?: string;
      oldText: string;
      newText: string;
      language: string;
    }>;
  }): Promise<{
    operation: string;
    files: Array<{
      path?: string;
      language: string;
      changes: Array<{
        kind: "modified" | "added" | "removed" | "moved";
        nodeKind: string;
        oldStart: number;
        oldEnd: number;
        newStart: number;
        newEnd: number;
      }>;
      error?: string;
    }>;
  }>;
  /**
   * IDE-grade structural service. `index` parses one or more files and returns
   * symbol/structural nodes; `query` runs the same index and filters nodes by
   * node kind or text. This is the foundation for refactoring, cross-file
   * analysis and agent planning. It is a pure read surface.
   */
  astService?(input: {
    workspaceID?: string;
    operation: "index" | "query";
    files: Array<{
      path?: string;
      source: string;
      language: string;
    }>;
    query?: {
      nodeKind?: string;
      textIncludes?: string;
    };
  }): Promise<{
    operation: string;
    files: Array<{
      path?: string;
      language: string;
      nodes: RuntimeAstNode[];
      error?: string;
    }>;
    matches?: Array<{
      path?: string;
      language: string;
      nodes: RuntimeAstNode[];
    }>;
  }>;
  /**
   * Phase C's cross-file move detection (the object-store study's
   * acceptance 3): the before and after sets through the SAME AST index,
   * answered as the detected moves. A move's `from`/`to` are the rename
   * plan's fields verbatim — a detection result feeds `astRefactorPlan`
   * directly (the study's 打通).
   */
  astMove?(input: {
    workspaceID?: string;
    before: Array<{ path?: string; source: string; language: string }>;
    after: Array<{ path?: string; source: string; language: string }>;
  }): Promise<{
    moves: Array<{
      from: string;
      to: string;
      fromFile: string;
      toFile: string;
      nodeKind: string;
      similarity: number;
      states: { renamed: boolean; moved: boolean; modified: boolean };
    }>;
  }>;
  /**
   * Phase C's workspace move face (the object-store study's second
   * face): the workspace's real files — the working tree against a git
   * ref (default HEAD) — through the same index, answered as the
   * detected moves. The same from/to-to-rename-plan contract as
   * `astMove`.
   */
  workspaceAstMove?(input?: {
    workspaceID?: string;
    paths?: string[];
    from?: string;
  }): Promise<{
    from: string;
    scanned: number;
    skipped?: Array<{ path: string; reason: string }>;
    moves: Array<{
      from: string;
      to: string;
      fromFile: string;
      toFile: string;
      nodeKind: string;
      similarity: number;
      states: { renamed: boolean; moved: boolean; modified: boolean };
    }>;
  }>;
  /**
   * Refactor plan generation. It uses AST query/index to find every structure
   * that would participate in a refactor and returns a non-writing plan. The
   * plan can be sent to `astRefactorPreview` for final review.
   */
  astRefactorPlan?(input: {
    workspaceID?: string;
    operation: "rename" | "extract" | "inline" | "move" | "custom";
    files: Array<{
      path?: string;
      source: string;
      language: string;
    }>;
    rename?: {
      from: string;
      to: string;
    };
    query?: {
      nodeKind?: string;
      textIncludes?: string;
    };
  }): Promise<{
    operation: string;
    targets: Array<{
      path?: string;
      language: string;
      nodeKind: string;
      text: string;
      start: number;
      end: number;
      suggestedText?: string;
    }>;
    files: Array<{
      path?: string;
      language: string;
      error?: string;
    }>;
  }>;
  /**
   * Applies a refactor plan. This is the Phase 3 write surface: it performs
   * AST-range edits and writes files. It must only run after a reviewed plan;
   * `dryRun` returns the would-be edits without touching disk.
   */
  astApplyRefactor?(input: {
    workspaceID?: string;
    operation: "rename" | "extract" | "inline" | "move" | "custom";
    files: Array<{
      path?: string;
      source: string;
      language: string;
    }>;
    rename?: {
      from: string;
      to: string;
    };
    dryRun?: boolean;
  }): Promise<{
    operation: string;
    applied: Array<{
      path?: string;
      language: string;
      replacements: Array<{
        start: number;
        end: number;
        from: string;
        to: string;
      }>;
      before?: string;
      after?: string;
      error?: string;
    }>;
  }>;

  /**
   * Lists the current session's sandboxed sub-agent PRs for read-only display.
   * Merging/approval remains model-driven through `team_review`; this surface
   * only lets a UI observe the PR queue.
   */
  teamPRList?(sessionID?: string): Promise<RuntimeTeamPR[]>;
  dispose?(): Promise<void>;
  /**
   * Whether config could be applied right now. Advisory only: a turn can start
   * between asking and acting, which is why `reloadConfig` re-checks and reports
   * for itself rather than trusting a caller to have asked.
   */
  canReloadConfig?(): Promise<{ allowed: boolean; reason?: string }>;
  /**
   * Writes a config patch to disk (merged over the current config, like the
   * TUI settings menu) and applies it. Refusal is a value with a reason, like
   * `reloadConfig`: the file may be written while a running turn prevents
   * application. Idempotent by patch: replaying the same patch reproduces the
   * same merged result.
   */
  updateConfig?(input: {
    patch: Record<string, unknown>;
    scope?: "project" | "global";
  }): Promise<{ applied: boolean; reason?: string }>;
  /** Reads the fully resolved product configuration through the runtime. */
  configGet?(): Promise<ConfigV3>;
  /**
   * The interface-preference settings (`tui.json`). The TUI used to own this
   * file privately; the runtime now serves it so any consumer reads and
   * writes the same settings the TUI renders. `config` is the fully resolved
   * effective value (defaults + global + project), `sources` says what came
   * from where.
   */
  settingsGet?(): Promise<{
    config: Record<string, unknown>;
    sources: Array<{
      scope: "defaults" | "global" | "project";
      path?: string;
      applied: boolean;
      diagnostic?: string;
    }>;
  }>;
  settingsSet?(
    patch: Record<string, unknown>,
    scope: "global" | "project",
  ): Promise<{ applied: boolean }>;
  /**
   * The response cache's runtime face (rina Phase 4): read its state, or
   * flip the opt-in for the live process (a restart-free toggle, beside
   * the composition row's boot-time one). Omitted input reads; `enabled`
   * sets. The stats answer "is it earning its keep" — the study's
   * metrics, readable without opening the operation log.
   */
  /**
   * Applies the config on disk. Refusal is a value rather than an exception,
   * because refusing is a normal outcome — applying new policy underneath a
   * running turn would change the rules the turn started under.
   */
  reloadConfig?(): Promise<{ applied: boolean; reason?: string }>;
  cancel(reason?: string, sessionID?: string): void;
  /**
   * Pauses the running turn. Refusal is a value: there may be nothing running, or
   * it may already be paused, and both are ordinary answers. Returning nothing
   * made the RPC reply claim `paused: true` in every case, including when the
   * runtime had done nothing at all.
   */
  pause?(
    reason?: string,
    sessionID?: string,
  ): PauseOutcome | Promise<PauseOutcome>;
  /** Resumes a paused turn. Refusal is a value, as with `pause`. */
  resume?(sessionID?: string): ResumeOutcome | Promise<ResumeOutcome>;
  /**
   * Selects the agent for subsequent turns. Three outcomes are real and were all
   * invisible to a caller: applied now, deferred until the running turn ends, or
   * rejected because no such agent exists.
   */
  selectAgent?(
    name?: string,
    sessionID?: string,
  ): AgentSelectionOutcome | Promise<AgentSelectionOutcome>;
  agents?(input?: {
    workspaceID?: string;
  }): Promise<RuntimeAgentCatalogEntry[]>;
  modelCatalog?(input?: {
    workspaceID?: string;
  }): Promise<RuntimeModelCatalogEntry[]>;
  modelSelection?(sessionID?: string): Promise<RuntimeModelSelection>;
  selectModel?(
    modelID?: string,
    variant?: string,
    sessionID?: string,
  ): Promise<void>;
  setDefaultModel?(
    modelID: string,
  ): Promise<{ saved: boolean; reason?: string }>;
  /** A session-local Composer override for subsequent provider requests. */
  reasoningEffort?(
    sessionID?: string,
  ): Promise<RuntimeReasoningEffort | undefined>;
  setReasoningEffort?(
    effort?: RuntimeReasoningEffort,
    sessionID?: string,
  ): Promise<void>;
  skills?(input?: {
    workspaceID?: string;
  }): Promise<RuntimeSkillCatalogEntry[]>;
  /** The settings panel's switch: a disabled skill stays listed but is refused. */
  skillSetEnabled?(input: {
    name: string;
    enabled: boolean;
    workspaceID?: string;
  }): Promise<{ name: string }>;
  /** Deletes a workspace-owned skill (project/user); other sources refuse. */
  skillRemove?(input: {
    name: string;
    workspaceID?: string;
  }): Promise<{ removed: string }>;
  workspaceFiles?(input?: {
    workspaceID?: string;
    query?: string;
    type?: "file" | "directory";
    limit?: number;
  }): Promise<RuntimeWorkspaceFileEntry[]>;
  workspaceSearch?(input: {
    workspaceID?: string;
    query: string;
    include?: string;
    limit?: number;
  }): Promise<RuntimeWorkspaceMatch[]>;
  workspaceList?(input?: {
    workspaceID?: string;
    path?: string;
    offset?: number;
    limit?: number;
  }): Promise<RuntimeWorkspaceListPage>;
  workspaceRead?(input: {
    workspaceID?: string;
    path: string;
    offset?: number;
    limit?: number;
  }): Promise<RuntimeWorkspaceContent>;
  /**
   * Reads a plugin-declared workspace resource by contribution name.
   *
   * This is the named counterpart to `workspaceRead`: callers describe the
   * resource, not the plugin's private directory layout.
   */
  resourceRead?(
    input: RuntimeWorkspaceResourceReadInput,
  ): Promise<RuntimeWorkspaceContent>;
  /** Writes a file inside the active workspace. */
  workspaceWrite?(input: {
    workspaceID?: string;
    path: string;
    content: string;
    encoding?: "utf8" | "base64";
  }): Promise<{ written: boolean }>;
  /** Creates a new file or directory inside the active workspace. */
  workspaceCreate?(input: {
    workspaceID?: string;
    path: string;
    content?: string;
    encoding?: "utf8" | "base64";
    directory?: boolean;
  }): Promise<{ created: boolean }>;
  /** Renames a file or directory inside the active workspace. */
  workspaceRename?(input: {
    workspaceID?: string;
    path: string;
    newPath: string;
  }): Promise<{ renamed: boolean }>;
  /** Moves a file or directory to the system trash/recycle bin. */
  workspaceDelete?(input: {
    workspaceID?: string;
    path: string;
  }): Promise<{ deleted: boolean; trash: boolean }>;
  /**
   * Returns the current workspace write-lock activity: which sessions are
   * currently writing (or waiting to write) which paths. Read-only.
   */
  workspaceWriteConflicts?(input?: { workspaceID?: string }): Promise<
    Array<{
      sessionID?: string;
      paths: string[];
      acquiredAt: number;
      queuedAt: number;
      active: boolean;
    }>
  >;
  /** Lists all workspace roots managed by this runtime host. */
  workspaceRoots?(): Promise<WorkspaceSummary[]>;
  /**
   * Adds a workspace root to the runtime host. When the root is already
   * registered, a provided `title` updates that workspace's display title.
   */
  workspaceAdd?(input: {
    path: string;
    title?: string;
  }): Promise<WorkspaceSummary>;
  /** Removes a workspace root from the runtime host. */
  workspaceRemove?(workspaceID: string): Promise<{ removed: boolean }>;
  /** Makes a workspace root the active target for runtime operations. */
  workspaceActivate?(workspaceID: string): Promise<WorkspaceSummary>;
  workspacePermissionGet?(
    workspaceID: string,
  ): Promise<WorkspacePermissionSettings>;
  workspacePermissionSet?(
    workspaceID: string,
    settings: WorkspacePermissionSettings,
  ): Promise<WorkspacePermissionSettings>;
  workspaceToolGet?(workspaceID: string): Promise<WorkspaceToolSettings>;
  workspaceToolSet?(
    workspaceID: string,
    settings: WorkspaceToolSettings,
  ): Promise<WorkspaceToolSettings>;
  workspaceGlob?(input: {
    workspaceID?: string;
    pattern: string;
    path?: string;
    limit?: number;
  }): Promise<RuntimeWorkspaceFileEntry[]>;
  nativeTerminalList?(
    sessionID?: string,
  ): Promise<RuntimeNativeTerminalSession[]>;
  nativeTerminalRead?(
    id: string,
    sessionID?: string,
  ): Promise<{ id: string } & RuntimeTerminalRead>;
  nativeTerminalOpenHub?(): Promise<{ muxWindowID: number }>;
  nativeTerminalClaimHumanInput?(
    id: string,
    sessionID?: string,
  ): Promise<RuntimeNativeTerminalSession>;
  nativeTerminalRevokeApprovalScope?(
    id: string,
    sessionID?: string,
  ): Promise<{
    id: string;
    scope: string;
    revoked: boolean;
  }>;
  nativeTerminalReleaseHumanControl?(
    id: string,
    sessionID?: string,
  ): Promise<RuntimeNativeTerminalSession>;
  nativeTerminalBeginSecureInput?(
    id: string,
    sessionID?: string,
  ): Promise<RuntimeNativeTerminalSession>;
  nativeTerminalEndSecureInput?(
    id: string,
    sessionID?: string,
  ): Promise<RuntimeNativeTerminalSession>;
  nativeTerminalStop?(
    id: string,
    sessionID?: string,
  ): Promise<RuntimeNativeTerminalSession>;
  /**
   * Starts a native terminal session remotely. The route exists and is a write;
   * the host must explicitly enable terminal writes (`terminalWrite: true`),
   * otherwise the call is refused. `cwd` defaults to the runtime's workspace
   * root. Remote callers are treated as model-side actors for ownership and
   * secure-input arbitration.
   */
  nativeTerminalStart?(input: {
    command: string;
    cwd?: string;
    id?: string;
    sessionID?: string;
    agentID?: string;
  }): Promise<RuntimeNativeTerminalSession>;
  /**
   * Writes input bytes (including control bytes such as Enter, Ctrl-C, Esc) to
   * a native terminal session. Refused while a human holds input, while secure
   * input is active, or when the host has not enabled terminal writes.
   * `idempotencyKey` makes a replay answer `delivery: "duplicate"` instead of
   * writing again.
   */
  nativeTerminalWrite?(input: {
    id: string;
    input: string;
    idempotencyKey?: string;
    sessionID?: string;
    /** Who is typing; absent means the model (a tool call writing in). */
    actor?: "model" | "human";
  }): Promise<{
    id: string;
    writtenBytes: number;
    delivery: "accepted" | "duplicate" | "cancelled";
  }>;
  /**
   * Resizes a native terminal session. Subject to the same secure-input
   * interlock as the model-side tool; geometry itself stays human-owned.
   */
  nativeTerminalResize?(input: {
    id: string;
    rows: number;
    cols: number;
    sessionID?: string;
  }): Promise<RuntimeNativeTerminalSession>;
  checkpointList?(sessionID?: string): Promise<RuntimeCheckpoint[]>;
  checkpointListByKind?(
    kind?: CheckpointKind,
    sessionID?: string,
  ): Promise<RuntimeCheckpoint[]>;
  auditRounds?(
    planID?: string,
    workspaceID?: string,
  ): Promise<AuditRoundRecord[]>;
  roundDiff?(input: {
    workspaceID?: string;
    from: CheckpointRef;
    to: CheckpointRef;
    paths?: string[];
    includePatch?: boolean;
    includeContent?: boolean;
    maxFiles?: number;
    maxPatchChars?: number;
  }): Promise<RuntimeWorkspaceDiffChange[]>;
  checkpointPreview?(
    id: string,
    sessionID?: string,
    options?: {
      includePatch?: boolean;
    },
  ): Promise<CheckpointPreview>;
  checkpointRollback?(input: {
    id: string;
    dryRun?: boolean;
    sessionID?: string;
  }): Promise<CheckpointPreview>;
  checkpointRename?(input: {
    id: string;
    name: string;
    sessionID?: string;
  }): Promise<RuntimeCheckpoint>;
  sandboxList?(sessionID?: string): Promise<RuntimeSandbox[]>;
  sandboxDiff?(
    id: string,
    sessionID?: string,
    options?: {
      includePatch?: boolean;
    },
  ): Promise<RuntimeSandboxChange[]>;
  sandboxResources?(
    id: string,
    sessionID?: string,
  ): Promise<RuntimeSandboxResource[]>;
  sandboxResourceOutput?(input: {
    id: string;
    resourceID: string;
    maxBytes?: number;
    sessionID?: string;
  }): Promise<string>;
  sandboxMerge?(
    id: string,
    sessionID?: string,
  ): Promise<RuntimeSandboxChange[]>;
  sandboxDelete?(
    id: string,
    sessionID?: string,
  ): Promise<{
    pendingChanges: RuntimeSandboxChange[];
    runningResources: string[];
  }>;
  /**
   * Undoes one sandbox's promotion. `restored: false` means there was nothing to
   * undo, not that the rollback failed.
   */
  sandboxRollback?(
    id: string,
    sessionID?: string,
  ): Promise<{ restored: boolean }>;
  sandboxResourceStop?(input: {
    id: string;
    resourceID: string;
    sessionID?: string;
  }): Promise<RuntimeSandboxResource>;
  sessionList?(): Promise<RuntimeSessionSummary[]>;
  sessionTouch?(id: string): Promise<void>;
  sessionRename?(id: string, title: string): Promise<RuntimeSessionSummary>;
  sessionPin?(id: string, pinned: boolean): Promise<RuntimeSessionSummary>;
  sessionDuplicate?(id: string, title?: string): Promise<RuntimeSessionSummary>;
  sessionFork?(
    id: string,
    turnID: string,
    title?: string,
  ): Promise<RuntimeSessionSummary>;
  sessionRollbackMessages?(
    id: string,
    turnID: string,
  ): Promise<{ id: string; rolledBackTo: string; safetyCheckpointID?: string }>;
  sessionDelete?(
    id: string,
  ): Promise<{ id: string; removedAttachments: number }>;
  /**
   * Creates a session record. Idempotent by id: creating an existing id
   * answers `created: false` with the existing summary instead of failing.
   * With no id the runtime mints one. A write.
   */
  sessionNew?(input?: {
    id?: string;
    title?: string;
    workspaceID?: string;
  }): Promise<{ sessionID: string; created: boolean }>;
  /**
   * Archives a session record: it stays listable with `archived: true` and
   * can still be exported, but is no longer a candidate for new work. A
   * write; idempotent (archiving an archived session answers
   * `archived: true`).
   */
  sessionArchive?(id: string): Promise<{ id: string; archived: boolean }>;
  /**
   * Restores an archived session so it becomes attachable and visible in the
   * normal workspace session list again. Idempotent: restoring an active
   * session answers `archived: false`.
   */
  sessionRestore?(id: string): Promise<{ id: string; archived: boolean }>;
  /**
   * Exports a session's journal: the record header plus every event in
   * sequence. Read-only; an unknown session id is an argument error.
   */
  sessionExport?(id: string): Promise<{
    sessionID: string;
    title: string;
    createdAt: string;
    archived: boolean;
    events: Array<{ seq: number; event: RuntimeEvent }>;
  }>;
  /**
   * Makes an existing durable session the active session of this runtime without
   * rebuilding the host process. An in-flight turn remains owned by its current
   * session and continues in the background; attach switches only the session
   * this runtime presents to its UI and direct calls.
   */
  sessionAttach?(id: string): Promise<{ sessionID: string }>;
  mcpCatalog?(input?: { workspaceID?: string }): Promise<MCPCatalogSnapshot>;
  /**
   * Lists permission profiles with the active default. Read-only.
   */
  permissionList?(): Promise<{
    default: string;
    profiles: Array<{ name: string } & PermissionProfile>;
  }>;
  /**
   * Creates or replaces a permission profile. Validated against the config
   * schema; the config file is written either way and the runtime reloads
   * it — `applied: false` with a reason when a running turn blocks the
   * reload. A write.
   */
  permissionSave?(input: {
    name: string;
    profile: PermissionProfile;
  }): Promise<{ saved: boolean; applied: boolean; reason?: string }>;
  /**
   * Deletes a permission profile. Idempotent: an unknown name answers
   * `deleted: true`. The profile currently selected as default is refused
   * (`deleted: false` with a reason). A write.
   */
  permissionDelete?(name: string): Promise<{
    deleted: boolean;
    reason?: string;
  }>;
  /**
   * Adds or replaces an MCP server from its config (the MCP official field
   * set: type/command/args/url/headers/environment/…). The runtime writes
   * the config and reconnects the server; connection failures surface as
   * diagnostics. A write.
   */
  mcpServerAdd?(input: {
    workspaceID?: string;
    name: string;
    config: MCPServerConfig;
  }): Promise<{ saved: boolean }>;
  /**
   * Removes an MCP server. Idempotent: an unknown name answers
   * `removed: true`. The runtime writes the config and disconnects. A write.
   */
  mcpServerRemove?(
    name: string,
    workspaceID?: string,
  ): Promise<{ removed: boolean }>;
  /**
   * Creates an agent definition. A write; creating an existing name answers
   * `created: false` with a reason.
   */
  agentCreate?(input: {
    workspaceID?: string;
    name: string;
    config: AgentConfig;
  }): Promise<{ created: boolean; reason?: string }>;
  /**
   * Replaces an agent definition. A write; an unknown name is an argument
   * error.
   */
  agentUpdate?(input: {
    workspaceID?: string;
    name: string;
    config: AgentConfig;
  }): Promise<{ updated: boolean }>;
  /**
   * Deletes an agent definition. A write; idempotent (unknown answers
   * `deleted: true`); the default agent refuses deletion.
   */
  agentDelete?(
    name: string,
    workspaceID?: string,
  ): Promise<{
    deleted: boolean;
    reason?: string;
  }>;
  /**
   * Discovers the models a provider endpoint offers, without configuring it.
   * Read-only, but carries the api key for the probe.
   */
  providerDiscover?(input: {
    type: string;
    baseURL: string;
    apiKey: string;
    headers?: Record<string, string>;
  }): Promise<{ models: string[] }>;
  /**
   * Adds or replaces a provider by type, endpoint and key, and applies the
   * config. A write.
   */
  providerAdd?(input: {
    name: string;
    type: string;
    baseURL?: string;
    apiKey: string;
    label?: string;
    previousName?: string;
    headers?: Record<string, string>;
    models?: Array<{
      id: string;
      name?: string;
      reasoning?: boolean;
      image?: boolean;
      contextWindow?: number;
    }>;
  }): Promise<{ saved: boolean }>;
  /**
   * Removes a provider and its catalog models and model overrides. A write;
   * idempotent. Refuses deletion when the provider is referenced by the
   * configured default model, an agent or mode, or a loaded session. References
   * from the provider's own models do not prevent deletion.
   */
  providerRemove?(name: string): Promise<{
    removed: boolean;
    reason?: string;
    /** Set when the deleted provider supplied the global default model. */
    defaultModel?: string;
  }>;
  /**
   * Unloads a plugin. A write; idempotent (unknown answers `unloaded: true`).
   */
  pluginUnload?(id: string): Promise<{ unloaded: boolean }>;
  /**
   * Reloads a plugin from its manifest path: unloads the current instance and
   * re-imports the module. A write; an unknown plugin id is an argument
   * error.
   */
  pluginReload?(id: string): Promise<{ reloaded: boolean }>;
  /**
   * Hot-reloads an out-of-tree tool family: re-imports its entry with a
   * cache-busting query and re-registers it without a restart. This is what a
   * self-modifying agent triggers after its change is promoted. A write; an
   * unknown family id or a disabled family is an argument error.
   */
  toolFamilyReload?(id: string): Promise<{ reloaded: boolean }>;
  getMcpPrompt?(
    server: string,
    name: string,
    arguments_?: Record<string, string>,
    workspaceID?: string,
  ): Promise<unknown>;
  readMcpResource?(
    server: string,
    uri: string,
    workspaceID?: string,
  ): Promise<unknown>;
  plugins?(): Promise<PluginStatus[]>;
  pluginInstall?(input: { spec: string }): Promise<{
    installed: boolean;
    pluginID: string;
    packageName?: string;
  }>;
  pluginUninstall?(input: { pluginID: string }): Promise<{
    uninstalled: boolean;
    pluginID: string;
  }>;
  pluginSetEnabled?(input: {
    pluginID: string;
    enabled: boolean;
  }): Promise<{ pluginID: string; enabled: boolean }>;
  pluginCatalog?(): Promise<PluginCatalogEntry[]>;
  /**
   * Unattended work, read-only.
   *
   * These exist so an integration can list and inspect scheduled tasks and flows
   * without shelling out to the CLI. They report problems per entry instead of
   * throwing, so one broken document cannot blank the list. Running a task is
   * deliberately not here: it is a long, side-effecting operation with its own
   * preflight, and belongs to the task controller rather than a read API.
   */
  /**
   * Commands contributed by capabilities and plugins, so a UI can render them
   * without knowing which extension produced each one.
   */
  commandCatalog?(input?: {
    workspaceID?: string;
  }): Promise<ContributedCommand[]>;
  commandExecute?(input: ContributedCommandExecution): Promise<void>;
  runtimeStatus?(sessionID?: string): Promise<RuntimeStatusSnapshot>;
  diagnostics?(
    limit?: number,
    sessionID?: string,
  ): Promise<RuntimeDiagnostic[]>;
  /**
   * The operation log's records (T3/T4: the telemetry zone's read face for
   * a host — the same records the CLI's debug bundle reads and the query
   * primitives filter). Pure read: leveled, rotated, redaction-sealed.
   */
  operationRecords?(input?: {
    level?: import("./schema-types").OperationRecord["level"];
    component?: string;
    contains?: string;
    since?: string;
    limit?: number;
  }): Promise<import("./schema-types").OperationRecord[]>;
  snapshot(input?: { sessionID?: string; workspaceID?: string }): RuntimeEvent;
  diagnostic(message: string, level?: "info" | "warning" | "error"): void;
  lastSubmission(input?: {
    sessionID?: string;
    workspaceID?: string;
  }): SubmittedTurn | undefined;
  /**
   * Answers a pending approval. Refusal is a value: a request that timed out or
   * was already answered is dropped, which an external UI has to know about —
   * "the model was told this call did not run" and "your answer arrived" are
   * different facts. This used to return nothing and the RPC reply said
   * `responded: true` either way.
   */
  respondApproval(
    response: ApprovalResponse,
  ): InteractiveResponseOutcome | Promise<InteractiveResponseOutcome>;
  /** Answers a pending question. Refusal is a value, as with `respondApproval`. */
  respondQuestion(
    response: QuestionResponse,
  ): InteractiveResponseOutcome | Promise<InteractiveResponseOutcome>;
  /** Answers a generic `interactive.request` by id + kind. */
  respondInteractive?(
    response: InteractiveResponse,
  ): InteractiveResponseOutcome | Promise<InteractiveResponseOutcome>;
  constitutionRules?(sessionID?: string): Promise<
    Array<{
      ruleID: string;
      statement: string;
      scope: "project" | "package" | "sandbox" | "task" | "release";
      priority: "critical" | "high" | "medium" | "low";
      /** `agent_proposed` marks a model-authored rule approved by the user (EI §3.8 P-1.c). */
      source: "user" | "master_plan" | "policy" | "agent_proposed";
      enforcement: "deny" | "approval" | "warn";
      overridePolicy: "forbidden" | "user_scoped" | "user_explicit";
      /** Structured anchor for hard enforcement (EI §3.8 P-1.c). */
      appliesTo?: {
        tools?: string[];
        paths?: string[];
        commandPattern?: string;
      };
      /** EI §3.7.5 provenance for an agent-proposed rule. */
      proposedBy?: "agent" | "navi";
      approvedBy?: "user";
    }>
  >;
  /**
   * The granted scoped overrides (ledger plan §3's ScopedOverride), the
   * companion read to `constitutionRules`: the session's overrides merged
   * with the workspace-tier ones, time-filtered at read time so an expired
   * override answers as expired rather than vanishing silently. A rule's
   * `overridePolicy: "forbidden"` never appears here — the request is
   * refused before a grant exists.
   */
  constitutionOverrides?(sessionID?: string): Promise<
    Array<{
      id: string;
      ruleID: string;
      reason: string;
      approvedBy: "user";
      paths?: string[];
      taskID?: string;
      expiresAt?: string;
    }>
  >;
  /**
   * Session-scoped decisions by default. `scope: "workspace"` reads the
   * instance/workspace store explicitly; `"all"` merges both and marks each
   * record's source. A bare string is accepted as the session id for
   * compatibility and intentionally means session scope.
   */
  decisionRecords?(
    input?:
      | string
      | {
          sessionID?: string;
          scope?: "session" | "workspace" | "all";
          limit?: number;
          cursor?: string;
        },
  ): Promise<
    GovernancePage<{
      id: string;
      scope: "session" | "workspace";
      decision: string;
      rationale: string[];
      alternatives: { option: string; rejectedReason?: string }[];
      consequences: string[];
      status: "proposed" | "accepted" | "superseded";
      linkedPlans: string[];
      linkedConstraints: string[];
    }>
  >;
  /**
   * Records a decision as a durable `decision.recorded` fact. The decision text
   * and rationale may reach the journal — safe prose only, never tool output,
   * file content or secrets.
   */
  recordDecision?(
    input: {
      decision: string;
      rationale?: string[];
      alternatives?: { option: string; rejectedReason?: string }[];
      consequences?: string[];
      linkedPlans?: string[];
      linkedConstraints?: string[];
      /**
       * `session` (default) keeps the decision in this session's journal.
       * `workspace` also promotes it to the instance/workspace decision store;
       * callers must opt in explicitly so ordinary decisions never leak across
       * sessions.
       */
      scope?: "session" | "workspace";
    },
    sessionID?: string,
  ): Promise<{ recorded: boolean }>;
  /** The durable mailbox of Live Work Chat intents, projected from the journal. */
  mailboxList?(sessionID?: string): Promise<
    Array<{
      messageID: string;
      source: "user_via_live_chat" | "system";
      priority: "normal" | "high" | "urgent";
      intent: string;
      text: string;
      safeSummary: string;
      relatedPlanID?: string;
      deliveryPolicy: string;
      createdAt: string;
      status: string;
      reason?: string;
    }>
  >;
  /**
   * Enqueues a Live Work Chat intent as a durable mailbox message. The text is
   * user intent prose that may reach the journal — secrets must be redacted by
   * the caller; `safeSummary` is the bounded, redacted summary.
   */
  mailboxSend?(input: {
    source?: "user_via_live_chat" | "system";
    priority?: "normal" | "high" | "urgent";
    intent: string;
    text: string;
    safeSummary?: string;
    relatedPlanID?: string;
    deliveryPolicy?: string;
    sessionID?: string;
  }): Promise<{ queued: boolean; messageID?: string }>;
  /** Marks a queued mailbox message delivered at a safe boundary. */
  mailboxDeliver?(
    messageID: string,
    sessionID?: string,
  ): Promise<{ delivered: boolean }>;
  /** Acknowledges a delivered mailbox message. */
  mailboxAcknowledge?(
    messageID: string,
    sessionID?: string,
  ): Promise<{ acknowledged: boolean }>;
  /** Defers a mailbox message, with a safe reason. */
  mailboxDefer?(
    messageID: string,
    reason?: string,
    sessionID?: string,
  ): Promise<{ deferred: boolean }>;
  /** Supersedes a mailbox message, with a safe reason. */
  mailboxSupersede?(
    messageID: string,
    reason?: string,
    sessionID?: string,
  ): Promise<{ superseded: boolean }>;
  /**
   * Lists persisted plan documents for the workspace. Plan content lives in
   * Markdown under `.natalia/plans/`; this is only the lightweight registry
   * (planID, documentPath, title, status).
   */
  planDocList?(sessionID?: string): Promise<
    Array<{
      planID: string;
      title: string;
      documentPath: string;
      status: string;
      createdBy: "user" | "live_chat" | "main_agent";
      createdAt: string;
      updatedAt: string;
      /**
       * Monotonic content revision (EI §3.4): bumps on every plan-document
       * write, and is the value a WorkContract draft binds to as its
       * planVersion. A draft whose planVersion is older than the document's
       * revision is stale and must be re-proposed.
       */
      revision: number;
      markedAt?: string;
      /**
       * The status this plan had before it was paused, so a resume returns
       * the plan's OWN state (the 2026-10-08 audit's P0-3: a pause round
       * trip used to land every plan on `executing`).
       */
      statusBeforePause?: string;
    }>
  >;
  /** Reads a Markdown plan document by planID or path. */
  planDocRead?(input: {
    planID?: string;
    path?: string;
    sessionID?: string;
  }): Promise<{
    planID?: string;
    title?: string;
    documentPath: string;
    content: string;
  }>;
  /**
   * Writes a Markdown plan document. Only `.natalia/plans/` paths are accepted.
   * If the path is not yet marked, a draft record is created.
   */
  planDocWrite?(input: {
    path: string;
    content: string;
    title?: string;
    planID?: string;
    sessionID?: string;
  }): Promise<{ written: boolean; planID?: string }>;
  /** Marks a plan document as a formal Plan and returns its stable planID. */
  planDocMark?(input: {
    path: string;
    title?: string;
    /**
     * Who marked the plan (EI §8.1): `user` for a direct user mark, `live_chat`
     * when Navi marks the plan the user directed her to draft, `main_agent`
     * when the main agent marks it. Defaults to `user`.
     */
    createdBy?: "user" | "live_chat" | "main_agent";
    sessionID?: string;
  }): Promise<{ marked: boolean; planID: string }>;
  /**
   * The session's projected runtime notices (ADR Phase C): the latest
   * prompt-level instruction change per kind (config reload, agent switch,
   * plan handoff). Later revisions supersede earlier ones; nothing mutates
   * history.
   */
  notices?(sessionID?: string): Promise<RuntimeProjectedNotice[]>;
  /** Deletes a plan registry record (does not delete the Markdown file). */
  planDocDelete?(
    planID: string,
    sessionID?: string,
  ): Promise<{ deleted: boolean }>;
  /** Reads the current lifecycle status of a marked plan. */
  planDocStatus?(
    planID: string,
    sessionID?: string,
  ): Promise<{ status: string }>;
  /**
   * The plan lifecycle statuses that END a plan: `completed` (the audit passed)
   * and `handed_off` (a next plan took over). A plan in one of these is a closed
   * fact: `planDocUpdateStatus` refuses to move it back to a live status, which
   * is what let a pause/resume return a finished plan to `executing` in the
   * 2026-10-06 smoke run (T-20). Writers that project a terminal status must
   * spell it exactly as it appears here.
   */
  planDocUpdateStatus?(input: {
    planID: string;
    status: string;
    sessionID?: string;
  }): Promise<{ updated: boolean; reason?: string }>;
  /**
   * Pause/resume that keeps the plan's OWN status: a pause records the
   * status the plan had before it and a resume returns that status, so
   * `audit_gaps` round trips as `audit_gaps` — never as a hardcoded
   * `executing` (the 2026-10-08 audit's P0-3).
   */
  planDocPause?(input: {
    planID: string;
    paused: boolean;
    sessionID?: string;
  }): Promise<{
    updated: boolean;
    status?: string;
    previousStatus?: string;
    reason?: string;
  }>;
  /**
   * Reads the session-scoped active plan pointer. Plan documents themselves are
   * workspace-level; activation is independent per session.
   */
  planDocActive?(sessionID?: string): Promise<{ planID?: string }>;
  /** Sets the session's active plan pointer without changing lifecycle status. */
  planDocActivate?(
    planID: string,
    sessionID?: string,
  ): Promise<{ planID?: string; updated: boolean }>;
  /** Clears the session's active plan pointer. */
  planDocDeactivate?(
    sessionID?: string,
  ): Promise<{ planID?: string; updated: boolean }>;

  /**
   * Directly pause/resume/clear the session's current goal, bypassing the
   * model. used by the status-bar controls so a stuck turn can still be stopped.
   */
  goalControl?(
    action: "pause" | "resume" | "clear",
    sessionID?: string,
  ): Promise<{ ok: boolean; action: string; message?: string }>;

  /**
   * Edit the current goal's objective / round cap / plan from the status bar,
   * bypassing the model. Compare-and-set on `goalID`/`revision`; a running goal
   * round gets a `next-step` steering note so it can adapt without a restart.
   */
  goalEdit?(
    input: GoalEditInput,
    sessionID?: string,
  ): Promise<{ ok: boolean; action: string; message?: string }>;

  evidenceRecords?(
    input?: { sessionID?: string; limit?: number; cursor?: string },
    sessionID?: string,
  ): Promise<
    GovernancePage<{
      /**
       * The record's id — the string `record_validation` returns and
       * `record_completion`'s evidenceIDs cite (T-02). Without it a caller
       * cannot correlate its citation with the record it names.
       */
      id: string;
      taskID: string;
      objective: string;
      status: string;
      /** E3: the status driven by its plan's lifecycle, when the record belongs to a task. */
      effectiveStatus?: string;
      changes: Array<{
        path: string;
        changeType: "added" | "modified" | "deleted";
        summary: string;
      }>;
      validations: Array<{
        command: string;
        result: "passed" | "failed" | "skipped";
        safeSummary: string;
        artifactRef?: string;
        durationMs?: number;
      }>;
      knownGaps: string[];
      recordedAt?: string;
      environment?: string;
    }>
  >;
  /**
   * Runs a validation command against the workspace and records the outcome as
   * a durable `evidence.recorded` fact. Only the command, outcome, bounded safe
   * summary and duration reach the journal — the raw output is redacted and
   * truncated before recording.
   */
  recordValidation?(
    input: {
      taskID: string;
      objective: string;
      command: string;
      timeoutSec?: number;
      knownGaps?: string[];
    },
    sessionID?: string,
  ): Promise<{
    recorded: boolean;
    result?: "passed" | "failed";
    safeSummary?: string;
  }>;
  /** The completion cards, projected from the journal (P2 E4). */
  completions?(
    input?: { sessionID?: string; limit?: number; cursor?: string },
    sessionID?: string,
  ): Promise<
    GovernancePage<{
      completionID: string;
      taskID: string;
      objective: string;
      changeSummary: string;
      behaviorImpact?: string;
      validations: Array<{
        command: string;
        result: "passed" | "failed" | "skipped";
        safeSummary: string;
      }>;
      humanValidation?: string;
      knownGaps: string[];
      externalSideEffects: string[];
      rollbackState?: string;
      evidenceIDs: string[];
      recordedAt: string;
    }>
  >;
  /**
   * Discovery G-c — the external baseline: the frozen eval's directory
   * (named by the caller or NATALIA_EVAL_DIR) read into its typed shape,
   * answered BESIDE the internal position (G-b's aggregate). No per-task
   * delta: our journal's runs have no key joining them to the external
   * tasks, and the join's absence is stated, not bridged.
   */
  externalBenchmark?(
    input?: { dir?: string },
    sessionID?: string,
  ): Promise<
    | { joined: false; reason: "no_eval_dir"; note: string }
    | {
        /** The joins this harness recorded (the per-task comparison). */
        joined: boolean;
        benchmark: {
          name: string;
          status?: string;
          model?: string;
          taskCount: number;
          harnessCount: number;
          configurationCount: number;
          tasks: Array<{
            id: string;
            title: string;
            expected: number;
            successful: number;
            successRate: number;
            difficulty?: string;
            category?: string;
          }>;
          source: string;
        };
        external: {
          tasks: number;
          harnesses: number;
          configurations: number;
          cells: number;
          successes: number;
          successRate: number;
        };
        internal: {
          promptGroups: number;
          runs: number;
          successes: number;
          successRate: number;
        };
        perTask: Array<{
          externalTaskID: string;
          baselineSuccessRate: number;
          ourRuns: number;
          ourSuccessRate: number;
        }>;
        note: string;
      }
  >;
  /**
   * Block ②'s writer: promote ONE growth trigger to a proposal through
   * the constitution's class policy. Records the `growth.promoted`
   * fact; **applies nothing** — the composition's apply_generation
   * keeps its own approval floor (growth 默认不自授权).
   */
  promoteGrowthTrigger?(
    input: { capability: string },
    sessionID?: string,
  ): Promise<
    | { promoted: false; reason: "no_session" | "unknown_trigger" }
    | {
        promoted: true;
        destination: "skill" | "policy" | "generation";
        approval: "auto" | "human" | "human_plus_verification";
        appliedBy: string;
        next: string;
        reason: string;
      }
  >;
  /**
   * Block ②'s reader: the journaled promotions, each naming its
   * destination, approval and next step (the audit trail).
   */
  growthPromotions?(sessionID?: string): Promise<
    Array<{
      promotionID: string;
      at: string;
      trigger: {
        rule: string;
        capability: string;
        evidence: Record<string, number | string>;
        reason: string;
      };
      destination: "skill" | "policy" | "generation";
      approval: "auto" | "human" | "human_plus_verification";
      appliedBy: string;
      next: string;
      reason: string;
    }>
  >;
  /**
   * Block ②'s writer: promote ONE growth trigger to a proposal through
   * the constitution's class policy. Records the `growth.promoted`
   * fact; **applies nothing** — the composition's apply_generation
   * keeps its own approval floor (growth 默认不自授权).
   */
  promoteGrowthTrigger?(
    input: { capability: string },
    sessionID?: string,
  ): Promise<
    | { promoted: false; reason: "no_session" | "unknown_trigger" }
    | {
        promoted: true;
        destination: "skill" | "policy" | "generation";
        approval: "auto" | "human" | "human_plus_verification";
        appliedBy: string;
        next: string;
        reason: string;
      }
  >;
  /**
   * Block ②'s reader: the journaled promotions, each naming its
   * destination, approval and next step (the audit trail).
   */
  growthPromotions?(sessionID?: string): Promise<
    Array<{
      promotionID: string;
      at: string;
      trigger: {
        rule: string;
        capability: string;
        evidence: Record<string, number | string>;
        reason: string;
      };
      destination: "skill" | "policy" | "generation";
      approval: "auto" | "human" | "human_plus_verification";
      appliedBy: string;
      next: string;
      reason: string;
    }>
  >;
  /**
   * Block ②'s writer: promote ONE growth trigger to a proposal through
   * the constitution's class policy. Records the `growth.promoted`
   * fact; **applies nothing** — the composition's apply_generation
   * keeps its own approval floor (growth 默认不自授权).
   */
  promoteGrowthTrigger?(
    input: { capability: string },
    sessionID?: string,
  ): Promise<
    | { promoted: false; reason: "no_session" | "unknown_trigger" }
    | {
        promoted: true;
        destination: "skill" | "policy" | "generation";
        approval: "auto" | "human" | "human_plus_verification";
        appliedBy: string;
        next: string;
        reason: string;
      }
  >;
  /**
   * Block ②'s reader: the journaled promotions, each naming its
   * destination, approval and next step (the audit trail).
   */
  growthPromotions?(sessionID?: string): Promise<
    Array<{
      promotionID: string;
      at: string;
      trigger: {
        rule: string;
        capability: string;
        evidence: Record<string, number | string>;
        reason: string;
      };
      destination: "skill" | "policy" | "generation";
      approval: "auto" | "human" | "human_plus_verification";
      appliedBy: string;
      next: string;
      reason: string;
    }>
  >;
  /**
   * Discovery G-d — the repeated correction patterns: the human's
   * corrections across the journal's safe sources, clustered into
   * 固化 suggestions. A suggestion applies nothing; the destination's
   * class is the constitution's approval policy's business.
   */
  correctionPatterns?(sessionID?: string): Promise<{
    suggestions: Array<{
      capability: string;
      observations: number;
      destination: "rule" | "skill" | "tool" | "policy";
      sources: Array<"mailbox" | "human_validation" | "rejected_alternative">;
      reason: string;
    }>;
    considered: { corrections: number };
  }>;
  /**
   * The growth branch's trigger face (the study's "G-d + 触发面"): the
   * four growth systems' views assembled into the triggers that deserve
   * the human's attention — each naming its rule, its evidence (the
   * source's own numbers) and its destination class. Applies nothing;
   * the NGM proposal interface and the constitution's approval policy
   * decide.
   */
  growthTriggers?(sessionID?: string): Promise<
    Array<{
      rule:
        | "prompt_success"
        | "benchmark_gap"
        | "correction_pattern"
        | "capability_gap";
      class: "skill" | "rule" | "policy" | "generation";
      capability: string;
      evidence: Record<string, number | string>;
      reason: string;
    }>
  >;
  /**
   * The joined per-task view alone (the trigger's G-c input): the joins
   * this harness recorded against the external benchmark.
   */
  externalJoinedTasks?(sessionID?: string): Promise<
    Array<{
      externalTaskID: string;
      baselineSuccessRate: number;
      ourRuns: number;
      ourSuccessRate: number;
    }>
  >;
  /**
   * Discovery G-c's join (the adapter layer's record): one of our runs
   * against an external task. The turn's score is READ from the journal
   * (the G-b scorer — no new telemetry); the task's id is the join's
   * explicit key, so the per-task comparison is a fact, not a hash
   * coincidence.
   */
  recordExternalRun?(
    input: { dir?: string; taskID: string; turnID: string },
    sessionID?: string,
  ): Promise<
    | { recorded: false; reason: "no_eval_dir" | "unknown_task" }
    | {
        recorded: true;
        externalTaskID: string;
        turnID: string;
        success?: boolean;
        baselineSuccessRate: number;
      }
  >;
  /**
   * Discovery G-b — the internal-evaluation read: the same prompt's
   * success/cost distribution, scored from the journal (a replay fold —
   * the fork/duplicate turns a prompt replayed through show up sharing
   * its promptKey). Read-only and defensive: missing numbers stay
   * undefined, never zero-invented.
   */
  promptRunGroups?(sessionID?: string): Promise<
    Array<{
      promptKey: string;
      runs: number;
      successes: number;
      successRate: number;
      avgInputTokens?: number;
      avgOutputTokens?: number;
      avgDurationMs?: number;
      avgSteps: number;
      retries: number;
      lastAt?: string;
    }>
  >;
  /**
   * Discovery G-a's growth faces. `growthPropose` derives the capability
   * curriculum from the journal (the completions' known gaps and the
   * plan's unbacked tasks) and records the `growth.proposed` fact — a
   * proposal applies nothing (the study's approval policy: growth 默认
   * 不自授权; the NGM proposal interface and the constitution's class
   * policy decide). `growthProposals` reads the journaled proposals.
   */
  growthPropose?(
    input?: { planID?: string },
    sessionID?: string,
  ): Promise<{
    proposalID: string;
    at: string;
    suggestions: Array<{
      kind: "tool" | "skill" | "rule" | "policy";
      capability: string;
      observations: number;
      sources: string[];
      reason: string;
    }>;
    considered: { tasks: number; gaps: number };
  }>;
  growthProposals?(sessionID?: string): Promise<
    Array<{
      proposalID: string;
      at: string;
      suggestions: Array<{
        kind: "tool" | "skill" | "rule" | "policy";
        capability: string;
        observations: number;
        sources: string[];
        reason: string;
      }>;
      considered: { tasks: number; gaps: number };
      sessionID?: string;
    }>
  >;
  /**
   * EI Phase 0: the user records a human validation note on a completion card
   * ("用户走 UI 补 humanValidation"). Durable; merged onto the card by
   * `completions`.
   */
  recordHumanValidation?(
    input: { taskID: string; validation: string },
    sessionID?: string,
  ): Promise<{ recorded: boolean; reason?: string }>;
  /**
   * The plan task state machine (EI §4 Phase 4): the plan document's markdown
   * checkboxes (declaration source) projected against the session's recorded
   * evidence (fact source), evidence-first. A checked box with no backing
   * evidence is a `gap`, never `verified`; skipped stays visible.
   */
  planTaskStates?(
    input?: { planID?: string },
    sessionID?: string,
  ): Promise<
    Array<{
      id: string;
      text: string;
      declaration: "open" | "done" | "skipped";
      depth: number;
      state: "pending" | "in_progress" | "verified" | "gap" | "skipped";
    }>
  >;
  /**
   * Work Graph integrity (EI WG4 / Phase 3 D): rebuilds the graph from the
   * session's complete event history and verifies the causal chain is not
   * faked — no dangling edges, no session-less (incomplete) nodes, no
   * duplicate ids. `stable` is the single trust bit.
   */
  workGraphIntegrity?(sessionID?: string): Promise<{
    nodeCount: number;
    edgeCount: number;
    danglingEdges: Array<{
      edgeID: string;
      sourceID: string;
      targetID: string;
      missing: "source" | "target" | "both";
    }>;
    incompleteNodes: Array<{ nodeID: string; kind: string; summary: string }>;
    duplicateNodeIDs: string[];
    stable: boolean;
  }>;
  /**
   * The unattributed workspace changes (EI WG4 / Phase 3 D): the workspace
   * changes the runtime could not attribute to a tool call, surfaced for
   * diagnosis, never silently folded into the causal chain.
   */
  unattributedChanges?(
    sessionID?: string,
  ): Promise<Array<{ nodeID: string; path: string; sessionID?: string }>>;
  /**
   * Record a completion card: the fixed report structure that answers "is it
   * really done, what evidence is missing". changeSummary is safe prose — never
   * a diff or file content.
   */
  recordCompletion?(
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
  ): Promise<{ recorded: boolean; completionID?: string }>;
  sessionSnapshot?(sessionID?: string): Promise<
    | {
        agentStatus: string;
        currentStep?: string;
        activeTool?: string;
        changedFiles: number;
        unvalidatedChanges: number;
        hasPTY: boolean;
        hasSandbox: boolean;
      }
    | undefined
  >;
  driftFindings?(
    input?: { sessionID?: string; limit?: number; cursor?: string },
    sessionID?: string,
  ): Promise<
    GovernancePage<{
      findingID: string;
      severity: "advisory" | "warning" | "high";
      confidence: number;
      originalObjective: string;
      currentActivity: string;
      evidence: string[];
      applicableConstraints: string[];
      status:
        | "open"
        | "explained"
        | "disputed"
        | "dismissed"
        | "corrected"
        | "detour_declared";
      /** How many times this finding was reopened (翻案, EI §3.5). */
      reopenedCount: number;
      rationale?: string;
      /** The evaluation contract version the finding was judged under (EI §8.6). */
      contractVersion: number;
      /** Which rules fired with their confidences (EI §8.6 judgment matrix). */
      ruleHits: Array<{ rule: string; confidence: number }>;
      /** The accepted contract's planID, when judged against one. */
      planID?: string;
    }>
  >;
  /**
   * Runs the DriftEvaluator against safe signals and publishes any
   * `drift.finding_opened` facts. The evaluator is the only production writer
   * of drift findings and has no write power — a finding only escalates to an
   * approval/Chat/mailbox prompt, never a cancellation.
   */
  evaluateDrift?(
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
      /** EI Phase 2 机制 2: recent action kinds for the no-progress window. */
      recentActions?: Array<{
        kind:
          | "workspace_change"
          | "evidence.recorded"
          | "plan_step"
          | "completion.recorded"
          | "tool_call";
      }>;
      /** EI Phase 2 机制 2: recent failed tool calls for the failure-loop rule. */
      recentFailures?: Array<{ toolName: string; key: string }>;
    },
    sessionID?: string,
  ): Promise<{ opened: number }>;
  /**
   * Acknowledge a drift finding (P7 D3 / EI §8.6): the Main Agent explains it,
   * disputes it, or declares a sanctioned detour; the user dismisses it or the
   * work corrects it. Only an open finding can transition.
   */
  acknowledgeDriftFinding?(
    input: {
      findingID: string;
      status:
        | "explained"
        | "disputed"
        | "dismissed"
        | "corrected"
        | "detour_declared";
      rationale?: string;
    },
    sessionID?: string,
  ): Promise<{ acknowledged: boolean }>;
  /**
   * Reopen a terminal drift finding (翻案, EI §3.5) — a user-only action that
   * lifts a dismissed/explained finding back to open. The findingID is
   * unchanged; the reopen is a new `drift.finding_updated(status:"open")` and
   * the projection counts it as `reopenedCount`. A corrected finding is not
   * reopenable (its premise is gone). The Main Agent cannot reopen.
   */
  reopenDriftFinding?(
    input: { findingID: string },
    sessionID?: string,
  ): Promise<{ reopened: boolean; reason?: string; reopenedCount?: number }>;
  requestOverride?(
    input: {
      ruleID: string;
      reason: string;
      paths?: string[];
      taskID?: string;
      expiresAt?: string;
    },
    sessionID?: string,
  ): Promise<{ requested: boolean; requestID?: string; reason?: string }>;
  approveOverride?(input: {
    requestID: string;
    decision: "once" | "reject";
  }): Promise<{ approved: boolean }>;
  /**
   * Update a constitution rule (EI §3.8 P-1.c, user-owned): disable or
   * re-enable a hard rule (`enabled:false` is a reversible update; the durable
   * tombstone is `removeConstitutionRule`). Only a user edits rules — a model
   * never disables or weakens an existing one.
   */
  updateConstitutionRule?(
    input: {
      ruleID: string;
      enabled?: boolean;
      statement?: string;
      enforcement?: "deny" | "approval" | "warn";
      priority?: "critical" | "high" | "medium" | "low";
      appliesTo?: {
        tools?: string[];
        paths?: string[];
        commandPattern?: string;
      };
    },
    sessionID?: string,
  ): Promise<{ updated: boolean; reason?: string }>;
  /**
   * Remove a constitution rule (EI §3.8 P-1.c, user-owned): an append-only
   * tombstone — the journal keeps the rule's full history, the effective set
   * drops it. Requires the caller's confirmation; a model never deletes.
   */
  removeConstitutionRule?(
    input: { ruleID: string },
    sessionID?: string,
  ): Promise<{ removed: boolean }>;
  /**
   * Add a user-owned constitution rule (EI §3.8 P-1.c, user-owned): the user
   * creates a rule directly from the Constitution tab. Provenance is
   * `source: "user"`. Release scope is rejected; a deny/approval rule requires
   * a non-empty appliesTo anchor.
   */
  createConstitutionRule?(
    input: {
      statement: string;
      enforcement: "deny" | "approval" | "warn";
      scope?: "project" | "package";
      appliesTo?: {
        tools?: string[];
        paths?: string[];
        commandPattern?: string;
      };
      priority?: "critical" | "high" | "medium" | "low";
    },
    sessionID?: string,
  ): Promise<{ created: boolean; ruleID?: string; reason?: string }>;
  /**
   * The constitution/AGENTS document rules (EI §3.8 P-1.c): the sections parsed
   * from the workspace documents, each tagged with its enforcement (prose →
   * warn, `<!-- enforcement -->` → hard with appliesTo). The soft rules the UI
   * can promote into journal rules.
   */
  constitutionDocRules?(sessionID?: string): Promise<
    Array<{
      id: string;
      source: "constitution" | "agents";
      section: string;
      statement: string;
      enforcement: "deny" | "approval" | "warn";
      annotated: boolean;
      appliesTo?: {
        tools?: string[];
        paths?: string[];
        commandPattern?: string;
      };
    }>
  >;
  /**
   * Promote a parsed document rule into the executable journal (EI §3.8 P-1.c):
   * a user lifts a soft section into a hard `constitution.rule_added` (source
   * "user", no gate). A deny/approval rule must already carry a non-empty
   * appliesTo anchor; a promote without one is refused.
   */
  promoteConstitutionDocRule?(
    input: { id: string },
    sessionID?: string,
  ): Promise<{ promoted: boolean; ruleID?: string; reason?: string }>;
  /**
   * Edit a soft (document) constitution/AGENTS rule in place and write it back
   * (EI §3.8 P-1.c): the user rewrites a section's prose and syncs its
   * enforcement / appliesTo annotations. The document is the source of truth;
   * a deny/approval rule requires a non-empty appliesTo anchor.
   */
  updateConstitutionDocRule?(
    input: {
      id: string;
      statement?: string;
      enforcement?: "deny" | "approval" | "warn";
      appliesTo?: {
        tools?: string[];
        paths?: string[];
        commandPattern?: string;
      };
    },
    sessionID?: string,
  ): Promise<{ updated: boolean; reason?: string }>;
  registeredTools?(sessionID?: string): Promise<
    Array<{
      name: string;
      owner: string;
      scope: string;
      recovery: string;
      precedence: number;
      requiresApproval: boolean;
    }>
  >;
  capabilities?(input?: {
    workspaceID?: string;
  }): Promise<CapabilityRecordView[]>;
  projectionContributions?(input?: {
    workspaceID?: string;
  }): Promise<ProjectionContribution[]>;
  workGraphNodes?(input?: {
    sessionID?: string;
    workspaceID?: string;
  }): Promise<WorkGraphNodeView[]>;
  workGraphEdges?(input?: {
    sessionID?: string;
    workspaceID?: string;
  }): Promise<WorkGraphEdgeView[]>;
  /**
   * Sends the user's message into the Live Work Chat conversation (P8 C2). The
   * Chat is a long-lived, always-available collaborator with the full safe
   * project/execution context, not a stateless second agent; it answers with a
   * stream-owned `${channel}.chat.message.delta` and settles with
   * `${channel}.chat.message.added`.
   */
  /** Navi-owned stream surface. No shared channel parameter. */
  naviChat?: ChatStreamSurface;
  /** Nia-owned stream surface. No shared channel parameter. */
  niaChat?: ChatStreamSurface;

  /**
   * Current subagent views for the active session. The runtime keeps subagent
   * records in its own persistent registry, so this is a lazy read surface; it
   * does not require replaying the full session event log.
   */
  subagents?(sessionID?: string): Promise<RuntimeSubagentView[]>;
  subagentHistory?(sessionID?: string): Promise<RuntimeSubagentView[]>;
  /**
   * Paged subagent history for inspector panes. The legacy array surface stays
   * for callers that only need a bounded tail.
   */
  subagentHistoryPage?(input: {
    subagentID?: string;
    sessionID?: string;
    cursor?: string;
    limit?: number;
  }): Promise<TranscriptPage<RuntimeSubagentView>>;
};

export type ChatModelProfile = {
  normal?: {
    modelID?: string;
    variant?: string;
    reasoningEffort?: RuntimeReasoningEffort;
  };
  expert?: {
    modelID?: string;
    variant?: string;
    reasoningEffort?: RuntimeReasoningEffort;
  };
};

export type ChatMessageRow = {
  messageID: string;
  role: "user" | "chat" | "system";
  text: string;
  at: string;
  attachments?: LocalAttachment[];
  kind?: "message" | "thinking" | "tool" | "compaction" | "collab";
  tool?: {
    /** Durable event id, stable across replay and live hydration. */
    eventID?: string;
    name: string;
    status: string;
    summary: string;
    result?: string;
    argumentsRaw?: string;
    /** The tool's own card, so a replayed chat row renders like a live one. */
    card?: ToolCard;
    meta?: Record<string, unknown>;
    startedAt?: number;
    endedAt?: number;
  };
};

export type FakeBackend = RuntimeClient;
