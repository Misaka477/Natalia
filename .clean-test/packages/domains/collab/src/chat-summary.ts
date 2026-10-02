/**
 * Concise Chat tool summaries — runtime/collaboration/chat-summary.ts.
 *
 * A secret-safe one-line summary of a Live Work Chat tool call for the
 * conversation, so the chat transcript stays readable without leaking tool
 * arguments or raw results.
 */

/** A concise, secret-safe summary of a Chat tool call for the conversation. */
export function chatToolSummary(
  toolName: string,
  args: Record<string, unknown>,
  result: string,
) {
  switch (toolName) {
    case "mailbox_send": {
      const intent = typeof args.intent === "string" ? args.intent : "intent";
      const outcome = safeParseJson(result);
      const messageID =
        outcome && typeof outcome.messageID === "string"
          ? ` (${outcome.messageID})`
          : "";
      if (outcome && outcome.queued === false)
        return `mailbox intent not queued: ${intent}${messageID}`;
      return `queued mailbox intent: ${intent}${messageID}`;
    }
    case "mailbox_cancel": {
      const messageID =
        typeof args.messageID === "string" ? args.messageID : "unknown";
      return `cancelled mailbox ${messageID}`;
    }
    case "plan_create": {
      const title = typeof args.title === "string" ? args.title : "untitled";
      return `drafted plan: ${title}`;
    }
    case "plan_update": {
      const planID = typeof args.planID === "string" ? args.planID : "unknown";
      return `revised plan ${planID}`;
    }
    case "plan_propose": {
      const planID = typeof args.planID === "string" ? args.planID : "unknown";
      return `proposed plan ${planID} for your review`;
    }
    default:
      return `${toolName} (${result.slice(0, 120)})`;
  }
}

function safeParseJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}
