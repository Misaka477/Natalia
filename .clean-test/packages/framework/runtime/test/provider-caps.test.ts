import { expect, test } from "bun:test";
import { resolveEndpointCapabilities } from "../src/provider-caps";

test("an undeclared capability set resolves every flag to off", () => {
  // The rule: a capability is on only when declared. An assumed one makes every
  // request fail against a parameter the deployment never accepted.
  expect(resolveEndpointCapabilities(undefined)).toEqual({
    supportsLongCacheRetention: false,
    supportsCacheControlOnTools: false,
    sendSessionAffinityHeaders: false,
    sessionAffinityFormat: undefined,
    supportsPromptCacheKey: false,
    promptCacheKeyField: undefined,
    supportsExplicitPromptCacheMode: false,
  });
});

test("an empty declaration is the same as no declaration", () => {
  expect(resolveEndpointCapabilities({})).toEqual(
    resolveEndpointCapabilities(undefined),
  );
});

test("a declared flag survives, and its neighbours stay off", () => {
  const caps = resolveEndpointCapabilities({
    supportsCacheControlOnTools: true,
  });

  expect(caps.supportsCacheControlOnTools).toBe(true);
  expect(caps.supportsLongCacheRetention).toBe(false);
  expect(caps.sendSessionAffinityHeaders).toBe(false);
});

test("a string field stays absent until declared, so no spelling is invented", () => {
  const caps = resolveEndpointCapabilities({ supportsPromptCacheKey: true });

  // A key is on but no spelling is named: the caller must fall back to the
  // wire default rather than assume one.
  expect(caps.supportsPromptCacheKey).toBe(true);
  expect(caps.promptCacheKeyField).toBeUndefined();
});

test("declaring a spelling does not turn the capability on by itself", () => {
  // The two gates are independent: a spelling without the flag sends nothing.
  const caps = resolveEndpointCapabilities({
    promptCacheKeyField: "prompt_cache_key",
  });

  expect(caps.supportsPromptCacheKey).toBe(false);
  expect(caps.promptCacheKeyField).toBe("prompt_cache_key");
});
