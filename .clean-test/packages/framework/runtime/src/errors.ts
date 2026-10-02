import type { ErrorKind } from "@anthelia/contracts";

export type { ErrorKind } from "@anthelia/contracts";

export type ProviderErrorInput = {
  kind: ErrorKind;
  message: string;
  statusCode?: number;
  retryAfterMs?: number;
  cause?: unknown;
};

export class ProviderError extends Error {
  readonly kind: ErrorKind;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  override readonly cause?: unknown;

  constructor(input: ProviderErrorInput) {
    super(input.message);
    this.name = "ProviderError";
    this.kind = input.kind;
    this.statusCode = input.statusCode;
    this.retryAfterMs = input.retryAfterMs;
    this.cause = input.cause;
  }
}

export function providerError(input: ProviderErrorInput) {
  return new ProviderError(input);
}

export function asProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return providerError({
      kind: "timeout",
      message: "provider request timed out",
      cause: error,
    });
  }
  return providerError({
    kind: "connection",
    message: "provider connection failed",
    cause: error,
  });
}

export function mapHttpStatusToErrorKind(statusCode: number): ErrorKind {
  if (statusCode === 408) return "timeout";
  if (statusCode === 429) return "rate_limit";
  if (statusCode === 402) return "quota";
  if ([500, 502, 503, 504].includes(statusCode)) return "server";
  if (statusCode === 401 || statusCode === 403) return "auth";
  if ([400, 404, 422].includes(statusCode)) return "invalid_request";
  // Anything else below 500 is not known to be the caller's fault. Reporting it
  // as an invalid request asserted something untrue about the request, which
  // made a billing failure read like a malformed call.
  return statusCode >= 500 ? "server" : "unknown";
}

/**
 * Providers disagree on how a spent balance arrives: some answer 402, others
 * 429 with a quota code, so the body has to be consulted as well as the status.
 */
function isQuotaError(bodyCode?: string, message?: string) {
  if (
    bodyCode === "insufficient_quota" ||
    bodyCode === "insufficient_balance" ||
    bodyCode === "billing_hard_limit_reached"
  )
    return true;
  return /insufficient[_ -]?(?:quota|balance|credit)|quota[_ -]?exceeded|exceeded[^.]*\bquota\b|out of credit|billing/iu.test(
    message ?? "",
  );
}

export function providerErrorFromHttp(input: {
  statusCode: number;
  statusText?: string;
  retryAfter?: string | null;
  retryAfterMs?: string | null;
  message?: string;
  bodyCode?: string;
}) {
  const kind = isContextLimitError(input.bodyCode, input.message)
    ? "context_limit"
    : isQuotaError(input.bodyCode, input.message)
      ? "quota"
      : mapHttpStatusToErrorKind(input.statusCode);
  return providerError({
    kind,
    statusCode: input.statusCode,
    retryAfterMs:
      parseRetryAfterMilliseconds(input.retryAfterMs) ??
      parseRetryAfterMs(input.retryAfter),
    message:
      input.message ?? input.statusText ?? `provider HTTP ${input.statusCode}`,
  });
}

export function parseRetryAfterMilliseconds(value?: string | null) {
  if (!value) return undefined;
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  return Math.round(milliseconds);
}

function isContextLimitError(bodyCode?: string, message?: string) {
  if (bodyCode === "context_length_exceeded") return true;
  return /context[_ -]?(length|limit)|maximum context|too many tokens/iu.test(
    message ?? "",
  );
}

export function parseRetryAfterMs(value?: string | null, now = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - now);
}

export function redactedProviderMessage(error: ProviderError) {
  return `${error.kind}${error.statusCode ? ` (${error.statusCode})` : ""}`;
}
