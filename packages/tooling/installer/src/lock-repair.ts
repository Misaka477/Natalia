import { relative, resolve } from "node:path";
import type { NataliaLock } from "@anthelia/contracts";
import {
  discoverPluginManifests,
  lockManifestPath,
  resolveLockManifestPath,
} from "@anthelia/plugin";
import {
  loadNataliaLock,
  packageDirectory,
  pluginClosurePaths,
  saveNataliaLock,
} from "./closure";

export type LockRepair = {
  /** The lock key the repair is about (after any rename). */
  key: string;
  /** What was wrong, in the terms the user can act on. */
  detail: string;
};

type LockEntry = NataliaLock["plugins"][string];

type Resolved = {
  key: string;
  packageName: string;
  manifest: string;
  metadata: LockEntry["metadata"];
  /** The manifest's own id, when the package on disk could be read. */
  declared?: string;
};

/**
 * Bring a plugin store's `natalia.lock` back in line with the packages on
 * disk, and say what was wrong.
 *
 * Two field failures made this necessary, both written by us and both
 * invisible until the whole plugin system was dead:
 *
 * - `manifest` was an ABSOLUTE path built from the store root current at
 *   install time. Moving the store inside the product
 *   (`<install>/plugin-store` → `<home>/.natalia/plugin-store`) carried those
 *   paths along in the copy, and the loader requires a manifest to live inside
 *   its own package — so 15 of the 16 official plugins on a real install were
 *   refused with "plugin manifest escapes package" and NOTHING loaded. Every
 *   plugin-owned panel went with them (the terminal tab, the file tab).
 * - The lock key came from a table that disagreed with the manifest for one
 *   plugin (`natalia-browser` vs `natalia-tool-browser`), so that entry could
 *   never load either ("manifest has id …") — and because the disagreement
 *   produced two keys for the same package, the store held both.
 *
 * The rule this settles on is the one every other reader already uses: the
 * package directory under `node_modules` is authoritative and the lock is a
 * derived record of it — a path relative to the store root, keyed by the
 * manifest's own id. A package whose manifest cannot be read is left exactly
 * as it was: an unreadable package is a different problem, and guessing
 * would hide it.
 */
export async function reconcilePluginStoreLock(
  pluginStoreRoot: string,
): Promise<LockRepair[]> {
  const storeRoot = resolve(pluginStoreRoot);
  const lock = await loadNataliaLock(storeRoot);
  const repairs: LockRepair[] = [];
  const entries: Resolved[] = [];
  for (const [key, entry] of Object.entries(lock.plugins)) {
    const packageRoot = packageDirectory(
      pluginClosurePaths(storeRoot).pluginsDir,
      entry.packageName,
    );
    const found = await discoverPluginManifests(packageRoot, {
      nodeModules: false,
    });
    const discovered = found.length === 1 ? found[0]! : undefined;
    entries.push({
      key,
      packageName: entry.packageName,
      manifest: discovered
        ? lockManifestPath(
            entry.packageName,
            relative(packageRoot, discovered.path).split(/[\\/]/u).join("/"),
          )
        : entry.manifest,
      metadata: entry.metadata,
      ...(discovered ? { declared: discovered.manifest.id } : {}),
    });
  }
  // A key that is not its manifest's id, and a second key for the same
  // package, are the same defect seen twice: the package is the authority, so
  // the key that agrees with the manifest wins and the stale twin is dropped.
  const adopted = new Map<string, Resolved>();
  for (const entry of entries) {
    const nextKey = entry.declared ?? entry.key;
    const existing = adopted.get(nextKey);
    if (!existing) {
      adopted.set(nextKey, entry);
      continue;
    }
    const keepExisting = existing.key === nextKey;
    repairs.push({
      key: nextKey,
      detail:
        `dropped lock key ${keepExisting ? entry.key : existing.key} — both ` +
        `name ${entry.packageName}, and the manifest's id is ${nextKey}`,
    });
    if (!keepExisting) adopted.set(nextKey, entry);
  }
  for (const [key, entry] of adopted) {
    if (key !== entry.key)
      repairs.push({
        key,
        detail: `lock key ${entry.key} → ${key} (the manifest's own id)`,
      });
    if (entry.manifest !== lock.plugins[entry.key]!.manifest)
      repairs.push({
        key,
        detail:
          `manifest ${lock.plugins[entry.key]!.manifest} → ${entry.manifest} ` +
          `(resolved against the package on disk, not against the store root ` +
          `it was installed under)`,
      });
  }
  if (!repairs.length) return repairs;
  const repaired: NataliaLock["plugins"] = {};
  for (const [key, entry] of adopted)
    repaired[key] = {
      packageName: entry.packageName,
      manifest: entry.manifest,
      metadata: { ...entry.metadata, id: key },
    };
  await saveNataliaLock(storeRoot, { version: 1, plugins: repaired });
  return repairs;
}
