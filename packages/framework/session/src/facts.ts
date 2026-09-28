/**
 * The session package's NODE-FREE surface: the record types, the pure
 * folds and the re-exports every consumer uses — everything EXCEPT the
 * two stores (JsonSessionStore needs node:fs; SqliteSessionStore needs
 * bun:sqlite). A browser consumer never writes a session store — it
 * talks to the daemon over RPC — so the browser entry (./browser) is
 * this file, and the node entry (./index) is this file plus the stores.
 *
 * The split exists because a barrel that re-exports a node-only module
 * drags it into every consumer's bundle: the web build broke exactly so
 * (Vite externalized bun:sqlite, then the NAMED import failed hard).
 * index.ts re-exports this file, so the node-side surface is unchanged.
 */

import type { RuntimeEvent, SessionID } from "@anthelia/contracts";

export * from "./invariants";

export type SessionMetadata = {
  pinned?: boolean;
  lastAccessedAt?: string;
  /** Manual titles take precedence over generated and local fallback titles. */
  titleSource?: "manual" | "generated" | "fallback";
  inFlightOperation?: DurableInFlightOperation;
  /**
   * TERM-M.3 (c): a terminal the model asked a human to take over, with the
   * turn ended. Typed and durable like `inFlightOperation`; the runtime
   * resumes the task with a new turn once the human releases the pane.
   */
  pendingHumanTerminal?: {
    terminalID: string;
    reason: string;
    since: string;
  };
} & Record<string, unknown>;

/** Safe crash-audit state, intentionally insufficient to replay work. */
export type DurableInFlightOperation = {
  kind: "provider_dispatch" | "tool_execution";
  turnID: string;
  toolName?: string;
  toolCallID?: string;
  startedAt: string;
};

export type SessionRecord = {
  id: SessionID;
  title: string;
  createdAt: string;
  events: RuntimeEvent[];
  cancelled: boolean;
  resumable: boolean;
  metadata?: SessionMetadata;
  inbox?: import("./inbox").AdmittedSessionInput[];
};

export function createSessionRecord(
  id: SessionID,
  title: string,
  now = new Date(),
): SessionRecord {
  return {
    id,
    title,
    createdAt: now.toISOString(),
    events: [],
    cancelled: false,
    resumable: true,
  };
}

export function appendSessionEvent(
  session: SessionRecord,
  event: RuntimeEvent,
) {
  session.events.push(event);
  if (event.type === "turn.cancelled") session.cancelled = true;
}

export {
  releaseSessionRunCoordinator,
  SessionRunCoordinator,
  sessionRunCoordinator,
} from "./run-coordinator";
export {
  admitInput,
  admissionCutoff,
  buildInputAdmission,
  buildInputUpdated,
  buildSubmittedTurn,
  admittedInputs,
  claimNextSteps,
  normalizeDelivery,
  normalizeInbox,
  promoteInputToStep,
  promoteNextSteps,
  promoteNextTurn,
  removeAdmittedInput,
  replaceAdmittedInput,
  SessionInputConflictError,
} from "./inbox";
export type { AdmittedSessionInput, SessionInputDelivery } from "./inbox";
export {
  modelVisibleEvents,
  projectSessionMessages,
  projectedConstitutionRules,
  projectedConstitutionOverrides,
  projectedWorkContracts,
  projectedRuntimeNotices,
  nextContextInstructionsRevision,
  projectedDecisionRecords,
  latestSessionSnapshot,
  projectedCanonicalTools,
  projectedDriftFindings,
  projectedCapabilities,
  projectedEvidenceRecords,
  projectedCompletions,
  projectedGrowthProposals,
  projectedExternalRuns,
  projectedGrowthPromotions,
  projectedWorkGraphNodes,
  projectedWorkGraphEdges,
  projectedMailboxMessages,
  projectedPlanDocs,
  projectedChatMessages,
  projectedNaviChatMessages,
  projectedNiaChatMessages,
  projectedCollabMessages,
  normalizeCollaborationEvent,
  projectSession,
  PROJECTION_STATE_VERSION,
  initProjection,
  applyProjection,
  viewProjection,
  foldProjection,
  type SessionUsageBuckets,
  type SessionUsageTotals,
  emptySessionUsageTotals,
  serializeProjectionState,
  deserializeProjectionState,
  restoreProjection,
  settleInterruptedTurns,
  settleInterruptedTurnIDs,
  selectedAgentFromEvents,
  selectedModelFromEvents,
  emptySessionFactState,
  applySessionFactEvent,
  sessionFactStateFromEvents,
  sessionFactActiveTurnIDs,
  sessionFactConstitutionRules,
  sessionFactConstitutionOverrides,
  emptySessionConstitutionFactState,
  emptySessionIntelligenceFactState,
  applySessionConstitutionFact,
  sessionConstitutionRulesFrom,
  type SessionConstitutionFactState,
  sessionFactWorkContracts,
  emptySessionWorkContractFactState,
  applySessionWorkContractFact,
  sessionWorkContractsFrom,
  sessionFactDriftFindings,
  sessionFactEvidenceRecords,
  sessionFactCompletions,
  sessionFactGrowthProposals,
  sessionFactExternalRuns,
  sessionFactGrowthPromotions,
  sessionFactGoal,
  sessionFactHumanValidation,
  evictTerminalFacts,
  FACT_TERMINAL_LIMIT,
  sessionFactMailboxMessages,
  sessionFactDecisionRecords,
  sessionFactLatestSnapshot,
  sessionFactCollabMessages,
  sessionFactIntelligenceFacts,
  sessionIntelligenceFactsFrom,
  sessionIntelligenceFactsFromEvents,
  sessionFactNaviChatMessages,
  sessionFactNiaChatMessages,
  sessionFactCollaborationEvents,
  isCollaborationStreamEvent,
  sessionFactDiagnosticStreamEvents,
  isDiagnosticStreamEvent,
  settlementRecordsFromEvents,
} from "./projector";
export type {
  ProjectedCapability,
  ProjectedDriftFinding,
  ProjectedCollabMessage,
  ProjectedMailboxMessage,
  ProjectedPlanDoc,
  ProjectedWorkContract,
  SessionProjection,
  ProjectionState,
  SerializedProjectionState,
  SessionFactState,
  SessionWorkContractFactState,
  SessionIntelligenceFactState,
  SessionIntelligenceFacts,
} from "./projector";
export type { SettlementNoticeRecord } from "./projector";
export { projectInteractiveRequests, requestsForSession } from "./interactive";
export type {
  InteractiveProjection,
  PendingApproval,
  PendingQuestion,
} from "./interactive";
