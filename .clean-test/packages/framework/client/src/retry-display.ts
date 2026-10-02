import type { ErrorKind, RuntimeEvent } from "@anthelia/contracts";

export function retryDisplayLine(event: RuntimeEvent) {
  if (event.type === "step.retry") {
    return `Retrying after ${event.reason}${event.statusCode ? ` (${event.statusCode})` : ""} · attempt ${event.attempt}/${event.maxAttempts ?? "unlimited"} · waiting ${formatWait(event.waitMs)}`;
  }
  if (event.type === "step.retry.cleared") {
    return `Retry recovered after ${event.attempts} attempts`;
  }
  if (event.type === "step.retry.exhausted") {
    // Saying "exhausted" after one of three attempts described the wrong cause:
    // the attempt budget was never reached because the failure was final.
    const cause =
      event.retryable === false
        ? `Not retryable after ${event.attempts}/${event.maxAttempts ?? "unlimited"}`
        : `Retry exhausted after ${event.attempts}/${event.maxAttempts ?? "unlimited"}`;
    const hint = providerErrorHint(event.reason);
    return `${cause}: ${event.message}${hint ? ` · ${hint}` : ""}`;
  }
  return undefined;
}

/**
 * Turns a failure kind into the next thing worth doing. The kinds themselves
 * stay free of prose so other consumers can word this differently, and a kind
 * with no useful action returns nothing rather than filler.
 */
export function providerErrorHint(kind: ErrorKind): string | undefined {
  if (kind === "quota")
    return "the provider account is out of credit; top it up or switch provider with /models";
  if (kind === "auth")
    return "check the provider API key in .natalia/config.json";
  if (kind === "context_limit")
    return "the conversation is too long for this model; compact it or start a new session";
  if (kind === "rate_limit")
    return "the provider is rate limiting; retry later";
  if (kind === "connection" || kind === "timeout")
    return "check network access to the provider endpoint";
  return undefined;
}

function formatWait(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
