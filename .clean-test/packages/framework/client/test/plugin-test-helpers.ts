import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { afterAll, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  initializeOfficialPlugins,
  OFFICIAL_PLUGIN_PACKAGES,
  type PackageManagerRun,
} from "@natalia/installer";
import {
  createRealRuntimeClient as createRuntimeClient,
  type RealRuntimeClientOptions,
} from "../src";
import { pluginManifestSchema } from "@anthelia/plugin";

// The official plugin distribution the repo build writes at the ROOT's
// dist/ts/plugins. Anchored to this file, not the CWD: the suite is run
// both from the repo root and from this package, and a CWD-relative
// resolve silently picked up a stale package-local copy in the latter
// (the "missing natalia-file-editor" phantom).
const officialPluginDistribution = resolve(
  import.meta.dir,
  "../../../../dist/ts/plugins",
);
const officialPluginTestWorkspaces = resolve(
  "dist",
  "ts",
  "client-test-workspaces",
);
const officialPluginConfigFixture = "official-plugin-config.test.json";
const officialPluginStoreSuffix = "-plugin-store";
const testWorkspaces = new Set<string>();
const allWorkspaces = new Set<string>();
const trackedClients = new Set<{ dispose?: () => Promise<void> }>();

/**
 * Registers this test file's workspace cleanup.
 *
 * Every test file that creates workspaces through this helper MUST call this
 * once at module scope. A module-scope `afterEach` inside an imported helper
 * only attaches to the first file that loads the module in a bun process
 * (probe: two files sharing one helper leave the second file's workspaces
 * behind), so the hooks have to be registered from the test file itself.
 *
 * The dispose-then-remove order is load-bearing: an undisposed runtime client
 * keeps async session persistence alive, and its next flush does
 * `mkdir(<workspace>/.natalia/sessions, { recursive: true })` — recreating the
 * workspace directory seconds after the removal, which is how a fully green
 * suite still left ~60 directories per run. Disposing first lands the flush
 * inside the workspace while it still exists, so the removal sticks.
 *
 * The one bounded settle lives in the afterAll pass rather than per test: a
 * child execution (a subagent's checkpoint journal) can write one file after
 * the parent dispose returns, so every workspace gets one re-removal after a
 * short delay — once per file instead of once per test, which keeps the suite
 * from paying hundreds of sleeps. The consequence of getting any of this
 * wrong is not a dirty directory: one leaked workspace per test filled the
 * disk until every verify failed with ENOSPC (95,927 leftovers exhausted
 * btrfs metadata). The test-workspace hygiene guard at the end of `npm test`
 * fails loudly on any residue, so a forgotten call cannot pass silently.
 */
export function useWorkspaceCleanup(): void {
  afterEach(async () => {
    const clients = [...trackedClients];
    trackedClients.clear();
    for (const client of clients) {
      try {
        await client.dispose?.();
      } catch {
        // A test that already disposed, or a client torn down mid-flight, is
        // not a cleanup failure; the workspace removal below still runs.
      }
    }
    const workspaces = [...testWorkspaces];
    testWorkspaces.clear();
    await Promise.all(
      workspaces.map((workspace) =>
        rm(workspace, { recursive: true, force: true }),
      ),
    );
  });
  afterAll(async () => {
    // Late child writes land here: a child execution's deferred flush can
    // recreate a removed workspace well after its test ended — under load the
    // lag reaches seconds (observed: a subagent's constitution write landing
    // long after its parent client disposed). Sweep in bounded passes and stop
    // the moment nothing survives, so a clean file pays nothing. rmSync is
    // deliberate: this runs at teardown and must not depend on further
    // event-loop turns.
    for (let pass = 0; pass < 8; pass++) {
      if (pass > 0) await new Promise((resolve) => setTimeout(resolve, 250));
      let remaining = 0;
      for (const workspace of allWorkspaces) {
        try {
          rmSync(workspace, { recursive: true, force: true });
          if (existsSync(workspace)) remaining++;
        } catch {
          remaining++;
        }
      }
      if (remaining === 0) break;
    }
    allWorkspaces.clear();
  });
}

/**
 * Registers a path outside `officialPluginWorkspace` for the same per-file
 * sweep — for artifacts a test derives from its workspace (e.g. the governance
 * ledger root real-runtime.test.ts points at a sibling directory). Unregistered
 * artifacts accumulate exactly like leaked workspaces did.
 */
export function registerTestArtifact(path: string): void {
  allWorkspaces.add(path);
}

export async function officialPluginWorkspace(prefix: string) {
  await assertOfficialPluginDistribution();
  await mkdir(officialPluginTestWorkspaces, { recursive: true });
  const workspaceRoot = await mkdtemp(
    join(officialPluginTestWorkspaces, basename(prefix)),
  );
  testWorkspaces.add(workspaceRoot);
  const pluginStoreRoot = officialPluginStoreRoot(workspaceRoot);
  testWorkspaces.add(pluginStoreRoot);
  allWorkspaces.add(workspaceRoot);
  allWorkspaces.add(pluginStoreRoot);
  await initializeOfficialPlugins({
    pluginStoreRoot,
    distributionRoot: officialPluginDistribution,
    runPackageManager: installPrebuiltPackage,
  });
  const configPath = join(workspaceRoot, ".natalia", "config.json");
  await mkdir(join(workspaceRoot, ".natalia"), { recursive: true });
  await writeFile(configPath, JSON.stringify({ version: 3 }));
  await writeFile(
    join(workspaceRoot, ".natalia", officialPluginConfigFixture),
    await readFile(configPath),
  );
  return workspaceRoot;
}

export function createOfficialRuntimeClient(
  options: RealRuntimeClientOptions = {},
) {
  restoreOfficialPluginConfig(options.workspaceRoot ?? process.cwd());
  const capabilityRegistry = options.capabilityRegistry;
  const client = createRuntimeClient({
    ...options,
    pluginStoreRoot:
      options.pluginStoreRoot ??
      officialPluginStoreRoot(options.workspaceRoot ?? process.cwd()),
    ...(capabilityRegistry ? { capabilityRegistry } : {}),
  });
  const reloadConfig = client.reloadConfig?.bind(client);
  if (reloadConfig)
    client.reloadConfig = async () => {
      restoreOfficialPluginConfig(options.workspaceRoot ?? process.cwd());
      return await reloadConfig();
    };
  const dispose = client.dispose?.bind(client);
  if (dispose)
    client.dispose = async () => {
      await dispose();
    };
  // Tracked so `useWorkspaceCleanup()` can dispose before removing the
  // workspace — otherwise the runtime's deferred session flush recreates the
  // directory after removal (see the hook's doc comment).
  trackedClients.add(client);
  return client;
}

export function officialPluginStoreRoot(workspaceRoot: string) {
  return `${workspaceRoot}${officialPluginStoreSuffix}`;
}

export async function installFixturePlugin(
  workspaceRoot: string,
  sourceRoot: string,
) {
  const manifest = pluginManifestSchema.parse(
    JSON.parse(await readFile(join(sourceRoot, "natalia.plugin.json"), "utf8")),
  );
  const pluginStoreRoot = officialPluginStoreRoot(workspaceRoot);
  const packageName = `fixture-${manifest.id}`;
  const packageRoot = join(pluginStoreRoot, "node_modules", packageName);
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(dirname(packageRoot), { recursive: true });
  await cp(sourceRoot, packageRoot, { recursive: true });
  const manifestPath = join(packageRoot, "natalia.plugin.json");
  const lockPath = join(pluginStoreRoot, "natalia.lock");
  const lock = await readJSONFile<{
    version: 1;
    plugins: Record<string, unknown>;
  }>(lockPath, { version: 1, plugins: {} });
  lock.plugins[manifest.id] = {
    packageName,
    manifest: manifestPath,
    metadata: {
      id: manifest.id,
      source: { type: "path", path: sourceRoot },
      resolvedVersion: manifest.version,
      scope: manifest.scope,
      dependencies: [],
    },
  };
  await writeFile(lockPath, JSON.stringify(lock));
}

export function restoreOfficialPluginConfig(workspaceRoot: string) {
  const fixturePath = join(
    workspaceRoot,
    ".natalia",
    officialPluginConfigFixture,
  );
  if (!existsSync(fixturePath)) return;
  const configPath = join(workspaceRoot, ".natalia", "config.json");
  try {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      plugins?: PluginConfig;
    };
    const current = existsSync(configPath)
      ? (JSON.parse(readFileSync(configPath, "utf8")) as {
          plugins?: PluginConfig;
        })
      : {};
    current.plugins = {
      ...fixture.plugins,
      ...current.plugins,
      enabled: {
        ...fixture.plugins?.enabled,
        ...current.plugins?.enabled,
      },
      packages: {
        ...fixture.plugins?.packages,
        ...current.plugins?.packages,
      },
    };
    writeFileSync(configPath, JSON.stringify(current));
  } catch {
    // Invalid config is intentional in rollback and diagnostic tests.
  }
}

type PluginConfig = {
  paths?: string[];
  enabled?: Record<string, boolean>;
  packages?: Record<string, unknown>;
};

async function assertOfficialPluginDistribution() {
  for (const { directory } of OFFICIAL_PLUGIN_PACKAGES) {
    const manifest = join(
      officialPluginDistribution,
      directory,
      "natalia.plugin.json",
    );
    try {
      await readFile(manifest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error(
          `framework client tests require prebuilt official plugins at ${officialPluginDistribution}; run ts:build first (missing ${manifest})`,
        );
      throw error;
    }
  }
}

const installPrebuiltPackage: PackageManagerRun = async ({ args }) => {
  if (args[0] !== "install")
    throw new Error(`unsupported test package-manager operation: ${args[0]}`);
  const prefix = args[args.indexOf("--prefix") + 1];
  const source = args.at(-1);
  if (!prefix || !source)
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
    // Native executable packaging is verified by the release lifecycle test.
    // Framework tests need the plugin module, not a 165 MB copy per workspace.
    if (file === "wezterm") continue;
    const destination = join(target, file);
    await mkdir(dirname(destination), { recursive: true });
    const sourcePath = join(source, file);
    if ((await stat(sourcePath)).isDirectory())
      await cp(sourcePath, destination, { recursive: true });
    else await link(sourcePath, destination);
  }

  const dependencies = await readJSON<Record<string, string>>(
    join(prefix, "package.json"),
    "dependencies",
  );
  dependencies[packageJSON.name] = packageJSON.version;
  await writeFile(
    join(prefix, "package.json"),
    JSON.stringify({ dependencies }),
  );
  const lockPath = join(prefix, "package-lock.json");
  const packages = await readJSON<Record<string, unknown>>(
    lockPath,
    "packages",
  );
  packages[`node_modules/${packageJSON.name}`] = {
    version: packageJSON.version,
  };
  await writeFile(lockPath, JSON.stringify({ lockfileVersion: 3, packages }));
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

async function readJSONFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

/**
 * Test helper: makes `@natalia/*` resolvable from a plugin workspace outside
 * the repo (bun resolves bare specifiers by walking up from the importing
 * file, and `/tmp` workspaces have no bun.lock/workspace context). Real
 * deployments must provide the same resolution — see the plugin guide's
 * dependency-resolution note.
 */
export async function installPluginSdkLinks(root: string) {
  const scoped = join(root, "node_modules", "@natalia");
  await mkdir(scoped, { recursive: true });
  for (const pkg of ["plugin", "contracts"]) {
    const target = join(scoped, pkg);
    try {
      await symlink(join(process.cwd(), "packages", pkg), target, "dir");
    } catch {
      // Windows without Developer Mode cannot create directory symlinks, and a
      // hard failure here would mask the plugin-loading behaviour under test.
      // A copy resolves identically inside the test process. The packages'
      // own node_modules links (bun junctions) cannot be copied either, so
      // they are excluded: `@anthelia/contracts` resolves from the sibling
      // copy, and anything else resolves up through the repository root.
      await cp(join(process.cwd(), "packages", pkg), target, {
        recursive: true,
        filter: (source) => !source.includes(`${sep}node_modules${sep}`),
      });
    }
  }
}

/**
 * The plugin SDK entry as a file URL for plugin test fixtures. Bare-specifier
 * resolution from a /tmp workspace is unreliable inside a test process that
 * has already resolved the specifier from the repo (bun caches resolution by
 * context), so fixtures import the SDK by absolute URL. A Windows drive path
 * must be a file URL: bun parses a raw `E:\...` import specifier as an
 * unix-style path and mangles the drive letter.
 */
export function pluginSdkImportPath(): string {
  return pathToFileURL(
    join(process.cwd(), "packages", "core", "plugin", "src", "index.ts"),
  ).href;
}
