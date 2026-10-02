import { resolvePluginDependencies } from "./dependencies";
import type {
  DesiredPluginCatalog,
  DesiredPluginEntry,
} from "./desired-catalog";
import type { PluginManifest } from "./manifest";
import type { createPluginRegistry } from "./registry";

type PluginRegistry = ReturnType<typeof createPluginRegistry>;
type DesiredState = {
  entry: DesiredPluginEntry;
  fingerprint: string;
  settingsFingerprint: string;
  settings: unknown;
  activatable: boolean;
};

export function createDesiredPluginController(input: {
  registry: PluginRegistry;
  assertOwnerReleased?(id: string): void;
  onError?(id: string, action: string, error: unknown): void;
}) {
  let desired = new Map<string, DesiredState>();
  let lifecycleQueue = Promise.resolve();
  let reloadSequence = 0;

  function previous(id: string) {
    const state = desired.get(id);
    return state
      ? { fingerprint: state.fingerprint, manifest: state.entry.manifest }
      : undefined;
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = lifecycleQueue.then(operation, operation);
    lifecycleQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function reconcileDesired(
    source:
      | DesiredPluginCatalog
      | (() => DesiredPluginCatalog | Promise<DesiredPluginCatalog>),
    settings?: Record<string, unknown>,
  ) {
    await enqueue(async () => {
      const catalog = typeof source === "function" ? await source() : source;
      await applyDesired(catalog, settings);
    });
  }

  async function applyDesired(
    catalog: DesiredPluginCatalog,
    settings: Record<string, unknown> | undefined,
  ) {
    const { entries, blocked } = catalog;
    const byID = new Map(entries.map((entry) => [entry.id, entry]));
    if (
      byID.size !== entries.length ||
      entries.some((entry) => entry.manifest && entry.id !== entry.manifest.id)
    )
      throw new Error(
        "desired catalog contains duplicate or mismatched plugin ids",
      );
    for (const id of desired.keys()) {
      const mounted = input.registry
        .list()
        .some((manifest) => manifest.id === id);
      if (!mounted) input.assertOwnerReleased?.(id);
    }
    const previousDesired = desired;
    const next = new Map(
      entries.map((entry) => [
        entry.id,
        {
          entry,
          fingerprint: entry.fingerprint,
          settingsFingerprint: settingsFingerprint(settings?.[entry.id]),
          settings: settings?.[entry.id],
          activatable: !blocked.has(entry.id),
        },
      ]),
    );
    desired = next;
    for (const manifest of input.registry.list().reverse()) {
      if (!input.registry.list().some((entry) => entry.id === manifest.id))
        continue;
      const previous = previousDesired.get(manifest.id);
      const wanted = next.get(manifest.id);
      if (
        wanted?.entry.enabled &&
        wanted.activatable &&
        previous?.fingerprint === wanted.fingerprint &&
        previous.settingsFingerprint === wanted.settingsFingerprint &&
        input.registry.status(manifest.id)?.status !== "failed"
      )
        continue;
      await input.registry.unload(manifest.id);
      input.assertOwnerReleased?.(manifest.id);
    }
    let firstError: unknown;
    for (const state of next.values())
      if (
        state.entry.enabled &&
        state.activatable &&
        !input.registry
          .list()
          .some((manifest) => manifest.id === state.entry.id)
      )
        try {
          if (!hasLiveDependencies(input.registry, state.entry.manifest))
            continue;
          const result = await loadOne(state.entry, state.settings);
          if (!result.loaded && firstError === undefined)
            firstError =
              result.error ??
              new Error(`plugin failed to load: ${state.entry.id}`);
        } catch (error) {
          firstError ??= error;
        }
    if (firstError !== undefined) throw firstError;
  }

  async function loadOne(entry: DesiredPluginEntry, settings?: unknown) {
    try {
      const plugin = await entry.load();
      if (!plugin) return { loaded: false };
      if (plugin.manifest.id !== entry.id)
        throw new Error(
          `plugin loader returned id ${plugin.manifest.id} for ${entry.id}`,
        );
      await input.registry.load(plugin, settings);
    } catch (error) {
      if (!entry.onError) throw error;
      entry.onError(error);
      return { loaded: false, error };
    }
    return { loaded: true };
  }

  async function load(entry: DesiredPluginEntry, settings?: unknown) {
    return await enqueue(async () => {
      desired.set(entry.id, {
        entry,
        fingerprint: entry.fingerprint,
        settingsFingerprint: settingsFingerprint(settings),
        settings,
        activatable: true,
      });
      if (input.registry.list().some((item) => item.id === entry.id))
        await unloadOne(entry.id);
      return await loadOne(entry, settings);
    });
  }

  async function unloadOne(id: string) {
    if (input.registry.list().some((manifest) => manifest.id === id))
      await input.registry.unload(id);
    input.assertOwnerReleased?.(id);
    return { unloaded: true as const };
  }

  async function unload(id: string) {
    return await enqueue(() => unloadOne(id));
  }

  async function loadReloadCandidate(
    state: DesiredState,
    cacheBust: string | undefined,
    action: "reload" | "rollback" | "restore",
  ) {
    try {
      const plugin = await state.entry.load(cacheBust);
      if (!plugin)
        throw new Error(`plugin failed to ${action}: ${state.entry.id}`);
      if (plugin.manifest.id !== state.entry.id)
        throw new Error(
          `plugin loader returned id ${plugin.manifest.id} for ${state.entry.id}`,
        );
      await input.registry.load(plugin, state.settings);
    } catch (error) {
      if (state.entry.onError) state.entry.onError(error);
      else input.onError?.(state.entry.id, action, error);
      throw error;
    }
  }

  async function reloadOne(id: string) {
    const state = desired.get(id);
    if (!state?.entry.enabled || !state.activatable)
      throw new Error(`plugin not found: ${id}`);
    await unloadOne(id);
    let reloadError: unknown;
    let rollbackError: unknown;
    let restorationError: unknown;
    try {
      await loadReloadCandidate(
        state,
        `${Date.now()}-${reloadSequence++}`,
        "reload",
      );
    } catch (error) {
      reloadError = error;
      await unloadOne(id);
      try {
        await loadReloadCandidate(state, undefined, "rollback");
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure;
        try {
          await unloadOne(id);
        } catch (unloadFailure) {
          rollbackError = new AggregateError(
            [rollbackFailure, unloadFailure],
            `plugin ${id} rollback cleanup failed`,
          );
        }
      }
    }
    for (const candidate of desired.values()) {
      if (
        candidate.entry.id === id ||
        !candidate.entry.enabled ||
        !candidate.activatable ||
        (input.registry
          .list()
          .some((manifest) => manifest.id === candidate.entry.id) &&
          input.registry.status(candidate.entry.id)?.status !== "failed")
      )
        continue;
      try {
        if (input.registry.status(candidate.entry.id)?.status === "failed")
          await unloadOne(candidate.entry.id);
        if (!hasLiveDependencies(input.registry, candidate.entry.manifest))
          continue;
        await loadReloadCandidate(candidate, undefined, "restore");
      } catch (error) {
        if (candidate.entry.id === id) rollbackError ??= error;
        else restorationError ??= error;
      }
    }
    if (reloadError !== undefined) throw reloadError;
    if (rollbackError !== undefined) throw rollbackError;
    if (restorationError !== undefined) throw restorationError;
    return { reloaded: true as const };
  }

  async function reload(id: string) {
    return await enqueue(() => reloadOne(id));
  }

  async function close() {
    await enqueue(async () => {
      try {
        await input.registry.close();
      } finally {
        for (const id of desired.keys()) input.assertOwnerReleased?.(id);
        desired.clear();
      }
    });
  }

  return {
    previous,
    reconcileDesired,
    load,
    unload,
    reload,
    close,
    whenIdle: () => lifecycleQueue,
  };
}

function hasLiveDependencies(
  registry: PluginRegistry,
  manifest: PluginManifest | undefined,
) {
  if (!manifest || manifest.apiVersion !== 2) return true;
  const mounted = registry.list();
  const available = mounted.filter((candidate) => {
    const status = registry.status(candidate.id)?.status;
    return status === "active" || status === "pending";
  });
  const resolution = resolvePluginDependencies([manifest], available, mounted);
  return resolution.denied.length === 0 && resolution.pending.length === 0;
}

function settingsFingerprint(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value))
    return `[${value.map(settingsFingerprint).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, child]) =>
          `${JSON.stringify(key)}:${settingsFingerprint(child)}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
