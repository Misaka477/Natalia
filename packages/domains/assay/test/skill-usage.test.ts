import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { skillUsageFromEvents } from "../src/skill-usage";

/**
 * Discovery D4's usage reader: the fold that gives the skill lifecycle's
 * garbage collector the facts it was built waiting for.
 */

const AT = "2026-10-14T10:00:00.000Z";
const LATER = "2026-10-14T11:00:00.000Z";

function activation(
  name: string,
  turnID: string | undefined,
  at = AT,
): RuntimeEvent {
  return {
    type: "skill.activated",
    at,
    name,
    source: "project",
    ...(turnID ? { turnID } : {}),
  } as RuntimeEvent;
}

function finished(id: string, stopReason: string): RuntimeEvent {
  return {
    type: "turn.finished",
    at: LATER,
    id,
    stopReason,
  } as RuntimeEvent;
}

test("an activation whose turn finished done is a use and a success", () => {
  const rows = skillUsageFromEvents([
    activation("deploy-runbook", "turn_1"),
    finished("turn_1", "done"),
  ]);
  const row = rows.get("deploy-runbook")!;
  expect(row.uses).toBe(1);
  expect(row.successes).toBe(1);
  expect(row.lastUsedAt).toBe(Date.parse(AT));
});

test("a turn that did not finish done is a use without a success — never a failure", () => {
  const rows = skillUsageFromEvents([
    activation("deploy-runbook", "turn_1"),
    finished("turn_1", "error"),
    activation("deploy-runbook", "turn_2"),
    finished("turn_2", "done"),
  ]);
  const row = rows.get("deploy-runbook")!;
  expect(row.uses).toBe(2);
  expect(row.successes).toBe(1);
});

test("an unfinished turn is a use with no verdict — absence is not a negative", () => {
  const rows = skillUsageFromEvents([
    activation("deploy-runbook", "turn_still_running"),
  ]);
  const row = rows.get("deploy-runbook")!;
  expect(row.uses).toBe(1);
  expect(row.successes).toBe(0);
});

test("an activation outside any turn counts as a use", () => {
  const rows = skillUsageFromEvents([activation("deploy-runbook", undefined)]);
  expect(rows.get("deploy-runbook")!.uses).toBe(1);
});

test("the lastUsedAt is the newest activation, and skills fold separately", () => {
  const rows = skillUsageFromEvents([
    activation("a", "turn_1", AT),
    activation("b", "turn_2", AT),
    activation("a", "turn_3", LATER),
    finished("turn_3", "done"),
  ]);
  expect(rows.get("a")!.uses).toBe(2);
  expect(rows.get("a")!.lastUsedAt).toBe(Date.parse(LATER));
  expect(rows.get("a")!.successes).toBe(1);
  expect(rows.get("b")!.uses).toBe(1);
  expect(rows.get("b")!.lastUsedAt).toBe(Date.parse(AT));
});

test("a stream with no activations folds to nothing", () => {
  const rows = skillUsageFromEvents([
    finished("turn_1", "done"),
    { type: "turn.submitted", at: AT, id: "turn_2" } as unknown as RuntimeEvent,
  ]);
  expect(rows.size).toBe(0);
});

test("the fold feeds the gc: a stale working skill outranks a dead one", () => {
  // The end-to-end shape the CLI's gc runs: fold first, score second.
  const rows = skillUsageFromEvents([
    activation("worker", "turn_1"),
    finished("turn_1", "done"),
    activation("dead", "turn_2"),
    finished("turn_2", "done"),
  ]);
  expect(rows.get("worker")!.successes / rows.get("worker")!.uses).toBe(1);
  expect(rows.get("dead")!.successes / rows.get("dead")!.uses).toBe(1);
});
