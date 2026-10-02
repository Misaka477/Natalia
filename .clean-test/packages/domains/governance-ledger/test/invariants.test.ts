import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { constitutionInvariants } from "../src/invariants";

const check = constitutionInvariants[0]!;

type RuleFields = {
  ruleID: string;
  priority: "critical" | "high" | "medium" | "low";
  overridePolicy: "forbidden" | "user_scoped" | "user_explicit";
  statement?: string;
};

const added = (fields: RuleFields) =>
  ({
    type: "constitution.rule_added",
    statement: fields.statement ?? "must",
    scope: "release",
    source: "policy",
    enforcement: "deny",
    at: "2026-01-01T00:00:00.000Z",
    sessionID: "ses_c",
    ...fields,
  }) as unknown as RuntimeEvent;

const updated = (fields: Partial<RuleFields> & { ruleID: string }) =>
  ({
    type: "constitution.rule_updated",
    at: "2026-01-02T00:00:00.000Z",
    ...fields,
  }) as unknown as RuntimeEvent;

const removed = (ruleID: string) =>
  ({
    type: "constitution.rule_removed",
    ruleID,
    at: "2026-01-03T00:00:00.000Z",
  }) as unknown as RuntimeEvent;

const run = (...events: RuntimeEvent[]) =>
  check.check({
    sessions: [{ sessionID: "ses_c", events, factStateComplete: true }],
  });

test("removing a protected rule violates", () => {
  const violations = run(
    added({ ruleID: "C-1", priority: "critical", overridePolicy: "forbidden" }),
    removed("C-1"),
  );
  expect(violations).toHaveLength(1);
  expect(violations[0]!.code).toBe("constitution.protected_rule_removed");
  expect(violations[0]!.detail).toContain("C-1");
  expect(violations[0]!.sessionID).toBe("ses_c");
});

test("weakening a protected rule violates; strengthening or touching others does not", () => {
  const weaken = run(
    added({ ruleID: "C-1", priority: "critical", overridePolicy: "forbidden" }),
    updated({ ruleID: "C-1", priority: "low", overridePolicy: "forbidden" }),
  );
  expect(weaken).toHaveLength(1);
  expect(weaken[0]!.code).toBe("constitution.protected_rule_weakened");

  const relax = run(
    added({ ruleID: "C-1", priority: "critical", overridePolicy: "forbidden" }),
    updated({
      ruleID: "C-1",
      priority: "critical",
      overridePolicy: "user_scoped",
    }),
  );
  expect(relax).toHaveLength(1);

  // A warn-only (unprotected) rule may be removed freely — the invariant
  // guards what the user marked untouchable, not all policy.
  expect(
    run(
      added({ ruleID: "W-1", priority: "low", overridePolicy: "user_scoped" }),
      removed("W-1"),
    ),
  ).toHaveLength(0);
  expect(
    run(
      added({
        ruleID: "C-1",
        priority: "critical",
        overridePolicy: "forbidden",
      }),
    ),
  ).toHaveLength(0);
});

test("each session folds its own seeded ledger (no cross-session masking)", () => {
  const violations = check.check({
    sessions: [
      {
        sessionID: "ses_one",
        events: [
          added({
            ruleID: "C-1",
            priority: "critical",
            overridePolicy: "forbidden",
          }),
        ],
        factStateComplete: true,
      },
      {
        sessionID: "ses_two",
        events: [removed("C-1")],
        factStateComplete: true,
      },
    ],
  });
  // ses_two removed a rule its own ledger never had — nothing protected to
  // remove there, so no violation; the fold never leaks across windows.
  expect(violations).toHaveLength(0);
});
