/**
 * The official-plugin fixture assembly, shared by every test that boots a
 * real runtime with plugins.
 *
 * It exists because a runtime told about a plugin store it never filled is
 * a runtime with no tools: the SDK's conformance suite pointed
 * `pluginStoreRoot` at the repository's shared `dist/ts/plugin-store` (a
 * refresh artifact), read its 16-plugin lock, and then registered NOTHING
 * — the store is populated by the CLI's npm path at install time, and a
 * test that names it directly gets a lock with no plugin modules. The
 * framework-client tests never hit this because they build their own
 * per-workspace store through this file's helpers.
 *
 * The rule: a test that wants official plugins gets its OWN store, filled
 * here from the repo's build output (`dist/ts/plugins`), with a package
 * "manager" that copies rather than npm-installs (no network, no native
 * executables — the release lifecycle test verifies those).
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  initializeOfficialPlugins,
  type PackageManagerRun,
} from "@natalia/installer";
import { pluginManifestSchema } from "@anthelia/plugin";

/**
 * The official plugin distribution the repo build writes at the ROOT's
 * dist/ts/plugins. Anchored to this file, not the CWD: the suite is run
 * from many directories.
 */
const officialPluginDistribution = resolve(
  import.meta.dir,
  "../../../../dist/ts/plugins",
);

/** Asserts the build output exists — the honest failure, not a phantom. */
export async function assertOfficialPluginDistribution(): Promise<void> {
  for (const directory of [
    join(officialPluginDistribution, "natalia-tool-fs-read"),
    join(officialPluginDistribution, "natalia-tool-fs-write"),
    join(officialPluginDistribution, "natalia-local-tools"),
  ]) {
    try {
      await readFile(join(directory, "natalia.plugin.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error(
          `tests require prebuilt official plugins at ${officialPluginDistribution}; run ts:build first (missing ${directory})`,
        );
      throw error;
    }
  }
}

/** The store a test workspace owns: `<workspace>-plugin-store`. */
export function officialPluginStoreRoot(workspaceRoot: string): string {
  return `${workspaceRoot}-plugin-store`;
}

/**
 * The package-manager seam for the installer: a copy of the built package
 * into the store, in place of an npm install. Network-free and native-free
 * (the release lifecycle test owns the executables).
 */
const installPrebuiltPackage: PackageManagerRun = async ({ cwd, args }) => {
  if (args[0] !== "install")
    throw new Error(`unsupported test package-manager operation: ${args[0]}`);
  const prefix = args[args.indexOf("--prefix") + 1];
  const source = args.at(-1);
  if (!prefix || !source || !cwd)
    throw new Error("invalid test package-manager install arguments");
  const packageJSON = JSON.parse(
    await readFile(join(source, "package.json"), "utf8"),
  ) as { name: string; version: string; files?: string[] };
  const target = join(prefix, "node_modules", ...packageJSON.name.split("/"));
  await mkdir(target, { recursive: true });
  for (const file of new Set([
    "package.json",
    "natalia.plugin.json",
    ...(packageJSON.files ?? []),
  ])) {
    if (file === "wezterm") continue;
    const destination = join(target, file);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(source, file), destination, { recursive: true });
  }
  // The store's own dependency record: the lifecycle derives the installed
  // package NAME from the change in that file (before/after), so a seam
  // that copies modules without writing it leaves the installer with
  // nothing to attribute — "must change exactly one direct dependency;
  // found 0" — and every official plugin fails to install.
  const dependencies = await readJSON<Record<string, string>>(
    join(prefix, "package.json"),
    "dependencies",
  );
  dependencies[packageJSON.name] = packageJSON.version;
  await writeFile(
    join(prefix, "package.json"),
    JSON.stringify({ dependencies }),
  );
  const packages = await readJSON<Record<string, unknown>>(
    join(prefix, "package-lock.json"),
    "packages",
  );
  packages[`node_modules/${packageJSON.name}`] = {
    version: packageJSON.version,
  };
  await writeFile(
    join(prefix, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages }),
  );
};

async function readJSON<T extends object>(
  path: string,
  key: string,
): Promise<T> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    return (value[key] as T | undefined) ?? ({} as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {} as T;
    throw error;
  }
}

/**
 * A workspace whose official-plugin store is filled and whose config
 * enables every official plugin (the default `{}` config leaves them
 * discoverable but unloaded).
 */
export async function officialPluginWorkspace(
  prefix: string,
): Promise<{ workspaceRoot: string; pluginStoreRoot: string }> {
  await assertOfficialPluginDistribution();
  const parent = await mkdtemp(join(tmpdir(), "natalia-official-plugin-"));
  const workspaceRoot = join(parent, basename(prefix));
  await mkdir(workspaceRoot, { recursive: true });
  const pluginStoreRoot = officialPluginStoreRoot(workspaceRoot);
  await initializeOfficialPlugins({
    pluginStoreRoot,
    distributionRoot: officialPluginDistribution,
    runPackageManager: installPrebuiltPackage,
  });
  // The workspace's own config directory: the runtime reads config.json
  // from here, and a workspace whose parent mkdtemp made but whose
  // .natalia was never created refuses the first write with ENOENT.
  await mkdir(join(workspaceRoot, ".natalia"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".natalia", "config.json"),
    JSON.stringify({ version: 3 }),
  );
  return { workspaceRoot, pluginStoreRoot };
}

/** Removes a workspace and its store (the failure safety net). */
export async function removeOfficialPluginWorkspace(
  workspaceRoot: string,
): Promise<void> {
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(officialPluginStoreRoot(workspaceRoot), {
    recursive: true,
    force: true,
  });
}

/**
 * Fills an EXISTING store the same way (for suites that already own their
 * store layout, such as the framework-client's per-workspace roots).
 */
export async function fillOfficialPluginStore(
  pluginStoreRoot: string,
): Promise<void> {
  await assertOfficialPluginDistribution();
  await initializeOfficialPlugins({
    pluginStoreRoot,
    distributionRoot: officialPluginDistribution,
    runPackageManager: installPrebuiltPackage,
  });
}

/** The manifest's parse, re-exported for suites that assert on it. */
export { pluginManifestSchema };
