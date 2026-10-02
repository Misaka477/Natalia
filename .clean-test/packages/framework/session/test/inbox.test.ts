import { expect, test } from "bun:test";
import type { AdmittedSessionInput } from "../src";
import {
  admitInput,
  buildInputAdmission,
  buildInputUpdated,
  claimNextSteps,
  createSessionRecord,
  normalizeInbox,
  promoteInputToStep,
  promoteNextSteps,
  promoteNextTurn,
  removeAdmittedInput,
  replaceAdmittedInput,
  SessionInputConflictError,
} from "../src";

test("session inbox exact retry is idempotent and conflicting reuse is rejected", () => {
  const session = createSessionRecord("ses_inbox", "Inbox");
  const input = {
    id: "turn_one",
    text: "hello",
    delivery: "next-step" as const,
  };
  const first = admitInput(
    session,
    input,
    new Date("2026-07-21T00:00:00.000Z"),
  );
  expect(admitInput(session, input)).toEqual(first);
  expect(() => admitInput(session, { ...input, text: "different" })).toThrow(
    SessionInputConflictError,
  );
  expect(() =>
    admitInput(session, { ...input, delivery: "next-turn" }),
  ).toThrow(SessionInputConflictError);
});

test("session inbox treats structured mentions as part of admission identity", () => {
  const session = createSessionRecord("ses_mentions", "Mentions");
  const input = {
    id: "turn_mentions",
    text: "inspect",
    delivery: "next-step" as const,
    resources: [{ server: "docs", uri: "docs://guide", name: "Guide" }],
    agents: [{ name: "review" }],
  };
  const first = admitInput(session, input);
  expect(admitInput(session, input)).toEqual(first);
  expect(() =>
    admitInput(session, { ...input, agents: [{ name: "build" }] }),
  ).toThrow(SessionInputConflictError);
});

test("next-step inputs are promoted before next-turn inputs", () => {
  const session = createSessionRecord("ses_promote", "Promote");
  admitInput(session, { id: "step_a", text: "a", delivery: "next-step" });
  admitInput(session, { id: "turn_a", text: "b", delivery: "next-turn" });
  admitInput(session, { id: "step_b", text: "c", delivery: "next-step" });
  admitInput(session, { id: "turn_b", text: "d", delivery: "next-turn" });

  expect(promoteNextSteps(session).map((item) => item.id)).toEqual([
    "step_a",
    "step_b",
  ]);
  expect(promoteNextTurn(session).map((item) => item.id)).toEqual(["turn_a"]);
  expect(promoteNextTurn(session).map((item) => item.id)).toEqual(["turn_b"]);
  expect(promoteNextTurn(session)).toEqual([]);
});

test("next-step promotion honors a captured admission cutoff", () => {
  const session = createSessionRecord("ses_cutoff", "Cutoff");
  admitInput(session, {
    id: "before",
    text: "before",
    delivery: "next-step",
  });
  const cutoff = session.inbox![0]!.admittedSeq;
  admitInput(session, { id: "after", text: "after", delivery: "next-step" });

  expect(promoteNextSteps(session, cutoff).map((item) => item.id)).toEqual([
    "before",
  ]);
  expect(
    session.inbox?.find((item) => item.id === "after")?.promotedAt,
  ).toBeUndefined();
});

test("claimNextSteps takes every pending next-step and marks it promoted", () => {
  const session = createSessionRecord("ses_claim", "Claim");
  admitInput(session, { id: "s1", text: "a", delivery: "next-step" });
  admitInput(session, { id: "q1", text: "b", delivery: "next-turn" });
  admitInput(session, { id: "s2", text: "c", delivery: "next-step" });

  const claimed = claimNextSteps(session, "turn_1", 3);
  expect(claimed.map((item) => item.id)).toEqual(["s1", "s2"]);
  expect(claimed[0]!.claimedTurnID).toBe("turn_1");
  expect(claimed[0]!.claimedStep).toBe(3);
  // Claimed steps are no longer promotable by a drain.
  expect(promoteNextSteps(session)).toEqual([]);
  expect(promoteNextTurn(session).map((item) => item.id)).toEqual(["q1"]);
});

test("remove and replace only touch not-yet-promoted inputs", () => {
  const session = createSessionRecord("ses_mutate", "Mutate");
  admitInput(session, { id: "a", text: "first", delivery: "next-turn" });
  admitInput(session, { id: "b", text: "second", delivery: "next-turn" });

  expect(replaceAdmittedInput(session, "a", "edited")?.text).toBe("edited");
  expect(removeAdmittedInput(session, "b")?.id).toBe("b");
  expect(session.inbox?.map((item) => item.id)).toEqual(["a"]);

  promoteNextTurn(session);
  expect(removeAdmittedInput(session, "a")).toBeUndefined();
  expect(replaceAdmittedInput(session, "a", "late")).toBeUndefined();
});

test("promoteInputToStep moves a queued turn into the running turn", () => {
  const session = createSessionRecord("ses_steer", "Steer");
  admitInput(session, { id: "a", text: "next", delivery: "next-turn" });
  expect(promoteInputToStep(session, "a")?.delivery).toBe("next-step");
  expect(claimNextSteps(session, "turn_1", 1).map((item) => item.id)).toEqual([
    "a",
  ]);
  expect(promoteInputToStep(session, "a")).toBeUndefined();
});

test("normalizeInbox maps legacy steer/queue to next-turn", () => {
  const session = createSessionRecord("ses_legacy", "Legacy");
  session.inbox = [
    {
      id: "s",
      sessionID: session.id,
      text: "old steer",
      delivery: "steer" as never,
      admittedAt: new Date(0).toISOString(),
      admittedSeq: 1,
    },
    {
      id: "q",
      sessionID: session.id,
      text: "old queue",
      delivery: "queue" as never,
      admittedAt: new Date(0).toISOString(),
      admittedSeq: 2,
    },
    {
      id: "n",
      sessionID: session.id,
      text: "new step",
      delivery: "next-step",
      admittedAt: new Date(0).toISOString(),
      admittedSeq: 3,
    },
  ] as AdmittedSessionInput[];
  normalizeInbox(session);
  expect(session.inbox.map((item) => item.delivery)).toEqual([
    "next-turn",
    "next-turn",
    "next-step",
  ]);
});

test("admission and update facts carry the text digest", () => {
  const admission = buildInputAdmission({
    id: "in_1",
    text: "hello",
    delivery: "next-step",
    admittedAt: "2026-01-01T00:00:00.000Z",
    admittedSeq: 3,
  });
  expect(admission).toMatchObject({
    type: "input.admitted",
    id: "in_1",
    text: "hello",
    delivery: "next-step",
    admittedAt: "2026-01-01T00:00:00.000Z",
    admittedSeq: 3,
  });
  expect(admission.sha256).toHaveLength(64);
  expect(admission.byteLength).toBe(5);

  const updated = buildInputUpdated("in_1", "hello there");
  expect(updated).toMatchObject({
    type: "input.updated",
    id: "in_1",
    text: "hello there",
  });
  expect(updated.sha256).not.toBe(admission.sha256);
});
