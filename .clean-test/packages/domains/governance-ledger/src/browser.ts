/**
 * The governance-ledger package's BROWSER entry (the vite config aliases
 * `@natalia/governance-ledger` here for the web build): the pure surface
 * — the contracts, the folds, the rule builders. The node entry is this
 * plus the disk-backed store and the server-side controller (instance
 * governance JSON lives on the daemon's side; a browser consumer reads
 * the projected state through the snapshot, never the ledger file).
 *
 * Same shape as the session package's browser entry: a barrel that
 * re-exports a node-only module drags it into every consumer's bundle.
 */
export * from "./contracts";
export * from "./invariants";
// ./views is deliberately NOT here: its one disk-reading fold (loading
// the instance governance JSON) makes the module node-ful, and no
// browser consumer uses it today. If one ever needs a views fold, split
// that function out then — the entry is a loud list, not a barrel.
export {
  SELF_PROTECTION_RULES,
  buildConstitutionRuleUpdate,
  buildUserConstitutionRule,
  buildConstitutionRuleRemoved,
  buildPromotedConstitutionRule,
  buildProposedConstitutionRule,
  applicablePlanConstraints,
  constitutionPathMatch,
  recordDecision,
  seedConstitutionRules,
  validateConstitutionRuleProposal,
  type ConstitutionRuleProposal,
} from "./constitution-ledger";
export {
  boundValidationOutcome,
  buildCompletionRecorded,
  buildHumanValidation,
  buildEvidenceRecorded,
  evidenceStatusForPlanState,
  type EvidenceInput,
  type EvidenceRecordedStatus,
  type ValidationOutcome,
} from "./evidence-ledger";
