import type { SessionID } from "@anthelia/contracts";
import type { ServiceOperation } from "@anthelia/runtime-services";

/** Governance ledger contracts, moved from runtime-services with the token. */

export interface GovernanceLedgerController {
  seedConstitutionRules: ServiceOperation;
  recordDecision: ServiceOperation;
  boundValidationOutcome: ServiceOperation;
  buildHumanValidation: ServiceOperation;
  buildCompletionRecorded: ServiceOperation;
  buildEvidenceRecorded: ServiceOperation;
  evidenceStatusForPlanState: ServiceOperation;
  validateConstitutionRuleProposal: ServiceOperation;
  buildProposedConstitutionRule: ServiceOperation;
  buildPromotedConstitutionRule: ServiceOperation;
  buildConstitutionRuleUpdate: ServiceOperation;
  buildUserConstitutionRule: ServiceOperation;
  buildConstitutionRuleRemoved: ServiceOperation;
}
