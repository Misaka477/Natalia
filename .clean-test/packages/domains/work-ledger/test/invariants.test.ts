import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { workLedgerInvariants } from "../src/invariants";
import {
  buildWorkContractAccepted,
  buildWorkContractDrafted,
} from "../src/work-contract";

const machine = workLedgerInvariants[0]!;
const evidence = workLedgerInvariants[1]!;
const now = "2026-01-01T00:00:00.000Z";

const drafted = (planID: string, planVersion: number) =>
  buildWorkContractDrafted({
    id: `wc:${planID}:${planVersion}`,
    planID,
    planVersion,
    draftedAt: now,
  }) as unknown as RuntimeEvent;

const accepted = (planID: string, planVersion: number) =>
  buildWorkContractAccepted({
    id: `wc:${planID}:${planVersion}:ok`,
    planID,
    planVersion,
    acceptedAt: now,
  }) as unknown as RuntimeEvent;

const completion = (taskID: string) =>
  ({
    type: "completion.recorded",
    id: "comp_1",
    taskID,
    objective: "done",
    changeSummary: "s",
    validations: [],
    recordedAt: now,
  }) as unknown as RuntimeEvent;

const run = (check: typeof machine, ...events: RuntimeEvent[]) =>
  check.check({
    sessions: [{ sessionID: "ses_w", events, factStateComplete: true }],
  });

test("draft then accept is the legal machine path", () => {
  expect(
    run(machine, drafted("plan:1", 1), accepted("plan:1", 1)),
  ).toHaveLength(0);
});

test("an acceptance without a matching draft violates — by version too", () => {
  const noDraft = run(machine, accepted("plan:1", 1));
  expect(noDraft).toHaveLength(1);
  expect(noDraft[0]!.code).toBe("work_contract.accepted_without_draft");
  // A draft for ANOTHER version does not license this acceptance.
  const wrongVersion = run(
    machine,
    drafted("plan:1", 2),
    accepted("plan:1", 1),
  );
  expect(wrongVersion).toHaveLength(1);
  // And the draft may live in a different window (cross-session contracts).
  const across = machine.check({
    sessions: [
      {
        sessionID: "a",
        events: [drafted("plan:9", 3)],
        factStateComplete: true,
      },
      {
        sessionID: "b",
        events: [accepted("plan:9", 3)],
        factStateComplete: true,
      },
    ],
  });
  expect(across).toHaveLength(0);
});

test("an accepted contract must end with evidence for its plan", () => {
  const missing = run(evidence, accepted("plan:1", 1));
  expect(missing).toHaveLength(1);
  expect(missing[0]!.code).toBe("work_contract.accepted_without_evidence");
  expect(
    run(evidence, accepted("plan:1", 1), completion("plan:1")),
  ).toHaveLength(0);
  // completion for a DIFFERENT plan does not satisfy this one.
  expect(
    run(evidence, accepted("plan:1", 1), completion("plan:2")),
  ).toHaveLength(1);
});
