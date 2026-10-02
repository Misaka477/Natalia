import { expect, test } from "bun:test";
import {
  contextConfigSchema,
  endpointCapabilitiesSchema,
  endpointProtocolSchema,
  goalConfigSchema,
  providerConfigSchema,
  runtimeConfigSchema,
} from "../src";

test("the endpoint protocol declares an optional module and capabilities", () => {
  // The extension seam: a custom format names a local module, and its optional
  // cache extensions are declared rather than guessed.
  const parsed = endpointProtocolSchema.parse({
    format: "my-format",
    module: "./adapters/mine.ts",
    capabilities: { supportsCacheControlOnTools: true },
  });
  expect(parsed.format).toBe("my-format");
  expect(parsed.module).toBe("./adapters/mine.ts");
  expect(parsed.capabilities?.supportsCacheControlOnTools).toBe(true);

  // Absent is the safe case: nothing declared, nothing sent.
  expect(endpointProtocolSchema.parse({})).toEqual({});
});

test("the endpoint capabilities are all optional and default to off", () => {
  // Every field absent means off, because an assumed capability makes every
  // request fail against a parameter the deployment never accepted.
  expect(endpointCapabilitiesSchema.parse({})).toEqual({});
  expect(
    endpointCapabilitiesSchema.parse({ supportsLongCacheRetention: true })
      .supportsLongCacheRetention,
  ).toBe(true);
});

test("unknown capability fields are rejected, not ignored", () => {
  // A silently ignored typo would read as "the capability is declared and off".
  expect(() =>
    endpointCapabilitiesSchema.parse({ supportsCacheControlOnTool: true }),
  ).toThrow();
});

test("the context budget defaults the preserved tail to a token floor", () => {
  // A count alone cannot say how much context a turn holds: ten short exchanges
  // and ten file reads are the same count and an order of magnitude apart.
  const parsed = contextConfigSchema.parse({});
  expect(parsed.preservedRecentMessages).toBe(10);
  expect(parsed.preservedRecentTokens).toBe(20_000);
});

test("the runtime config bounds a subagent's wall clock and gates its result", () => {
  const parsed = runtimeConfigSchema.parse({});
  expect(parsed.subagentWallClockMs).toBe(900_000);
  expect(parsed.subagentMinResultChars).toBe(200);
  expect(parsed.subagentSettledNotices).toBe(20);
});

test("the goal config carries an optional completion command", () => {
  // Absent by default: a workspace without the config behaves exactly as before,
  // and an invented default would fail every workspace with no test suite.
  const empty = goalConfigSchema.parse({});
  expect(empty.completionCommand).toBeUndefined();

  const configured = goalConfigSchema.parse({
    completionCommand: "bun run verify",
  });
  expect(configured.completionCommand).toBe("bun run verify");
});

test("the goal config rejects unknown fields and blank commands", () => {
  expect(() => goalConfigSchema.parse({ nope: 1 })).toThrow();
  expect(() => goalConfigSchema.parse({ completionCommand: "   " })).toThrow();
});

test("a provider config carries the endpoint protocol and its connection", () => {
  const parsed = providerConfigSchema.parse({
    name: "primary",
    driver: "openai",
    connection: { apiKey: "k" },
    requestDefaults: {},
    protocol: { format: "openai-chat" },
  });
  expect(parsed.protocol?.format).toBe("openai-chat");
});
