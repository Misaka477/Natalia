import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  isDiagnosticStreamEvent,
  projectedConstitutionRules,
  projectedWorkContracts,
  sessionFactDiagnosticStreamEvents,
  sessionFactStateFromEvents,
} from "@anthelia/session";
import type { SessionExecutionState } from "@anthelia/substrate";
import {
  driftJudgeReadsFor,
  instructionRevision,
  openInvariantHits,
} from "../src/boundary";

/**
 * The drift judge's read policy (boundary.ts): its constraints (the
 * constitution rules and work contracts it judges against) and its triggers
 * (the open invariant violations and the instruction epoch that force a
 * re-evaluation) come from the complete fact state when available. A
 * fast-attach execution holds only the post-epoch tail — judging a turn
 * against a tail's empty constraint set, or missing a pre-epoch violation
 * or instruction notice, is exactly what this policy prevents.
 */

const rule: RuntimeEvent = {
  type: "constitution.rule_added",
  id: "rule:1",
  ruleID: "C-001",
  statement: "Never commit without approval",
  scope: "project",
  priority: "critical",
  source: "user",
  enforcement: "approval",
  overridePolicy: "forbidden",
};

const contract: RuntimeEvent = {
  type: "work_contract.accepted",
  id: "work_contract:plan_1:accepted",
  planID: "plan_1",
  planVersion: 1,
  scope: ["src/**"],
  verification: ["bun test"],
  constraints: ["never commit without approval"],
  acceptedBy: "user",
  acceptedAt: "2026-01-01T00:00:00.000Z",
};

function violation(): RuntimeEvent {
  return {
    type: "invariant.violation",
    owner: "session-store",
    invariant: "recovery_index_matches_events",
    code: "R2",
    detail: "indexed_events drifted",
    at: "2026-01-01T00:00:00.000Z",
  };
}

function resolved(): RuntimeEvent {
  return {
    type: "invariant.resolved",
    owner: "session-store",
    invariant: "recovery_index_matches_events",
    code: "R2",
    detail: "indexed_events drifted",
    at: "2026-01-01T00:01:00.000Z",
  };
}

function instructions(revision: number): RuntimeEvent {
  return {
    type: "context.instructions",
    id: `context:config:${revision}`,
    kind: "config_reload",
    at: "2026-01-01T00:00:00.000Z",
    revision,
    summary: "runtime config reloaded",
  } as RuntimeEvent;
}

/** The pre-epoch facts, then the noise a fast attach would still hold. */
function journal(): RuntimeEvent[] {
  const all: RuntimeEvent[] = [
    rule,
    contract,
    violation(),
    instructions(3),
    resolved(),
  ];
  for (let index = 0; index < 50; index += 1)
    all.push({
      type: "tool.update",
      id: `turn_1:call_${index}`,
      name: "read_file",
      callID: `call_${index}`,
      status: "succeeded",
      summary: "read",
    });
  return all;
}

test("the fact path keeps pre-epoch constraints and triggers on a fast attach", () => {
  const all = journal();
  const tail = all.slice(-2);
  const exec = {
    session: { id: "ses_boundary", events: tail },
    factStateComplete: true,
    factState: sessionFactStateFromEvents(all),
  } as unknown as SessionExecutionState;

  const reads = driftJudgeReadsFor(exec);
  expect(reads.constitutionRules.map((r) => r.ruleID)).toEqual(["C-001"]);
  expect(reads.workContracts).toEqual(projectedWorkContracts(all));
  // The violation was resolved: no open hit survives, and the epoch notice
  // (revision 3) is visible from the slice while the tail holds neither.
  expect(reads.invariantHits).toEqual([]);
  expect(reads.instructionRevision).toBe(3);
});

test("the fact path reports an open pre-epoch violation the tail cannot see", () => {
  const all = journal().filter((event) => event.type !== "invariant.resolved");
  const exec = {
    session: { id: "ses_boundary", events: all.slice(-2) },
    factStateComplete: true,
    factState: sessionFactStateFromEvents(all),
  } as unknown as SessionExecutionState;

  const reads = driftJudgeReadsFor(exec);
  expect(reads.invariantHits).toEqual(openInvariantHits(all));
  expect(reads.invariantHits[0]?.code).toBe("R2");
});

test("the belt path folds the resident array when the state is incomplete", () => {
  const all = journal();
  const exec = {
    session: { id: "ses_boundary", events: all },
    factStateComplete: false,
  } as unknown as SessionExecutionState;

  const reads = driftJudgeReadsFor(exec);
  expect(reads.constitutionRules).toEqual(projectedConstitutionRules(all));
  expect(reads.workContracts).toEqual(projectedWorkContracts(all));
  expect(reads.invariantHits).toEqual(openInvariantHits(all));
  expect(reads.instructionRevision).toBe(instructionRevision(all));
});

test("a tail-only belt is the debt this policy exists to prevent", () => {
  const all = journal();
  const tail = all.slice(-2);
  const exec = {
    session: { id: "ses_boundary", events: tail },
    factStateComplete: false,
  } as unknown as SessionExecutionState;

  // What the pre-fix reconcile path saw on every turn-end: no constraint,
  // no violation, no epoch notice — the judge would have judged the work
  // against an empty frame and never noticed a reference-frame change.
  const reads = driftJudgeReadsFor(exec);
  expect(reads.constitutionRules).toEqual([]);
  expect(reads.workContracts).toEqual([]);
  expect(reads.invariantHits).toEqual([]);
  expect(reads.instructionRevision).toBe(0);
});

test("the diagnostic slice folds identically to the full journal", () => {
  const all = journal();
  const slice = sessionFactDiagnosticStreamEvents(
    sessionFactStateFromEvents(all),
  );
  // Only the four families ride the slice, in journal order.
  expect(slice).toEqual(all.filter(isDiagnosticStreamEvent));
  expect(openInvariantHits(slice)).toEqual(openInvariantHits(all));
  expect(instructionRevision(slice)).toBe(instructionRevision(all));
});
