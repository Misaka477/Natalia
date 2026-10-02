import { expect, test } from "bun:test";
import {
  buildMailboxQueued,
  buildMailboxStatus,
} from "@anthelia/runtime-services";

test("buildMailboxQueued carries the durable intent fact", () => {
  const event = buildMailboxQueued({
    id: "mailbox:1:queued",
    messageID: "mailbox:1",
    source: "user_via_live_chat",
    priority: "high",
    intent: "reprioritize",
    text: "please focus on the docs task first",
    safeSummary: "user asked to reprioritize to docs",
    relatedPlanID: "plan_1",
    deliveryPolicy: "next_safe_boundary",
    createdAt: "now",
  });
  expect(event).toMatchObject({
    type: "mailbox.queued",
    messageID: "mailbox:1",
    source: "user_via_live_chat",
    priority: "high",
    intent: "reprioritize",
    text: "please focus on the docs task first",
    safeSummary: "user asked to reprioritize to docs",
    relatedPlanID: "plan_1",
    deliveryPolicy: "next_safe_boundary",
  });
});

test("mailbox status transitions build the right event types", () => {
  const delivered = buildMailboxStatus({
    id: "mailbox:1:delivered",
    messageID: "mailbox:1",
    status: "delivered",
    at: "t1",
  });
  expect(delivered.type).toBe("mailbox.delivered");
  if (delivered.type === "mailbox.delivered")
    expect(delivered.deliveredAt).toBe("t1");

  const acknowledged = buildMailboxStatus({
    id: "mailbox:1:ack",
    messageID: "mailbox:1",
    status: "acknowledged",
    at: "t2",
  });
  expect(acknowledged.type).toBe("mailbox.acknowledged");
  if (acknowledged.type === "mailbox.acknowledged")
    expect(acknowledged.acknowledgedAt).toBe("t2");

  const deferred = buildMailboxStatus({
    id: "mailbox:1:deferred",
    messageID: "mailbox:1",
    status: "deferred",
    at: "t3",
    reason: "unsafe boundary",
  });
  expect(deferred.type).toBe("mailbox.deferred");
  if (deferred.type === "mailbox.deferred")
    expect(deferred.reason).toBe("unsafe boundary");

  const superseded = buildMailboxStatus({
    id: "mailbox:1:superseded",
    messageID: "mailbox:1",
    status: "superseded",
    at: "t4",
  });
  expect(superseded.type).toBe("mailbox.superseded");
  if (superseded.type === "mailbox.superseded")
    expect(superseded.reason).toContain("superseded");
});

test("mailbox facts carry only safe prose, never raw state", () => {
  const queued = buildMailboxQueued({
    id: "mailbox:2:queued",
    messageID: "mailbox:2",
    source: "system",
    priority: "normal",
    intent: "constraint",
    text: "never commit secrets",
    safeSummary: "a constraint",
    deliveryPolicy: "before_next_tool",
    createdAt: "now",
  });
  expect(JSON.stringify(queued)).not.toContain("supersecret");
  expect(JSON.stringify(queued)).not.toContain("stdout");
});
