import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginPackageConfig } from "@anthelia/contracts";
import {
  discoverPluginManifests,
  resolveInstalledPluginEntries,
  validatePluginPath,
  type DesiredPluginEntry,
  type Plugin,
  type PluginManifestEntry,
} from "@anthelia/plugin";

export async function discoverDesiredPluginEntries(input: {
  pluginStoreRoot?: string;
  workspaceRoot?: string;
  paths?: string[];
  packages?: Record<string, PluginPackageConfig>;
  enabled?: Record<string, boolean>;
  declaredIDs: string[];
  onError(id: string, error: unknown): void;
}): Promise<DesiredPluginEntry[]> {
  const installed = input.pluginStoreRoot
    ? await resolveInstalledPluginEntries({
        pluginStoreRoot: input.pluginStoreRoot,
        enabled: input.enabled,
      })
    : { entries: [], errors: [] };
  for (const failure of installed.errors)
    input.onError(failure.id, failure.error);

  const ids = new Set(input.declaredIDs);
  for (const id of installed.entries.map(({ manifest }) => manifest.id)) {
    if (ids.has(id)) throw new Error(`duplicate plugin id: ${id}`);
    ids.add(id);
  }

  const pathEntries: PluginManifestEntry[] = [];
  for (const rawPath of input.paths ?? []) {
    const root = resolve(input.workspaceRoot ?? process.cwd(), rawPath);
    for (const item of await discoverPluginManifests(root, {
      nodeModules: false,
    })) {
      if (input.enabled?.[item.manifest.id] === false) continue;
      // Installed/declared entries are authoritative; a path that points at the
      // same source package must not turn into a duplicate-id failure.
      if (ids.has(item.manifest.id)) continue;
      ids.add(item.manifest.id);
      pathEntries.push({ manifest: item.manifest, path: item.path });
    }
  }

  const entries = installed.entries.map((entry) => desiredEntry(entry, input));
  return [
    ...entries,
    ...pathEntries.map((entry) => desiredEntry(entry, input)),
  ];
}

function desiredEntry(
  entry: PluginManifestEntry,
  input: { onError(id: string, error: unknown): void },
): DesiredPluginEntry {
  const { manifest, path } = entry;
  return {
    id: manifest.id,
    enabled: true,
    fingerprint: JSON.stringify({ manifest, path }),
    manifest,
    path,
    onError: (error) => input.onError(manifest.id, error),
    async load(cacheBust) {
      const modulePath = validatePluginPath(
        resolve(path, ".."),
        manifest.entry,
      );
      const moduleURL = pathToFileURL(modulePath).href;
      const specifier = cacheBust
        ? `${moduleURL}?reload=${cacheBust}`
        : moduleURL;
      const module = (await import(specifier)) as { default?: unknown };
      const candidate = (
        typeof module.default === "function" ? module.default() : module.default
      ) as Partial<Plugin> | undefined;
      if (!candidate?.setup || typeof candidate.setup !== "function")
        throw new Error(`plugin module has no setup function: ${manifest.id}`);
      return { ...candidate, manifest } as Plugin;
    },
  };
}
