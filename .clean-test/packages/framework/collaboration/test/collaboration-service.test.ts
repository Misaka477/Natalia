import { expect, test } from "bun:test";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import {
  createCollaborationService,
  type SendCollaborationInput,
} from "../src";

const sessionID = "ses_collaboration_service" as SessionID;

function setup(maxAutoRounds = 3) {
  const events: RuntimeEvent[] = [];
  let sequence = 0;
  const service = createCollaborationService({
    events: (candidate) => (candidate === sessionID ? events : undefined),
    publish: (_sessionID, event) => events.push(event),
    nextSequence: () => ++sequence,
    maxAutoRounds: () => maxAutoRounds,
    now: () => new Date("2026-08-25T00:00:00.000Z"),
  });
  return { events, service };
}

test("service sends every collaboration kind as collab.message", async () => {
  const { events, service } = setup();
  const question = await service.send({
    sessionID,
    kind: "question",
    from: "main_agent",
    text: "safe?",
  });
  await service.send({
    sessionID,
    kind: "answer",
    from: "live_chat",
    replyToID: question.message.id,
    text: "yes",
  });
  const suggestion = await service.send({
    sessionID,
    kind: "suggestion",
    from: "live_chat",
    text: "use echo",
    priority: "high",
  });
  await service.send({
    sessionID,
    kind: "response",
    from: "main_agent",
    replyToID: suggestion.message.id,
    text: "adopted",
    decision: "adopted",
  });
  await service.send({
    sessionID,
    kind: "notice",
    from: "main_agent",
    text: "blocked",
    noticeType: "blocked",
  });
  await service.send({
    sessionID,
    kind: "chat",
    from: "main_agent",
    text: "hello",
  });

  expect(events).toHaveLength(6);
  expect(events.map((event) => event.type)).toEqual([
    "natalia.collab.message", // question from main_agent
    "navi.collab.message", // answer from live_chat
    "navi.collab.message", // suggestion from live_chat
    "natalia.collab.message", // response from main_agent
    "natalia.collab.message", // notice from main_agent
    "natalia.collab.message", // chat from main_agent
  ]);
  expect(service.pendingFor(sessionID, "live_chat")).toHaveLength(1);
  expect(service.pendingFor(sessionID, "main_agent")).toHaveLength(0);
});

test("service namespaces Nia chat as nia.collab.message", async () => {
  const { events, service } = setup();
  await service.send({
    sessionID,
    kind: "chat",
    from: "nia",
    text: "audit findings are ready",
  });
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("nia.collab.message");
  expect(events[0]).toMatchObject({
    message: {
      from: "nia",
      to: "main_agent",
      text: "audit findings are ready",
    },
  });
});

test("service rejects invalid, inexact, and duplicate replies", async () => {
  const { service } = setup();
  const question = await service.send({
    sessionID,
    kind: "question",
    from: "main_agent",
    text: "safe?",
  });
  const invalid: SendCollaborationInput = {
    sessionID,
    kind: "answer",
    from: "live_chat",
    replyToID: question.message.id.slice(8),
    text: "yes",
  };
  await expect(service.send(invalid)).rejects.toThrow("no pending question");
  await service.send({ ...invalid, replyToID: question.message.id });
  await expect(
    service.send({ ...invalid, replyToID: question.message.id }),
  ).rejects.toThrow("no pending question");
  await expect(
    service.send({
      sessionID,
      kind: "chat",
      from: "live_chat",
      replyToID: question.message.id,
      text: "wrong kind",
    }),
  ).rejects.toThrow("no pending chat");
});

test("service closes chat at the automatic round limit", async () => {
  const { service } = setup(1);
  const first = await service.send({
    sessionID,
    kind: "chat",
    from: "main_agent",
    text: "one check",
  });
  const final = await service.send({
    sessionID,
    kind: "chat",
    from: "live_chat",
    replyToID: first.message.id,
    continueConversation: true,
    text: "closed",
  });
  expect(final.message).toMatchObject({
    kind: "chat",
    round: 1,
    expectsReply: false,
  });
  expect(final.wake).toEqual({
    recipient: "main_agent",
    messageID: final.message.id,
    replyRequired: false,
  });
});

test("new chats reject continueConversation because they always request one reply", async () => {
  const { service } = setup();

  await expect(
    service.send({
      sessionID,
      kind: "chat",
      from: "live_chat",
      text: "Are you free?",
      continueConversation: false,
    }),
  ).rejects.toThrow(
    "continueConversation is only valid when replying with replyToID",
  );

  const first = await service.send({
    sessionID,
    kind: "chat",
    from: "live_chat",
    text: "Are you free?",
  });
  expect(first.message).toMatchObject({
    kind: "chat",
    round: 1,
    expectsReply: true,
  });
});
