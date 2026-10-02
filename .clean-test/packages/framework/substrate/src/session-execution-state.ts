import type { AgentDefinition } from "@anthelia/agent";
import type {
  LocalAttachment,
  ModelCapabilities,
  RuntimeReasoningEffort,
  SubmittedTurn,
} from "@anthelia/contracts";
import {
  ContextLedger,
  TokenMeter,
  type StreamingProvider,
} from "@anthelia/runtime";
import type { SessionFactState, SessionRecord } from "@anthelia/session";
import type { SkillMetadata } from "@anthelia/runtime-services";
import type { RuntimeContextStatusConfig } from "./status-config";

export type CollabSnapshot = {
  collabMessages: import("@anthelia/session").ProjectedCollabMessage[];
  planDocs: import("@anthelia/session").ProjectedPlanDoc[];
  mailboxMessages: import("@anthelia/session").ProjectedMailboxMessage[];
  revision: number;
  eventCount: number;
};

type PermissionProfile = import("@anthelia/contracts").PermissionProfile;

export type SessionExecutionState = {
  session: SessionRecord;
  context: ContextLedger;
  attachmentReferences: Map<string, LocalAttachment[]>;
  toolCalls: Map<string, number[]>;
  provider?: StreamingProvider;
  runtimeContextConfig: RuntimeContextStatusConfig;
  activeModelCapabilities?: ModelCapabilities;
  permissionMode: "ask" | "auto" | "read_only";
  permissionProfile?: PermissionProfile;
  activeAbort?: AbortController;
  activeTurnID?: string;
  selectedAgent?: AgentDefinition;
  pendingAgent?: AgentDefinition;
  selectedModel?: { modelID?: string; variant?: string };
  reasoningEffort?: RuntimeReasoningEffort;
  lastProviderUsage?: { inputTokens: number; outputTokens: number };
  /**
   * The provider prefix-cache tier's session total (RINA Phase 5's
   * observable): accumulated per step, separate from lastProviderUsage —
   * which stays per-step BY DESIGN (the ledger checkpoint reads it, and a
   * summed value made small turns look like 1M+ prompts once). The share
   * is derived at read time (rina's providerCacheShare), never stored.
   */
  providerCacheUsage?: {
    steps: number;
    inputTokens: number;
    cacheReadTokens: number;
  };
  /**
   * Calendar date this session's execution state was first built, fixed for the
   * session's life. It is snapshotted rather than read per request so the model
   * never sees two contradictory dates for when the session began.
   */
  sessionStartedAt: string;
  /**
   * The date the session's history currently reflects. Rolls forward when the
   * day changes under a long-running session, which appends one `dynamic` notice
   * rather than rewriting anything already said.
   */
  currentDate: string;
  activeSkill?: SkillMetadata;
  endTurnWaitingHuman?: { terminalID: string; reason: string };
  lastSubmitted?: SubmittedTurn;
  paused: boolean;
  pauseWaiters: Array<() => void>;
  naviChatLedger: ContextLedger;
  niaChatLedger: ContextLedger;
  /** Main/Natalia request meter. Chat streams own their own meters below. */
  tokenMeter: TokenMeter;
  naviTokenMeter: TokenMeter;
  niaTokenMeter: TokenMeter;
  naviChatModelProfile?: import("@anthelia/contracts").ChatModelProfile;
  niaChatModelProfile?: import("@anthelia/contracts").ChatModelProfile;
  advisorPending?: boolean;
  collabSnapshot?: CollabSnapshot;
  /** Total durable event count; may be larger than session.events.length when full events are still loading in background. */
  eventCount?: number;
  /** Next hidden per-session durable sequence to stamp on a persisted event. */
  nextSessionSeq: number;
  /** True once session.events holds the complete durable log (not the fast-path tail). */
  fullEventsLoaded?: boolean;
  /**
   * Incremental hot memory for this session, maintained at the event sink
   * (see session-facts.ts). Created lazily by `ensureSessionFactState`, so it
   * is absent until a surface first asks for it.
   */
  factState?: SessionFactState;
  /**
   * False while `factState` was seeded from a fast-attach tail instead of the
   * complete durable log. A consumer that needs cross-history facts (open drift,
   * active rules, pending mailbox) must not trust an incomplete state.
   */
  factStateComplete?: boolean;
  /**
   * EI Phase 1 "降档": true when terminal facts were evicted from the bounded
   * hot state. A read that needs the evicted entries reconstructs them from the
   * durable store instead of trusting the (now bounded) hot state.
   */
  factStateTerminalEvicted?: boolean;
  /** Memoized session projection for snapshot/intelligence reads at one event revision. */
  snapshotProjection?: {
    eventCount: number;
    value: import("@anthelia/session").SessionProjection;
  };
  /** Memoized promise that loads the complete durable event log into session.events. */
  fullEventsPromise?: Promise<void>;
  injectedMailboxIDs: Set<string>;
  /** Lazily opened shared event window for secondary projections. */
  eventWindow?: import("./session-window").SessionWindow<
    import("./session-window").SessionWindowEntry<
      import("@anthelia/contracts").RuntimeEvent
    >
  >;
  /**
   * Turn ids whose `turn.submitted` was already published, so the runtime can
   * avoid an O(events) journal scan before every turn. Seeded once from the
   * loaded journal and extended as turns are announced.
   */
  announcedTurnIDs: Set<string>;
  naviPendingQueue: Array<{
    messageID: string;
    text: string;
    attachments?: LocalAttachment[];
  }>;
  niaPendingQueue: Array<{
    messageID: string;
    text: string;
    attachments?: LocalAttachment[];
  }>;
  naviAbortWakePending?: boolean;
  niaAbortWakePending?: boolean;
};

/** Seeds {@link SessionExecutionState.announcedTurnIDs} from the loaded journal. */
export function announcedTurnIDsFrom(session: SessionRecord): Set<string> {
  const ids = new Set<string>();
  for (const event of session.events)
    if (event.type === "turn.submitted") ids.add(event.id);
  return ids;
}
