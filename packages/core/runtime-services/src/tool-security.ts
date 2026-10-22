import { tryParseToolArguments } from "@anthelia/tools";

/**
 * The tools a read_only session may still call.
 *
 * read_only withholds every tool that requires approval — the model is not
 * offered a capability a human has not stood behind. The exemption is for
 * tools with NO WRITE EFFECT: they read a document and answer with text,
 * and withholding them punishes a session for a mode that promised to stop
 * WRITES. The client's own sandbox-rung already says exactly that
 * ("every tool that writes is refused outright"); the implementation was
 * wider than the promise, and this is the narrowing.
 *
 * `skill_load` is the one member. Loading a skill appends a document to
 * the conversation: it changes no file, no process, no screen. The
 * instruction-injection surface is real and stays guarded where it
 * matters — ask/auto still require approval for it (it is an approval
 * family, with the session-level "Allow skills" affordance), and a
 * skill's SCRIPTS still need the shell, which read_only withholds.
 *
 * The bar for joining this set is "changes nothing outside the
 * conversation", not "feels safe": a tool that writes a file, sends
 * input, or spawns a process does not belong here however read-only it
 * looks. `sandbox_create`/`sandbox_execute`/`sandbox_write`/`sandbox_merge`
 * are all withheld; `sandbox_list`/`sandbox_diff` are already
 * approval-free and need no exemption.
 */
export const READ_ONLY_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "skill_load",
]);

/** Whether a read_only session may call this tool. */
export function isReadOnlySafe(toolName: string): boolean {
  return READ_ONLY_SAFE_TOOLS.has(toolName);
}

/**
 * Whether read_only WITHHOLDS this tool — the whole rule, in one place.
 *
 * It is read in five places, and that is the reason it exists here: the two
 * advertised-schema filters (provider-runner), the execution pre-stage, the
 * unresolved-call report (execute-calls) and the approval seam
 * (interactive-waiter). When each carried its own copy the copies drifted,
 * and both drifts were measured in a real session: a read_only session told
 * to call a tool its schema did not carry, and then a tool advertised and
 * refused anyway. One definition is the fix; a comment promising they agree
 * is not.
 *
 * The rule is the write-effect test, not a trust vote — see
 * READ_ONLY_SAFE_TOOLS for the bar.
 */
export function isWithheldInReadOnly(tool: {
  name: string;
  requiresApproval?: boolean;
}): boolean {
  return Boolean(tool.requiresApproval) && !isReadOnlySafe(tool.name);
}

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
