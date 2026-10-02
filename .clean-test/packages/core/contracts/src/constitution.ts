/**
 * Constitution vocabulary shared by the runtime and the governance UI.
 *
 * A constitution rule is normally enforced by the journal: the projection
 * carries it and the tool-execution matcher executes it. A small set is
 * different — its guarantee is enforced by **hard-coded runtime code** (the
 * `SELF_PROTECTION_PATTERNS` in the tool-execution path, which block the
 * command before approval regardless of permission profile). Deleting the
 * journal row cannot remove that guarantee, so the runtime and the governance
 * panel refuse to edit, disable or delete these rules: a panel that pretended
 * otherwise would lie about the enforcement that is still active.
 */
export const HARD_PROTECTED_CONSTITUTION_RULE_IDS: ReadonlySet<string> =
  new Set(["C-TERM-001", "C-TERM-002", "C-TERM-003"]);

/**
 * True when a rule is backed by hard-coded runtime enforcement (see
 * `HARD_PROTECTED_CONSTITUTION_RULE_IDS`). Every other rule — including the
 * release-scope runtime-policy rules `C-REL-*` and user-owned
 * project/package rules — is editable/disableable/deletable by the user.
 */
export function isHardProtectedConstitutionRule(ruleID: string): boolean {
  return HARD_PROTECTED_CONSTITUTION_RULE_IDS.has(ruleID);
}
