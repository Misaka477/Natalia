import { resolvePluginDependencies } from "./dependencies";
import type { PluginManifest } from "./manifest";
import type { Plugin } from "./types";

export type DesiredPluginEntry = {
  id: string;
  enabled: boolean;
  fingerprint: string;
  manifest?: PluginManifest;
  /**
   * The package's `natalia.plugin.json` path — the anchor a declared
   * skills directory resolves against (absent for injected host entries,
   * which ship no skills). Carried so the skills input can discover a
   * plugin's shipped skills without re-reading the store.
   */
  path?: string;
  prepare?(): Promise<Plugin>;
  load(cacheBust?: string): Promise<Plugin | undefined>;
  onError?(error: unknown): void;
};

export type DesiredPluginCatalog = {
  entries: DesiredPluginEntry[];
  blocked: Set<string>;
};

export async function resolveDesiredPluginCatalog(input: {
  entries: DesiredPluginEntry[];
  previous(
    id: string,
  ): { fingerprint: string; manifest?: PluginManifest } | undefined;
  onError(id: string, error: unknown): void;
}): Promise<DesiredPluginCatalog> {
  const ids = new Set<string>();
  for (const entry of input.entries) {
    if (ids.has(entry.id)) throw new Error(`duplicate plugin id: ${entry.id}`);
    ids.add(entry.id);
  }

  const prepared = await Promise.all(
    input.entries.map(async (entry) => {
      if (!entry.enabled || entry.manifest) return entry;
      const previous = input.previous(entry.id);
      const reusable = previous?.fingerprint === entry.fingerprint;
      const plugin = reusable ? undefined : await entry.prepare?.();
      const manifest = reusable ? previous?.manifest : plugin?.manifest;
      if (!manifest)
        throw new Error(`plugin manifest unavailable: ${entry.id}`);
      return { ...entry, manifest };
    }),
  );
  for (const entry of prepared)
    if (entry.manifest && entry.manifest.id !== entry.id)
      throw new Error(
        `plugin manifest id ${entry.manifest.id} does not match ${entry.id}`,
      );

  const enabled = prepared.filter(
    (entry): entry is DesiredPluginEntry & { manifest: PluginManifest } =>
      entry.enabled && !!entry.manifest,
  );
  const resolution = resolvePluginDependencies(
    enabled.map((entry) => entry.manifest),
  );
  const unresolved = [...resolution.denied, ...resolution.pending];
  for (const item of unresolved)
    input.onError(
      item.id,
      new Error(`plugin dependency unresolved: ${item.reason}`),
    );

  const byID = new Map(prepared.map((entry) => [entry.id, entry]));
  const ordered = resolution.order.map((id) => byID.get(id)!);
  const orderedIDs = new Set(resolution.order);
  ordered.push(...prepared.filter((entry) => !orderedIDs.has(entry.id)));
  return {
    entries: ordered,
    blocked: new Set(unresolved.map((item) => item.id)),
  };
}
