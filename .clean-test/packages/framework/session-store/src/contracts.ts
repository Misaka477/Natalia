import type {
  ChatModelProfile,
  DurableContextCheckpointRecord,
  GoalSnapshot,
  LocalAttachment,
  PromptAgentMention,
  PromptResourceMention,
  RuntimeEvent,
  RuntimeMessagePage,
  RuntimeReasoningEffort,
  RuntimeSessionSummary,
  SessionID,
} from "@anthelia/contracts";
import type {
  AdmittedSessionInput,
  SessionMetadata,
  SessionRecord,
  StoredContextEpoch,
} from "@anthelia/session";

/**
 * Session store contracts, moved from runtime-services as the token
 * migration completed: the package that implements the mechanism declares
 * its face.
 */

export type SessionStoreRecoveryView = {
  activeTurnIDs: string[];
  goal?: GoalSnapshot & {
    roundsStarted: number;
    activation: "armed" | "disarmed";
    createdAt?: string;
    updatedAt?: string;
  };
  approvals: Array<Extract<RuntimeEvent, { type: "approval.request" }>>;
  questions: Array<Extract<RuntimeEvent, { type: "question.request" }>>;
  interactives: Array<Extract<RuntimeEvent, { type: "interactive.request" }>>;
  selectedAgent?: string;
  selectedModel?: { modelID?: string; variant?: string };
  reasoningEffort?: RuntimeReasoningEffort;
  chatModelProfile?: Record<string, ChatModelProfile>;
  permissionMode?: "ask" | "auto" | "read_only";
  permissionProfile?: string;
  attachments: Map<string, LocalAttachment[]>;
  diagnostics: Array<Extract<RuntimeEvent, { type: "diagnostic" }>>;
};

export interface SessionStoreController {
  init(): Promise<void>;
  status(): { initialized: boolean; mode: "sqlite" | "json" };
  load(
    id: SessionID,
    options?: {
      title?: string;
      create?: boolean;
      indexedRecovery?: boolean;
      /** Load only events the live execution projection needs. */
      runtimeEvents?: boolean;
    },
  ): Promise<{
    session: SessionRecord;
    contextEpoch?: StoredContextEpoch;
    recovery?: SessionStoreRecoveryView;
  }>;
  saveInbox(session: SessionRecord): Promise<void>;
  /**
   * The durable inbox on disk — the turn controller's claim authority: a
   * second live client over one session carries its own record, and a
   * claim made only there would let both run the same turn.
   */
  loadInbox(sessionID: SessionID): Promise<AdmittedSessionInput[]>;
  /**
   * Cheap read of the fast-restore recovery projection (no full event load).
   * Used to re-seed live projections — e.g. the goal status bar — on attach.
   */
  loadRecoveryProjection(id: SessionID): SessionStoreRecoveryView | undefined;
  appendEvent(session: SessionRecord, event: RuntimeEvent): Promise<void>;
  appendEvents(session: SessionRecord, events: RuntimeEvent[]): Promise<void>;
  updateMetadata(
    session: SessionRecord | SessionID,
    partial: Partial<SessionMetadata>,
  ): Promise<void>;
  contextEventsAfter(
    id: SessionID,
    epoch?: StoredContextEpoch,
  ): RuntimeEvent[] | undefined;
  writeContextEpoch(
    id: SessionID,
    snapshot: import("@anthelia/contracts").DurableContextCheckpointRecord,
  ): void;
  ensureMessageIndex(id: SessionID): void;
  ensureMessageIndexAsync(id: SessionID): Promise<void>;
  prewarmMessagePage(id: SessionID): Promise<void>;
  loadFullAsync(
    id: SessionID,
    options?: { runtimeEvents?: boolean },
  ): Promise<SessionRecord>;
  referencedAttachments(): Promise<LocalAttachment[]>;
  /** Durable event count for one session, independent of the live window. */
  eventCount(id: SessionID): Promise<number>;
  history(
    id: SessionID,
    fallback: RuntimeEvent[],
    options?: { after?: number; offset?: number; limit?: number },
  ): Promise<{
    events: Array<{
      seq: number;
      sessionSeq?: number;
      event: RuntimeEvent;
    }>;
    hasMore: boolean;
  }>;
  eventWindow(
    id: SessionID,
    fallback: RuntimeEvent[],
    options?: { beforeSeq?: number; limit?: number },
  ): Promise<{
    events: Array<{
      seq: number;
      sessionSeq?: number;
      event: RuntimeEvent;
    }>;
    hasMore: boolean;
  }>;
  messages(
    id: SessionID,
    fallback: SessionRecord,
    options?: { limit?: number; order?: "asc" | "desc"; cursor?: string },
  ): Promise<RuntimeMessagePage>;
  flush(id?: SessionID): Promise<void>;
  list(): Promise<RuntimeSessionSummary[]>;
  touch(id: string): Promise<void>;
  rename(id: string, title: string): Promise<RuntimeSessionSummary>;
  pin(id: string, pinned: boolean): Promise<RuntimeSessionSummary>;
  duplicate(id: string, title?: string): Promise<RuntimeSessionSummary>;
  fork(
    id: string,
    turnID: string,
    title?: string,
  ): Promise<RuntimeSessionSummary>;
  messageRollback(
    id: string,
    turnID: string,
  ): Promise<{ id: string; rolledBackTo: string; safetyCheckpointID?: string }>;
  delete(id: string): Promise<{ id: string; removedAttachments: number }>;
  create(input: {
    id?: string;
    title?: string;
  }): Promise<{ sessionID: string; created: boolean }>;
  setAutoTitle(
    id: string,
    title: string,
    source: "generated" | "fallback",
  ): Promise<RuntimeSessionSummary>;
  archive(id: string): Promise<{ id: string; archived: boolean }>;
  restore(id: string): Promise<{ id: string; archived: boolean }>;
  export(id: string): Promise<{
    sessionID: string;
    title: string;
    createdAt: string;
    archived: boolean;
    events: Array<{ seq: number; event: RuntimeEvent }>;
  }>;
  close(): Promise<void>;
  /**
   * Persist a serialized projection checkpoint stamped with the current max
   * event sequence, so a later attach can resume by folding only the tail.
   * Returns the stamped last sequence.
   */
  saveProjectionCheckpoint(id: SessionID, serializedState: string): number;
  /**
   * Load a serialized projection checkpoint. Returns undefined when absent,
   * written by an older state version, or corrupt, so the caller fails soft to
   * a full projection.
   */
  loadProjectionCheckpoint(
    id: SessionID,
  ): { serializedState: string; lastSeq: number } | undefined;
  /** Durable events after a sequence, for tail-replaying a checkpoint. */
  eventsAfter(id: SessionID, after: number): RuntimeEvent[];
}
