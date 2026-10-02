import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BUILTIN_PROVIDER_ADAPTERS,
  BUILTIN_PROVIDER_FORMATS,
  ensureBuiltinProviderAdapters,
} from "../src/builtin-provider-adapters";
import {
  clearProviderAdapters,
  getProviderAdapter,
  providerFromKind,
  providerAdapterFormats,
  providerFormatFromDriver,
  resolveEndpointProtocol,
  registerProviderAdapter,
  unregisterProviderAdapters,
  type ProviderAdapter,
  type ProviderAdapterOptions,
} from "../src";

/** A stand-in adapter that records the options it was built with. */
function fakeAdapter(format: string): ProviderAdapter<ProviderAdapterOptions> {
  return {
    format,
    create: (options) =>
      ({
        provider: options.provider ?? format,
        model: options.model,
        async *stream() {
          yield { type: "done" as const };
        },
      }) as never,
  };
}

// The registry is process-global, so another suite's registrations are visible
// here. Each test starts from an empty one and installs what it needs.
beforeEach(() => {
  clearProviderAdapters();
});

afterEach(() => {
  clearProviderAdapters();
});

describe("provider adapter registry", () => {
  test("resolves an adapter by its declared format", () => {
    registerProviderAdapter(fakeAdapter("my-format"), "plugin-a");

    expect(getProviderAdapter("my-format")?.format).toBe("my-format");
    expect(providerAdapterFormats()).toEqual(["my-format"]);
  });

  test("refuses a second adapter for a format already held", () => {
    registerProviderAdapter(fakeAdapter("dup"), "plugin-a");

    // Two adapters claiming one format means one of them can never run, and
    // whichever request it would have served fails somewhere else entirely.
    expect(() =>
      registerProviderAdapter(fakeAdapter("dup"), "plugin-b"),
    ).toThrow(/already registered by "plugin-a"/);
  });

  test("an adapter whose format is free may register after the incumbent left", () => {
    const dispose = registerProviderAdapter(fakeAdapter("swap"), "plugin-a");
    dispose();
    registerProviderAdapter(fakeAdapter("swap"), "plugin-b");

    expect(getProviderAdapter("swap")).toBeDefined();
  });

  test("withdraws every adapter a source registered, and only those", () => {
    registerProviderAdapter(fakeAdapter("a-one"), "plugin-a");
    registerProviderAdapter(fakeAdapter("a-two"), "plugin-a");
    registerProviderAdapter(fakeAdapter("b-one"), "plugin-b");

    unregisterProviderAdapters("plugin-a");

    expect(providerAdapterFormats()).toEqual(["b-one"]);
  });

  test("a disposer removes only its own registration", () => {
    const disposeA = registerProviderAdapter(fakeAdapter("shared"), "plugin-a");
    disposeA();
    // The slot is free again, so a fresh registration must survive the stale
    // disposer being run twice.
    registerProviderAdapter(fakeAdapter("shared"), "plugin-b");
    disposeA();

    expect(getProviderAdapter("shared")).toBeDefined();
  });

  test("an unknown format resolves to nothing rather than a default", () => {
    // No silent fallback: a caller that guesses would send the wrong wire
    // shape and fail far from the cause.
    expect(getProviderAdapter("nope")).toBeUndefined();
  });

  test("accepts a specific-options adapter without a cast", () => {
    // Anthropic's adapter takes `thinkingBudgetTokens`, which the base options
    // do not declare. Method-syntax bivariance on `create` is what lets it be
    // registered — and held in a base-typed list — with no cast; a
    // property-style `create` would have forced one at every site.
    // `builtin-provider-adapters.ts` compiles as the proof.
    const anthropic = BUILTIN_PROVIDER_ADAPTERS.find(
      (adapter) => adapter.format === "anthropic-messages",
    );
    expect(anthropic).toBeDefined();
    expect(anthropic!.format).toBe("anthropic-messages");
  });

  test("the registry view widens options to the common base", () => {
    // A consequence of storing adapters by format: the lookup type is the base,
    // so a format-specific field cannot be passed through the registry. That is
    // deliberate — the registry is the crossing point, and a caller that needs
    // `thinkingBudgetTokens` resolves the adapter itself rather than widening
    // the shared contract for one format.
    registerProviderAdapter(fakeAdapter("base-only"), "plugin-a");
    const adapter = getProviderAdapter("base-only")!;

    // The excess field is not part of the contract, so it is neither accepted
    // by the type nor honoured by the adapter.
    const built = adapter.create({ apiKey: "k", model: "m" });
    expect(built.model).toBe("m");
  });
});

describe("built-in adapters", () => {
  test("registers on first use and is idempotent", () => {
    ensureBuiltinProviderAdapters();
    const first = providerAdapterFormats();
    ensureBuiltinProviderAdapters();

    expect(providerAdapterFormats()).toEqual(first);
  });

  test("heals after the registry was cleared", () => {
    ensureBuiltinProviderAdapters();
    clearProviderAdapters();
    expect(providerAdapterFormats()).toEqual([]);

    ensureBuiltinProviderAdapters();

    expect(providerAdapterFormats().length).toBe(
      BUILTIN_PROVIDER_ADAPTERS.length,
    );
  });

  test("covers the three supported families plus Gemini for its tests", () => {
    ensureBuiltinProviderAdapters();

    expect([...BUILTIN_PROVIDER_FORMATS].sort()).toEqual([
      "anthropic-messages",
      "google-generative-ai",
      "openai-chat",
      "openai-responses",
    ]);
    for (const format of BUILTIN_PROVIDER_FORMATS)
      expect(getProviderAdapter(format)).toBeDefined();
  });

  test("each built-in builds a provider for its own endpoint", () => {
    ensureBuiltinProviderAdapters();

    for (const format of BUILTIN_PROVIDER_FORMATS) {
      const built = getProviderAdapter(format)!.create({
        apiKey: "k",
        model: `model-for-${format}`,
      });
      expect(built.model).toBe(`model-for-${format}`);
    }
  });
});

describe("providerFormatFromDriver", () => {
  test("maps the config catalog's driver vocabulary onto formats", () => {
    expect(providerFormatFromDriver("anthropic")).toBe("anthropic-messages");
    expect(providerFormatFromDriver("anthropic-compatible")).toBe(
      "anthropic-messages",
    );
    expect(providerFormatFromDriver("openai")).toBe("openai-chat");
    expect(providerFormatFromDriver("openai-compatible")).toBe("openai-chat");
    expect(providerFormatFromDriver("gemini")).toBe("google-generative-ai");
  });

  test("an unrecognised driver resolves to the OpenAI family", () => {
    // An unknown name is far more likely to be an OpenAI-compatible endpoint
    // than an Anthropic-shaped one, and this is the only name-based guess left
    // in the seam.
    expect(providerFormatFromDriver("some-random-thing")).toBe("openai-chat");
    expect(providerFormatFromDriver(undefined)).toBe("openai-chat");
  });
});

describe("resolveEndpointProtocol", () => {
  test("a declared format wins over whatever the driver suggests", () => {
    // The whole point of the seam: `"claude-via-openrouter"` must not become an
    // Anthropic request just because its name contains "claude".
    const resolved = resolveEndpointProtocol({
      driver: "claude-via-openrouter",
      protocol: { format: "openai-chat" },
    });

    expect(resolved).toEqual({ format: "openai-chat", declared: true });
  });

  test("a driver that reads as Anthropic is overridden by a declared format", () => {
    const resolved = resolveEndpointProtocol({
      driver: "openai-anthropic-gateway",
      protocol: { format: "openai-responses" },
    });

    expect(resolved.format).toBe("openai-responses");
    expect(resolved.declared).toBe(true);
  });

  test("an absent declaration is inferred and reported as undeclared", () => {
    const resolved = resolveEndpointProtocol({ driver: "anthropic" });

    expect(resolved.format).toBe("anthropic-messages");
    expect(resolved.declared).toBe(false);
  });

  test("a blank declaration counts as absent", () => {
    // A whitespace-only value is a typo, not a format name; treating it as
    // declared would register nothing under it and fail at dispatch.
    const resolved = resolveEndpointProtocol({
      driver: "openai",
      protocol: { format: "   " },
    });

    expect(resolved.format).toBe("openai-chat");
    expect(resolved.declared).toBe(false);
  });

  test("an unnamed endpoint still resolves rather than throwing", () => {
    const resolved = resolveEndpointProtocol({});

    expect(resolved.format).toBe("openai-chat");
    expect(resolved.declared).toBe(false);
  });

  test("the inferred value is what dispatch would use, for every driver", () => {
    // The resolver and the registry must agree, or a config that loads would
    // still fail to find its adapter.
    ensureBuiltinProviderAdapters();
    for (const driver of [
      "anthropic",
      "anthropic-compatible",
      "openai",
      "openai-compatible",
      "gemini",
      "something-else",
    ]) {
      const { format } = resolveEndpointProtocol({ driver });
      expect(getProviderAdapter(format)).toBeDefined();
    }
  });
});

describe("providerFromKind dispatch", () => {
  test("dispatches on the declared format, not on the driver name", () => {
    // End-to-end proof of the seam: a name that reads as Anthropic, with a
    // declared OpenAI format, must produce a provider that speaks OpenAI. The
    // old name-substring path sent Anthropic headers here and failed with 400.
    const provider = providerFromKind({
      apiKey: "k",
      model: "gpt-test",
      providerName: "claude-via-openrouter",
      provider: "claude-via-openrouter",
      format: "openai-chat",
    });

    expect(provider.provider).toBe("claude-via-openrouter");
    expect(provider.model).toBe("gpt-test");
  });

  test("dispatches to Anthropic when the driver says so and nothing is declared", () => {
    const provider = providerFromKind({
      apiKey: "k",
      model: "claude-test",
      providerName: "anthropic",
      provider: "anthropic",
    });

    expect(provider.provider).toBe("anthropic");
    expect(provider.model).toBe("claude-test");
  });

  test("an unregistered declared format fails loudly instead of falling back", () => {
    // Silently degrading to OpenAI would send the wrong wire shape and fail
    // somewhere far from the cause.
    expect(() =>
      providerFromKind({
        apiKey: "k",
        model: "m",
        providerName: "custom",
        provider: "custom",
        format: "no-such-format",
      }),
    ).toThrow(/no provider adapter is registered for format "no-such-format"/);
  });
});
