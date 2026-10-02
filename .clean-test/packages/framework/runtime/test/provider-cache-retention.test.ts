import { expect, test } from "bun:test";
import { anthropicCacheControl } from "../src/provider-caps";

test("short retention is the default marker", () => {
  expect(
    anthropicCacheControl({
      retention: "short",
      supportsLongCacheRetention: false,
    }),
  ).toEqual({ type: "ephemeral" });
});

test("long retention adds the ttl only when the endpoint declared it", () => {
  expect(
    anthropicCacheControl({
      retention: "long",
      supportsLongCacheRetention: true,
    }),
  ).toEqual({ type: "ephemeral", ttl: "1h" });
});

test("long retention degrades to short rather than sending an unsupported ttl", () => {
  // The request still has to go out, and a `ttl` the deployment rejects fails
  // every request — so asking for more than is supported gives what is.
  expect(
    anthropicCacheControl({
      retention: "long",
      supportsLongCacheRetention: false,
    }),
  ).toEqual({ type: "ephemeral" });
});

test("none opts out of the cache entirely", () => {
  expect(
    anthropicCacheControl({
      retention: "none",
      supportsLongCacheRetention: true,
    }),
  ).toBeUndefined();
});
