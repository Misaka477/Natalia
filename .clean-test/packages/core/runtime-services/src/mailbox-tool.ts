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

export function createMailboxAcknowledgeTool(input: {
  /** The runtime callback: mark each delivered message id acknowledged. */
  onAcknowledge: (
    messageIDs: string[],
    context: ToolExecutionContext,
  ) => Promise<void>;
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
      await input.onAcknowledge(messageIDs, context);
      return `Acknowledged ${messageIDs.length} mailbox message(s).`;
    },
  };
}
