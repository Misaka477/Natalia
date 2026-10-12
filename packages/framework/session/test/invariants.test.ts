import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { sessionInvariants } from "../src/invariants";

const check = sessionInvariants[0]!;

function window(events: RuntimeEvent[], complete: boolean) {
  return {
    sessionID: "ses_inv",
    events,
    factStateComplete: complete,
  };
}

const turn = (id: string) => ({ type: "turn.started", id }) as RuntimeEvent;

test("turns with an incomplete projection violate", () => {
  const violations = check.check({
    sessions: [window([turn("turn_1"), turn("turn_2")], false)],
  });
  expect(violations).toHaveLength(1);
  expect(violations[0]!.code).toBe("session.projection_incomplete");
  expect(violations[0]!.detail).toContain("ses_inv");
  // D2: the citation travels on the violation itself, for the journal event.
  expect(violations[0]!.sessionID).toBe("ses_inv");
});

test("a completed projection is clean, and sessions without turns are exempt", () => {
  expect(
    check.check({ sessions: [window([turn("turn_1")], true)] }),
  ).toHaveLength(0);
  // Boot noise (created/ready events) with no turns must not trip it.
  expect(
    check.check({
      sessions: [
        window(
          [
            {
              type: "session.created",
              sessionID: "ses_inv",
              title: "t",
            } as RuntimeEvent,
          ],
          false,
        ),
      ],
    }),
  ).toHaveLength(0);
});

/**
 * The approval-pairing invariant (洞 2's asked/decided pair): a question
 * whose turn ended without an answer, and an answer whose question never
 * existed, are both escapes — the invariant makes them loud.
 */

const pairing = sessionInvariants[1]!;

const request = (id: string, turnID: string) =>
  ({
    type: "approval.request",
    id,
    turnID,
    title: "t",
    preview: "p",
  }) as RuntimeEvent;
const response = (id: string) =>
  ({ type: "approval.response", id, decision: "once" }) as RuntimeEvent;
const turnDone = (id: string) =>
  ({ type: "turn.finished", id, stopReason: "done" }) as RuntimeEvent;

test("a question whose turn finished without an answer is an escape", () => {
  const violations = pairing.check({
    sessions: [window([request("appr_1", "turn_1"), turnDone("turn_1")], true)],
  });
  expect(violations).toHaveLength(1);
  expect(violations[0]!.code).toBe("session.approval_unanswered");
  expect(violations[0]!.detail).toContain("authority nobody granted");
});

test("a question whose turn is still open is pending, not escaped", () => {
  // The turn is parked on the answer — the mechanism working, not a hole.
  const violations = pairing.check({
    sessions: [window([request("appr_1", "turn_1")], true)],
  });
  expect(violations).toHaveLength(0);
});

test("a matched pair is clean, and an answer without a question is an escape", () => {
  expect(
    pairing.check({
      sessions: [
        window(
          [request("appr_1", "turn_1"), response("appr_1"), turnDone("turn_1")],
          true,
        ),
      ],
    }),
  ).toHaveLength(0);
  const orphans = pairing.check({
    sessions: [window([response("appr_ghost")], true)],
  });
  expect(orphans).toHaveLength(1);
  expect(orphans[0]!.code).toBe("session.approval_unasked");
});

test("a request with no turn attribution is not judged escaped", () => {
  // A recovered request without its turn (the old mapping gap) cannot be
  // paired to a turn finish — it is not evidence of an escape either way.
  const violations = pairing.check({
    sessions: [
      window(
        [
          {
            type: "approval.request",
            id: "appr_x",
            title: "t",
            preview: "p",
          } as RuntimeEvent,
          turnDone("turn_1"),
        ],
        true,
      ),
    ],
  });
  expect(violations).toHaveLength(0);
});
