/**
 * Per-endpoint capability declarations, and the single rule that resolves them.
 *
 * The rule: **a capability is on only when the endpoint declares it on.** There
 * are no adapter-level defaults that turn something on. The asymmetry decides
 * it — an undeclared capability that stays off costs one unused optimisation,
 * while one that is wrongly assumed on makes every request fail with a 400 from
 * a parameter the deployment never accepted. Guessing from a model id or a base
 * URL is exactly how that happens.
 *
 * The one thing not gated here is each format's own native caching mechanism:
 * `cache_control` on the Anthropic system block is part of the Messages spec, so
 * the adapter emits it the way it emits `stream: true`. Everything below is an
 * optional extension layered on top of a format, and every one of those is
 * gated.
 */

/** Optional cache-related extensions an endpoint may declare it accepts. */
export interface EndpointCapabilities {
  /**
   * Anthropic: accepts `cache_control.ttl: "1h"`. Long retention is an add-on to
   * the Messages spec, not part of it, so it is never assumed.
   */
  supportsLongCacheRetention?: boolean;
  /**
   * Anthropic: accepts `cache_control` on tool definitions. Added to the spec
   * after tool caching shipped, so conforming endpoints are not obliged to.
   */
  supportsCacheControlOnTools?: boolean;
  /**
   * Anthropic: routes by replica and needs a session-affinity header for the
   * prefix cache to be hit at all. Without it requests are load-balanced across
   * replicas and the cache never lands.
   */
  sendSessionAffinityHeaders?: boolean;
  /** Which affinity header to send; `"openrouter"` means `x-session-id`. */
  sessionAffinityFormat?: "openrouter";
  /**
   * OpenAI families: accepts a session key (`promptCacheKey` /
   * `prompt_cache_key`). An extension rather than part of either spec.
   */
  supportsPromptCacheKey?: boolean;
  /** The field spelling this endpoint uses, so it is never guessed. */
  promptCacheKeyField?: "promptCacheKey" | "prompt_cache_key";
  /**
   * OpenAI Responses only: accepts the newer `prompt_cache_options` shape. The
   * older `prompt_cache_retention` is used when this is off, and the two are
   * never sent together — sending the one an endpoint rejects is a hard 400.
   */
  supportsExplicitPromptCacheMode?: boolean;
}

/**
 * Every capability resolved to a definite value.
 *
 * Written out rather than derived with a mapped type: the two string fields stay
 * optional because "no spelling declared" is a real state, while every flag
 * becomes a plain boolean so a caller never has to remember what an absent one
 * means.
 */
export interface ResolvedEndpointCapabilities {
  readonly supportsLongCacheRetention: boolean;
  readonly supportsCacheControlOnTools: boolean;
  readonly sendSessionAffinityHeaders: boolean;
  readonly sessionAffinityFormat?: "openrouter";
  readonly supportsPromptCacheKey: boolean;
  readonly promptCacheKeyField?: "promptCacheKey" | "prompt_cache_key";
  readonly supportsExplicitPromptCacheMode: boolean;
}

/**
 * Resolve declared capabilities into definite values.
 *
 * Every flag defaults to `false` and every string to `undefined`, so a caller
 * that reads the resolved value never has to remember which fields are optional
 * and what an absent one means. Spreading an undeclared object is therefore
 * equivalent to declaring nothing, which is the safe case.
 */
export function resolveEndpointCapabilities(
  declared: EndpointCapabilities | undefined,
): ResolvedEndpointCapabilities {
  return {
    supportsLongCacheRetention: declared?.supportsLongCacheRetention ?? false,
    supportsCacheControlOnTools: declared?.supportsCacheControlOnTools ?? false,
    sendSessionAffinityHeaders: declared?.sendSessionAffinityHeaders ?? false,
    sessionAffinityFormat: declared?.sessionAffinityFormat,
    supportsPromptCacheKey: declared?.supportsPromptCacheKey ?? false,
    promptCacheKeyField: declared?.promptCacheKeyField,
    supportsExplicitPromptCacheMode:
      declared?.supportsExplicitPromptCacheMode ?? false,
  };
}

/**
 * How long an endpoint's prompt cache should be retained.
 *
 * A preference rather than a capability: it says what the caller wants, while
 * `supportsLongCacheRetention` says what the deployment accepts. Asking for more
 * than an endpoint supports degrades to what it does support, because the
 * request still has to go out.
 */
export type CacheRetention = "none" | "short" | "long";

/** Default retention: the provider's own short window. */
export const DEFAULT_CACHE_RETENTION: CacheRetention = "short";

/**
 * The cache-control marker to send, or `undefined` to send none.
 *
 * `none` opts out entirely — a legitimate choice when diagnosing whether the
 * cache is what is slow. `long` is only honoured when the endpoint declared it
 * accepts long retention; otherwise it degrades to `short` rather than sending a
 * `ttl` the deployment rejects.
 */
export function anthropicCacheControl(input: {
  retention: CacheRetention;
  supportsLongCacheRetention: boolean;
}): { type: "ephemeral"; ttl?: "1h" } | undefined {
  if (input.retention === "none") return undefined;
  if (input.retention === "long" && input.supportsLongCacheRetention)
    return { type: "ephemeral", ttl: "1h" };
  return { type: "ephemeral" };
}
