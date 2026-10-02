import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";
import { createScriptedProvider } from "./e2e-harness";
import { createRealRuntimeClient } from "../src/runtime/main";

/**
 * D6a end-to-end — design law 3 made testable: recorded feedback lands
 * in the journal, NEVER becomes model input, and recording itself
 * makes no model call. The token below appears in the note; if any
 * provider request ever contains it, isolation is broken and this test
 * says so.
 */

const ISOLATION_TOKEN = "FEEDBACK_ISOLATION_TOKEN_9f3a";

let scratch = "";

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("feedback reaches the journal but never the model", async () => {
  scratch = mkdtempSync(join(tmpdir(), "feedback-e2e-"));
  const requests: unknown[] = [];
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: scratch,
    sessionID: "ses_fb_e2e" as never,
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request: unknown) {
        requests.push(request);
        yield { type: "content" as const, text: "reply one" };
        yield { type: "done" as const };
      },
    } as never,
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!("ses_fb_e2e" as never);
  await client.submitAndWait!("first turn");
  const callsAfterTurn = requests.length;

  // Record a rating: no provider call may happen for it.
  const result = await client.feedback!({
    scope: "message",
    sessionID: "ses_fb_e2e" as never,
    messageID: "msg_from_turn_1",
    verdict: "down",
    category: "accuracy",
    note: `misread the diff ${ISOLATION_TOKEN}`,
  });
  expect(result.recorded).toBe(true);
  expect(requests.length).toBe(callsAfterTurn); // recording made NO model call

  const recorded = events.find((e) => e.type === "feedback.recorded") as
    | Extract<RuntimeEvent, { type: "feedback.recorded" }>
    | undefined;
  expect(recorded).toBeDefined();
  expect(recorded!.verdict).toBe("down");
  expect(recorded!.messageID).toBe("msg_from_turn_1");
  expect(recorded!.note).toContain(ISOLATION_TOKEN);

  // A subsequent turn: the note and the verdict must be absent from EVERY
  // provider request (the isolation proof, on the actual payloads).
  await client.submitAndWait!("second turn");
  await client.dispose?.();
  expect(requests.length).toBeGreaterThan(callsAfterTurn);
  const payload = JSON.stringify(requests);
  // Precise assertions: the naive words ("feedback", "down") appear in
  // legitimate tool descriptions — isolation is about THE RECORD FIELDS.
  expect(payload).not.toContain(ISOLATION_TOKEN);
  expect(payload).not.toContain('"verdict": "down"');
  expect(payload).not.toContain('"messageID": "msg_from_turn_1"');
});
