import {
  initializeOfficialPlugins,
  loadNataliaLock,
  saveNataliaLock,
  OFFICIAL_PLUGIN_PACKAGES,
  type OfficialPluginID,
} from "@natalia/installer";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
 * Anything under /$bunfs is rejected outright: the VFS lies about
 * location. One source of truth — the plugin distribution AND the
 * doctor's layer census both ask this question.
 */
export function realExecutableDirs(input: {
  argv0?: string;
  execPath: string;
  pathEnv?: string;
}): string[] {
  const roots: string[] = [];
  const push = (p: string | undefined) => {
    if (p && !p.startsWith("/$bunfs")) roots.push(p);
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
  if (!input.execPath.startsWith("/$bunfs")) {
    try {
      push(dirname(realpathSync(input.execPath)));
    } catch {
      /* dev-style paths fall through to the caller's default */
    }
  }
  for (const dir of (input.pathEnv ?? process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      push(dirname(realpathSync(join(dir, "natalia"))));
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

/** The store follows its distribution root (sibling), both contexts alike. */
export function pluginStoreRootFrom(distributionRoot: string): string {
  return resolve(distributionRoot, "..", "plugin-store");
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
    id: "natalia-browser",
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

async function syncDevOfficialPlugins() {
  if (process.env.NATALIA_TS_VERSION) return;
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
    ) as { entry?: string; [key: string]: unknown };
    manifest.entry = "index.ts";
    const manifestPath = join(packageRoot, "natalia.plugin.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const lock = await loadNataliaLock(storeRoot);
    lock.plugins[official.id] = {
      packageName: official.packageName,
      manifest: manifestPath,
      metadata: {
        id: official.id,
        source: { type: "path", path: sourceDir },
        resolvedVersion: "1.0.0",
        scope: "session",
        dependencies: [],
      },
    };
    await saveNataliaLock(storeRoot, lock);
  }
}

/**
 * A store path must be WRITABLE: inside the bundle every derived path
 * lives under the read-only VFS, so the store falls back to the
 * user home anchor (NATALIA_HOME respected — the same layout purge and
 * install reason about). Dev/installed paths keep the sibling rule.
 */
export function writableStoreRoot(
  resolved: string,
  input: { env?: NodeJS.ProcessEnv; home?: string } = {},
): string {
  if (!resolved.startsWith("/$bunfs")) return resolved;
  const env = input.env ?? process.env;
  const anchor = env.NATALIA_HOME
    ? resolve(env.NATALIA_HOME)
    : resolve(input.home ?? homedir(), ".natalia");
  return join(anchor, "plugin-store");
}

export function pluginStoreRoot() {
  return writableStoreRoot(
    pluginStoreRootFrom(officialPluginDistributionRoot()),
  );
}

export async function initializeCliOfficialPlugins(
  initialize: typeof initializeOfficialPlugins = initializeOfficialPlugins,
) {
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
