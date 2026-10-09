/**
 * The `mailbox_acknowledge` tool — how the main agent acknowledges the Live
 * Work Chat mailbox messages it has acted on.
 *
 * Delivered intents are injected as ordinary tagged user messages before the
 * next model step. Without an acknowledgement, a message stays `delivered`
 * and would keep being eligible; the tool lets the agent confirm which
 * messages it processed so they stop being re-injected.
 *
 * The tool is a pure shell: it validates the message ids and hands them to the
 * runtime through `onAcknowledge` (which publishes the durable
 * `mailbox.acknowledged` events). No mailbox content, tool results or secrets
 * pass through here.
 */
import type { RuntimeTool, ToolExecutionContext } from "@anthelia/tools";

/**
 * What the acknowledge actually did, per id.
 *
 * The tool used to report `Acknowledged N mailbox message(s)` for whatever the
 * caller asked, so a fabricated id answered `Acknowledged 1` while nothing
 * changed (the 2026-10-08 audit's P1-6). The answer now names the truth: what
 * was acknowledged, and why anything was not.
 */
export type AcknowledgeOutcome = {
  acknowledged: string[];
  skipped: Array<{ messageID: string; reason: "unknown" | "not_delivered" }>;
};

export function createMailboxAcknowledgeTool(input: {
  /** The runtime callback: mark each delivered message id acknowledged. */
  onAcknowledge: (
    messageIDs: string[],
    context: ToolExecutionContext,
  ) => Promise<AcknowledgeOutcome>;
}): RuntimeTool {
  return {
    name: "mailbox_acknowledge",
    description:
      "Acknowledge Live Work Chat mailbox messages you have read and acted on. Call this after acting on tagged [user]/[Navi] steering messages; acknowledged messages stop being re-injected.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        messageIDs: {
          type: "array",
          items: { type: "string" },
          description:
            "The messageIDs from the pending user intents to acknowledge",
        },
      },
      required: ["messageIDs"],
      additionalProperties: false,
    },
    async execute(raw, context) {
      const args =
        raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const messageIDs = Array.isArray(args.messageIDs)
        ? args.messageIDs.map(String).filter((id) => id.length > 0)
        : [];
      if (!messageIDs.length)
        return "No message ids supplied; nothing to acknowledge.";
      // The runtime's own answer, not the caller's request: an id that names
      // no delivered message is reported as such instead of counted.
      const outcome = await input.onAcknowledge(messageIDs, context);
      const parts = [
        `Acknowledged ${outcome.acknowledged.length} mailbox message(s).`,
      ];
      if (outcome.skipped.length)
        parts.push(
          `Not acknowledged: ${outcome.skipped
            .map((entry) => `${entry.messageID} (${entry.reason})`)
            .join(", ")}.`,
        );
      return parts.join(" ");
    },
  };
}
