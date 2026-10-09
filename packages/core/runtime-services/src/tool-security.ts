import { tryParseToolArguments } from "@anthelia/tools";

export function terminalApprovalScope(toolName: string, rawArguments: string) {
  const args = tryParseToolArguments(rawArguments);
  const terminalID = typeof args.id === "string" ? args.id : undefined;
  if (!terminalID) return undefined;
  if (
    ![
      "interactive_terminal_write",
      "interactive_terminal_send_line",
      "interactive_terminal_keys",
    ].includes(toolName)
  )
    return undefined;
  const risk = terminalInputRisk(toolName, args);
  return {
    terminalID,
    risk,
    scope: `terminal:${terminalID}:${risk === "terminal_low" ? "low-risk" : "high-risk"}`,
    // NO TTL (R4(b), the user's 2026-10-10 ruling: an approval the agent is
    // waiting on must never expire). This used to carry a 30-minute TTL for
    // `terminal_low`, which made it the ONE approval that could time out: the
    // wait failed, the model was told the call did not run, and a human who
    // answered at minute 31 answered a settled request. Every other approval
    // already waited forever; the exception was the inconsistency, not the
    // rule.
    ttlMs: undefined,
  } as const;
}

export function terminalInputRisk(
  toolName: string,
  args: Record<string, unknown>,
) {
  if (toolName === "interactive_terminal_keys") {
    const keys = Array.isArray(args.keys)
      ? args.keys
      : args.key === undefined
        ? []
        : [{ key: args.key, modifiers: args.modifiers }];
    return keys.every((value) => {
      if (!value || typeof value !== "object") return false;
      const key = value as Record<string, unknown>;
      const modifiers = Array.isArray(key.modifiers) ? key.modifiers : [];
      return (
        modifiers.length === 0 &&
        typeof key.key === "string" &&
        /^[\p{L}\p{N}\p{P}\p{S}\s]$/u.test(key.key)
      );
    })
      ? "terminal_low"
      : "terminal_high";
  }
  const input = typeof args.text === "string" ? args.text : args.input;
  if (typeof input !== "string") return "terminal_high";
  return /(?:\brm\b|\bsudo\b|\bcurl\b|\bwget\b|\bssh\b|\bscp\b|\b(?:git\s+push|npm\s+publish)\b|>|\bchmod\b|\bkill\b)/iu.test(
    input,
  )
    ? "terminal_high"
    : "terminal_low";
}

export function readOnlyToolMessage(toolName: string) {
  return `tool denied by read-only permission mode: ${toolName}`;
}
