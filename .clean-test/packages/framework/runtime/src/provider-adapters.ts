/**
 * The provider adapter seam: a format-keyed registry of wire-format adapters.
 *
 * Why a registry rather than a name match: the adapter used to be chosen by
 * substring-matching a user-authored `driver` string, so `"claude-via-openrouter"`
 * selected the Anthropic adapter and sent `x-api-key` to an OpenAI endpoint. A
 * declared format removes the guess — the endpoint says which wire format it
 * speaks and the registry resolves that to an adapter, loudly when it cannot.
 *
 * An adapter is a factory, not an instance: one endpoint needs one provider
 * instance carrying its own key, base URL and model, so the registry stores
 * `create` and the caller supplies the per-endpoint options.
 */

import type { StreamingProvider } from "./provider";

/**
 * The wire formats this seam knows by name. A closed list is only an
 * autocomplete affordance: {@link ProviderFormat} stays assignable from any
 * string so a custom adapter can register its own format without editing this
 * package. The `(string & {})` member is what keeps the union from collapsing
 * to `string` and losing completion on the known members.
 */
export type KnownProviderFormat =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages";

/** A wire format: one of the known ones, or a custom adapter's own. */
export type ProviderFormat = KnownProviderFormat | (string & {});

/**
 * The options every adapter needs to build a provider for one endpoint.
 *
 * Each adapter's own options type extends this with its format-specific
 * fields, and the registry keeps them through a generic parameter so the
 * precise type survives at the registration site instead of being flattened
 * into a permissive record.
 */
export interface ProviderAdapterOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  /** Stable identity for this endpoint, used in runtime status and tracing. */
  provider?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
}

/**
 * One registered wire-format adapter.
 *
 * `create` is declared with method syntax on purpose. That makes its parameter
 * bivariant, so an adapter whose options extend the base — Anthropic's
 * `thinkingBudgetTokens`, say — is accepted by the registry without a cast, and
 * a property-style declaration would force one at every registration site.
 */
export interface ProviderAdapter<
  TOptions extends ProviderAdapterOptions = ProviderAdapterOptions,
> {
  /** The wire format this adapter implements. Also its registry key. */
  readonly format: ProviderFormat;
  /** Build a provider for one endpoint. */
  create(options: TOptions): StreamingProvider;
}

/** The registry's stored view: options widened to the common base. */
export type AnyProviderAdapter = ProviderAdapter<ProviderAdapterOptions>;

interface RegisteredAdapter {
  readonly adapter: AnyProviderAdapter;
  /** Who registered it, so a plugin's adapters can be withdrawn together. */
  readonly sourceId?: string;
}

const adapters = new Map<ProviderFormat, RegisteredAdapter>();

/**
 * Register an adapter under its format.
 *
 * A second adapter for a format already held is a programming error, not a
 * precedence rule: two adapters claiming one format means one of them will
 * never run, and the request it would have served fails somewhere else. The
 * caller must unregister the incumbent first.
 *
 * @returns a disposer that removes this registration, and only this one.
 */
export function registerProviderAdapter(
  adapter: AnyProviderAdapter,
  sourceId?: string,
): () => void {
  const existing = adapters.get(adapter.format);
  if (existing)
    throw new Error(
      `provider adapter format "${adapter.format}" is already registered` +
        `${existing.sourceId ? ` by "${existing.sourceId}"` : ""}; ` +
        `unregister it first`,
    );
  adapters.set(adapter.format, { adapter, sourceId });
  return () => {
    if (adapters.get(adapter.format)?.adapter === adapter)
      adapters.delete(adapter.format);
  };
}

/**
 * Withdraw every adapter registered under one source id.
 *
 * This is how a plugin unloading, or a hot reload, releases what it installed:
 * without it a reloaded plugin would collide with its own previous
 * registration and fail to start.
 */
export function unregisterProviderAdapters(sourceId: string): void {
  for (const [format, entry] of adapters) {
    if (entry.sourceId === sourceId) adapters.delete(format);
  }
}

/** The adapter for a format, or `undefined` when none is registered. */
export function getProviderAdapter(
  format: ProviderFormat,
): AnyProviderAdapter | undefined {
  return adapters.get(format)?.adapter;
}

/** Every registered format, in registration order. */
export function providerAdapterFormats(): ProviderFormat[] {
  return [...adapters.keys()];
}

/** Test seam: drop every registration so a suite starts from a known state. */
export function clearProviderAdapters(): void {
  adapters.clear();
}

/**
 * Map a `driver` string onto a wire format.
 *
 * This is the only place that infers a format from a name. Every mapping here
 * is a guess about what a human meant to type, which is why the seam it feeds is
 * a registry keyed by declared format: once an endpoint declares
 * `protocol.format`, this runs only for entries that have not been updated yet,
 * and each such run says so out loud through {@link resolveEndpointProtocol}.
 *
 * The known driver vocabulary comes from the config catalog's discovery
 * allowlist, so the two cannot drift into accepting different names.
 */
export function providerFormatFromDriver(
  driver: string | undefined,
): ProviderFormat {
  const kind = (driver ?? "").toLowerCase();
  if (kind.includes("anthropic") || kind.includes("claude"))
    return "anthropic-messages";
  if (kind.includes("gemini") || kind.includes("google"))
    return "google-generative-ai";
  // `openai`, `openai-compatible`, and anything unrecognised: the OpenAI
  // families are the default because an unknown name is far more likely to be
  // an OpenAI-compatible endpoint than an Anthropic-shaped one.
  return "openai-chat";
}

/** What an endpoint's configuration resolved to, after inference if needed. */
export interface ResolvedEndpointProtocol {
  /** The wire format to dispatch on. */
  readonly format: ProviderFormat;
  /** False when the format was inferred from `driver` rather than declared. */
  readonly declared: boolean;
}

/**
 * Normalise an endpoint's protocol declaration into the format to dispatch on.
 *
 * This is the single place that infers a format from a name, and it is the seam
 * between configuration and dispatch: everything downstream receives a
 * {@link ResolvedEndpointProtocol} and never sees the ambiguity. Inferring here
 * rather than making the field mandatory is a data-migration concern, not an
 * incomplete feature — the resolved value is what the rest of the code consumes
 * either way, and the warning names the exact JSON that removes the guess.
 *
 * A declared format always wins. An absent one is inferred and reported, because
 * a silent guess is how `"claude-via-openrouter"` ends up sending Anthropic
 * headers to an OpenAI endpoint.
 */
export function resolveEndpointProtocol(input: {
  driver?: string | undefined;
  protocol?: { format?: string | undefined } | undefined;
}): ResolvedEndpointProtocol {
  const declared = input.protocol?.format?.trim();
  if (declared) return { format: declared, declared: true };
  const format = providerFormatFromDriver(input.driver);
  console.warn(
    `[providers] endpoint "${input.driver ?? "(unnamed)"}" declares no ` +
      `protocol.format; inferring "${format}" from its driver. Declare it so ` +
      `the adapter is chosen by declaration rather than by a name guess:\n` +
      `  "protocol": { "format": "${format}" }`,
  );
  return { format, declared: false };
}
