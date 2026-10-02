import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  applySessionFactEvent,
  emptySessionFactState,
  evictTerminalFacts,
} from "../src";

const evidence = (id: string, status: string): RuntimeEvent =>
  ({
    type: "evidence.recorded",
    id,
    taskID: `t_${id}`,
    objective: "o",
    status,
  }) as RuntimeEvent;
const completion = (id: string): RuntimeEvent =>
  ({
    type: "completion.recorded",
    id,
    taskID: `t_${id}`,
    objective: "o",
    changeSummary: "c",
    validations: [],
    recordedAt: "2026-01-01T00:00:00.000Z",
  }) as RuntimeEvent;
const decision = (id: string): RuntimeEvent =>
  ({
    type: "decision.recorded",
    id,
    decision: `d_${id}`,
    scope: "session",
    status: "accepted",
  }) as unknown as RuntimeEvent;

test("evictTerminalFacts bounds terminal entries but keeps active ones", () => {
  const state = emptySessionFactState();
  for (let i = 0; i < 500; i += 1)
    applySessionFactEvent(state, evidence(`term${i}`, "accepted"));
  for (let i = 0; i < 10; i += 1)
    applySessionFactEvent(state, evidence(`active${i}`, "validated"));
  for (let i = 0; i < 300; i += 1)
    applySessionFactEvent(state, completion(`comp${i}`));
  for (let i = 0; i < 300; i += 1)
    applySessionFactEvent(state, decision(`dec${i}`));

  const evicted = evictTerminalFacts(state, 200);
  expect(evicted).toBe(true);
  const keptEvidence = state.intelligence.journalEvents.filter(
    (event) => event.type === "evidence.recorded",
  );
  // Terminal evidence keeps the most recent 200; active evidence is kept whole.
  expect(
    keptEvidence.filter((event) => event.status === "accepted"),
  ).toHaveLength(200);
  expect(
    keptEvidence.filter((event) => event.status === "validated"),
  ).toHaveLength(10);
  expect(
    state.intelligence.journalEvents.filter(
      (event) => event.type === "completion.recorded",
    ),
  ).toHaveLength(200);
  expect(state.decisions.records).toHaveLength(200);
});

test("evictTerminalFacts keeps open/disputed drift and is idempotent", () => {
  const state = emptySessionFactState();
  for (let i = 0; i < 300; i += 1) {
    applySessionFactEvent(state, {
      type: "drift.finding_opened",
      id: `f${i}`,
      findingID: `f${i}`,
      severity: "advisory",
      confidence: 0.5,
      originalObjective: "o",
      currentActivity: "a",
      evidence: [],
      applicableConstraints: [],
      contractVersion: 1,
    } as RuntimeEvent);
    // Terminal: the finding was explained.
    applySessionFactEvent(state, {
      type: "drift.finding_updated",
      id: `f${i}:updated`,
      findingID: `f${i}`,
      status: "explained",
    } as RuntimeEvent);
  }
  for (let i = 0; i < 5; i += 1)
    applySessionFactEvent(state, {
      type: "drift.finding_opened",
      id: `open${i}`,
      findingID: `open${i}`,
      severity: "advisory",
      confidence: 0.5,
      originalObjective: "o",
      currentActivity: "a",
      evidence: [],
      applicableConstraints: [],
      contractVersion: 1,
    } as RuntimeEvent);
  expect(evictTerminalFacts(state, 200)).toBe(true);
  const statuses = [...state.drift.findings.values()].map((f) => f.status);
  expect(statuses.filter((s) => s === "open").length).toBe(5);
  // Terminal findings keep the most recent 200.
  expect(statuses.filter((s) => s === "explained").length).toBe(200);
  // Second pass: already bounded, nothing more to evict.
  expect(evictTerminalFacts(state, 200)).toBe(false);
});
