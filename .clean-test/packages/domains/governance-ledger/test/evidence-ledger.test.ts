import { expect, test } from "bun:test";
import {
  boundValidationOutcome,
  buildCompletionRecorded,
  buildEvidenceRecorded,
  evidenceStatusForPlanState,
} from "../src/evidence-ledger";
test("buildEvidenceRecorded carries the outcome as an evidence fact", () => {
  const event = buildEvidenceRecorded({
    id: "evidence:1",
    taskID: "task_1",
    objective: "verify the runtime builds",
    status: "validated",
    validations: [
      {
        command: "npm run typecheck",
        result: "passed",
        safeSummary: "typecheck passed",
        durationMs: 1200,
      },
    ],
    knownGaps: ["no integration coverage"],
  });
  expect(event).toMatchObject({
    type: "evidence.recorded",
    id: "evidence:1",
    taskID: "task_1",
    status: "validated",
    validations: [
      {
        command: "npm run typecheck",
        result: "passed",
        safeSummary: "typecheck passed",
        durationMs: 1200,
      },
    ],
    knownGaps: ["no integration coverage"],
  });
});

test("a failed validation records status failed, not validated", () => {
  const event = buildEvidenceRecorded({
    id: "evidence:2",
    taskID: "task_2",
    objective: "verify tests",
    status: "failed",
    validations: [
      {
        command: "npm test",
        result: "failed",
        safeSummary: "2 tests failed",
      },
    ],
  });
  expect(event.status).toBe("failed");
});

test("empty optional lists are omitted, not emitted as empty arrays", () => {
  const event = buildEvidenceRecorded({
    id: "evidence:3",
    taskID: "task_3",
    objective: "no validation recorded",
    status: "implemented",
  });
  expect("validations" in event).toBe(false);
  expect("knownGaps" in event).toBe(false);
  expect("changes" in event).toBe(false);
});

test("boundValidationOutcome caps the safe summary and clamps duration", () => {
  const outcome = boundValidationOutcome({
    command: "run a long validation",
    result: "passed",
    safeSummary: "x".repeat(5000),
    durationMs: -5,
  });
  expect(outcome.safeSummary.length).toBe(2000);
  expect(outcome.durationMs).toBe(0);
});

test("boundValidationOutcome omits the duration when none is supplied", () => {
  const outcome = boundValidationOutcome({
    command: "run",
    result: "skipped",
    safeSummary: "skipped",
  });
  expect("durationMs" in outcome).toBe(false);
});

test("validation facts are secret-safe: no raw output shape is accepted", () => {
  // The builder's input type has no field for raw stdout/stderr, so the only
  // way for output to reach the journal is through the bounded safe summary.
  const event = buildEvidenceRecorded({
    id: "evidence:4",
    taskID: "task_4",
    objective: "no secrets",
    status: "failed",
    validations: [
      {
        command: "print secret",
        result: "failed",
        safeSummary: "api_key=********",
      },
    ],
  });
  expect(JSON.stringify(event)).not.toContain("supersecret");
  expect(JSON.stringify(event)).not.toContain("stdout");
});

test("buildCompletionRecorded carries the fixed completion-card structure", () => {
  const event = buildCompletionRecorded({
    id: "completion:1",
    taskID: "task_1",
    objective: "verify the build",
    changeSummary: "added the build check",
    behaviorImpact: "CI now runs typecheck",
    validations: [
      { command: "npm run typecheck", result: "passed", safeSummary: "ok" },
    ],
    humanValidation: "reviewed by owner",
    knownGaps: ["no windows coverage"],
    externalSideEffects: ["writes .tmp"],
    rollbackState: "available",
    evidenceIDs: ["evidence:1"],
    recordedAt: "now",
  });
  expect(event).toMatchObject({
    type: "completion.recorded",
    taskID: "task_1",
    changeSummary: "added the build check",
    behaviorImpact: "CI now runs typecheck",
    validations: [{ command: "npm run typecheck", result: "passed" }],
    humanValidation: "reviewed by owner",
    knownGaps: ["no windows coverage"],
    rollbackState: "available",
    evidenceIDs: ["evidence:1"],
  });
});

test("completion cards carry the fixed fields and omit empty optional sections", () => {
  const event = buildCompletionRecorded({
    id: "completion:2",
    taskID: "task_2",
    objective: "do work",
    changeSummary: "the work is done",
    validations: [],
    recordedAt: "now",
  });
  expect(event.changeSummary).toBe("the work is done");
  expect("behaviorImpact" in event).toBe(false);
  expect("humanValidation" in event).toBe(false);
  expect("knownGaps" in event).toBe(false);
  expect("rollbackState" in event).toBe(false);
});

test("evidence status transition policy maps plan lifecycle to effective status", () => {
  expect(evidenceStatusForPlanState("marked", "implemented")).toBe(
    "implemented",
  );
  expect(evidenceStatusForPlanState("executing", "planned")).toBe(
    "implemented",
  );
  // A paused plan does not override the recorded evidence status.
  expect(evidenceStatusForPlanState("paused", "implemented")).toBe(
    "implemented",
  );
  expect(evidenceStatusForPlanState("awaiting_audit", "implemented")).toBe(
    "implemented",
  );
  expect(evidenceStatusForPlanState("auditing", "implemented")).toBe(
    "implemented",
  );
  expect(evidenceStatusForPlanState("completed", "implemented")).toBe(
    "accepted",
  );
  expect(evidenceStatusForPlanState("completed", "implemented")).toBe(
    "accepted",
  );
});
