import type { ToolRegistry } from "@anthelia/tools";
import type { PluginIntegrationPoint, PluginManifest } from "./manifest";
import type {
  Plugin,
  PluginActivationStatus,
  PluginAudit,
  PluginCachePort,
  PluginCommand,
  PluginContributionOwner,
} from "./types";

export type ActivationEpoch = {
  listeners: Set<(event: unknown) => void>;
  commands: Map<string, PluginCommand>;
  dispose: Array<() => void>;
  abort: AbortController;
  effects: Set<Promise<unknown>>;
  contributionOwner: PluginContributionOwner | undefined;
};

export type MountedPlugin = {
  plugin: Plugin;
  config: unknown;
  status: PluginActivationStatus;
  missingServices: string[];
  requiredProviders: Map<string, unknown>;
  lastAttemptedProviders: Map<string, unknown>;
  error?: string;
  epoch?: ActivationEpoch;
};

export type PluginRegistryInput = {
  tools: ToolRegistry;
  onAudit?: (entry: PluginAudit) => void;
  onChange?: () => void;
  registerOwner?: (
    manifest: PluginManifest,
  ) =>
    | PluginContributionOwner
    | Promise<PluginContributionOwner | undefined>
    | undefined;
  runtimeConfig?: () => unknown;
  /**
   * The cache port's host seam (the engine fabric behind it). Absent =
   * this host wires no fabric, and a plugin's cache call fails loud at
   * use ("cache is not available in this host") rather than silently
   * degrading into an uncached path.
   */
  cache?: PluginCachePort;
  service?: <T>(name: string) => T | undefined;
  serviceProvider?: (name: string) => unknown;
  onServiceUpdate?: (
    listener: (update: {
      name: string;
      provider?: string;
      providerBefore?: string;
    }) => void,
  ) => () => void;
};

export type RegistryState = {
  input: PluginRegistryInput;
  commandOwners: Map<string, string>;
  writeAudit(
    pluginID: string,
    action: PluginAudit["action"],
    detail?: string,
  ): void;
  cleanup(disposers: Array<() => void>): unknown[];
  once(dispose: () => void): () => void;
  serviceSnapshot(manifest: PluginManifest): {
    missingServices: string[];
    providers: Map<string, unknown>;
  };
  sameProviders(
    left: Map<string, unknown>,
    right: Map<string, unknown>,
  ): boolean;
  assertCapability(
    manifest: PluginManifest,
    capability: PluginIntegrationPoint,
  ): void;
};
