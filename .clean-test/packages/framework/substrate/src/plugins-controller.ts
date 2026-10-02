import type { PluginPackageConfig, RuntimeEvent } from "@anthelia/contracts";
import type { CapabilityRegistryHost } from "@anthelia/capability";
import { dirname, resolve } from "node:path";
import {
  createDesiredPluginController,
  createPluginRegistry,
  pluginSkillDir,
  resolveDesiredPluginCatalog,
  type DesiredPluginEntry,
  type PluginManifest,
} from "@anthelia/plugin";
import type { ToolRegistry } from "@anthelia/tools";
import {
  localToolsInput,
  mcpInput,
  skillsInput,
  terminalInput,
} from "@anthelia/runtime-services";
import { discoverDesiredPluginEntries } from "./plugin-discovery";
import { registerPluginOwner } from "./plugin-owner";
import { snapshotProjectionContributions } from "./projection-contributions";
import {
  createPluginCachePort,
  type CacheFabricLike,
} from "./plugin-cache-port";

/** The fabric's service name — the token in `@anthelia/rina` is `rina.cache`. */
const RINA_CACHE_SERVICE = "rina.cache";

/**
 * The loaded plugins' declared skills directories (absolute), resolved
 * against each package's manifest path. Pure over the resolved catalog
 * so the resolution is testable without a live controller. A plugin
 * without a declaration, or without a package path (the injected host
 * entries), contributes nothing.
 */
export function pluginSkillDirsFrom(
  entries: readonly DesiredPluginEntry[],
): string[] {
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.manifest || !entry.path) continue;
    const dir = pluginSkillDir(entry.manifest);
    if (dir) dirs.push(resolve(dirname(entry.path), dir));
  }
  return dirs;
}

const HOST_INPUT_SERVICES = new Set([
  localToolsInput.id,
  mcpInput.id,
  skillsInput.id,
  terminalInput.id,
]);

export type PluginConfigSnapshot = {
  paths?: string[];
  packages?: Record<string, PluginPackageConfig>;
  enabled?: Record<string, boolean>;
  settings?: Record<string, unknown>;
};

export function createPluginsController(input: {
  pluginStoreRoot?: string;
  workspaceRoot: string;
  tools: ToolRegistry;
  capabilityRegistry: CapabilityRegistryHost;
  discoverDesiredEntries?: typeof discoverDesiredPluginEntries;
  publish(event: RuntimeEvent): void;
}) {
  let registry: ReturnType<typeof createPluginRegistry> | undefined;
  let controller: ReturnType<typeof createDesiredPluginController> | undefined;
  let lastCatalog: DesiredPluginEntry[] = [];
  let closed = false;
  let hostInputGeneration = 0;

  function init() {
    closed = false;
    registry = createPluginRegistry({
      tools: input.tools,
      onAudit: (entry) => {
        input.publish({
          type: "plugin.update",
          id: entry.pluginID,
          status: entry.action,
          detail: entry.detail,
        });
        publishProjectionSnapshot();
      },
      registerOwner: (manifest) =>
        registerPluginOwner(manifest, input.capabilityRegistry),
      runtimeConfig: () => input.capabilityRegistry.service("runtime.config"),
      // The plugin cache port over the engine's fabric (the base closure
      // round). Resolved lazily through the service directory, so the
      // wiring order between services and this controller cannot strand it.
      cache: createPluginCachePort(() =>
        input.capabilityRegistry.service<CacheFabricLike>(RINA_CACHE_SERVICE),
      ),
      service: <T>(name: string) => input.capabilityRegistry.service<T>(name),
      serviceProvider: (name) =>
        input.capabilityRegistry.ownerOf("services", name),
      onServiceUpdate: (listener) =>
        input.capabilityRegistry.onServiceUpdate(listener),
    });
    controller = createDesiredPluginController({
      registry,
      assertOwnerReleased(id) {
        if (input.capabilityRegistry.has(id))
          throw new Error(
            `plugin ${id} unloaded without releasing its capability owner`,
          );
      },
      onError: publishPluginError,
    });
  }

  async function reconcileDesired(
    injectedEntries: DesiredPluginEntry[],
    config: PluginConfigSnapshot,
  ) {
    const snapshot = structuredClone(config);
    const current = getController();
    const inputGeneration = ++hostInputGeneration;
    await current.reconcileDesired(async () => {
      const users = await (
        input.discoverDesiredEntries ?? discoverDesiredPluginEntries
      )({
        pluginStoreRoot: input.pluginStoreRoot,
        workspaceRoot: input.workspaceRoot,
        paths: snapshot.paths ?? [],
        packages: snapshot.packages ?? {},
        enabled: snapshot.enabled,
        declaredIDs: injectedEntries.map((entry) => entry.id),
        onError: publishLoadError,
      });
      const entries = [...injectedEntries, ...users].map((entry) =>
        entry.manifest?.requires.some((name) => HOST_INPUT_SERVICES.has(name))
          ? {
              ...entry,
              fingerprint: `${entry.fingerprint}:host-input:${inputGeneration}`,
            }
          : entry,
      );
      const catalog = await resolveDesiredPluginCatalog({
        entries,
        previous: current.previous,
        onError: publishLoadError,
      });
      // The resolved catalog is the runtime's plugin composition: the
      // generation record snapshots it by identity and fingerprint.
      lastCatalog = catalog.entries;
      return catalog;
    }, snapshot.settings);
  }

  function publishProjectionSnapshot() {
    input.publish({
      type: "projections.updated",
      contributions: snapshotProjectionContributions(input.capabilityRegistry),
    });
  }

  function publishLoadError(id: string, error: unknown) {
    publishPluginError(id, "load", error);
  }

  function publishPluginError(id: string, action: string, error: unknown) {
    input.publish({
      type: "diagnostic",
      level: "warning",
      owner: id,
      message: `plugin ${id} ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  function getController() {
    if (!controller) throw new Error("plugins are not enabled in this runtime");
    return controller;
  }

  function get() {
    if (!registry) throw new Error("plugins are not enabled in this runtime");
    return registry;
  }

  function list(): PluginManifest[] {
    return registry?.list() ?? [];
  }

  /** The loaded plugins' declared skills directories (absolute). */
  function skillDirs(): string[] {
    return pluginSkillDirsFrom(lastCatalog);
  }

  async function close() {
    if (closed) return;
    const current = controller;
    if (!current) return;
    closed = true;
    try {
      await current.close();
    } catch (error) {
      publishPluginError("plugins", "cleanup/close", error);
    } finally {
      registry = undefined;
    }
  }

  return {
    init,
    reconcileDesired,
    catalog: () =>
      lastCatalog.map(({ id, enabled, fingerprint }) => ({
        id,
        enabled,
        fingerprint,
      })),
    get,
    list,
    skillDirs,
    status: (id: string) => registry?.status(id),
    active: (id: string) => registry?.active(id) ?? false,
    load: (entry: DesiredPluginEntry, settings?: unknown) =>
      getController().load(entry, settings),
    unload: (id: string) =>
      controller
        ? controller.unload(id)
        : Promise.resolve({ unloaded: true as const }),
    reload: (id: string) => getController().reload(id),
    close,
    dispatch: (event: RuntimeEvent) => registry?.dispatch(event),
  };
}
