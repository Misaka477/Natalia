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
  /**
   * The intent the next Nia wake should run with, recorded by
   * `requestNiaWake` and consumed by `wakeNia`.
   *
   * The wake queue in the provider-model controller coalesces per session, so
   * the intent cannot ride the call: several wakes collapse into one, and the
   * last requester's intent is the one the merged wake runs with. The exec is
   * where the rest of this per-session wake state already lives
   * (`niaAbortWakePending`, `advisorPending`), and it is cleared once the wake
   * has read it so a later plain wake does not inherit a stale intent.
   */
  niaWakeIntent?: import("@anthelia/contracts").ChatTurnIntent;
  /**
   * 洞 2's four-rung ladder: the session's confinement rung, when the human
   * widened it mid-session (an escalation granted "for session" rather than
   * per-call). The policy home's resolve reads it as the session override —
   * it beats the deployment default and loses to a call's explicit grant.
   *
   * It lives on the exec because it is per-session and it dies with the
   * session: a restart starts at the deployment's rung again, and the
   * journal's `context.instructions {kind: "sandbox_rung"}` record is the
   * durable half that says the switch happened. A narrower session (the
   * human tightening) is the same field with a narrower mode — the ladder
   * moves in both directions.
   */
  sandboxModeOverride?: import("@anthelia/confinement").ConfinementMode;
  /**
   * The session's APPROVAL rung, when the human moved it mid-session.
   *
   * The other half of 洞 2's ladder. `permissionMode` above is the value the
   * session runs with; this remembers that the HUMAN chose it for this session,
   * which is what keeps a later `config.reload` from stamping the deployment's
   * mode back over the choice (the reload writes `exec.permissionMode`, and
   * without this field it had no way to tell "the config says ask" from "the
   * human said ask for this session").
   *
   * Like `sandboxModeOverride` it is per-session and dies with the session: a
   * restart starts at the deployment's rung, and the journal's
   * `context.instructions {kind: "sandbox_rung"}` record is the durable half.
   */
  permissionModeOverride?: "ask" | "auto" | "read_only";
  /**
   * True when THIS PROCESS moved the session's rung (`applySessionRung`).
   *
   * `permissionModeOverride` cannot answer that: it is filled at construction from
   * the store's recovery row, which can still hold the value a session was created
   * with. So a restart looked like "someone chose here" and the attach-time
   * reconcile skipped, leaving the execution on the stale mode.
   */
  permissionModeChosenInProcess?: boolean;
  /**
   * The session's SHELL, when the human moved it mid-session.
   *
   * Per-session and dies with the session, for the same reason as the rung
   * fields: a restart starts at the deployment's shell, and the journal's
   * `context.instructions {kind: "shell_switch"}` record is the durable half
   * that says the switch happened.
   *
   * The value is also projected onto `NATALIA_SHELL`, because the executor seam
   * reads the environment and six call sites ask for the executor at module
   * scope where no session state is reachable. Those sites resolve per call, so
   * the projection is what makes the switch take effect on the next command
   * rather than the next start.
   */
  shellOverride?: "bash" | "pwsh" | "zsh";
};

/** Seeds {@link SessionExecutionState.announcedTurnIDs} from the loaded journal. */
export function announcedTurnIDsFrom(session: SessionRecord): Set<string> {
  const ids = new Set<string>();
  for (const event of session.events)
    if (event.type === "turn.submitted") ids.add(event.id);
  return ids;
}
