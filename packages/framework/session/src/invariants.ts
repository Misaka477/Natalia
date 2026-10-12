import type { Invariant } from "@anthelia/contracts";

/**
 * The session domain's declared data relations (Discovery D1: the owner
 * declares, the layer ticks, violations attribute back here).
 */
export const sessionInvariants: readonly Invariant[] = [
  {
    id: "session.projection-complete-after-turns",
    statement:
      "a session that ran turns must have a completed fact projection (factStateComplete) — an incomplete projection means reads answer from a hole",
    check(input) {
      const violations = [];
      for (const window of input.sessions) {
        const ranTurns = window.events.some(
          (event) =>
            event.type === "turn.started" || event.type === "turn.finished",
        );
        if (ranTurns && window.factStateComplete !== true)
          violations.push({
            code: "session.projection_incomplete",
            detail: `session ${window.sessionID} ran turns but its fact projection is incomplete (${window.events.length} events unfolded)`,
            sessionID: window.sessionID,
          });
      }
      return violations;
    },
  },
  {
    // 洞 2's audit pairing: asked/decided travel as one pair, and the
    // invariant is what makes "one without the other" loud instead of
    // silent. Two escapes, both real:
    //
    //  - a question whose turn ENDED without an answer. The turn finished
    //    (done or cancelled) while the human's answer was still outstanding
    //    — whatever ran after it ran on an authority nobody granted. A
    //    question whose turn is still open is NOT a violation: the turn is
    //    parked on the answer, which is the mechanism working.
    //  - an answer to a question never asked. A response whose id no
    //    request carries means the audit trail has a decision with no
    //    decision-point.
    id: "session.approval-paired-within-its-turn",
    statement:
      "every approval.request whose turn finished carries its approval.response in the same window, and every response carries its request — an unanswered question and an unasked answer are both escapes",
    check(input) {
      const violations = [];
      for (const window of input.sessions) {
        const asked = new Set<string>();
        const answered = new Set<string>();
        const finishedTurns = new Set<string>();
        const requestTurn = new Map<string, string>();
        for (const event of window.events) {
          if (event.type === "approval.request") {
            asked.add(event.id);
            if (event.turnID) requestTurn.set(event.id, event.turnID);
          } else if (event.type === "approval.response") {
            answered.add(event.id);
          } else if (event.type === "turn.finished") {
            finishedTurns.add(event.id);
          }
        }
        for (const id of asked) {
          if (answered.has(id)) continue;
          const turnID = requestTurn.get(id);
          // No turn attribution, or the turn is still open: the question is
          // legitimately pending, not escaped.
          if (turnID === undefined || !finishedTurns.has(turnID)) continue;
          violations.push({
            code: "session.approval_unanswered",
            detail: `session ${window.sessionID} asked for approval ${id} in turn ${turnID}, the turn finished, and no response arrived — the work after it ran on an authority nobody granted`,
            sessionID: window.sessionID,
          });
        }
        for (const id of answered) {
          if (asked.has(id)) continue;
          violations.push({
            code: "session.approval_unasked",
            detail: `session ${window.sessionID} holds an approval response ${id} whose request is not in the window — a decision with no decision-point`,
            sessionID: window.sessionID,
          });
        }
      }
      return violations;
    },
  },
];
