import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  pluginClosurePaths,
  withStoreLock,
  type PackageManagerRun,
} from "./closure";
import { installPlugin } from "./lifecycle";

export const OFFICIAL_PLUGIN_PACKAGES = [
  {
    id: "natalia-local-tools",
    packageName: "@natalia/plugin-local-tools",
    directory: "natalia-local-tools",
  },
  {
    id: "natalia-file-editor",
    packageName: "@natalia/plugin-file-editor",
    directory: "natalia-file-editor",
  },
  {
    // The plugin's id is its MANIFEST's id. This table said
    // `natalia-browser` while the manifest has always said
    // `natalia-tool-browser`, and every writer that keyed a lock entry by this
    // table produced an entry its own reader then refused ("manifest has id
    // natalia-tool-browser") — measured on a real store, as a permanently dead
    // entry. The `directory` is a distribution directory name, which is a
    // different thing and stays.
    id: "natalia-tool-browser",
    packageName: "@natalia/plugin-browser",
    directory: "natalia-browser",
  },
  {
    // The desktop driver. The manifest id is the distribution directory
    // name here, so no second spelling is introduced (the browser entry
    // above is why this comment exists at all).
    id: "natalia-tool-computer-use",
    packageName: "@natalia/plugin-native-computer-use",
    directory: "natalia-tool-computer-use",
  },
  {
    id: "natalia-skills",
    packageName: "@natalia/plugin-skills",
    directory: "natalia-skills",
  },
  {
    id: "natalia-team",
    packageName: "@natalia/plugin-team",
    directory: "natalia-team",
  },
  {
    id: "natalia-mcp",
    packageName: "@natalia/plugin-mcp",
    directory: "natalia-mcp",
  },
  {
    id: "natalia-tool-ask",
    packageName: "@natalia/plugin-tool-ask",
    directory: "natalia-tool-ask",
  },
  {
    id: "natalia-tool-fs-read",
    packageName: "@natalia/plugin-tool-fs-read",
    directory: "natalia-tool-fs-read",
  },
  {
    id: "natalia-tool-fs-write",
    packageName: "@natalia/plugin-tool-fs-write",
    directory: "natalia-tool-fs-write",
  },
  {
    id: "natalia-tool-process",
    packageName: "@natalia/plugin-tool-process",
    directory: "natalia-tool-process",
  },
  {
    id: "natalia-tool-search",
    packageName: "@natalia/plugin-tool-search",
    directory: "natalia-tool-search",
  },
  {
    id: "natalia-tool-shell",
    packageName: "@natalia/plugin-tool-shell",
    directory: "natalia-tool-shell",
  },
  {
    id: "natalia-tool-terminal",
    packageName: "@natalia/plugin-native-terminal",
    directory: "natalia-tool-terminal",
  },
  {
    id: "natalia-tool-todo",
    packageName: "@natalia/plugin-tool-todo",
    directory: "natalia-tool-todo",
  },
  {
    id: "natalia-tool-web",
    packageName: "@natalia/plugin-tool-web",
    directory: "natalia-tool-web",
  },
] as const;

export type OfficialPluginID = (typeof OFFICIAL_PLUGIN_PACKAGES)[number]["id"];

const initializationMarker = "official-plugins-initialized-v1";

export async function resolveOfficialPluginPackage(
  distributionRoot: string,
  pluginID: string,
) {
  const entry = OFFICIAL_PLUGIN_PACKAGES.find(({ id }) => id === pluginID);
  if (!entry) throw new Error(`unknown official plugin: ${pluginID}`);

  const root = await realpath(resolve(distributionRoot));
  const packageDirectory = await realpath(join(root, entry.directory)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT")
        throw new Error(
          `official plugin package is missing from distribution: ${pluginID}`,
        );
      throw error;
    },
  );
  const pathFromRoot = relative(root, packageDirectory);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    (await stat(packageDirectory)).isDirectory() === false
  )
    throw new Error(
      `official plugin package escapes distribution: ${pluginID}`,
    );
  return packageDirectory;
}

type OfficialInstallInput = {
  pluginStoreRoot: string;
  distributionRoot: string;
  runPackageManager?: PackageManagerRun;
};

type OfficialInstallSeams = {
  installPlugin?: typeof installPlugin;
};

export async function initializeOfficialPlugins(
  input: OfficialInstallInput & {
    pluginIDs?: readonly OfficialPluginID[];
    seams?: OfficialInstallSeams;
  },
) {
  return await withStoreLock(
    input.pluginStoreRoot,
    "official-initialization",
    async () => {
      const marker = join(resolve(input.pluginStoreRoot), initializationMarker);
      if (await fileExists(marker))
        return { initialized: false as const, installed: [] };

      const installed = [];
      for (const pluginID of input.pluginIDs ??
        OFFICIAL_PLUGIN_PACKAGES.map(({ id }) => id))
        installed.push(
          await (input.seams?.installPlugin ?? installPlugin)({
            pluginStoreRoot: input.pluginStoreRoot,
            spec: await resolveOfficialPluginPackage(
              input.distributionRoot,
              pluginID,
            ),
            runPackageManager: input.runPackageManager,
          }),
        );

      await writeInitializationMarker(marker);
      return { initialized: true as const, installed };
    },
  );
}

/**
 * Reinstall one official plugin from the distribution the runtime ships with.
 *
 * The staged package is REMOVED first, and that removal is the whole point.
 * `installPlugin` runs `npm install <absolute directory>`, and npm treats a
 * dependency the store already satisfies as up to date: the store's
 * package.json names this package, package-lock.json already records it at this
 * version, and the directory is present — so npm exits 0 and copies NOTHING
 * while `installPlugin` writes the freshly computed contentHash into
 * natalia.lock. Measured on a deployed store: `natalia plugin reinstall
 * natalia-tool-terminal` exited 0, the lock recorded the new hash, and
 * `node_modules/@natalia/plugin-native-terminal/index.js` was still the
 * PREVIOUS build (its mtime days old) — so the runtime loaded plugin code the
 * lock claimed it had replaced, and a fix that shipped in the release never
 * ran. Removing the staged directory is what makes npm re-materialize the
 * package from the distribution, which is what "reinstall" means.
 *
 * The spec is resolved BEFORE the removal, so a distribution that has lost (or
 * never had) the package fails without taking a working install with it.
 */
export async function reinstallOfficialPlugin(
  input: OfficialInstallInput & {
    pluginID: OfficialPluginID;
    seams?: OfficialInstallSeams;
  },
) {
  const spec = await resolveOfficialPluginPackage(
    input.distributionRoot,
    input.pluginID,
  );
  await removeStagedPackage(input.pluginStoreRoot, input.pluginID);
  return await (input.seams?.installPlugin ?? installPlugin)({
    pluginStoreRoot: input.pluginStoreRoot,
    spec,
    runPackageManager: input.runPackageManager,
  });
}

/** The directory a plugin id installs as, gone if it was there. */
async function removeStagedPackage(
  pluginStoreRoot: string,
  pluginID: OfficialPluginID,
) {
  const entry = OFFICIAL_PLUGIN_PACKAGES.find(({ id }) => id === pluginID);
  if (!entry) throw new Error(`unknown official plugin: ${pluginID}`);
  await rm(
    join(
      pluginClosurePaths(pluginStoreRoot).pluginsDir,
      "node_modules",
      ...entry.packageName.split("/"),
    ),
    { recursive: true, force: true },
  );
}

async function fileExists(path: string) {
  return await readFile(path)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
}

async function writeInitializationMarker(path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}`;
  try {
    await writeFile(temporary, "initialized\n", { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
