import { expect, test } from "bun:test";
import { createMailboxAcknowledgeTool } from "@anthelia/runtime-services";
import type { ToolExecutionContext } from "@anthelia/tools";

/**
 * `mailbox_acknowledge` (the 2026-10-08 audit's P1-6).
 *
 * The audit measured a fabricated id answering `Acknowledged 1 mailbox
 * message(s)` — a silent success that changed nothing. The tool now reports
 * what the RUNTIME did, not what the caller asked for.
 */

function toolWith(outcome: {
  acknowledged: string[];
  skipped: Array<{ messageID: string; reason: "unknown" | "not_delivered" }>;
}) {
  const seen: string[][] = [];
  const tool = createMailboxAcknowledgeTool({
    async onAcknowledge(messageIDs) {
      seen.push(messageIDs);
      return outcome;
    },
  });
  return { tool, seen };
}

const context = {} as ToolExecutionContext;

test("an acknowledged message is counted, and a fabricated id is named", async () => {
  const { tool } = toolWith({
    acknowledged: ["mbx_1"],
    skipped: [{ messageID: "probe-bogus", reason: "unknown" }],
  });
  const answer = await tool.execute(
    { messageIDs: ["mbx_1", "probe-bogus"] },
    context,
  );
  // The count is the runtime's, and the id that changed nothing is named
  // with the reason — a caller can act on it instead of trusting a lie.
  expect(answer).toBe(
    "Acknowledged 1 mailbox message(s). Not acknowledged: probe-bogus (unknown).",
  );
});

test("a message that is not delivered is named as such, not silently dropped", async () => {
  const { tool } = toolWith({
    acknowledged: [],
    skipped: [{ messageID: "mbx_9", reason: "not_delivered" }],
  });
  const answer = await tool.execute({ messageIDs: ["mbx_9"] }, context);
  expect(answer).toBe(
    "Acknowledged 0 mailbox message(s). Not acknowledged: mbx_9 (not_delivered).",
  );
});

test("no ids supplied is still a no-op, and says so", async () => {
  const { tool } = toolWith({ acknowledged: [], skipped: [] });
  expect(await tool.execute({ messageIDs: [] }, context)).toBe(
    "No message ids supplied; nothing to acknowledge.",
  );
});
