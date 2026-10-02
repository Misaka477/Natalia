import type { Invariant } from "@anthelia/contracts";

type RuleRow = {
  priority: "critical" | "high" | "medium" | "low";
  overridePolicy: "forbidden" | "user_scoped" | "user_explicit";
};

const protectedNow = (row: RuleRow | undefined) =>
  row !== undefined &&
  (row.priority === "critical" || row.priority === "high") &&
  row.overridePolicy === "forbidden";

/**
 * The constitution's non-rollback rule as a live check (Discovery D1's
 * candidate: critical/high rules only ever grow weaker-never — the runtime
 * twin of the gate's constitution face: the gate stops a CANDIDATE from
 * weakening the rules, this stops the RUNNING ledger from drifting).
 *
 * Folded per session: each session seeds its own rule copies
 * (seedConstitutionRules), so a window is its own ledger — cross-session
 * concatenation would re-add the same ids and hide real removals.
 */
export const constitutionInvariants: readonly Invariant[] = [
  {
    id: "constitution.protected-rules-never-weaken",
    statement:
      "a critical/high rule marked forbidden may not be removed or weakened by the running ledger",
    check(input) {
      const violations = [];
      for (const window of input.sessions) {
        const ledger = new Map<string, RuleRow>();
        for (const event of window.events) {
          if (event.type === "constitution.rule_added") {
            ledger.set(event.ruleID, {
              priority: event.priority,
              overridePolicy: event.overridePolicy,
            });
            continue;
          }
          if (event.type === "constitution.rule_removed") {
            const row = ledger.get(event.ruleID);
            if (protectedNow(row))
              violations.push({
                code: "constitution.protected_rule_removed",
                detail: `rule ${event.ruleID} (${row!.priority}/forbidden) was removed in session ${window.sessionID}`,
                sessionID: window.sessionID,
              });
            ledger.delete(event.ruleID);
            continue;
          }
          if (event.type === "constitution.rule_updated") {
            const row = ledger.get(event.ruleID);
            if (!row || !protectedNow(row)) continue;
            // Update events mark their changed fields optional — absence
            // means "unchanged", not "cleared" (a cleared priority would
            // itself be the weakening, and it must name itself).
            const next: RuleRow = {
              priority: event.priority ?? row.priority,
              overridePolicy: event.overridePolicy ?? row.overridePolicy,
            };
            if (!protectedNow(next))
              violations.push({
                code: "constitution.protected_rule_weakened",
                detail: `rule ${event.ruleID} weakened (${row!.priority}/${row!.overridePolicy} -> ${next.priority}/${next.overridePolicy}) in session ${window.sessionID}`,
                sessionID: window.sessionID,
              });
            ledger.set(event.ruleID, next);
          }
        }
      }
      return violations;
    },
  },
];
