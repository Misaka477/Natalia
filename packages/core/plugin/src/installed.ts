import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { nataliaLockSchema, type NataliaLock } from "@anthelia/contracts";
import { discoverPluginManifests } from "./discovery";
import { pluginManifestSchema, type PluginManifest } from "./manifest";

export type PluginManifestEntry = { manifest: PluginManifest; path: string };
export type InstalledPluginEntryResolution = {
  entries: PluginManifestEntry[];
  errors: Array<{ id: string; error: Error }>;
  /**
   * Problems that were REPAIRED instead of skipped: the entry is in
   * `entries`, and the reason its recorded location was wrong is here. A
   * silent repair would hide exactly the drift that broke every plugin on
   * an installed Windows app (see `resolveEntryManifestPath`).
   */
  warnings: Array<{ id: string; error: Error }>;
};

/**
 * The lock's `manifest` field, in the one shape that survives the store
 * moving: a path RELATIVE to the store root, POSIX-separated.
 *
 * The field used to be an absolute path built from whichever store root was
 * current at install time. The store then moved inside the product — from
 * `<install>/plugin-store` to `<home>/.natalia/plugin-store`, the change that
 * took user plugins out of the tree the uninstaller deletes — and the copied
 * lock kept the old absolute paths. `resolveInstalledPluginEntries` requires
 * the manifest to be inside its package, so every one of those entries was
 * refused: measured on an installed Windows app, 15 of 16 official plugins
 * failed with "plugin manifest escapes package", which means NO plugin loaded
 * and every plugin-owned panel disappeared from the rail (the terminal tab,
 * the file tab, and every capability-gated control with them). A relative
 * record cannot drift that way.
 */
export function lockManifestPath(
  packageName: string,
  relativeManifest: string,
): string {
  return [
    "node_modules",
    ...packageName.split("/"),
    ...relativeManifest.split(/[\\/]/u),
  ].join("/");
}

/** A lock's recorded `manifest`, resolved against the store it belongs to. */
export function resolveLockManifestPath(
  pluginStoreRoot: string,
  recorded: string,
): string {
  return isAbsolute(recorded)
    ? resolve(recorded)
    : resolve(resolve(pluginStoreRoot), recorded);
}

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
  const warnings: InstalledPluginEntryResolution["warnings"] = [];
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
      warnings,
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
      const manifestPath = await resolveEntryManifestPath({
        pluginStoreRoot: input.pluginStoreRoot,
        packageRoot,
        recorded: locked.manifest,
        id,
        warnings,
      });
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
  return { entries, errors, warnings };
}

/**
 * Where a locked entry's manifest really is, in and only in its package.
 *
 * Two shapes reach here, and the difference is the whole point of the
 * relative record: a RELATIVE path resolves against the store root and cannot
 * go stale when the store moves; an ABSOLUTE one is what locks written before
 * that carried, and is honoured while it still lies inside the package.
 *
 * An absolute path that lies outside its package is the "store moved" case: it
 * is re-anchored to the package's OWN manifest — the same file the installer,
 * the plugin catalog and the discovery walk all read — and reported as a
 * warning, because a repair nobody is told about is how 15 dead plugins stayed
 * invisible. The re-anchored file still passes the realpath containment and
 * the content-hash pin below, so nothing outside the package can be loaded
 * either way. When the package has no manifest to anchor to, the entry fails
 * with the same "escapes package" refusal as before.
 */
async function resolveEntryManifestPath(input: {
  pluginStoreRoot: string;
  packageRoot: string;
  recorded: string;
  id: string;
  warnings: InstalledPluginEntryResolution["warnings"];
}): Promise<string> {
  const candidate = resolveLockManifestPath(
    input.pluginStoreRoot,
    input.recorded,
  );
  if (isInside(input.packageRoot, candidate)) return candidate;
  const anchored = await packageManifestPath(input.packageRoot, input.recorded);
  if (!anchored)
    throw new Error(
      `plugin ${input.id} manifest escapes package: ${candidate} is outside ` +
        `${input.packageRoot}, and that package declares no natalia.plugin.json`,
    );
  input.warnings.push({
    id: input.id,
    error: new Error(
      `plugin ${input.id} lock manifest path ${candidate} is outside its ` +
        `package — the lock is stale (a store that moved keeps absolute ` +
        `paths); the package's own ${anchored} was used`,
    ),
  });
  return anchored;
}

/** The package's own manifest: its root, or the single one below it. */
async function packageManifestPath(
  packageRoot: string,
  recorded: string,
): Promise<string | undefined> {
  const found = await discoverPluginManifests(packageRoot, {
    nodeModules: false,
  });
  const wanted = basename(recorded);
  return (
    found.find((entry) => basename(entry.path) === wanted)?.path ??
    (found.length === 1 ? found[0]!.path : undefined)
  );
}

function isInside(root: string, candidate: string) {
  const inside = relative(resolve(root), resolve(candidate));
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

function assertPathInside(root: string, candidate: string, message: string) {
  if (!isInside(root, candidate)) throw new Error(message);
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
