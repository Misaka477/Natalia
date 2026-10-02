/**
 * The built-in wire-format adapters.
 *
 * Registration is lazy rather than an import side effect: importing this
 * package's index must not install adapters, or a test that wants an empty
 * registry would have to know which module to avoid.
 * {@link ensureBuiltinProviderAdapters} fills whatever is missing on first use,
 * so every caller — production and test alike — gets a working registry without
 * arranging an import order, and a suite that cleared the registry heals on its
 * next call.
 *
 * A custom adapter reaches the same registry through `registerProviderAdapter`
 * with its own format string, so adding one does not require editing this file.
 */

import {
  AnthropicProvider,
  GeminiProvider,
  OpenAICompatibleProvider,
  OpenAIResponsesProvider,
  type AnthropicProviderOptions,
  type GeminiProviderOptions,
  type OpenAICompatibleProviderOptions,
  type OpenAIResponsesProviderOptions,
} from "./provider";
import {
  getProviderAdapter,
  registerProviderAdapter,
  type AnyProviderAdapter,
  type ProviderAdapter,
  type ProviderFormat,
} from "./provider-adapters";

const openAIChatAdapter: ProviderAdapter<OpenAICompatibleProviderOptions> = {
  format: "openai-chat",
  create: (options) => new OpenAICompatibleProvider(options),
};

const anthropicMessagesAdapter: ProviderAdapter<AnthropicProviderOptions> = {
  format: "anthropic-messages",
  create: (options) => new AnthropicProvider(options),
};

const openAIResponsesAdapter: ProviderAdapter<OpenAIResponsesProviderOptions> =
  {
    format: "openai-responses",
    create: (options) => new OpenAIResponsesProvider(options),
  };

/**
 * Gemini is registered only because the adapter exists and its tests exercise
 * it. It is not a supported target: the product's families are OpenAI chat,
 * OpenAI responses and Anthropic messages.
 */
const geminiAdapter: ProviderAdapter<GeminiProviderOptions> = {
  format: "google-generative-ai",
  create: (options) => new GeminiProvider(options),
};

/**
 * Every built-in adapter, in the order they register.
 *
 * Method-syntax bivariance lets each specific adapter sit in a list typed by
 * the common base without a cast at every entry.
 */
export const BUILTIN_PROVIDER_ADAPTERS: readonly AnyProviderAdapter[] = [
  openAIChatAdapter,
  openAIResponsesAdapter,
  anthropicMessagesAdapter,
  geminiAdapter,
];

/** Every format a built-in adapter covers, for validation and diagnostics. */
export const BUILTIN_PROVIDER_FORMATS: readonly ProviderFormat[] =
  BUILTIN_PROVIDER_ADAPTERS.map((adapter) => adapter.format);

/**
 * Register whatever built-in adapter is missing.
 *
 * Checking the registry instead of remembering whether it ran keeps this
 * idempotent and self-healing: a test that cleared the registry does not need
 * to reset a flag to get the built-ins back.
 */
export function ensureBuiltinProviderAdapters(): void {
  for (const adapter of BUILTIN_PROVIDER_ADAPTERS) {
    if (!getProviderAdapter(adapter.format))
      registerProviderAdapter(adapter, "builtin");
  }
}
