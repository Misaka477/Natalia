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
];
