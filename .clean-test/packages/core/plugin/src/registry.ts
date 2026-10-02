import { resolvePluginDependencies } from "./dependencies";
import { manifestIntegrationPoints, pluginManifestSchema } from "./manifest";
import { resolvePluginConfig } from "./config";
import { activatePlugin } from "./registry-activation";
import type {
  MountedPlugin,
  PluginRegistryInput,
  RegistryState,
} from "./registry-state";
import type { Plugin, PluginAudit, PluginStatus } from "./types";

export function createPluginRegistry(input: PluginRegistryInput) {
  const plugins = new Map<string, MountedPlugin>();
  const audit: PluginAudit[] = [];
  const commandOwners = new Map<string, string>();
  const cleanup = (disposers: Array<() => void>): unknown[] => {
    const errors: unknown[] = [];
    for (const dispose of [...disposers].reverse())
      try {
        dispose();
      } catch (error) {
        errors.push(error);
      }
    return errors;
  };
  const once = (dispose: () => void) => {
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      dispose();
    };
  };
  const serviceSnapshot: RegistryState["serviceSnapshot"] = (manifest) => {
    const missingServices: string[] = [];
    const providers = new Map<string, unknown>();
    for (const name of manifest.requires) {
      const value = input.service?.(name);
      if (value === undefined) missingServices.push(name);
      else providers.set(name, input.serviceProvider?.(name) ?? value);
    }
    return { missingServices, providers };
  };
  const sameProviders: RegistryState["sameProviders"] = (left, right) =>
    left.size === right.size &&
    [...left].every(([name, provider]) => Object.is(provider, right.get(name)));
  const writeAudit: RegistryState["writeAudit"] = (
    pluginID,
    action,
    detail,
  ) => {
    const entry = { pluginID, action, detail, timestamp: Date.now() };
    audit.push(entry);
    try {
      input.onAudit?.(entry);
    } catch {
      // an audit observer must not break the audit trail
    }
  };
  const state: RegistryState = {
    input,
    commandOwners,
    cleanup,
    once,
    serviceSnapshot,
    sameProviders,
    writeAudit,
    assertCapability(manifest, capability) {
      if (!manifestIntegrationPoints(manifest).includes(capability)) {
        writeAudit(manifest.id, "denied", capability);
        throw new Error(
          `plugin capability denied: ${manifest.id}/${capability}`,
        );
      }
    },
  };
  let transitionQueue = Promise.resolve();
  const enqueueTransition = <T>(transition: () => Promise<T>): Promise<T> => {
    const result = transitionQueue.then(transition, transition);
    transitionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  async function deactivate(entry: MountedPlugin) {
    const epoch = entry.epoch;
    if (!epoch) {
      entry.status = "pending";
      return [];
    }
    entry.status = "deactivating";
    const errors: unknown[] = [];
    try {
      await entry.plugin.dispose?.();
    } catch (error) {
      errors.push(error);
    }
    epoch.abort.abort();
    await Promise.allSettled(epoch.effects);
    errors.push(...cleanup(epoch.dispose));
    try {
      epoch.contributionOwner?.release();
    } catch (error) {
      errors.push(error);
    }
    entry.epoch = undefined;
    entry.requiredProviders.clear();
    entry.status = "pending";
    input.onChange?.();
    return errors;
  }

  async function reconcileEntry(entry: MountedPlugin) {
    const snapshot = serviceSnapshot(entry.plugin.manifest);
    entry.missingServices = snapshot.missingServices;
    if (
      entry.status === "active" &&
      (snapshot.missingServices.length ||
        !sameProviders(entry.requiredProviders, snapshot.providers))
    )
      await deactivate(entry);
    if (
      !snapshot.missingServices.length &&
      (entry.status === "pending" || entry.status === "failed")
    )
      await activatePlugin(state, entry);
  }

  async function loadPlugin(plugin: Plugin, config: unknown) {
    const manifest = pluginManifestSchema.parse(plugin.manifest);
    if (plugins.has(manifest.id))
      throw new Error(`plugin already loaded: ${manifest.id}`);
    // v2 and v3 both declare dependencies; the graph check below is the
    // same for either (v1 predates the dependency model entirely).
    if (manifest.apiVersion === 2 || manifest.apiVersion === 3) {
      const mounted = [...plugins.values()];
      const resolution = resolvePluginDependencies(
        [manifest],
        mounted
          .filter(
            (entry) => entry.status === "active" || entry.status === "pending",
          )
          .map((entry) => entry.plugin.manifest),
        mounted.map((entry) => entry.plugin.manifest),
      );
      const unresolved = [...resolution.denied, ...resolution.pending][0];
      if (unresolved) {
        writeAudit(
          manifest.id,
          resolution.denied.length ? "denied" : "failed",
          unresolved.reason,
        );
        throw new Error(
          `plugin dependency unresolved: ${manifest.id}: ${unresolved.reason}`,
        );
      }
    }
    let resolvedConfig: unknown;
    try {
      resolvedConfig = resolvePluginConfig({ ...plugin, manifest }, config);
    } catch (error) {
      writeAudit(
        manifest.id,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    const snapshot = serviceSnapshot(manifest);
    const entry: MountedPlugin = {
      plugin: { ...plugin, manifest },
      config: resolvedConfig,
      status: "pending",
      missingServices: snapshot.missingServices,
      requiredProviders: new Map(),
      lastAttemptedProviders: new Map(),
    };
    plugins.set(manifest.id, entry);
    writeAudit(manifest.id, "loaded");
    try {
      await enqueueTransition(() => reconcileEntry(entry));
    } catch (error) {
      if (entry.status !== "failed") plugins.delete(manifest.id);
      throw error;
    }
  }

  async function unloadOne(id: string) {
    const entry = plugins.get(id);
    if (!entry) throw new Error(`plugin not found: ${id}`);
    const errors = await deactivate(entry);
    plugins.delete(id);
    const error = errors[0];
    writeAudit(
      id,
      error === undefined ? "unloaded" : "failed",
      error instanceof Error
        ? error.message
        : error === undefined
          ? undefined
          : String(error),
    );
    if (error !== undefined) throw error;
  }

  function dependentOrder(id: string): string[] {
    const order: string[] = [];
    const visited = new Set<string>();
    const visit = (dependencyID: string) => {
      for (const [candidateID, entry] of [...plugins].reverse()) {
        if (visited.has(candidateID)) continue;
        const manifest = entry.plugin.manifest;
        if (
          manifest.apiVersion !== 2 ||
          !manifest.dependencies.some(
            (dependency) =>
              !dependency.optional && dependency.id === dependencyID,
          )
        )
          continue;
        visited.add(candidateID);
        visit(candidateID);
        order.push(candidateID);
      }
    };
    visit(id);
    return order;
  }

  async function unloadMany(ids: string[]) {
    const errors: unknown[] = [];
    for (const id of ids)
      if (plugins.has(id))
        try {
          await unloadOne(id);
        } catch (error) {
          errors.push(error);
        }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, "multiple plugins failed to unload");
  }

  const unsubscribeServices = input.onServiceUpdate?.((update) => {
    void enqueueTransition(async () => {
      for (const entry of plugins.values())
        if (entry.plugin.manifest.requires.includes(update.name))
          try {
            await reconcileEntry(entry);
          } catch {
            // one dependent's reconcile failure must not block the others
          }
    });
  });

  return {
    async load(plugin: Plugin, config?: unknown) {
      await loadPlugin(plugin, config);
    },
    async unload(id: string) {
      if (!plugins.has(id)) throw new Error(`plugin not found: ${id}`);
      await enqueueTransition(() => unloadMany([...dependentOrder(id), id]));
    },
    async unloadAll() {
      await enqueueTransition(() => unloadMany([...plugins.keys()].reverse()));
    },
    async close() {
      await enqueueTransition(async () => {
        try {
          await unloadMany([...plugins.keys()].reverse());
        } finally {
          unsubscribeServices?.();
        }
      });
    },
    dispatch(event: unknown) {
      for (const entry of plugins.values())
        for (const listener of entry.epoch?.listeners ?? [])
          try {
            listener(event);
          } catch {
            // one listener must not break event delivery
          }
    },
    list: () => [...plugins.values()].map((entry) => entry.plugin.manifest),
    status(id: string): PluginStatus | undefined {
      const entry = plugins.get(id);
      if (!entry) return undefined;
      return {
        id,
        status: entry.status,
        missingServices: [...entry.missingServices],
        ...(entry.error ? { error: entry.error } : {}),
      };
    },
    active: (id: string) => plugins.get(id)?.status === "active",
    whenIdle: () => transitionQueue,
    commands: () =>
      [...plugins.values()].flatMap((entry) => [
        ...(entry.epoch?.commands.values() ?? []),
      ]),
    audit: () => [...audit],
  };
}
