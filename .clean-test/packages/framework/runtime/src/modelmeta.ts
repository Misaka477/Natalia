import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ContextWindowSource =
  | "config"
  | "provider_metadata"
  | "provider_detail"
  | "models_dev"
  | "known_catalog"
  | "fallback";

function keyIdentity(apiKey?: string) {
  if (!apiKey) return "no-key";
  return new Bun.CryptoHasher("sha256")
    .update(apiKey)
    .digest("hex")
    .slice(0, 12);
}

export type ContextWindowConfidence = "high" | "medium" | "low";

export type ContextWindowResolution = {
  tokens: number;
  source: ContextWindowSource;
  confidence: ContextWindowConfidence;
  detectedAt: string;
  expiresAt: string;
  ttlMs: number;
  diagnostic: string;
  maxOutputTokens?: number;
};

export type ModelMetadataProvider = {
  listModels?(): Promise<
    Array<{
      id: string;
      contextWindow?: number;
      inputTokenLimit?: number;
      maxOutputTokens?: number;
    }>
  >;
  modelDetail?(model: string): Promise<
    | {
        contextWindow?: number;
        inputTokenLimit?: number;
        maxOutputTokens?: number;
      }
    | undefined
  >;
};

export type ResolveContextInput = {
  provider: string;
  model: string;
  baseURL?: string;
  apiKey?: string;
  explicitContextWindow?: number | "auto";
  providerAdapter?: ModelMetadataProvider;
  now?: Date;
  ttlMs?: number;
  useModelsDevCatalog?: boolean;
};

type CacheEntry = ContextWindowResolution;

export class ContextWindowResolver {
  private cache = new Map<string, CacheEntry>();
  private diskCache = new Map<string, CacheEntry>();
  private diskLoaded = false;
  private diskWriteQueue = Promise.resolve();
  private readonly cacheFile?: string;

  constructor(options: { cacheFile?: string } = {}) {
    this.cacheFile = options.cacheFile;
    configureModelsDevCatalogCache(
      options.cacheFile
        ? join(dirname(options.cacheFile), "models-dev-catalog.json")
        : undefined,
    );
  }

  async resolve(input: ResolveContextInput): Promise<ContextWindowResolution> {
    const now = input.now ?? new Date();
    const ttlMs = input.ttlMs ?? 24 * 60 * 60 * 1000;
    if (typeof input.explicitContextWindow === "number") {
      return resolution(
        input.explicitContextWindow,
        "config",
        "high",
        now,
        ttlMs,
        "explicit config context_window",
      );
    }

    const cacheKey = this.cacheKey(input);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.parse(cached.expiresAt) > now.getTime()) return cached;

    if (this.cacheFile && !this.diskLoaded) await this.loadDiskCache();
    const diskCached = this.diskCache.get(cacheKey);
    if (diskCached && Date.parse(diskCached.expiresAt) > now.getTime()) {
      this.cache.set(cacheKey, diskCached);
      return diskCached;
    }

    const fromModels = await this.fromProviderMetadata(input, now, ttlMs);
    if (fromModels) {
      this.cache.set(cacheKey, fromModels);
      await this.persist(cacheKey, fromModels);
      return fromModels;
    }

    const detail = await input.providerAdapter
      ?.modelDetail?.(input.model)
      .catch(() => undefined);
    const detailTokens = detail?.contextWindow ?? detail?.inputTokenLimit;
    if (detailTokens && detailTokens > 0) {
      const result = resolution(
        detailTokens,
        "provider_detail",
        "high",
        now,
        ttlMs,
        "provider model detail context window",
        detail?.maxOutputTokens,
      );
      this.cache.set(cacheKey, result);
      await this.persist(cacheKey, result);
      return result;
    }

    if (input.useModelsDevCatalog) {
      const catalog = await modelsDevModelLimits(input.provider, input.model);
      if (catalog?.contextWindow) {
        const result = resolution(
          catalog.contextWindow,
          "models_dev",
          "medium",
          now,
          ttlMs,
          "Models.dev model catalog context window",
          catalog.maxOutputTokens,
        );
        this.cache.set(cacheKey, result);
        await this.persist(cacheKey, result);
        return result;
      }
    }

    const known = knownModelContextWindow(input.model);
    if (known) {
      const result = resolution(
        known,
        "known_catalog",
        "medium",
        now,
        ttlMs,
        "known-model catalog fallback",
      );
      this.cache.set(cacheKey, result);
      return result;
    }

    const fallback = resolution(
      32_000,
      "fallback",
      "low",
      now,
      ttlMs,
      "conservative fallback; provider metadata unavailable",
    );
    this.cache.set(cacheKey, fallback);
    return fallback;
  }

  private async loadDiskCache() {
    this.diskLoaded = true;
    if (!this.cacheFile) return;
    try {
      const raw = await readFile(this.cacheFile, "utf8");
      const parsed = JSON.parse(raw) as {
        entries?: Record<string, CacheEntry>;
      };
      for (const [key, value] of Object.entries(parsed.entries ?? {}))
        this.diskCache.set(key, value);
    } catch {
      // Cache is best-effort; a missing/corrupt file only costs one probe later.
    }
  }

  private async persist(cacheKey: string, value: CacheEntry) {
    if (!this.cacheFile) return;
    this.diskCache.set(cacheKey, value);
    const snapshot = Object.fromEntries(this.diskCache.entries());
    this.diskWriteQueue = this.diskWriteQueue
      .then(async () => {
        await mkdir(dirname(this.cacheFile!), { recursive: true, mode: 0o700 });
        await writeFile(
          this.cacheFile!,
          `${JSON.stringify({ version: 1, entries: snapshot }, null, 2)}\n`,
          { mode: 0o600 },
        );
      })
      .catch(() => {
        // Never let cache write failures break model resolution.
      });
    await this.diskWriteQueue;
  }

  cacheKey(
    input: Pick<
      ResolveContextInput,
      "provider" | "model" | "baseURL" | "apiKey" | "useModelsDevCatalog"
    >,
  ) {
    return [
      input.provider,
      input.baseURL ?? "default",
      input.model,
      keyIdentity(input.apiKey),
      input.useModelsDevCatalog ? "models-dev" : "local-only",
    ].join("|");
  }

  private async fromProviderMetadata(
    input: ResolveContextInput,
    now: Date,
    ttlMs: number,
  ) {
    const models = await input.providerAdapter
      ?.listModels?.()
      .catch(() => undefined);
    const item = models?.find((candidate) => candidate.id === input.model);
    const tokens = item?.contextWindow ?? item?.inputTokenLimit;
    if (!tokens || tokens <= 0) return undefined;
    return resolution(
      tokens,
      "provider_metadata",
      "high",
      now,
      ttlMs,
      "provider /models metadata context window",
      item?.maxOutputTokens,
    );
  }
}

export function knownModelContextWindow(model: string) {
  const normalized = model.toLowerCase();
  if (normalized.includes("gpt-5.5")) return 200_000;
  if (normalized.includes("gpt-5")) return 400_000;
  if (normalized.includes("gpt-4.1")) return 1_000_000;
  if (normalized.includes("gpt-4o")) return 128_000;
  if (normalized.includes("o1") || normalized.includes("o3")) return 200_000;
  if (normalized.includes("claude")) return 200_000;
  if (normalized.includes("gemini") && normalized.includes("2.5"))
    return 1_048_576;
  if (normalized.includes("gemini") && normalized.includes("1.5"))
    return 1_000_000;
  return undefined;
}

export function knownModelOutputLimit(model: string) {
  const normalized = model.toLowerCase();
  if (normalized.includes("gpt-5")) return 128_000;
  if (normalized.includes("gpt-4.1")) return 32_768;
  if (normalized.includes("gpt-4o")) return 16_384;
  if (normalized.includes("claude")) return 64_000;
  if (normalized.includes("gemini") && normalized.includes("2.5"))
    return 65_536;
  return undefined;
}

export const CONSERVATIVE_MODEL_LIMIT_FALLBACK = 32_000;

export type ModelLimitsMetadata = {
  contextWindow?: number;
  inputTokenLimit?: number;
  maxOutputTokens?: number;
};

let modelsDevCache:
  | { expiresAt: number; value: Record<string, ModelsDevProvider> }
  | undefined;
let modelsDevPending: Promise<Record<string, ModelsDevProvider>> | undefined;
let modelsDevCacheFile: string | undefined;

function configureModelsDevCatalogCache(cacheFile: string | undefined) {
  modelsDevCacheFile = cacheFile;
}

type ModelsDevProvider = {
  name?: string;
  models?: Record<
    string,
    {
      id?: string;
      limit?: { context?: number; input?: number; output?: number };
    }
  >;
};

export async function modelsDevModelLimits(
  provider: string,
  model: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelLimitsMetadata | undefined> {
  const catalog = await loadModelsDevCatalog(fetchImpl).catch(() => undefined);
  if (!catalog) return undefined;
  const candidates = Object.entries(catalog).flatMap(([providerID, item]) => {
    const entry = item.models?.[model];
    if (!entry?.limit) return [];
    const providerText = `${providerID} ${item.name ?? ""}`.toLowerCase();
    const providerWords = provider
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((word) => word.length > 2 && word !== "compatible");
    return [
      {
        providerID,
        score: providerWords.filter((word) => providerText.includes(word))
          .length,
        limit: entry.limit,
      },
    ];
  });
  if (!candidates.length) return undefined;
  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.providerID.localeCompare(right.providerID),
  );
  const selected = candidates[0]!.limit;
  return {
    contextWindow: positiveNumber(selected.context),
    inputTokenLimit: positiveNumber(selected.input),
    maxOutputTokens: positiveNumber(selected.output),
  };
}

async function loadModelsDevCatalog(fetchImpl: typeof fetch) {
  if (fetchImpl !== fetch) {
    const response = await fetchImpl("https://models.dev/api.json", {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok)
      throw new Error(`Models.dev catalog request failed (${response.status})`);
    return (await response.json()) as Record<string, ModelsDevProvider>;
  }
  const now = Date.now();
  if (modelsDevCache && modelsDevCache.expiresAt > now)
    return modelsDevCache.value;
  if (modelsDevCacheFile) {
    try {
      const raw = await readFile(modelsDevCacheFile, "utf8");
      const parsed = JSON.parse(raw) as {
        expiresAt: number;
        value: Record<string, ModelsDevProvider>;
      };
      if (parsed.expiresAt > now) {
        modelsDevCache = parsed;
        return parsed.value;
      }
    } catch {
      // Corrupt/missing catalog cache costs one network fetch.
    }
  }
  if (!modelsDevPending) {
    modelsDevPending = fetchImpl("https://models.dev/api.json", {
      signal: AbortSignal.timeout(3_000),
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            `Models.dev catalog request failed (${response.status})`,
          );
        return (await response.json()) as Record<string, ModelsDevProvider>;
      })
      .then(async (value) => {
        const next = {
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          value,
        };
        modelsDevCache = next;
        if (modelsDevCacheFile) {
          try {
            await mkdir(dirname(modelsDevCacheFile), {
              recursive: true,
              mode: 0o700,
            });
            await writeFile(
              modelsDevCacheFile,
              `${JSON.stringify(next, null, 2)}\n`,
              { mode: 0o600 },
            );
          } catch {
            // Catalog cache write failure must not break model resolution.
          }
        }
        return value;
      })
      .catch(() => {
        const value: Record<string, ModelsDevProvider> = {};
        modelsDevCache = { expiresAt: Date.now() + 5 * 60 * 1000, value };
        return value;
      })
      .finally(() => {
        modelsDevPending = undefined;
      });
  }
  return await modelsDevPending;
}

function positiveNumber(value: unknown) {
  return typeof value === "number" && value > 0 ? value : undefined;
}

function resolution(
  tokens: number,
  source: ContextWindowSource,
  confidence: ContextWindowConfidence,
  now: Date,
  ttlMs: number,
  diagnostic: string,
  maxOutputTokens?: number,
): ContextWindowResolution {
  return {
    tokens,
    source,
    confidence,
    detectedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    ttlMs,
    diagnostic,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}
