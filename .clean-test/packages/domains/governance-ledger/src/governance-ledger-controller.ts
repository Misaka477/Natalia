import {
  buildConstitutionRuleUpdate,
  buildUserConstitutionRule,
  buildConstitutionRuleRemoved,
  buildPromotedConstitutionRule,
  buildProposedConstitutionRule,
  recordDecision,
  seedConstitutionRules,
  validateConstitutionRuleProposal,
} from "./constitution-ledger";
import {
  boundValidationOutcome,
  buildCompletionRecorded,
  buildEvidenceRecorded,
  buildHumanValidation,
  evidenceStatusForPlanState,
} from "./evidence-ledger";
import type { GovernanceLedgerController } from "./contracts";

export function createGovernanceLedgerController(): GovernanceLedgerController {
  return {
    seedConstitutionRules,
    recordDecision,
    boundValidationOutcome,
    buildCompletionRecorded,
    buildEvidenceRecorded,
    buildHumanValidation,
    evidenceStatusForPlanState,
    validateConstitutionRuleProposal,
    buildProposedConstitutionRule,
    buildPromotedConstitutionRule,
    buildConstitutionRuleUpdate,
    buildUserConstitutionRule,
    buildConstitutionRuleRemoved,
  };
}
