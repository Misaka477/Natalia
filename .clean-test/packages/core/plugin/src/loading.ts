import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverPluginManifests } from "./discovery";
import { resolvePluginDependencies } from "./dependencies";
import type { PluginManifest } from "./manifest";
import type { PluginManifestEntry } from "./installed";
import { validatePluginPath } from "./installed";
import type { createPluginRegistry } from "./registry";
import type { Plugin } from "./types";

export async function loadLocalPlugins(input: {
  roots: string[];
  registry: ReturnType<typeof createPluginRegistry>;
  enabled?: Record<string, boolean>;
  settings?: Record<string, unknown>;
  onError?: (id: string, error: unknown) => void;
}) {
  const discovered: PluginManifestEntry[] = [];
  for (const root of input.roots)
    for (const item of await discoverPluginManifests(root))
      if (input.enabled?.[item.manifest.id] !== false) discovered.push(item);
  return loadPluginEntries({ ...input, entries: discovered });
}

export async function loadPluginEntries(input: {
  entries: PluginManifestEntry[];
  registry: ReturnType<typeof createPluginRegistry>;
  settings?: Record<string, unknown>;
  onError?: (id: string, error: unknown) => void;
}) {
  const loaded: PluginManifest[] = [];
  const resolution = resolvePluginDependencies(
    input.entries.map((item) => item.manifest),
    input.registry.list().filter((manifest) => {
      const status = input.registry.status(manifest.id)?.status;
      return status === "active" || status === "pending";
    }),
    input.registry.list(),
  );
  for (const unresolved of [...resolution.denied, ...resolution.pending])
    input.onError?.(
      unresolved.id,
      new Error(`plugin dependency unresolved: ${unresolved.reason}`),
    );
  const byID = new Map(input.entries.map((item) => [item.manifest.id, item]));
  for (const id of resolution.order) {
    const item = byID.get(id);
    if (!item) continue;
    const { manifest, path } = item;
    try {
      const entry = validatePluginPath(resolve(path, ".."), manifest.entry);
      const module = (await import(pathToFileURL(entry).href)) as {
        default?: unknown;
      };
      const plugin =
        typeof module.default === "function"
          ? module.default()
          : module.default;
      if (!plugin || typeof plugin !== "object")
        throw new Error(`plugin module has no default export: ${manifest.id}`);
      const candidate = plugin as Partial<Plugin>;
      if (!candidate.setup || typeof candidate.setup !== "function")
        throw new Error(`plugin module has no setup function: ${manifest.id}`);
      await input.registry.load(
        { ...candidate, manifest } as Plugin,
        input.settings?.[manifest.id],
      );
      loaded.push(manifest);
    } catch (error) {
      input.onError?.(manifest.id, error);
    }
  }
  return loaded;
}
