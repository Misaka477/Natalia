import type { UiAdapterMountInput } from "@anthelia/contracts";
import type { RuntimeTool } from "@anthelia/tools";
import type { PluginManifest } from "./manifest";

export type PluginConfigIssue = {
  message: string;
  path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
};

export type PluginConfigValidation = {
  value?: unknown;
  issues?: ReadonlyArray<PluginConfigIssue>;
};

export type PluginConfigSchema = {
  "~standard": {
    validate(
      value: unknown,
    ): PluginConfigValidation | Promise<PluginConfigValidation>;
  };
};

export type PluginAudit = {
  pluginID: string;
  action: "loaded" | "unloaded" | "denied" | "failed";
  detail?: string;
  timestamp: number;
};

export type Plugin = {
  manifest: PluginManifest;
  configSchema?: PluginConfigSchema;
  setup(api: PluginAPI): void | Promise<void>;
  dispose?(): void | Promise<void>;
};

/**
 * The plugin-facing cache kind — the engine fabric's law 1 (only
 * explicitly classified deterministic work may register), declared
 * structurally so the plugin kernel never depends on the engine's
 * fabric module. `deterministic: true` is a typed promise, not a
 * boolean a plugin can flip: a clock-reading or sampling "cache" is
 * not a cache.
 */
export type PluginCacheKind = {
  readonly id: string;
  readonly deterministic: true;
  /** `path` kinds revalidate evidence per hit; `tree` kinds drop on any write. */
  readonly invalidation: "path" | "tree";
  /** Both hooks or neither: a capture without a validator freezes values forever. */
  readonly captureEvidence?: (key: string) => unknown | Promise<unknown>;
  readonly validEvidence?: (
    evidence: unknown,
    key: string,
  ) => boolean | Promise<boolean>;
  /** How much budget an entry costs; strings count their UTF-8 bytes. */
  readonly sizeOf?: (value: unknown) => number;
};

/** Per-kind cost observability, the fabric's platform principle. */
export type PluginCacheMetrics = {
  hits: number;
  misses: number;
  invalidations: number;
  evictions: number;
  entries: number;
  bytes: number;
  bytesServed: number;
};

/**
 * The cache port (`ctx.cache`): a plugin that caches calls this and
 * NEVER hand-rolls a Map+TTL — a self-maintained cache misses the
 * invalidation discipline (writes), the metrics, and the generation
 * scope, which is exactly the RINA study's admission rule. Optional
 * on the type by the freshness gate (additions enter optional; the
 * natalia runtime always provides it — the `runtimeConfig` pattern),
 * gated by the `cache` integration point at activation.
 */
export type PluginCachePort = {
  /** Register a kind; the disposer unregisters it and drops its entries. */
  registerKind(kind: PluginCacheKind): () => void;
  /** Look up `key`, else run `compute` once (single-flight). Unknown kinds throw. */
  compute<T>(
    kindID: string,
    key: string,
    compute: () => T | Promise<T>,
  ): Promise<T>;
  metrics(kindID?: string): Record<string, PluginCacheMetrics>;
};

export type PluginAPI = {
  config: unknown;
  runtimeConfig?: () => unknown;
  tools: {
    register(tool: RuntimeTool): () => void;
    registerAlias(alias: string, target: string): () => void;
  };
  services: {
    provide(name: string, value: unknown): () => void;
    get<T>(name: string): T | undefined;
    on<T>(name: string, listener: (value: T | undefined) => void): () => void;
  };
  events: {
    on(listener: (event: unknown) => void): () => void;
    on(type: string, listener: (event: unknown) => void): () => void;
  };
  commands: { register(command: PluginCommand): () => void };
  resources: PluginNamedContributionRegistry;
  projections: PluginNamedContributionRegistry;
  workflows: PluginNamedContributionRegistry;
  settingsSchema: PluginNamedContributionRegistry;
  adapters: PluginAdapterContributionRegistry;
  scheduler: { add(job: PluginNamedContribution): () => void };
  effects: {
    signal: AbortSignal;
    run<T>(effect: (signal: AbortSignal) => Promise<T>): Promise<T>;
  };
  cache?: PluginCachePort;
};

export type PluginNamedContribution = { name: string; [key: string]: unknown };
export type PluginNamedContributionRegistry = {
  register(contribution: PluginNamedContribution): () => void;
};
export type PluginAdapterInstance = { dispose(): void | Promise<void> };
export type PluginAdapterContribution<
  Context = unknown,
  Instance extends PluginAdapterInstance = PluginAdapterInstance,
> = PluginNamedContribution & {
  adapterType: string;
  create(context: Context): Instance | Promise<Instance>;
};
export type PluginAdapterContributionRegistry = {
  register<Context, Instance extends PluginAdapterInstance>(
    contribution: PluginAdapterContribution<Context, Instance>,
  ): () => void;
  registerUi(contribution: PluginUiAdapterContribution): () => void;
};
export type PluginUiAdapterContribution = {
  kind: string;
  mount(input: UiAdapterMountInput): void | Promise<void>;
  dispose(): void | Promise<void>;
};
export type PluginAdapterRegistryView = {
  contribution<T>(kind: "adapters", name: string): T | undefined;
  ownerOf(kind: "adapters", name: string): string | undefined;
};
export type PluginCommand = {
  name: string;
  title: string;
  description?: string;
  acceptsArguments?: boolean;
  category?: string;
  run(invocation?: PluginCommandInvocation): PluginCommandResult;
};
export type PluginCommandInvocation = {
  raw: string;
  args: string[];
  workspaceRoot: string;
  sessionID?: string;
  signal?: AbortSignal;
};
export type PluginCommandResult = string | void | Promise<string | void>;
export type PluginContributionKind =
  | "tools"
  | "commands"
  | "listeners"
  | "services"
  | "resources"
  | "projections"
  | "workflows"
  | "settingsSchema"
  | "adapters"
  | "schedulerJobs";
export type PluginContributionOwner = {
  contribute(
    kind: PluginContributionKind,
    name: string,
    payload: unknown,
  ): () => void;
  release(): void;
};
export type PluginActivationStatus =
  | "pending"
  | "activating"
  | "active"
  | "deactivating"
  | "failed";
export type PluginStatus = {
  id: string;
  status: PluginActivationStatus;
  missingServices: string[];
  error?: string;
};

export function definePlugin(plugin: Plugin) {
  return plugin;
}
