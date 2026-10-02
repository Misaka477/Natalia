import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { sessionFactStateFromEvents } from "@anthelia/session";
import { mailboxMessagesForStatus } from "@natalia/collab";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";

const queued: RuntimeEvent = {
  type: "mailbox.queued",
  id: "mailbox:1:queued",
  messageID: "mailbox:1",
  source: "user_via_live_chat",
  priority: "high",
  intent: "reprioritize",
  text: "focus on docs",
  safeSummary: "reprioritize to docs",
  deliveryPolicy: "next_safe_boundary",
  createdAt: "t0",
};

test("mailbox_status reads the complete hot state without resolving the store", async () => {
  const exec = {
    session: { id: "ses_mailbox_status", events: [] },
    factState: sessionFactStateFromEvents([queued]),
    factStateComplete: true,
  } as unknown as SessionExecutionState;
  const ctx = {
    ports: {
      resolveService: () => {
        throw new Error("mailbox_status must not touch the session store here");
      },
    },
  } as unknown as RuntimeContext;

  const messages = await mailboxMessagesForStatus(ctx, exec);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    messageID: "mailbox:1",
    status: "queued",
    intent: "reprioritize",
  });
});
