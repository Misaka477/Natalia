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
