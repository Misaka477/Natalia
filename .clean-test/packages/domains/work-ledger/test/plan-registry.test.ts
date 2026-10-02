import { expect, test } from "bun:test";
import {
  buildAuditRequested,
  buildPlanDocCreated,
  buildPlanDocMarked,
  buildPlanDocStatus,
  buildPlanDocUpdated,
} from "../src";

test("buildPlanDocCreated carries the lightweight plan registry record", () => {
  const event = buildPlanDocCreated({
    id: "plan:create:1",
    planID: "plan_001",
    title: "First plan",
    documentPath: ".natalia/plans/plan_001.md",
    createdBy: "live_chat",
    status: "marked",
    createdAt: "2026-09-02T00:00:00.000Z",
  });
  expect(event).toMatchObject({
    type: "plan.doc.created",
    planID: "plan_001",
    documentPath: ".natalia/plans/plan_001.md",
    createdBy: "live_chat",
    status: "marked",
  });
});

test("plan registry transitions build the corresponding events", () => {
  const marked = buildPlanDocMarked({
    id: "plan:mark:1",
    planID: "plan_001",
    markedAt: "2026-09-02T00:01:00.000Z",
  });
  expect(marked.type).toBe("plan.doc.marked");
  expect(marked.planID).toBe("plan_001");

  const updated = buildPlanDocUpdated({
    id: "plan:update:1",
    planID: "plan_001",
    revision: 2,
    updatedAt: "2026-09-02T00:02:00.000Z",
    reason: "refined objective",
  });
  expect(updated.type).toBe("plan.doc.updated");
  expect(updated.reason).toBe("refined objective");

  const status = buildPlanDocStatus({
    id: "plan:status:1",
    planID: "plan_001",
    status: "completed",
    at: "2026-09-02T00:03:00.000Z",
  });
  expect(status).toMatchObject({
    type: "plan.doc.status",
    planID: "plan_001",
    status: "completed",
  });
});

test("buildAuditRequested carries the durable trigger shadow", () => {
  const request = buildAuditRequested({
    id: "audit:plan_001:1",
    planID: "plan_001",
    planVersion: 2,
    triggerEventID: "plan:status:7",
    round: 3,
    scope: "completion_recorded",
    at: "2026-09-02T00:04:00.000Z",
  });
  expect(request).toMatchObject({
    type: "audit.requested",
    planID: "plan_001",
    planVersion: 2,
    triggerEventID: "plan:status:7",
    round: 3,
    scope: "completion_recorded",
  });
});
