import type { Invariant } from "@anthelia/contracts";

/**
 * The work-ledger domain's declared data relations (Discovery D1): the
 * contract state machine and the evidence requirement — both as existence
 * checks across every window, because a contract drafted in one session
 * may be accepted in another and windows arrive in runtime-map order
 * (cross-session strict ordering needs D1b's global view; existence is
 * the honest check today).
 */
export const workLedgerInvariants: readonly Invariant[] = [
  {
    id: "work-ledger.contract-machine",
    statement:
      "every accepted contract has a drafted contract for exactly its plan and version (none -> drafted -> accepted, nothing skips the draft)",
    check(input) {
      const violations = [];
      const drafted = new Set<string>();
      const accepted: Array<{ planID: string; planVersion: number }> = [];
      for (const window of input.sessions)
        for (const event of window.events) {
          if (event.type === "work_contract.drafted")
            drafted.add(`${event.planID}#${event.planVersion}`);
          else if (event.type === "work_contract.accepted")
            accepted.push({
              planID: event.planID,
              planVersion: event.planVersion,
            });
        }
      for (const contract of accepted)
        if (!drafted.has(`${contract.planID}#${contract.planVersion}`))
          violations.push({
            code: "work_contract.accepted_without_draft",
            detail: `accepted contract ${contract.planID} v${contract.planVersion} has no matching draft in any window`,
          });
      return violations;
    },
  },
  {
    id: "work-ledger.accepted-has-evidence",
    statement:
      "every accepted contract ends with completion/evidence for its plan (the EI acceptance check, run live)",
    check(input) {
      const violations = [];
      const evidenced = new Set<string>();
      const accepted: string[] = [];
      for (const window of input.sessions)
        for (const event of window.events) {
          if (
            event.type === "completion.recorded" ||
            event.type === "evidence.recorded"
          )
            evidenced.add(event.taskID);
          else if (event.type === "work_contract.accepted")
            accepted.push(event.planID);
        }
      for (const planID of accepted)
        if (!evidenced.has(planID))
          violations.push({
            code: "work_contract.accepted_without_evidence",
            detail: `accepted contract for ${planID} has no completion/evidence record in any window`,
          });
      return violations;
    },
  },
];
