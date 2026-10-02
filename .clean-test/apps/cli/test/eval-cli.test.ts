import { expect, test } from "bun:test";
import { submitFailureReason } from "../src/eval-cli";

/**
 * The bench run's submit failure named for an operator. The live closure
 * round proved the chain: a real daemon without a provider answers the
 * submit with an unparseable body, and the batch carried that as a
 * per-task failure — this test pins the NAMING (the live run showed the
 * raw error's message was useless to whoever reads it).
 */

test("the timeout names itself (no provider answering?)", () => {
  expect(
    submitFailureReason(new Error("The operation was aborted due to timeout")),
  ).toBe("submit timed out after 45000ms (no provider answering?)");
  expect(submitFailureReason(new Error("aborted"))).toContain(
    "timed out after 45000ms",
  );
});

test("the unparseable answer names itself instead of leaking the parser's text", () => {
  expect(
    submitFailureReason(
      new TypeError("null is not an object (evaluating 'body.error')"),
    ),
  ).toBe("the daemon answered nothing that could be parsed");
});

test("anything else keeps the message, flattened through the submit's name", () => {
  expect(submitFailureReason(new Error("fetch failed"))).toBe(
    "submit failed: fetch failed",
  );
  expect(submitFailureReason("plain string")).toBe(
    "submit failed: plain string",
  );
});
