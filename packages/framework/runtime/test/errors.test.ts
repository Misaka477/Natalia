import { expect, test } from "bun:test";
import { asProviderError, providerError } from "../src/errors";

/**
 * The classifier keeps the original text (audit 缺口 1).
 *
 * `asProviderError` used to replace every unknown error's message with
 * "provider connection failed", so a TypeError thrown inside the turn path
 * read to the operator as a network failure — actively misleading, with the
 * real text only in `.cause`, which nothing displayed. The classification
 * stays (the retry policy's question is the kind); the message tells the
 * truth.
 */

test("a provider error passes through untouched", () => {
  const original = providerError({
    kind: "rate_limit",
    message: "slow down",
  });
  expect(asProviderError(original)).toBe(original);
});

test("an unknown error keeps its own name and message", () => {
  const failure = new TypeError("x is not a function");
  const classified = asProviderError(failure);
  // The kind is unchanged — the retry policy still sees connection-class.
  expect(classified.kind).toBe("connection");
  // The truth is in the message now, not only in the hidden cause.
  expect(classified.message).toContain("TypeError: x is not a function");
  expect(classified.message).not.toBe("provider connection failed");
  // And the cause chain is still there for the durable log to expand.
  expect(classified.cause).toBe(failure);
});

test("an abort still reads as a timeout", () => {
  const classified = asProviderError(new DOMException("aborted", "AbortError"));
  expect(classified.kind).toBe("timeout");
  expect(classified.message).toBe("provider request timed out");
});

test("a non-error value still classifies without losing it", () => {
  const classified = asProviderError("plain string failure");
  expect(classified.kind).toBe("connection");
  expect(classified.message).toContain("plain string failure");
  expect(classified.cause).toBe("plain string failure");
});
