import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  FakeRetryProvider,
  retryScenarios,
  type FakeRetryOutcome,
} from "./fixtures";
import {
  mapHttpStatusToErrorKind,
  parseRetryAfterMs,
  parseRetryAfterMilliseconds,
  providerError,
  providerErrorFromHttp,
  retryDelayMs,
  runStreamingWithRetry,
  runWithRetry,
  shouldRetryProviderError,
  type ProviderError,
} from "../src";

const noSleep = async (_ms: number) => undefined;

test("provider adapter maps status codes to typed error kinds without string contains", () => {
  expect(mapHttpStatusToErrorKind(408)).toBe("timeout");
  expect(mapHttpStatusToErrorKind(429)).toBe("rate_limit");
  expect(mapHttpStatusToErrorKind(500)).toBe("server");
  expect(mapHttpStatusToErrorKind(502)).toBe("server");
  expect(mapHttpStatusToErrorKind(503)).toBe("server");
  expect(mapHttpStatusToErrorKind(504)).toBe("server");
  expect(mapHttpStatusToErrorKind(401)).toBe("auth");
  expect(mapHttpStatusToErrorKind(403)).toBe("auth");
  expect(mapHttpStatusToErrorKind(400)).toBe("invalid_request");
  expect(mapHttpStatusToErrorKind(404)).toBe("invalid_request");
  expect(mapHttpStatusToErrorKind(422)).toBe("invalid_request");
  expect(
    providerErrorFromHttp({
      statusCode: 400,
      bodyCode: "context_length_exceeded",
    }).kind,
  ).toBe("context_limit");
});

test("retry policy retries only transient provider-neutral kinds", () => {
  for (const kind of [
    "timeout",
    "connection",
    "empty_response",
    "rate_limit",
    "server",
  ] as const) {
    expect(
      shouldRetryProviderError(providerError({ kind, message: kind })),
    ).toBe(true);
  }
  for (const kind of [
    "auth",
    "invalid_request",
    "context_limit",
    "cancel",
  ] as const) {
    expect(
      shouldRetryProviderError(providerError({ kind, message: kind })),
    ).toBe(false);
  }
});

test("backoff uses exponential jitter and bounded retry-after", () => {
  expect(
    retryDelayMs(
      providerError({ kind: "timeout", message: "timeout" }),
      1,
      undefined,
      () => 0,
    ),
  ).toBe(300);
  expect(
    retryDelayMs(
      providerError({ kind: "timeout", message: "timeout" }),
      2,
      undefined,
      () => 1,
    ),
  ).toBe(1101);
  expect(
    retryDelayMs(
      providerError({ kind: "rate_limit", message: "429", retryAfterMs: 9000 }),
      1,
    ),
  ).toBe(5000);
  expect(parseRetryAfterMs("2")).toBe(2000);
  expect(parseRetryAfterMilliseconds("1250")).toBe(1250);
  expect(
    providerErrorFromHttp({
      statusCode: 429,
      retryAfter: "8",
      retryAfterMs: "1250",
    }).retryAfterMs,
  ).toBe(1250);
});

test("cancellation interrupts retry backoff without another attempt", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const events: RuntimeEvent[] = [];
  const running = runWithRetry(
    { id: "turn_cancel_backoff", operation: "llm_step", step: 1 },
    async () => {
      attempts++;
      throw providerError({ kind: "server", message: "temporarily down" });
    },
    {
      signal: controller.signal,
      timer: async () => await new Promise<void>(() => undefined),
      random: () => 0,
      onEvent: (event) => events.push(event),
    },
  );
  await Bun.sleep(5);
  controller.abort(new Error("user cancelled"));
  await expect(running).rejects.toMatchObject({ kind: "cancel" });
  expect(attempts).toBe(1);
  expect(events.map((event) => event.type)).toEqual([
    "step.retry",
    "step.retry.exhausted",
  ]);
  expect(events.at(-1)).toMatchObject({ reason: "cancel", retryable: false });
});

test("N timeout attempts then success emit StepRetry and clear banner", async () => {
  const provider = new FakeRetryProvider(retryScenarios.timeoutThenSuccess);
  const waits: number[] = [];
  const events: string[] = [];
  const result = await runFakeScenario(provider, {
    timer: async (ms) => {
      waits.push(ms);
    },
    random: () => 0,
    onEvent: (event) => events.push(event.type),
  });
  expect(result).toEqual(["final"]);
  expect(provider.attempts).toBe(3);
  expect(waits).toEqual([300, 600]);
  expect(events).toEqual(["step.retry", "step.retry", "step.retry.cleared"]);
});

test("transient failures retry beyond the old attempt budget by default", async () => {
  let attempts = 0;
  const retries: Array<number | null> = [];
  const result = await runWithRetry(
    { id: "turn_unlimited", operation: "llm_step", step: 1 },
    async ({ attempt, maxAttempts }) => {
      attempts = attempt;
      expect(maxAttempts).toBeNull();
      if (attempt < 6)
        throw providerError({ kind: "server", message: "temporarily down" });
      return "recovered";
    },
    {
      timer: noSleep,
      random: () => 0,
      onEvent: (event) => {
        if (event.type === "step.retry") retries.push(event.maxAttempts);
      },
    },
  );
  expect(result).toBe("recovered");
  expect(attempts).toBe(6);
  expect(retries).toEqual([null, null, null, null, null]);
});

test("connection, 429, 503, empty and Retry-After fixtures retry", async () => {
  for (const [name, scenario] of Object.entries({
    connectionThenSuccess: retryScenarios.connectionThenSuccess,
    rateLimitRetryAfter: retryScenarios.rateLimitRetryAfter,
    server503ThenSuccess: retryScenarios.server503ThenSuccess,
    emptyThenSuccess: retryScenarios.emptyThenSuccess,
  })) {
    const provider = new FakeRetryProvider(scenario);
    const waits: number[] = [];
    const result = await runFakeScenario(provider, {
      timer: async (ms) => {
        waits.push(ms);
      },
      random: () => 0,
    });
    expect(result.length, name).toBe(1);
    expect(provider.attempts, name).toBe(2);
    if (name === "rateLimitRetryAfter") expect(waits).toEqual([1200]);
  }
});

test("think-only abnormal failed attempt transient content does not commit", async () => {
  const provider = new FakeRetryProvider(retryScenarios.thinkOnlyThenSuccess);
  const committed: string[] = [];
  const result = await runFakeScenario(provider, {
    onCommit: (chunk) => committed.push(chunk),
    timer: noSleep,
    random: () => 0,
  });
  expect(result).toEqual(["clean final"]);
  expect(committed).toEqual(["clean final"]);
  expect(committed).not.toContain("hidden failed thought");
});

test("cancel, auth, invalid request and context limit do not retry", async () => {
  for (const kind of [
    "cancel",
    "auth",
    "invalid_request",
    "context_limit",
  ] as const) {
    const events: string[] = [];
    await expect(
      runWithRetry(
        { id: `turn_${kind}`, operation: "llm_step", step: 1 },
        async () => {
          throw providerError({ kind, message: `${kind} secret-token` });
        },
        { timer: noSleep, onEvent: (event) => events.push(event.type) },
      ),
    ).rejects.toMatchObject({ kind });
    expect(events).toEqual(["step.retry.exhausted"]);
  }
});

test("attempt exhausted emits redacted summary", async () => {
  const provider = new FakeRetryProvider(retryScenarios.exhausted);
  const messages: string[] = [];
  await expect(
    runFakeScenario(provider, {
      policy: { maxAttemptsPerStep: 3 },
      timer: noSleep,
      random: () => 0,
      onEvent: (event) => {
        if (event.type === "step.retry.exhausted") messages.push(event.message);
      },
    }),
  ).rejects.toMatchObject({ kind: "timeout" });
  expect(provider.attempts).toBe(3);
  expect(messages).toEqual(["timeout"]);
  expect(messages.join(" ")).not.toContain("secret");
});

async function runFakeScenario(
  provider: FakeRetryProvider,
  options: Parameters<typeof runStreamingWithRetry>[2] = {},
) {
  return runStreamingWithRetry(
    { id: "turn_retry", operation: "llm_step", step: 1 },
    async (_attempt, emitTransient) => {
      const outcome = await provider.complete(emitTransient);
      if (outcome.type === "error") throw toProviderError(outcome);
      if (outcome.type === "think-only") {
        throw providerError({
          kind: "empty_response",
          message: "think-only abnormal response",
        });
      }
      return outcome.chunks;
    },
    options,
  );
}

function toProviderError(
  outcome: Extract<FakeRetryOutcome, { type: "error" }>,
): ProviderError {
  return providerError({
    kind: outcome.kind,
    statusCode: outcome.statusCode,
    retryAfterMs: outcome.retryAfterMs,
    message: outcome.message ?? outcome.kind,
  });
}

test("billing failures are classified as quota rather than invalid requests", () => {
  // DeepSeek answers 402 with this body; OpenAI answers 429 with a quota code.
  expect(
    providerErrorFromHttp({ statusCode: 402, message: "Insufficient Balance" })
      .kind,
  ).toBe("quota");
  expect(
    providerErrorFromHttp({
      statusCode: 429,
      bodyCode: "insufficient_quota",
      message: "You exceeded your current quota",
    }).kind,
  ).toBe("quota");
  // A spent balance is final, so it must not consume the retry budget.
  expect(
    shouldRetryProviderError(
      providerErrorFromHttp({
        statusCode: 402,
        message: "Insufficient Balance",
      }),
    ),
  ).toBe(false);
  // A plain rate limit still retries.
  expect(
    shouldRetryProviderError(
      providerErrorFromHttp({ statusCode: 429, message: "slow down" }),
    ),
  ).toBe(true);
});

test("an unrecognized status is reported as unknown, not as a bad request", () => {
  expect(mapHttpStatusToErrorKind(418)).toBe("unknown");
  expect(mapHttpStatusToErrorKind(451)).toBe("unknown");
  // Claiming the request was invalid asserted a cause that was not established.
  expect(mapHttpStatusToErrorKind(400)).toBe("invalid_request");
  expect(mapHttpStatusToErrorKind(503)).toBe("server");
});
