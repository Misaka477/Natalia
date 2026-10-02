import type { RuntimeEvent } from "@anthelia/contracts";
import {
  applySessionConstitutionFact,
  emptySessionConstitutionFactState,
  projectedConstitutionRules,
  projectedDecisionRecords,
  sessionConstitutionRulesFrom,
  type SessionConstitutionFactState,
} from "@anthelia/session";
import {
  loadInstanceGovernance,
  resolveGovernanceRoot,
} from "./instance-store";

/**
 * The CST3 read face's data (constitution/decision ledger plan §5): the
 * workspace-tier instance store folded into the SAME projections the
 * runtime's `constitutionRules` / `decisionRecords` faces serve. One fold,
 * one home — the CLI's commands and any future slash/chat face read
 * exactly what the session face reads, with no second projection to drift.
 *
 * History is complete here the way the plan requires ("supersede 不抹除
 * 旧事实"): the effective set is what `list` shows, and the tombstones and
 * overrides ride along so `show` can still explain a rule that was removed
 * or is temporarily disabled.
 */

export type GovernanceRuleView = ReturnType<
  typeof projectedConstitutionRules
>[number];
export type GovernanceDecisionView = ReturnType<
  typeof projectedDecisionRecords
>[number];
export type GovernanceOverrideView = Extract<
  RuntimeEvent,
  { type: "constitution.override_granted" }
>;

export type GovernanceViews = {
  /** The instance store was unreadable — the answer is "unknown", not "empty". */
  degraded: boolean;
  /** The effective rule set: added, updated, not disabled, not removed. */
  rules: GovernanceRuleView[];
  /** Disabled rules: reversible, still in the journal, hidden from the set. */
  disabled: GovernanceRuleView[];
  /** The durable tombstones, so a removed rule stays explainable. */
  removed: Array<{ ruleID: string; at: string; removedBy: "user" }>;
  /** Decision records in journal order. */
  decisions: GovernanceDecisionView[];
  /** Granted scoped overrides (scope + expiry are on the event). */
  overrides: GovernanceOverrideView[];
};

export function governanceViews(workspaceRoot?: string): GovernanceViews {
  const instance = loadInstanceGovernance(resolveGovernanceRoot(workspaceRoot));
  const state: SessionConstitutionFactState =
    emptySessionConstitutionFactState();
  for (const event of instance.events)
    applySessionConstitutionFact(state, event);
  return {
    degraded: instance.degraded,
    rules: sessionConstitutionRulesFrom(state),
    disabled: [...state.rules.values()].filter((rule) =>
      state.disabled.has(rule.ruleID),
    ),
    removed: instance.events
      .filter(
        (
          event,
        ): event is Extract<
          RuntimeEvent,
          { type: "constitution.rule_removed" }
        > => event.type === "constitution.rule_removed",
      )
      .map((event) => ({
        ruleID: event.ruleID,
        at: event.removedAt,
        removedBy: event.removedBy,
      })),
    decisions: projectedDecisionRecords(instance.events),
    overrides: instance.events.filter(
      (event): event is GovernanceOverrideView =>
        event.type === "constitution.override_granted",
    ),
  };
}
