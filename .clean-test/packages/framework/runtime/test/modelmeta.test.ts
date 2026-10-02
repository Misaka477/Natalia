import { expect, test } from "bun:test";
import {
  buildProviderRequest,
  ContextWindowResolver,
  modelsDevModelLimits,
} from "../src";

test("resolver priority is explicit config before provider metadata", async () => {
  const resolver = new ContextWindowResolver();
  const result = await resolver.resolve({
    provider: "openai",
    model: "gpt-5.5",
    explicitContextWindow: 123456,
    providerAdapter: {
      listModels: async () => [{ id: "gpt-5.5", contextWindow: 1 }],
    },
  });
  expect(result.tokens).toBe(123456);
  expect(result.source).toBe("config");
  expect(result.confidence).toBe("high");
  expect(result.ttlMs).toBeGreaterThan(0);
});

test("Models.dev resolves context and output limits when provider metadata is absent", async () => {
  const fetchImpl = Object.assign(
    async () =>
      Response.json({
        "stepfun-step-plan": {
          name: "StepFun Step Plan",
          models: {
            "step-3.7-flash": {
              limit: { context: 256000, input: 256000, output: 256000 },
            },
          },
        },
      }),
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  expect(
    await modelsDevModelLimits("step-plan", "step-3.7-flash", fetchImpl),
  ).toEqual({
    contextWindow: 256000,
    inputTokenLimit: 256000,
    maxOutputTokens: 256000,
  });
});

test("resolver uses provider metadata, detail, catalog, fallback and isolated cache", async () => {
  const resolver = new ContextWindowResolver();
  const now = new Date("2026-07-17T00:00:00Z");
  const metadata = await resolver.resolve({
    provider: "openai",
    model: "model-a",
    baseURL: "https://one.example/v1",
    apiKey: "key-a",
    now,
    providerAdapter: {
      listModels: async () => [{ id: "model-a", contextWindow: 64000 }],
    },
  });
  expect(metadata.source).toBe("provider_metadata");
  expect(metadata.detectedAt).toBe(now.toISOString());

  const detail = await resolver.resolve({
    provider: "anthropic",
    model: "model-b",
    providerAdapter: { modelDetail: async () => ({ inputTokenLimit: 128000 }) },
  });
  expect(detail.source).toBe("provider_detail");

  const catalog = await resolver.resolve({
    provider: "openai",
    model: "gpt-5.5",
  });
  expect(catalog.source).toBe("known_catalog");

  const fallback = await resolver.resolve({
    provider: "unknown",
    model: "unknown-model",
  });
  expect(fallback.source).toBe("fallback");
  expect(fallback.confidence).toBe("low");

  expect(
    resolver.cacheKey({
      provider: "openai",
      model: "model-a",
      baseURL: "https://one.example/v1",
      apiKey: "key-a",
    }),
  ).not.toBe(
    resolver.cacheKey({
      provider: "openai",
      model: "model-a",
      baseURL: "https://two.example/v1",
      apiKey: "key-a",
    }),
  );
});

test("resolver persists provider metadata results across instances", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "natalia-context-window-cache-"));
  const cacheFile = join(dir, "context-window-cache.json");
  let calls = 0;
  const input = {
    provider: "openai",
    model: "model-persist",
    baseURL: "https://one.example/v1",
    apiKey: "key-persist",
    providerAdapter: {
      listModels: async () => {
        calls++;
        return [{ id: "model-persist", contextWindow: 77777 }];
      },
    },
  };

  const first = new ContextWindowResolver({ cacheFile });
  const firstResult = await first.resolve(input);
  expect(firstResult.source).toBe("provider_metadata");
  expect(firstResult.tokens).toBe(77777);
  expect(calls).toBe(1);

  const second = new ContextWindowResolver({ cacheFile });
  const secondResult = await second.resolve(input);
  expect(secondResult.source).toBe("provider_metadata");
  expect(secondResult.tokens).toBe(77777);
  expect(calls).toBe(1);
});

test("provider request omits generic max token fields unless explicit or required", () => {
  const omitted = buildProviderRequest({
    model: "x",
    messages: [],
    maxOutputTokens: null,
  });
  expect(omitted.request).not.toHaveProperty("max_tokens");

  const zero = buildProviderRequest({
    model: "x",
    messages: [],
    maxOutputTokens: 0,
  });
  expect(zero.request).not.toHaveProperty("max_tokens");

  const explicit = buildProviderRequest({
    model: "x",
    messages: [],
    maxOutputTokens: 42,
  });
  expect(explicit.request.max_tokens).toBe(42);

  const anthropic = buildProviderRequest({
    model: "claude",
    messages: [],
    providerRequiresOutputLimit: true,
    providerDefaultOutputLimit: 4096,
  });
  expect(anthropic.request.max_tokens).toBe(4096);
  expect(anthropic.outputLimit.kind).toBe("provider-required");
});
