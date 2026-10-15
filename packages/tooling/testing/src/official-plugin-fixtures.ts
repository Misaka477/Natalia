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

import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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

/**
 * One official-plugin install shared by every workspace in the test
 * process, anchored to this file like the distribution above.
 *
 * Why it exists: a plugin bundle inlines its dependencies — zod, the config
 * schemas, hundreds of kilobytes of module state per plugin — and the ESM
 * registry keys evaluations by URL and never releases them for the life of
 * the process. A store per workspace therefore re-evaluates every official
 * bundle once per test and retains it: measured at ~50MB per test, which is
 * what put the real-runtime files at 4GB each while every assertion passed.
 * Symlinking each workspace's node_modules at this one install makes every
 * workspace resolve the same realpaths, so the bundles evaluate once for the
 * whole run. A workspace's own store keeps its lock, marker and package
 * bookkeeping, so per-workspace install state — which plugins are enabled,
 * which fixture is installed — stays isolated; the per-workspace natalia.lock
 * decides what loads, not what sits on disk.
 *
 * It lives beside client-test-workspaces rather than inside it: the
 * test-workspace hygiene guard fails on any directory left under that root,
 * and this one is deliberately long-lived. Freshness is self-healing — a
 * rebuilt distribution is newer than the marker and triggers a reinstall.
 */
export const sharedPluginStoreRoot = resolve(
  import.meta.dir,
  "../../../../dist/ts/shared-plugin-store",
);

// In-process serialization is enough: bun runs every test file of a run in
// ONE process, so a memoized promise is the lock, and this module is the one
// both fixture assemblies import it from. (A second concurrent `bun test` on
// the same checkout is not a supported shape; the worst case there is a
// failed install that the freshness check heals on the next run.)
let sharedPluginStoreReady: Promise<void> | undefined;

/** Makes sure the shared official-plugin install exists and is current. */
export async function ensureSharedPluginStore(): Promise<void> {
  sharedPluginStoreReady ??= installSharedPluginStore();
  await sharedPluginStoreReady;
}

async function installSharedPluginStore(): Promise<void> {
  const marker = join(sharedPluginStoreRoot, "official-plugins-initialized-v1");
  const distributionMtime = await newestFileMtime(officialPluginDistribution);
  const fresh = await stat(marker)
    .then((stats) => stats.mtimeMs >= distributionMtime)
    .catch(() => false);
  if (fresh) return;
  await rm(sharedPluginStoreRoot, { recursive: true, force: true });
  await initializeOfficialPlugins({
    pluginStoreRoot: sharedPluginStoreRoot,
    distributionRoot: officialPluginDistribution,
    runPackageManager: installPrebuiltPackage,
  });
  await stageNativeTerminalBridge();
}

/**
 * Put the Windows ConPTY bridge where the terminal plugin looks for it.
 *
 * The store is assembled from `dist/ts/plugins`, and `build:distribution`
 * — the build the whole suite runs on — sets NATALIA_BUILD_SKIP_NATIVE, so
 * ts-build stages no bridge at all. A store-loaded plugin on Windows has no
 * second answer: the POSIX Python fallback needs the POSIX pty module, so
 * every pane died with "the ConPTY bridge is not built" naming a path inside
 * the store that nothing had written. Measured: `interactive_terminal_start`
 * failed with exactly that message, and `nativeTerminalList()` returned [].
 *
 * The checkout's own prebuilt drop (`native-terminal:build-conpty:windows`)
 * is what a release stages beside its executable, so it is copied to the
 * tier the resolver reads — inside the plugin package, which is the one
 * candidate that resolves out of a store.
 *
 * Windows only, and only when the drop exists: on POSIX the Python bridge is
 * the tested default and staging the Rust one would silently switch which
 * backend the suite measures. A missing drop leaves the plugin's own loud
 * error naming the build command, which is the designed behaviour.
 */
async function stageNativeTerminalBridge(): Promise<void> {
  if (process.platform !== "win32") return;
  const triple = `windows-${process.arch === "x64" ? "x64" : process.arch}`;
  const bridge = resolve(
    import.meta.dir,
    "../../../../packages/plugins/native-terminal/prebuilt",
    triple,
    "natalia-conpty-bridge.exe",
  );
  if (!(await Bun.file(bridge).exists())) return;
  const target = join(
    sharedPluginStoreRoot,
    "node_modules",
    "@natalia",
    "plugin-native-terminal",
    "pty-bridge",
  );
  await mkdir(target, { recursive: true });
  await cp(bridge, join(target, "natalia-conpty-bridge.exe"));
}

async function newestFileMtime(root: string): Promise<number> {
  let newest = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestFileMtime(full));
      continue;
    }
    newest = Math.max(newest, (await stat(full)).mtimeMs);
  }
  return newest;
}

/**
 * Points a store's node_modules at the shared install.
 *
 * The installer's own containment checks (a package must realpath inside its
 * store's node_modules) still hold: the symlink resolves into the shared
 * store, so both sides of every check land in the same tree. What changes is
 * only the URL the loader evaluates — one per plugin for the whole run.
 */
async function linkSharedNodeModules(pluginStoreRoot: string): Promise<void> {
  await mkdir(pluginStoreRoot, { recursive: true });
  await rm(join(pluginStoreRoot, "node_modules"), {
    recursive: true,
    force: true,
  });
  await symlink(
    join(sharedPluginStoreRoot, "node_modules"),
    join(pluginStoreRoot, "node_modules"),
    // A directory junction on Windows: same link, no SeCreateSymbolicLink
    // privilege demanded of whoever runs the suite. POSIX takes "dir".
    process.platform === "win32" ? "junction" : "dir",
  );
}

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
    const sourcePath = join(source, file);
    if ((await stat(sourcePath)).isDirectory())
      await cp(sourcePath, destination, { recursive: true });
    // The shared install (see sharedPluginStoreRoot) means two workspaces
    // can install the same package concurrently: the second link finds the
    // destination already there with identical content, which is a no-op,
    // not a failure.
    else
      await link(sourcePath, destination).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
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
  await ensureSharedPluginStore();
  const parent = await mkdtemp(join(tmpdir(), "natalia-official-plugin-"));
  const workspaceRoot = join(parent, basename(prefix));
  await mkdir(workspaceRoot, { recursive: true });
  const pluginStoreRoot = officialPluginStoreRoot(workspaceRoot);
  await linkSharedNodeModules(pluginStoreRoot);
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
    JSON.stringify({ version: 4 }),
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
  await ensureSharedPluginStore();
  await linkSharedNodeModules(pluginStoreRoot);
  await initializeOfficialPlugins({
    pluginStoreRoot,
    distributionRoot: officialPluginDistribution,
    runPackageManager: installPrebuiltPackage,
  });
}

/** The manifest's parse, re-exported for suites that assert on it. */
export { pluginManifestSchema };
