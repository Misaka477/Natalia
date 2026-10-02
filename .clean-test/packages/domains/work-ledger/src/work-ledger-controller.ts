import {
  buildDriftFindingUpdate,
  createDriftEvaluator,
} from "./drift-evaluator";
import {
  buildAuditRequested,
  buildPlanDocCreated,
  buildPlanDocDeleted,
  buildPlanDocMarked,
  buildPlanDocStatus,
  buildPlanDocUpdated,
} from "./plan-registry";
import {
  buildDetourRequested,
  buildDetourReviewed,
  buildWorkContractAccepted,
  buildWorkContractDrafted,
  evaluateCompletionCard,
  mergeDetourIntoContract,
  validateDetour,
  validateWorkContractFields,
} from "./work-contract";
import {
  agentActionNode,
  approvalEdge,
  approvalNode,
  completionNode,
  completionValidationEdge,
  checkpointNode,
  constitutionCheckEdge,
  constitutionRuleNode,
  decisionNode,
  externalWorkspaceChangeNode,
  toolCallEdge,
  toolCallNode,
  rollbackCheckpointEdge,
  workspaceChangeEdge,
  workspaceChangeNode,
} from "./work-graph";
import type { WorkLedgerController } from "./contracts";

export function createWorkLedgerController(
  input: Parameters<typeof createDriftEvaluator>[0],
): WorkLedgerController {
  const driftEvaluator = createDriftEvaluator(input);
  return {
    buildPlanDocCreated,
    buildPlanDocDeleted,
    buildPlanDocMarked,
    buildPlanDocStatus,
    buildPlanDocUpdated,
    buildAuditRequested,
    evaluateDrift: driftEvaluator.evaluate,
    evaluateBehaviorDrift: driftEvaluator.evaluateBehavior,
    buildDriftFindingUpdate,
    buildWorkContractDrafted,
    buildWorkContractAccepted,
    buildDetourRequested,
    buildDetourReviewed,
    validateDetour,
    mergeDetourIntoContract,
    validateWorkContractFields,
    evaluateCompletionCard,
    agentActionNode,
    approvalEdge,
    approvalNode,
    completionNode,
    completionValidationEdge,
    checkpointNode,
    constitutionCheckEdge,
    constitutionRuleNode,
    decisionNode,
    externalWorkspaceChangeNode,
    toolCallEdge,
    toolCallNode,
    rollbackCheckpointEdge,
    workspaceChangeEdge,
    workspaceChangeNode,
  };
}
