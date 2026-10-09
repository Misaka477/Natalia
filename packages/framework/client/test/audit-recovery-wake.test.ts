import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";
import { unclosedAuditPlanIDs } from "../src/runtime/initialize/finalize";

/**
 * EI §3.9 restart recovery: the in-flight Nia wake is in-memory, so a restart
 * would drop an audit, and the finalize scan re-wakes her for the audits
 * still in flight.
 *
 * The old scan asked "was an `audit_gaps`/`completed` event ever seen" over
 * `session.events` — which on the fast-attach path is only the post-epoch
 * tail. Two failures came out of that: a plan that was paused, handed off or
 * still executing re-woke Nia on EVERY boot (nothing ever closed it), and
 * under `NATALIA_FAST_EXECUTION_LOAD` the tail hid the early events, so an
 * already-closed audit read as unclosed (a false re-wake) while an early
 * `audit.requested` read as never requested (a missed one).
 *
 * The scan now folds the plan's CURRENT status over the full log and wakes
 * only for the pre-verdict states.
 */

function status(planID: string, value: string, at: string): RuntimeEvent {
  return {
    type: "plan.doc.status",
    id: `status:${planID}:${value}:${at}`,
    planID,
    status: value,
    at,
  };
}

function requested(planID: string, round: number, at: string): RuntimeEvent {
  return {
    type: "audit.requested",
    id: `audit:${planID}:${round}`,
    planID,
    planVersion: 1,
    triggerEventID: `completion:${planID}:${round}`,
    round,
    scope: "completion_recorded",
    at,
  };
}

test("an audit still awaiting its verdict is re-woken", () => {
  for (const state of ["awaiting_audit", "auditing", "audit_pending"]) {
    expect(
      unclosedAuditPlanIDs([
        requested("plan_a", 1, "2026-10-10T00:00:00.000Z"),
        status("plan_a", "awaiting_audit", "2026-10-10T00:00:01.000Z"),
        status("plan_a", state, "2026-10-10T00:00:02.000Z"),
      ]),
    ).toEqual(["plan_a"]);
  }
});

test("a plan whose audit reached a verdict is not re-woken", () => {
  for (const state of ["audit_gaps", "completed"]) {
    expect(
      unclosedAuditPlanIDs([
        requested("plan_a", 1, "2026-10-10T00:00:00.000Z"),
        status("plan_a", "awaiting_audit", "2026-10-10T00:00:01.000Z"),
        status("plan_a", state, "2026-10-10T00:00:02.000Z"),
      ]),
    ).toEqual([]);
  }
});

test("a requested audit on a plan that moved on is not re-woken", () => {
  // The old scan's permanent false positive: nothing in the log ever closes
  // a paused, handed-off or executing plan, so every boot re-woke Nia for
  // an audit nobody is waiting on.
  for (const state of ["paused", "handed_off", "executing", "marked"]) {
    expect(
      unclosedAuditPlanIDs([
        requested("plan_a", 1, "2026-10-10T00:00:00.000Z"),
        status("plan_a", state, "2026-10-10T00:00:01.000Z"),
      ]),
    ).toEqual([]);
  }
});

test("the plan's CURRENT status decides, not any status it ever held", () => {
  // Round 1 closed; round 2 was requested and is awaiting its verdict. The
  // latest round is what the wake is for, and the key carries it.
  const woken = new Set<string>();
  expect(
    unclosedAuditPlanIDs(
      [
        requested("plan_a", 1, "2026-10-10T00:00:00.000Z"),
        status("plan_a", "awaiting_audit", "2026-10-10T00:00:01.000Z"),
        status("plan_a", "audit_gaps", "2026-10-10T00:00:02.000Z"),
        requested("plan_a", 2, "2026-10-10T00:01:00.000Z"),
        status("plan_a", "awaiting_audit", "2026-10-10T00:01:01.000Z"),
      ],
      woken,
    ),
  ).toEqual(["plan_a"]);
  // The same round never wakes twice in one process.
  expect(
    unclosedAuditPlanIDs(
      [
        requested("plan_a", 2, "2026-10-10T00:01:00.000Z"),
        status("plan_a", "awaiting_audit", "2026-10-10T00:01:01.000Z"),
      ],
      woken,
    ),
  ).toEqual([]);
});

test("a requested audit with no plan lifecycle at all still wakes", () => {
  // Work outside any plan document: the request's own status projection is
  // best-effort and there is no lifecycle to read, so the request alone is
  // the evidence an audit is in flight.
  expect(
    unclosedAuditPlanIDs([
      requested("task_without_plan", 1, "2026-10-10T00:00:00.000Z"),
    ]),
  ).toEqual(["task_without_plan"]);
});

test("a plan status without a request is never re-woken", () => {
  expect(
    unclosedAuditPlanIDs([
      status("plan_a", "awaiting_audit", "2026-10-10T00:00:01.000Z"),
    ]),
  ).toEqual([]);
});

test("several in-flight audits wake once per plan", () => {
  const planIDs = unclosedAuditPlanIDs([
    requested("plan_a", 1, "2026-10-10T00:00:00.000Z"),
    status("plan_a", "awaiting_audit", "2026-10-10T00:00:01.000Z"),
    requested("plan_b", 3, "2026-10-10T00:00:02.000Z"),
    status("plan_b", "auditing", "2026-10-10T00:00:03.000Z"),
    requested("plan_c", 1, "2026-10-10T00:00:04.000Z"),
    status("plan_c", "completed", "2026-10-10T00:00:05.000Z"),
  ]);
  expect(planIDs.sort()).toEqual(["plan_a", "plan_b"]);
});

const finalizeSource = readFileSync(
  join(import.meta.dir, "..", "src", "runtime", "initialize", "finalize.ts"),
  "utf8",
);

test("the finalize scan widens to the durable log before it scans", () => {
  // The scan reads the whole journal: on the fast-attach tail it both missed
  // early `audit.requested` events and missed the status events that closed
  // them. The CALL, not the import.
  expect(finalizeSource).toMatch(/[ .]ensureSessionFullEvents\(/u);
  expect(finalizeSource).toMatch(/[ .]unclosedAuditPlanIDs\(/u);
});
