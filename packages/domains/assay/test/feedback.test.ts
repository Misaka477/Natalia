import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import type { RuntimeContext } from "@anthelia/substrate";
import {
  createFeedbackSurface,
  FEEDBACK_CATEGORIES,
  validateFeedbackInput,
} from "../src/feedback";

/**
 * D6a — feedback capture with structural model-isolation: the factory's
 * ONLY seam is journal publication (no provider, no tools, no prompt),
 * and the boundary rules are enforced here AND at the transport edge.
 */

const base = { scope: "session", sessionID: "ses_fb", verdict: "up" } as const;

test("valid inputs pass with fields carried; invalid ones are named precisely", () => {
  expect(validateFeedbackInput(base).ok).toBe(true);
  const cases: Array<[unknown, string]> = [
    [null, "object"],
    [{ ...base, scope: "thread" }, "scope"],
    [{ ...base, sessionID: "" }, "sessionID"],
    [{ ...base, verdict: "meh" }, "verdict"],
    [{ ...base, scope: "message" }, "messageID"],
    [{ ...base, category: "vibes" }, "category"],
    [{ ...base, note: "x".repeat(2_001) }, "exceeds"],
  ];
  for (const [candidate, fragment] of cases) {
    const result = validateFeedbackInput(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(fragment);
  }
  // The fixed taxonomy is exactly five categories (code change to extend).
  expect([...FEEDBACK_CATEGORIES]).toEqual([
    "accuracy",
    "style",
    "speed",
    "safety",
    "other",
  ]);
  // A message-scoped rating with its id passes.
  expect(
    validateFeedbackInput({
      ...base,
      scope: "message",
      messageID: "msg_1",
      verdict: "down",
      category: "accuracy",
      note: "hallucinated a citation",
    }).ok,
  ).toBe(true);
});

function fakeCtx(published: RuntimeEvent[], disposed = false) {
  const exec = { session: { id: "ses_fb" } };
  return {
    ports: {
      isDisposed: () => disposed,
      getExecutionBySession: () => new Map([["ses_fb", exec]]),
      publishForSession: (_exec: unknown, event: RuntimeEvent) =>
        published.push(event),
      publish: (event: RuntimeEvent) => published.push(event),
    },
  } as unknown as RuntimeContext;
}

test("recording publishes exactly one journal event — nothing else can happen", async () => {
  const published: RuntimeEvent[] = [];
  const surface = createFeedbackSurface(fakeCtx(published));
  const result = await surface.feedback({
    scope: "session",
    sessionID: "ses_fb",
    verdict: "down",
    category: "style",
    note: "too terse",
  });
  expect(result.recorded).toBe(true);
  expect(result.id.startsWith("fb_")).toBe(true);
  expect(published).toHaveLength(1);
  const [event] = published as Array<Record<string, unknown>>;
  expect(event).toMatchObject({
    type: "feedback.recorded",
    id: result.id,
    scope: "session",
    verdict: "down",
    category: "style",
    note: "too terse",
  });
});

test("a disposed runtime refuses without journaling; invalid input throws before anything", async () => {
  const published: RuntimeEvent[] = [];
  const dead = createFeedbackSurface(fakeCtx(published, true));
  expect(
    await dead.feedback({
      scope: "session",
      sessionID: "ses_fb",
      verdict: "up",
    }),
  ).toEqual({ recorded: false, id: "" });
  expect(published).toHaveLength(0);

  const live = createFeedbackSurface(fakeCtx(published));
  await expect(
    live.feedback({
      scope: "session",
      sessionID: "ses_fb",
      verdict: "nope",
    } as never),
  ).rejects.toThrow(/verdict/u);
  expect(published).toHaveLength(0); // thrown BEFORE anything was recorded
});

test("a retraction names its record and journals the compensating fact", async () => {
  // The withdrawal is a DELETE of the committed rating, not a second
  // judgment: it names the record it undoes and publishes its own event.
  const events: RuntimeEvent[] = [];
  const surface = createFeedbackSurface({
    ports: {
      isDisposed: () => false,
      getExecutionBySession: () => new Map(),
      publish: (event: RuntimeEvent) => events.push(event),
      publishForSession: (_exec: unknown, event: RuntimeEvent) =>
        events.push(event),
    },
  } as never);
  const recorded = await surface.feedback({
    scope: "message",
    sessionID: "s1",
    messageID: "m1",
    verdict: "up",
  });
  expect(recorded.recorded).toBe(true);
  const retracted = await surface.feedback({
    scope: "message",
    sessionID: "s1",
    messageID: "m1",
    verdict: "up",
    retract: true,
    recordID: recorded.id,
  });
  expect(retracted.recorded).toBe(true);
  expect(events.map((event) => event.type)).toEqual([
    "feedback.recorded",
    "feedback.retracted",
  ]);
  const withdrawal = events[1] as Extract<
    RuntimeEvent,
    { type: "feedback.retracted" }
  >;
  expect(withdrawal.recordID).toBe(recorded.id);
  expect(withdrawal.verdict).toBe("up");
  expect(withdrawal.messageID).toBe("m1");
});

test("a retraction without its record is refused", () => {
  expect(
    validateFeedbackInput({
      scope: "message",
      sessionID: "s1",
      messageID: "m1",
      verdict: "up",
      retract: true,
    }).ok,
  ).toBe(false);
  expect(
    validateFeedbackInput({
      scope: "session",
      sessionID: "s1",
      verdict: "up",
      retract: true,
      recordID: "fb_x",
    }).ok,
  ).toBe(true);
});
