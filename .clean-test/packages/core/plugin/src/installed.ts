import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { nataliaLockSchema, type NataliaLock } from "@anthelia/contracts";
import { pluginManifestSchema, type PluginManifest } from "./manifest";

export type PluginManifestEntry = { manifest: PluginManifest; path: string };
export type InstalledPluginEntryResolution = {
  entries: PluginManifestEntry[];
  errors: Array<{ id: string; error: Error }>;
};

export async function loadNataliaPluginLock(
  pluginStoreRoot: string,
): Promise<NataliaLock> {
  try {
    return nataliaLockSchema.parse(
      JSON.parse(await readFile(join(pluginStoreRoot, "natalia.lock"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, plugins: {} };
    throw error;
  }
}

export async function resolveInstalledPluginEntries(input: {
  pluginStoreRoot: string;
  enabled?: Record<string, boolean>;
}): Promise<InstalledPluginEntryResolution> {
  const entries: PluginManifestEntry[] = [];
  const errors: InstalledPluginEntryResolution["errors"] = [];
  let lock: NataliaLock;
  try {
    lock = await loadNataliaPluginLock(input.pluginStoreRoot);
  } catch (error) {
    return {
      entries,
      errors: [
        {
          id: "plugin-store",
          error: new Error(
            `could not read natalia.lock: ${error instanceof Error ? error.message : String(error)}`,
          ),
        },
      ],
    };
  }
  const modulesRoot = resolve(input.pluginStoreRoot, "node_modules");
  for (const [id, locked] of Object.entries(lock.plugins)) {
    if (input.enabled?.[id] === false) continue;
    try {
      if (locked.metadata.id !== id)
        throw new Error(`plugin ${id} lock entry has id ${locked.metadata.id}`);
      if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/iu.test(locked.packageName))
        throw new Error(
          `plugin ${id} has invalid package name in natalia.lock`,
        );
      const packageRoot = resolve(
        modulesRoot,
        ...locked.packageName.split("/"),
      );
      assertPathInside(
        modulesRoot,
        packageRoot,
        "plugin package path escapes closure",
      );
      const manifestPath = resolve(locked.manifest);
      assertPathInside(
        packageRoot,
        manifestPath,
        "plugin manifest escapes package",
      );
      const [actualModulesRoot, actualPackageRoot, actualManifestPath] =
        await Promise.all([
          realpath(modulesRoot),
          realpath(packageRoot),
          realpath(manifestPath),
        ]);
      assertPathInside(
        actualModulesRoot,
        actualPackageRoot,
        "plugin package path escapes closure",
      );
      assertPathInside(
        actualPackageRoot,
        actualManifestPath,
        "plugin manifest escapes package",
      );
      const manifest = pluginManifestSchema.parse(
        JSON.parse(await readFile(actualManifestPath, "utf8")),
      );
      if (manifest.id !== id)
        throw new Error(`plugin ${id} manifest has id ${manifest.id}`);
      if (manifest.version !== locked.metadata.resolvedVersion)
        throw new Error(`plugin ${id} version does not match natalia.lock`);
      if (manifest.scope !== locked.metadata.scope)
        throw new Error(`plugin ${id} scope does not match natalia.lock`);
      // The installed CONTENT matches the lock: the same class of check as
      // the version/scope pair above, and the one that catches the
      // electron-incident drift (a manifest or entry changing after
      // install). A legacy entry with no pin passes — the field is an
      // install-time addition, not a load-time requirement.
      if (locked.metadata.contentHash !== undefined) {
        const contentHash = await computePluginPackageHash(actualPackageRoot);
        if (contentHash !== locked.metadata.contentHash)
          throw new Error(
            `plugin ${id} package content does not match natalia.lock (content ${contentHash}, lock ${locked.metadata.contentHash}) — the installed files changed after install; reinstall to re-pin`,
          );
      }
      const entry = validatePluginPath(
        resolve(actualManifestPath, ".."),
        manifest.entry,
      );
      assertPathInside(
        actualPackageRoot,
        await realpath(entry),
        "plugin entry escapes package",
      );
      entries.push({ manifest, path: actualManifestPath });
    } catch (error) {
      errors.push({
        id,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return { entries, errors };
}

function assertPathInside(root: string, candidate: string, message: string) {
  const inside = relative(resolve(root), resolve(candidate));
  if (inside !== "" && (inside.startsWith("..") || isAbsolute(inside)))
    throw new Error(message);
}

/**
 * The installed package's content hash — OUR pin, distinct from the
 * package manager's tarball `integrity`: a tarball digest proves what was
 * published, this proves what is on disk at load time.
 *
 * Deterministic across machines: every file under the package root except
 * a nested `node_modules` (npm's hoisting can rearrange a dependency tree
 * without touching the package — pinning that would false-positive on a
 * layout change, not a content change), sorted by relative path, each
 * file's own SHA-256 over one canonical listing line, then a SHA-256 over
 * the listing. No mtimes, no absolute paths, no FS ordering.
 */
export async function computePluginPackageHash(
  packageRoot: string,
): Promise<string> {
  const files: Array<{ path: string; sha256: string }> = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile())
        files.push({
          path: relative(packageRoot, full).split(sep).join("/"),
          sha256: createHash("sha256")
            .update(await readFile(full))
            .digest("hex"),
        });
    }
  };
  await walk(packageRoot);
  files.sort((left, right) => (left.path < right.path ? -1 : 1));
  const listing = files
    .map((file) => `${file.path}\0${file.sha256}\n`)
    .join("");
  return createHash("sha256").update(listing).digest("hex");
}

export function validatePluginPath(root: string, path: string) {
  const resolved = resolve(root, path);
  const inside = relative(resolve(root), resolved);
  if (inside !== "" && (inside.startsWith("..") || isAbsolute(inside)))
    throw new Error("plugin path escapes root");
  if (
    !isAbsolute(resolved) ||
    ![".js", ".mjs", ".ts"].some((extension) => resolved.endsWith(extension))
  )
    throw new Error("plugin entry must be a local JS or TS module");
  return resolved;
}
