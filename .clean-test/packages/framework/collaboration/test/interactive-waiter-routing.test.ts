/**
 * Routing and settlement regressions for the interactive waiter.
 *
 * Two bugs this locks down:
 *   - a response for a recovered/stale request must be routed by the client's
 *     `sessionID` hint instead of the currently attached session;
 *   - a cancelled or expired request must settle the durable journal with a
 *     `*response` event, or the UI re-opens it on every re-attach.
 */
import { expect, test } from "bun:test";
import type {
  QuestionResponse,
  RuntimeEvent,
  SessionID,
} from "@anthelia/contracts";
import { createInteractiveWaiter } from "../src/interactive-waiter";
import { createWorkLedgerController } from "@natalia/work-ledger";

type Published = { session: SessionID; event: RuntimeEvent };

function harness(options: {
  attached?: SessionID;
  isPending?: (
    session: SessionID,
    id: string,
    kind: "approval" | "question",
  ) => boolean;
  signal?: AbortSignal;
}) {
  const attached = options.attached ?? ("ses_attached" as SessionID);
  const published: Published[] = [];
  const waiter = createInteractiveWaiter({
    publish: (event) => {
      published.push({ session: attached, event });
    },
    publishForSession: (session, event) => {
      published.push({ session, event });
    },
    sessionID: () => attached,
    sessionIDForTurn: () => attached,
    permissionMode: () => "ask",
    abortSignal: () => options.signal,
    activeTurnID: () => undefined,
    isPending: options.isPending ?? (() => false),
    agentIDForTurn: () => undefined,
    workLedger: () =>
      createWorkLedgerController({ openFindingIDs: () => new Set() }),
  });
  return { waiter, published };
}

function responseSession(published: Published[]) {
  return published.find(({ event }) => event.type === "question.response")
    ?.session;
}

test("a live question response keeps the live session over a conflicting hint", async () => {
  const h = harness({});
  const pending = h.waiter.requireQuestion("q1", "turn_a", {
    title: "t",
    questions: [],
  });
  // The waiter is live, so its own turn→session mapping wins even if the client
  // sends a stale/incorrect routing hint.
  const outcome = h.waiter.respondQuestion({
    requestID: "q1",
    answers: [["a"]],
    sessionID: "ses_other",
  } as QuestionResponse);
  expect(outcome).toEqual({ accepted: true });
  expect(responseSession(h.published)).toBe("ses_attached" as SessionID);
  await expect(pending).resolves.toEqual([["a"]]);
});

test("a recovered question response is routed by its session hint", () => {
  const h = harness({
    attached: "ses_attached" as SessionID,
    isPending: (session, id, kind) =>
      session === ("ses_target" as SessionID) &&
      kind === "question" &&
      id === "q1",
  });
  const outcome = h.waiter.respondQuestion({
    requestID: "q1",
    answers: [["a"]],
    sessionID: "ses_target",
  } as QuestionResponse);
  expect(outcome).toEqual({ accepted: true });
  expect(responseSession(h.published)).toBe("ses_target" as SessionID);
});

test("cancelling a question settles the durable journal", async () => {
  const controller = new AbortController();
  const h = harness({
    attached: "ses_a" as SessionID,
    signal: controller.signal,
    isPending: (session, id, kind) =>
      session === ("ses_a" as SessionID) && kind === "question" && id === "q1",
  });
  const pending = h.waiter.requireQuestion("q1", "turn_a", {
    title: "t",
    questions: [],
  });
  controller.abort(new Error("stop"));
  await expect(pending).rejects.toThrow("stop");
  const settled = h.published.find(
    ({ event }) => event.type === "question.response",
  );
  expect(settled?.session).toBe("ses_a" as SessionID);
  if (settled?.event.type === "question.response")
    expect(settled.event.rejected).toBe(true);
});

test("a generic interactive request publishes, waits and settles by kind", async () => {
  const h = harness({});
  const pending = h.waiter.requireInteractive({
    requestID: "x1",
    turnID: "turn_a",
    kind: "custom.kind",
    title: "Pick one",
    payload: { options: ["a", "b"] },
    validate: (response) => (response === "a" ? undefined : ["must be a"]),
  });
  expect(
    h.published.some(
      ({ event }) =>
        event.type === "interactive.request" &&
        event.id === "x1" &&
        event.kind === "custom.kind",
    ),
  ).toBe(true);
  expect(
    h.waiter.respondInteractive({
      requestID: "x1",
      kind: "custom.kind",
      response: "a",
    }),
  ).toEqual({ accepted: true });
  await expect(pending).resolves.toEqual({
    response: "a",
    rejected: undefined,
  });
  expect(
    h.published.some(
      ({ event }) =>
        event.type === "interactive.response" &&
        event.id === "x1" &&
        event.kind === "custom.kind",
    ),
  ).toBe(true);
});

test("a generic interactive validate failure rejects the wait", async () => {
  const h = harness({});
  const pending = h.waiter.requireInteractive({
    requestID: "x2",
    turnID: "turn_a",
    kind: "custom.kind",
    title: "Pick",
    payload: {},
    validate: () => ["bad value"],
  });
  h.waiter.respondInteractive({
    requestID: "x2",
    kind: "custom.kind",
    response: 1,
  });
  await expect(pending).rejects.toThrow("invalid interactive response");
});

test("a response to a non-pending generic interactive is refused", () => {
  const h = harness({});
  expect(
    h.waiter.respondInteractive({
      requestID: "gone",
      kind: "custom.kind",
      response: null,
    }),
  ).toEqual({
    accepted: false,
    reason: "the interactive request is no longer pending",
  });
});
