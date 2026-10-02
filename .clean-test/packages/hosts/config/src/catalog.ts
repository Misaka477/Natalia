import {
  configV3Schema,
  modelRefKey,
  parseModelRef,
  type ConfigV3,
  type ModelCapabilities,
  type ModelLimits,
  type ModelOverride,
  type ModelRef,
  type ProviderRequestDefaults,
} from "@anthelia/contracts";
import { evaluateModelPolicy, evaluatePolicy } from "./policy";

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  toolCall: true,
  reasoning: true,
  thinking: true,
  imageInput: false,
  videoInput: false,
};

export type CatalogProviderModel = {
  id: string;
  provider: string;
  name: string;
  capabilities: ModelCapabilities;
  limits: ModelLimits;
  status: "stable" | "experimental" | "deprecated";
  source: "discovery" | "manual";
};

export interface CatalogProvider {
  id: string;
  name: string;
  driver: string;
  configured: boolean;
  models: CatalogProviderModel[];
}

export function buildModelCatalog(config: ConfigV3): CatalogProvider[] {
  return Object.entries(config.providers ?? {})
    .filter(
      ([id, provider]) =>
        provider.enabled &&
        evaluatePolicy(
          config.experimental.policies,
          "provider.use",
          id,
          "allow",
        ) === "allow",
    )
    .map(([id, provider]) => ({
      id,
      name: provider.name,
      driver: provider.driver,
      configured: Boolean(provider.connection?.apiKey),
      models: catalogModelsForProvider(config, id),
    }));
}

function catalogModelsForProvider(
  config: ConfigV3,
  providerID: string,
): CatalogProviderModel[] {
  const catalogModels = config.catalog?.providers?.[providerID]?.models ?? {};
  const overrideKeys = Object.keys(config.modelOverrides ?? {}).filter((key) =>
    key.startsWith(`${providerID}/`),
  );
  const modelIDs = new Set([
    ...Object.keys(catalogModels),
    ...overrideKeys.map((key) => key.slice(providerID.length + 1)),
  ]);
  return [...modelIDs]
    .filter(
      (modelID) =>
        config.modelOverrides[
          modelRefKey({ provider: providerID, model: modelID })
        ]?.enabled !== false,
    )
    .filter(
      (modelID) =>
        evaluateModelPolicy(
          config.experimental.policies,
          providerID,
          modelID,
        ) === "allow",
    )
    .map((modelID) => {
      const catalogModel = catalogModels[modelID];
      const override =
        config.modelOverrides[
          modelRefKey({ provider: providerID, model: modelID })
        ];
      return {
        id: modelID,
        provider: providerID,
        name: override?.name ?? catalogModel?.name ?? modelID,
        capabilities: catalogModel?.capabilities ?? DEFAULT_CAPABILITIES,
        limits: override?.limits ??
          catalogModel?.limits ?? { contextWindow: "auto" },
        status: catalogModel?.status ?? "stable",
        source: catalogModel?.source ?? "manual",
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function discoverProviderModels(
  driver: string,
  baseURL: string,
  apiKey: string,
  customHeaders?: Record<string, string>,
): Promise<string[]> {
  const base = baseURL.trim();
  if (!base)
    throw new Error("Provider base URL is required for model discovery");
  const supported = [
    "openai",
    "openai-compatible",
    "anthropic",
    "anthropic-compatible",
    "gemini",
  ];
  if (!supported.includes(driver))
    throw new Error(
      `Unsupported provider driver for model discovery: ${driver}`,
    );
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error("Provider base URL is invalid for model discovery");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("Provider base URL must use http or https");
  const headers = new Headers(customHeaders);
  const hasCustomAuth = [
    "authorization",
    "x-api-key",
    "api-key",
    "x-goog-api-key",
  ].some((name) => headers.has(name));
  if (!apiKey.trim() && !hasCustomAuth)
    throw new Error("Provider API key is required for model discovery");

  const anthropic = driver === "anthropic" || driver === "anthropic-compatible";
  const gemini = driver === "gemini";
  const endpointPath = parsed.pathname.replace(/\/+$/u, "");
  parsed.pathname = `${gemini || endpointPath ? endpointPath : "/v1"}/models`;
  const url = parsed.toString();
  const hasHeader = (name: string) => headers.has(name);
  if (anthropic) {
    if (apiKey && !hasHeader("x-api-key")) headers.set("x-api-key", apiKey);
    if (!hasHeader("anthropic-version"))
      headers.set("anthropic-version", "2023-06-01");
  } else if (gemini) {
    if (apiKey && !hasHeader("x-goog-api-key"))
      headers.set("x-goog-api-key", apiKey);
  } else if (apiKey && !hasHeader("authorization")) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`Model discovery failed (${response.status})`);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Model discovery returned an invalid response");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("Model discovery returned an invalid response");
    const record = payload as Record<string, unknown>;
    const list = gemini
      ? record.models
      : Array.isArray(record.data)
        ? record.data
        : record.models;
    if (!Array.isArray(list))
      throw new Error("Model discovery returned an invalid response");
    const values = list.map((model) => {
      if (!model || typeof model !== "object" || Array.isArray(model))
        throw new Error("Model discovery returned an invalid response");
      const item = model as Record<string, unknown>;
      const value = gemini ? (item.name ?? item.id) : (item.id ?? item.name);
      if (typeof value !== "string")
        throw new Error("Model discovery returned an invalid response");
      return value.trim().replace(/^models\//u, "");
    });
    return [
      ...new Set(values.filter((value): value is string => value.length > 0)),
    ].sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Model discovery timed out");
    if (error instanceof Error && error.message.startsWith("Model discovery"))
      throw error;
    throw new Error("Model discovery request failed");
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Configures a provider and imports one or more models into the catalog.
 *
 * Discovery or manual import both land in `catalog.providers[providerID].models`;
 * model overrides are never touched, so existing user intent (enabled, name,
 * request tuning) survives re-import. A missing default model is set to the
 * first imported model; an existing default is preserved.
 */
export function configureProviderModels(
  config: ConfigV3,
  input: {
    providerID: string;
    providerName?: string;
    driver: string;
    baseURL?: string;
    apiKey?: string;
    authHeader?: string;
    requestDefaults?: Partial<ProviderRequestDefaults>;
    source: "discovery" | "manual";
    modelIDs: string[];
  },
): ConfigV3 {
  const providerID = input.providerID.trim();
  if (!providerID) throw new Error("Provider ID is required");
  if (!input.driver.trim()) throw new Error("Provider driver is required");
  if (input.source === "discovery" && !input.apiKey?.trim())
    throw new Error("Provider API key is required for discovery");
  const baseURL = input.baseURL?.trim().replace(/\/+$/u, "");
  const modelIDs = [
    ...new Set(input.modelIDs.map((id) => id.trim()).filter(Boolean)),
  ];
  if (!modelIDs.length) throw new Error("At least one model ID is required");

  const existing = config.providers[providerID];
  const existingModels = config.catalog?.providers?.[providerID]?.models ?? {};

  return configV3Schema.parse({
    ...config,
    providers: {
      ...config.providers,
      [providerID]: {
        name: input.providerName?.trim() || existing?.name || providerID,
        driver: input.driver,
        enabled: existing?.enabled ?? true,
        connection: {
          baseURL: baseURL || existing?.connection?.baseURL,
          apiKey: input.apiKey?.trim() || existing?.connection?.apiKey,
          authHeader:
            input.authHeader?.trim() || existing?.connection?.authHeader,
        },
        requestDefaults: {
          stream:
            input.requestDefaults?.stream ??
            existing?.requestDefaults?.stream ??
            true,
          headers: {
            ...(existing?.requestDefaults?.headers ?? {}),
            ...(input.requestDefaults?.headers ?? {}),
          },
          options: {
            ...(existing?.requestDefaults?.options ?? {}),
            ...(input.requestDefaults?.options ?? {}),
          },
        },
      },
    },
    catalog: {
      ...config.catalog,
      providers: {
        ...config.catalog?.providers,
        [providerID]: {
          models: {
            ...existingModels,
            ...Object.fromEntries(
              modelIDs
                .filter((modelID) => !(modelID in existingModels))
                .map((modelID) => [
                  modelID,
                  {
                    name: modelID,
                    capabilities: { ...DEFAULT_CAPABILITIES },
                    limits: { contextWindow: "auto" },
                    status: "stable",
                    source: input.source,
                  },
                ]),
            ),
          },
        },
      },
    },
    defaultModel: config.defaultModel ?? {
      provider: providerID,
      model: modelIDs[0]!,
    },
  });
}

export type EffectiveModel = {
  ref: ModelRef;
  key: string;
  providerID: string;
  providerName: string;
  driver: string;
  name: string;
  enabled: boolean;
  capabilities: ModelCapabilities;
  limits: ModelLimits;
  status: "stable" | "experimental" | "deprecated";
  source: "discovery" | "manual";
  override?: ModelOverride;
  requestDefaults: {
    temperature: number | null;
    topP: number | null;
    stream: boolean;
    thinkingEnabled: boolean;
    headers: Record<string, string>;
    options: Record<string, unknown>;
  };
};

/**
 * Resolves the effective model: catalog facts merged under user overrides and
 * the provider's connection-level request defaults. Returns undefined when the
 * provider is unknown.
 */
export function resolveEffectiveModel(
  config: ConfigV3,
  ref: ModelRef | string,
): EffectiveModel | undefined {
  const modelRef = typeof ref === "string" ? parseModelRef(ref) : ref;
  const provider = config.providers[modelRef.provider];
  if (!provider) return undefined;
  const key = modelRefKey(modelRef);
  const catalogModel =
    config.catalog?.providers?.[modelRef.provider]?.models?.[modelRef.model];
  const override = config.modelOverrides[key];
  if (!catalogModel && !override) return undefined;
  return {
    ref: modelRef,
    key,
    providerID: modelRef.provider,
    providerName: provider.name,
    driver: provider.driver,
    name: override?.name ?? catalogModel?.name ?? modelRef.model,
    enabled:
      override?.enabled !== undefined
        ? override.enabled
        : catalogModel !== undefined,
    capabilities: catalogModel?.capabilities ?? DEFAULT_CAPABILITIES,
    limits: override?.limits ??
      catalogModel?.limits ?? { contextWindow: "auto" },
    status: catalogModel?.status ?? "stable",
    source: catalogModel?.source ?? "manual",
    override,
    requestDefaults: {
      temperature: override?.requestDefaults.temperature ?? null,
      topP: override?.requestDefaults.topP ?? null,
      stream:
        override?.requestDefaults.stream ?? provider.requestDefaults.stream,
      thinkingEnabled: override?.requestDefaults.thinkingEnabled ?? true,
      headers: {
        ...provider.requestDefaults.headers,
        ...override?.headers,
      },
      options: {
        ...provider.requestDefaults.options,
        ...override?.requestOptions,
      },
    },
  };
}
