import { executableName, nataliaHomeJoin } from "@anthelia/platform";
import { computePluginPackageHash, lockManifestPath } from "@anthelia/plugin";
import {
  initializeOfficialPlugins,
  loadNataliaLock,
  reconcilePluginStoreLock,
  saveNataliaLock,
  OFFICIAL_PLUGIN_PACKAGES,
  type LockRepair,
  type OfficialPluginID,
} from "@natalia/installer";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";

const runtimeCommands = new Set(["serve", "run", "eval", "ui", "record"]);
const daemonCommands = new Set(["daemon", "daemon-status", "daemon-stop"]);
const localCommands = new Set([
  "diagnose",
  "status",
  "workgraph",
  "doctor",
  "session",
  "fs",
  "trust",
  "replay",
]);

export function isRecognizedHostCommand(argv: readonly string[]) {
  const command = argv[0];
  if (!command) return true;
  return (
    runtimeCommands.has(command) ||
    daemonCommands.has(command) ||
    localCommands.has(command)
  );
}

/**
 * Whether a path lives inside Bun's embedded filesystem, where a
 * standalone bundle mounts its own program read-only: `/$bunfs` on
 * POSIX, `B:\\~BUN\\` on Windows (the same two roots start-app and the
 * native-terminal bridge discovery record). A path there describes no
 * real install — accepting one puts the plugin store on a read-only
 * filesystem and kills every host command with EROFS. The check is the
 * platform's own, decided at runtime; the POSIX spelling is unchanged.
 */
function isBunEmbeddedPath(path: string): boolean {
  if (process.platform === "win32")
    return path.toLowerCase().includes("\\~bun\\");
  return path.startsWith("/$bunfs");
}

/**
 * The INSTALLED layout's distribution root, for a STANDALONE-EXECUTABLE
 * bundle: inside one, `process.execPath` AND `import.meta.dir` both live
 * in the read-only VFS (`/$bunfs/...` — proven by the crash stack
 * naming the program itself `/…/natalia` under `/$bunfs/root`), so every
 * path derived from them puts the official plugins' STORE on a
 * read-only filesystem and kills every host command with EROFS — doctor
 * included, the very next step the installer prints.
 *
 * The installed truth sits beside the REAL executable
 * (versions/<v>/plugins, writable sibling store). The real directory is
 * found by resolving how we were invoked — argv0 first (works for
 * `./natalia` and PATH-resolved launches), then a PATH scan — and only
 * a candidate that actually has `plugins/` wins. Env overrides and dev
 * paths above this branch still take precedence.
 */
/**
 * Where the REAL executable lives, in every context: kernel truth on
 * Linux (/proc/self/exe — immune to bun's argv0/execPath rewriting
 * inside the single-executable VFS), then argv0 (symlinks resolved —
 * the installer's bin/natalia lands on versions/<v>), then a PATH scan.
 * Anything inside the embedded filesystem is rejected outright: the VFS
 * lies about location. One source of truth — the plugin distribution
 * AND the doctor's layer census both ask this question.
 */
export function realExecutableDirs(input: {
  argv0?: string;
  execPath: string;
  pathEnv?: string;
}): string[] {
  const roots: string[] = [];
  const push = (p: string | undefined) => {
    if (p && !isBunEmbeddedPath(p)) roots.push(p);
  };
  try {
    push(dirname(realpathSync("/proc/self/exe")));
  } catch {
    /* not Linux / unavailable */
  }
  try {
    push(dirname(realpathSync(input.argv0 ?? "")));
  } catch {
    /* bare name or missing: next candidate */
  }
  if (!isBunEmbeddedPath(input.execPath)) {
    try {
      push(dirname(realpathSync(input.execPath)));
    } catch {
      /* dev-style paths fall through to the caller's default */
    }
  }
  // The separator is the platform's own (":" on POSIX, ";" on Windows)
  // and the binary carries the platform's suffix: a Windows install is
  // found as natalia.exe on a ";"-separated PATH, which the POSIX
  // spelling never matched — the whole scan was dead there.
  for (const dir of (input.pathEnv ?? process.env.PATH ?? "").split(
    delimiter,
  )) {
    if (!dir) continue;
    try {
      push(dirname(realpathSync(join(dir, executableName("natalia")))));
    } catch {
      /* not there */
    }
  }
  return [...new Set(roots)];
}

export function installedPluginDistributionRoots(input: {
  argv0?: string;
  execPath: string;
  pathEnv?: string;
}): string[] {
  return realExecutableDirs(input);
}

export function installedPluginDistributionRoot(
  input: Parameters<typeof installedPluginDistributionRoots>[0],
): string | undefined {
  for (const root of installedPluginDistributionRoots(input)) {
    const candidate = resolve(root, "plugins");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The plugin store: the ONE user-data home's, in every context.
 *
 * It used to be a SIBLING of the distribution root — `<install>/plugin-store`,
 * `<repo>/dist/ts/plugin-store` — with a special case that re-anchored it to
 * the home when the distribution root lived inside the read-only VFS
 * (`isBunEmbeddedPath`). Both halves were wrong for the product. Downloaded
 * plugins are USER data living inside the install tree, which is the tree the
 * uninstaller deletes: removing the program took the user's plugins with it.
 * And "dev" and "installed" disagreed about where the same store was, so
 * `refresh:plugin-store` populated one directory while a runtime read another.
 *
 * Deriving it from the home deletes the special case outright: a path that is
 * never derived from the distribution root cannot land in the VFS. A dev or
 * test flow that needs its own store says so with `NATALIA_PLUGIN_STORE` —
 * an explicit injection, not a second rule.
 */
export const NATALIA_PLUGIN_STORE_ENV = "NATALIA_PLUGIN_STORE";

export function resolvePluginStoreRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env[NATALIA_PLUGIN_STORE_ENV]?.trim();
  // `nataliaHomeJoin`, not `nataliaHomePath`: the latter reads `process.env`
  // itself, so a caller that injects an environment would silently get the
  // ambient home — which is what a test asserting the injected one catches.
  return explicit
    ? resolve(explicit)
    : nataliaHomeJoin({ env }, "plugin-store");
}

export function pluginStoreRoot() {
  return resolvePluginStoreRoot();
}

export function officialPluginDistributionRoot() {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.NATALIA_TEST_OFFICIAL_PLUGIN_DISTRIBUTION
  )
    return resolve(process.env.NATALIA_TEST_OFFICIAL_PLUGIN_DISTRIBUTION);
  if (process.env.NATALIA_TS_VERSION) {
    // TS_VERSION is BAKED into standalone bundles as the version stamp,
    // so this branch means "bundled" at runtime — NOT "dev TS". The
    // bundle's import.meta.dir is the VFS root (/$bunfs), which is how
    // this used to poison both the distribution root and its store
    // onto a read-only path. Resolve from the REAL executable instead;
    // a source checkout (no bake) never enters here and keeps the dev
    // default below.
    const installed = installedPluginDistributionRoot({
      argv0: process.argv0,
      execPath: process.execPath,
    });
    if (installed) return installed;
  }
  if (process.env.NATALIA_DEV_PLUGIN_DISTRIBUTION)
    return resolve(process.env.NATALIA_DEV_PLUGIN_DISTRIBUTION);
  return resolve(import.meta.dir, "../../../dist/ts/plugins");
}

const DEV_PLUGIN_PACKAGES: ReadonlyArray<{
  id: OfficialPluginID;
  directory: string;
  source: string;
}> = [
  {
    // Manifest id, not a copy of it: see OFFICIAL_PLUGIN_PACKAGES.
    id: "natalia-tool-browser",
    directory: "natalia-browser",
    source: "packages/plugins/browser",
  },
  {
    id: "natalia-tool-web",
    directory: "natalia-tool-web",
    source: "packages/plugins/tools/web",
  },
];

async function pathExists(path: string) {
  return await access(path).then(
    () => true,
    () => false,
  );
}

/**
 * Point two plugins at the checkout's SOURCE while developing them.
 *
 * Only into a store the dev flow asked for (`NATALIA_PLUGIN_STORE`). The store
 * a plain run resolves is the product's own, in the one home, and writing dev
 * shims there is not a dev convenience: the shim re-exports a file inside the
 * checkout, so the INSTALLED app then loads a plugin whose import cannot
 * resolve, and reports it. Measured on a real store: `natalia-tool-web` failed
 * with "Cannot find package '@anthelia/tools' imported from
 * E:\\Development\\natalia-cli\\packages\\plugins\\tools\\web\\src\\web-tools.ts"
 * — a checkout path in a shipped runtime's diagnostic, and a plugin the user
 * lost. The rest of the store's plugins come from the installer and stay
 * authoritative.
 */
async function syncDevOfficialPlugins() {
  if (process.env.NATALIA_TS_VERSION) return;
  if (!process.env[NATALIA_PLUGIN_STORE_ENV]?.trim()) {
    console.warn(
      `[official-plugins] not pointing the browser and web plugins at this ` +
        `checkout's sources: ${NATALIA_PLUGIN_STORE_ENV} is unset, so the ` +
        `store is the product's own. Set it (refresh:plugin-store writes ` +
        `dist/ts/plugin-store) to develop those two plugins from source.`,
    );
    return;
  }
  const workspaceRoot = resolve(import.meta.dir, "../../..");
  for (const plugin of DEV_PLUGIN_PACKAGES) {
    const official = OFFICIAL_PLUGIN_PACKAGES.find(
      (entry) => entry.id === plugin.id,
    );
    if (!official) continue;
    const sourceDir = resolve(workspaceRoot, plugin.source);
    const sourceEntry = resolve(sourceDir, "src", "index.ts");
    if (!(await pathExists(sourceEntry))) continue;
    const storeRoot = pluginStoreRoot();
    const packageRoot = resolve(
      storeRoot,
      "node_modules",
      ...official.packageName.split("/"),
    );
    await rm(packageRoot, { recursive: true, force: true });
    await mkdir(packageRoot, { recursive: true });
    const specifier = pathToFileURL(sourceEntry).href;
    await writeFile(
      join(packageRoot, "index.ts"),
      `export { default } from ${JSON.stringify(specifier)};\n`,
    );
    for (const name of ["package.json", "LICENSE"]) {
      const from = resolve(sourceDir, name);
      if (await pathExists(from)) await cp(from, resolve(packageRoot, name));
    }
    const manifest = JSON.parse(
      await readFile(resolve(sourceDir, "natalia.plugin.json"), "utf8"),
    ) as {
      id?: string;
      entry?: string;
      scope?: "process" | "workspace" | "session";
      [key: string]: unknown;
    };
    manifest.entry = "index.ts";
    const manifestPath = join(packageRoot, "natalia.plugin.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    // The key is the manifest's OWN id and the recorded location is relative to
    // the store root: the table's id disagreed with the manifest for the
    // browser plugin, and an absolute path dies when the store moves. Both
    // mistakes were on disk in a real store.
    const pluginID = manifest.id ?? official.id;
    const lock = await loadNataliaLock(storeRoot);
    if (pluginID !== official.id)
      console.warn(
        `[official-plugins] ${official.id} declares manifest id ${pluginID}; ` +
          `recording the lock entry under the manifest's id`,
      );
    lock.plugins[pluginID] = {
      packageName: official.packageName,
      manifest: lockManifestPath(official.packageName, "natalia.plugin.json"),
      metadata: {
        id: pluginID,
        source: { type: "path", path: sourceDir },
        resolvedVersion: "1.0.0",
        // The pin is over what THIS run just wrote. Leaving it out is not
        // neutral: the entry this overwrites may carry an older pin, and a
        // kept stale pin refuses the entry at load ("package content does not
        // match natalia.lock") — a dev run silently bricking a plugin.
        contentHash: await computePluginPackageHash(packageRoot),
        scope: manifest.scope ?? "session",
        dependencies: [],
      },
    };
    await saveNataliaLock(storeRoot, lock);
  }
}

/**
 * Carry an existing install's plugin store into the one home, once.
 *
 * The store used to be a sibling of the distribution root, so an install that
 * ran before that moved keeps its plugins — including any THIRD-PARTY one the
 * user installed — in `<install>/plugin-store`. The sixteen official plugins
 * are re-created from the distribution on the next run, but a package the user
 * added is only in the old directory, and "reinstall your plugins" is not a
 * migration.
 *
 * A COPY, not a move: the old directory belongs to the install it was written
 * by, and removing it is the uninstaller's business. It runs only when the
 * home store is ABSENT, so it can never overwrite what the new location
 * already holds — the two roots are also compared resolved, because a
 * `NATALIA_PLUGIN_STORE` that points at the legacy path must not copy a
 * directory onto itself.
 *
 * The LOCK REPAIR that follows the copy runs on every store, migrated or not,
 * because a store a migration already carried is exactly the broken one: the
 * copy holds the old lock verbatim, its absolute manifest paths point into the
 * directory the copy came from, and the loader refuses a manifest that is not
 * inside its own package — 15 of 16 official plugins refused on a real
 * install, so no plugin loaded and every plugin-owned panel vanished. See
 * `reconcilePluginStoreLock`.
 */
export async function migrateLegacyPluginStore(
  input: { storeRoot?: string; legacyRoot?: string } = {},
): Promise<{ migrated: boolean; from?: string; repairs: LockRepair[] }> {
  const storeRoot = resolve(input.storeRoot ?? pluginStoreRoot());
  let legacyRoot: string | undefined;
  if (input.legacyRoot !== undefined) {
    legacyRoot = resolve(input.legacyRoot);
  } else {
    // Only an INSTALLED distribution has a legacy store to carry, and the
    // distinction is not cosmetic: a checkout's sibling is the DEV store that
    // `refresh:plugin-store` writes on purpose, so copying it into the home
    // once would freeze it — the next refresh writes the repository copy and
    // the runtime would keep reading the stale one. This asks the same
    // resolver the distribution root itself uses, so "installed" means what it
    // means everywhere else here.
    const installed = installedPluginDistributionRoot({
      argv0: process.argv0,
      execPath: process.execPath,
    });
    if (installed)
      legacyRoot = resolve(join(dirname(installed), "plugin-store"));
  }
  let migrated = false;
  if (
    legacyRoot !== undefined &&
    legacyRoot !== storeRoot &&
    !(await pathExists(storeRoot)) &&
    (await pathExists(legacyRoot))
  ) {
    await cp(legacyRoot, storeRoot, { recursive: true });
    migrated = true;
  }
  const repairs = await reconcilePluginStoreLock(storeRoot);
  for (const repair of repairs)
    console.warn(
      `[official-plugins] repaired the plugin store lock: ${repair.key}: ${repair.detail}`,
    );
  return {
    migrated,
    ...(migrated && legacyRoot !== undefined ? { from: legacyRoot } : {}),
    repairs,
  };
}

export async function initializeCliOfficialPlugins(
  initialize: typeof initializeOfficialPlugins = initializeOfficialPlugins,
) {
  // Before initialization, so the migrated store is what initialization then
  // finds (and so it does not re-install from the distribution over a store
  // the user already had).
  const migration = await migrateLegacyPluginStore();
  if (migration.migrated)
    console.warn(
      `[official-plugins] carried the plugin store into ${pluginStoreRoot()} ` +
        `from ${migration.from}; the old directory was left in place`,
    );
  const result = await initialize({
    pluginStoreRoot: pluginStoreRoot(),
    distributionRoot: officialPluginDistributionRoot(),
  });
  if (initialize === initializeOfficialPlugins) await syncDevOfficialPlugins();
  return result;
}

export async function initializeOfficialPluginsForHostCommand(
  argv: readonly string[],
  initialize: typeof initializeOfficialPlugins = initializeOfficialPlugins,
) {
  if (!isRecognizedHostCommand(argv)) return false;
  // The four obligations (constitution §1.3, the plugins zone): a plugin
  // boundary failure must not take the caller down. Official-plugin
  // bootstrap does real I/O — npm into the store — and a first run with
  // a full/read-only disk or no network used to throw straight out of
  // EVERY host command (doctor included, the installer's advertised next
  // step): the boundary defends, warns once, and the command proceeds
  // with plugins not-yet-initialized (their absence is reported, not
  // fatal).
  try {
    await initializeCliOfficialPlugins(initialize);
  } catch (error) {
    console.warn(
      "[official-plugins] initialization deferred:",
      error instanceof Error ? error.message : String(error),
    );
  }
  return true;
}

export function officialPluginID(value: string): OfficialPluginID {
  return value as OfficialPluginID;
}
