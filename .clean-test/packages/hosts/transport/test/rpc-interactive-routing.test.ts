/**
 * `approval.respond` / `question.respond` must carry the client's routing hints
 * through the transport. Dropping them made the runtime fall back to the
 * attached session and journal answers to the wrong session, so an answered
 * request stayed pending in its own journal and re-appeared.
 */
import { expect, test } from "bun:test";
import type { RuntimeClient, RuntimeEvent } from "@anthelia/contracts";
import { handleRPCMessage } from "../src/host";

function stubClient(overrides: Partial<RuntimeClient> = {}): RuntimeClient {
  return {
    start() {},
    async submit(text) {
      return {
        type: "turn.submitted",
        id: "turn_1",
        text,
        byteLength: text.length,
        lineCount: 1,
        sha256: "stub",
      };
    },
    cancel() {},
    snapshot(): RuntimeEvent {
      return { type: "diagnostic", level: "info", message: "stub" };
    },
    diagnostic() {},
    lastSubmission() {
      return undefined;
    },
    respondApproval() {
      return { accepted: true };
    },
    respondQuestion() {
      return { accepted: true };
    },
    ...overrides,
  };
}

test("question.respond forwards session routing hints to the runtime", async () => {
  let received: unknown;
  const client = stubClient({
    respondQuestion(input) {
      received = input;
      return { accepted: true };
    },
  });
  const response = await handleRPCMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "question.respond",
      params: {
        requestID: "q1",
        answers: [["a"]],
        rejected: false,
        sessionID: "ses_x",
        workspaceID: "ws_y",
      },
    },
    client,
  );
  expect(response.error).toBeUndefined();
  expect(received).toMatchObject({
    requestID: "q1",
    answers: [["a"]],
    sessionID: "ses_x",
    workspaceID: "ws_y",
  });
});

test("approval.respond forwards session routing hints to the runtime", async () => {
  let received: unknown;
  const client = stubClient({
    respondApproval(input) {
      received = input;
      return { accepted: true };
    },
  });
  const response = await handleRPCMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "approval.respond",
      params: {
        requestID: "a1",
        decision: "once",
        sessionID: "ses_x",
        workspaceID: "ws_y",
      },
    },
    client,
  );
  expect(response.error).toBeUndefined();
  expect(received).toMatchObject({
    requestID: "a1",
    decision: "once",
    sessionID: "ses_x",
    workspaceID: "ws_y",
  });
});

test("interactive.respond forwards the id, kind, response and routing hint", async () => {
  let received: unknown;
  const client = stubClient({
    respondInteractive(input) {
      received = input;
      return { accepted: true };
    },
  });
  const response = await handleRPCMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "interactive.respond",
      params: {
        requestID: "ix1",
        kind: "custom.kind",
        response: { a: 1 },
        sessionID: "ses_1",
      },
    },
    client,
  );
  expect(response.result).toEqual({ accepted: true });
  expect(received).toEqual({
    requestID: "ix1",
    kind: "custom.kind",
    response: { a: 1 },
    sessionID: "ses_1",
  });
});
