import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { createIntelligenceSurface } from "@natalia/engineering-intelligence";
import type { RuntimeContext } from "@anthelia/substrate";
import { createTestContext } from "@anthelia/runtime-services";
import { governanceLedgerController } from "@natalia/governance-ledger";
import { workLedgerController } from "@natalia/work-ledger";
import type { SessionExecutionState } from "@anthelia/substrate";
import { sessionFactStateFromEvents } from "@anthelia/session";

/**
 * Pure intelligence writes must not pull the full journal: they only need the
 * live execution (session id / active turn) and the ledgers. The fake service
 * deliberately has no `loadFullAsync`, so any accidental
 * `ensureSessionFullEvents()` would throw.
 */
function harness() {
  const published: RuntimeEvent[] = [];
  let decisionSequence = 0;
  const exec = {
    session: { id: "ses_pure_writes", events: [] },
    activeTurnID: "turn_1",
  } as unknown as SessionExecutionState;

  const ledger = {
    seedConstitutionRules: () => [],
    recordDecision: (input: { id: string; decision: string }) => ({
      type: "decision.recorded",
      id: input.id,
      decision: input.decision,
      status: "proposed",
    }),
    decisionNode: (input: {
      decisionID: string;
      decision: string;
      sessionID: string;
    }) => ({
      type: "workgraph.node_added",
      id: `wg:decision:${input.decisionID}`,
      nodeID: `wg:decision:${input.decisionID}`,
      kind: "decision",
      summary: input.decision,
      sessionID: input.sessionID,
    }),
    evaluateDrift: () => [],
    buildCompletionRecorded: (input: { id: string; taskID: string }) => ({
      type: "completion.recorded",
      id: input.id,
      taskID: input.taskID,
      objective: "objective",
      changeSummary: "summary",
      validations: [],
    }),
    buildAuditRequested: (input: { id: string; triggerEventID: string }) => ({
      type: "audit.requested",
      id: input.id,
      triggerEventID: input.triggerEventID,
      planID: "plan:1",
      planVersion: 1,
      round: 1,
      scope: "completion_recorded",
      at: "2026-01-01T00:00:00.000Z",
    }),
    completionValidationEdge: () => ({
      type: "workgraph.edge_added",
      id: "wg:edge:1",
      fromNodeID: "wg:change:1",
      toNodeID: "wg:completion:1",
      kind: "validated_by",
    }),
    boundValidationOutcome: () => undefined,
    buildHumanValidation: () => undefined,
    buildEvidenceRecorded: () => undefined,
    evidenceStatusForPlanState: () => undefined,
    validateConstitutionRuleProposal: () => [],
    buildProposedConstitutionRule: () => undefined,
    buildPromotedConstitutionRule: () => undefined,
    buildConstitutionRuleUpdate: () => undefined,
    buildUserConstitutionRule: () => undefined,
    buildConstitutionRuleRemoved: () => undefined,
    // WorkLedgerController face of the same double (the port stub answered
    // every lookup with it; the directory needs it registered per token).
    buildPlanDocCreated: () => undefined,
    buildPlanDocUpdated: () => undefined,
    buildPlanDocMarked: () => undefined,
    buildPlanDocDeleted: () => undefined,
    buildPlanDocStatus: () => undefined,
    evaluateBehaviorDrift: () => [],
    buildWorkContractDrafted: () => undefined,
    buildWorkContractAccepted: () => undefined,
    buildDetourRequested: () => undefined,
    buildDetourReviewed: () => undefined,
    validateDetour: () => [],
    mergeDetourIntoContract: () => undefined,
    validateWorkContractFields: () => [],
    evaluateCompletionCard: () => undefined,
    agentActionNode: () => undefined,
    approvalEdge: () => undefined,
    approvalNode: () => undefined,
    completionNode: () => undefined,
    checkpointNode: () => undefined,
    constitutionCheckEdge: () => undefined,
    constitutionRuleNode: () => undefined,
    externalWorkspaceChangeNode: () => undefined,
    toolCallEdge: () => undefined,
    toolCallNode: () => undefined,
    rollbackCheckpointEdge: () => undefined,
    buildDriftFindingUpdate: () => undefined,
    workspaceChangeEdge: () => undefined,
    workspaceChangeNode: () => undefined,
  };

  const ctx = {
    state: {
      pluginStoreRoot: "/tmp/natalia-pure-writes",
      serviceDirectory: createTestContext([
        governanceLedgerController.mock(ledger),
        workLedgerController.mock(ledger),
      ]),
    },
    ports: {
      getReady: async () => undefined,
      getExecutionBySession: () => new Map([["ses_pure_writes", exec]]),
      getActiveExec: () => exec,
      resolveService: () => ledger,
      publishForSession: (_exec: unknown, event: RuntimeEvent) => {
        published.push(event);
      },
      nextDecisionSequence: () => (decisionSequence += 1),
      nextCompletionSequence: () => 1,
      nextPlanSequence: () => 1,
      requestNiaWake: () => undefined,
      getWorkspaceRoot: () => "/tmp",
    },
  } as unknown as RuntimeContext;

  return {
    surface: createIntelligenceSurface(ctx, {}),
    published,
  };
}

test("recordDecision records without loading full history", async () => {
  const { surface, published } = harness();
  const result = await surface.recordDecision!(
    { decision: "Use the shared session window" },
    "ses_pure_writes",
  );
  expect(result).toEqual({ recorded: true });
  expect(published.filter((e) => e.type === "decision.recorded")).toHaveLength(
    1,
  );
  expect(
    published.filter(
      (e) => e.type === "workgraph.node_added" && e.kind === "decision",
    ),
  ).toHaveLength(1);
});

test("evaluateDrift records without loading full history", async () => {
  const { surface } = harness();
  const result = await surface.evaluateDrift!(
    { objective: "ship", currentActivity: "testing" },
    "ses_pure_writes",
  );
  expect(result).toEqual({ opened: 0 });
});

test("recordCompletion records without loading full history", async () => {
  const { surface, published } = harness();
  const result = await surface.recordCompletion!(
    {
      taskID: "task_1",
      objective: "ship",
      changeSummary: "did the thing",
    },
    "ses_pure_writes",
  );
  expect(result.recorded).toBe(true);
  expect(
    published.filter((e) => e.type === "completion.recorded"),
  ).toHaveLength(1);
});

test("acknowledgeDriftFinding reads a complete hot state without a full load", async () => {
  const published: RuntimeEvent[] = [];
  const earlier: RuntimeEvent = {
    type: "drift.finding_opened",
    id: "drift:1",
    findingID: "DF-1",
    severity: "warning",
    confidence: 0.5,
    originalObjective: "objective",
    currentActivity: "activity",
    evidence: [],
    applicableConstraints: [],
    contractVersion: 2,
  };
  const exec = {
    // A tail-only base: folding the journal here would miss the finding.
    session: { id: "ses_hot_state", events: [] },
    factState: sessionFactStateFromEvents([earlier]),
    factStateComplete: true,
  } as unknown as SessionExecutionState;
  const ledger = {
    buildDriftFindingUpdate: (input: {
      id: string;
      findingID: string;
      status: string;
      rationale?: string;
    }) => ({
      type: "drift.finding_updated",
      id: input.id,
      findingID: input.findingID,
      status: input.status,
      ...(input.rationale ? { rationale: input.rationale } : {}),
    }),
    seedConstitutionRules: () => [],
    recordDecision: () => undefined,
    decisionNode: () => undefined,
    evaluateDrift: () => [],
    buildCompletionRecorded: () => undefined,
    buildAuditRequested: () => undefined,
    completionValidationEdge: () => undefined,
    boundValidationOutcome: () => undefined,
    buildHumanValidation: () => undefined,
    buildEvidenceRecorded: () => undefined,
    evidenceStatusForPlanState: () => undefined,
    validateConstitutionRuleProposal: () => [],
    buildProposedConstitutionRule: () => undefined,
    buildPromotedConstitutionRule: () => undefined,
    buildConstitutionRuleUpdate: () => undefined,
    buildUserConstitutionRule: () => undefined,
    buildConstitutionRuleRemoved: () => undefined,
    buildPlanDocCreated: () => undefined,
    buildPlanDocUpdated: () => undefined,
    buildPlanDocMarked: () => undefined,
    buildPlanDocDeleted: () => undefined,
    buildPlanDocStatus: () => undefined,
    evaluateBehaviorDrift: () => [],
    buildWorkContractDrafted: () => undefined,
    buildWorkContractAccepted: () => undefined,
    buildDetourRequested: () => undefined,
    buildDetourReviewed: () => undefined,
    validateDetour: () => [],
    mergeDetourIntoContract: () => undefined,
    validateWorkContractFields: () => [],
    evaluateCompletionCard: () => undefined,
    agentActionNode: () => undefined,
    approvalEdge: () => undefined,
    approvalNode: () => undefined,
    completionNode: () => undefined,
    checkpointNode: () => undefined,
    constitutionCheckEdge: () => undefined,
    constitutionRuleNode: () => undefined,
    externalWorkspaceChangeNode: () => undefined,
    toolCallEdge: () => undefined,
    toolCallNode: () => undefined,
    rollbackCheckpointEdge: () => undefined,
    workspaceChangeEdge: () => undefined,
    workspaceChangeNode: () => undefined,
  };
  const ctx = {
    state: {
      pluginStoreRoot: "/tmp/natalia-hot-state",
      serviceDirectory: createTestContext([
        governanceLedgerController.mock(ledger),
        workLedgerController.mock(ledger),
      ]),
    },
    ports: {
      getReady: async () => undefined,
      getExecutionBySession: () => new Map([["ses_hot_state", exec]]),
      getActiveExec: () => exec,
      resolveService: () => ({
        buildDriftFindingUpdate: (input: {
          id: string;
          findingID: string;
          status: string;
          rationale?: string;
        }) => ({
          type: "drift.finding_updated",
          id: input.id,
          findingID: input.findingID,
          status: input.status,
          ...(input.rationale ? { rationale: input.rationale } : {}),
        }),
      }),
      publishForSession: (_exec: unknown, event: RuntimeEvent) => {
        published.push(event);
      },
    },
  } as unknown as RuntimeContext;
  const surface = createIntelligenceSurface(ctx, {});
  const result = await surface.acknowledgeDriftFinding!(
    { findingID: "DF-1", status: "explained" },
    "ses_hot_state",
  );
  expect(result).toEqual({ acknowledged: true });
  expect(
    published.filter((e) => e.type === "drift.finding_updated"),
  ).toHaveLength(1);
});
