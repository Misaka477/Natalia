import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  ensureSessionFactState,
  feedSessionFactState,
  reseedSessionFactState,
} from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";
import { sessionFactConstitutionRules } from "@anthelia/session";

function ruleEvent(id: string, ruleID: string): RuntimeEvent {
  return {
    type: "constitution.rule_added",
    id,
    ruleID,
    statement: `rule ${ruleID}`,
    scope: "project",
    priority: "high",
    source: "user",
    enforcement: "warn",
    overridePolicy: "forbidden",
  };
}

function fakeExec(
  events: RuntimeEvent[],
  fullEventsLoaded: boolean,
): SessionExecutionState {
  return {
    session: { id: "ses_facts", events },
    fullEventsLoaded,
  } as unknown as SessionExecutionState;
}

test("ensureSessionFactState seeds lazily and records completeness", () => {
  const events = [ruleEvent("r1", "C-001")];
  const incomplete = fakeExec(events, false);
  expect(incomplete.factState).toBeUndefined();

  const state = ensureSessionFactState(incomplete);
  expect(sessionFactConstitutionRules(state)).toHaveLength(1);
  expect(incomplete.factStateComplete).toBe(false);
  // Memoized: a second call returns the same instance.
  expect(ensureSessionFactState(incomplete)).toBe(state);

  const complete = fakeExec([ruleEvent("r2", "C-002")], true);
  ensureSessionFactState(complete);
  expect(complete.factStateComplete).toBe(true);
});

test("feedSessionFactState is a no-op before seeding and incremental after", () => {
  const events = [ruleEvent("r1", "C-001")];
  const exec = fakeExec(events, true);

  // No state yet: feeding must not create one or throw.
  feedSessionFactState(exec, ruleEvent("r2", "C-002"));
  expect(exec.factState).toBeUndefined();

  // First access folds the whole log (including the fed event's source).
  events.push(ruleEvent("r2", "C-002"));
  const state = ensureSessionFactState(exec);
  expect(sessionFactConstitutionRules(state)).toHaveLength(2);

  feedSessionFactState(exec, ruleEvent("r3", "C-003"));
  expect(sessionFactConstitutionRules(state)).toHaveLength(3);
});

test("reseedSessionFactState rebuilds after the base log is replaced", () => {
  const exec = fakeExec([ruleEvent("r1", "C-001")], false);
  const state = ensureSessionFactState(exec);
  expect(sessionFactConstitutionRules(state)).toHaveLength(1);
  expect(exec.factStateComplete).toBe(false);

  // Simulate `ensureSessionFullEvents` swapping in the full log.
  exec.session.events = [ruleEvent("r1", "C-001"), ruleEvent("r2", "C-002")];
  reseedSessionFactState(exec, true);
  expect(exec.factState).not.toBe(state);
  expect(sessionFactConstitutionRules(exec.factState!)).toHaveLength(2);
  expect(exec.factStateComplete).toBe(true);
});
