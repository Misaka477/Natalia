/** Parse the raw JSON arguments emitted for a tool call. */
export function parseToolArguments(input: string): unknown {
  if (!input.trim()) return {};
  return JSON.parse(input) as unknown;
}

/** Best-effort object parsing for policy and presentation paths. */
export function tryParseToolArguments(input: string): Record<string, unknown> {
  try {
    const parsed = parseToolArguments(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // The execution boundary reports malformed arguments in detail.
  }
  return {};
}
