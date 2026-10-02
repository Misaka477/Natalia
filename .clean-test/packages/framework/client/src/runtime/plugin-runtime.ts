import {
  OFFICIAL_PLUGIN_PACKAGES,
  installPlugin,
  listInstalledPlugins,
  loadNataliaLock,
  saveNataliaLock,
  setPluginEnabled,
  uninstallPlugin,
  type PackageManagerRun,
} from "@natalia/installer";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { computePluginPackageHash } from "@anthelia/plugin";
import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import type { RuntimeContext } from "@anthelia/substrate";

type OfficialPlugin = (typeof OFFICIAL_PLUGIN_PACKAGES)[number];

async function installOfficialLocal(
  pluginStoreRoot: string,
  official: OfficialPlugin,
) {
  const distributionRoot = resolve(pluginStoreRoot, "..", "plugins");
  const sourceDir = resolve(distributionRoot, official.directory);
  const packagesDir = resolve(pluginStoreRoot, "node_modules");
  const packageRoot = resolve(packagesDir, ...official.packageName.split("/"));
  await mkdir(packagesDir, { recursive: true });
  await rm(packageRoot, { recursive: true, force: true });
  await cp(sourceDir, packageRoot, { recursive: true });
  const lock = await loadNataliaLock(pluginStoreRoot);
  lock.plugins[official.id] = {
    packageName: official.packageName,
    manifest: resolve(packageRoot, "natalia.plugin.json"),
    metadata: {
      id: official.id,
      source: {
        type: "path",
        path: sourceDir,
      },
      resolvedVersion: "1.0.0",
      // Our pin over the copied files — the load-time verification's
      // anchor, the same one the installer records for managed installs.
      contentHash: await computePluginPackageHash(packageRoot),
      scope: "session",
      dependencies: [],
    },
  };
  await saveNataliaLock(pluginStoreRoot, lock);
  return {
    installed: true,
    pluginID: official.id,
    packageName: official.packageName,
  };
}

type PluginRuntime = Pick<
  RuntimeServiceClient,
  "pluginInstall" | "pluginUninstall" | "pluginSetEnabled" | "pluginCatalog"
>;

export function createPluginRuntime(
  ctx: RuntimeContext,
  seams?: { runPackageManager?: PackageManagerRun },
): PluginRuntime {
  async function requirePluginStore(): Promise<string> {
    if (!ctx.state.pluginStoreRoot)
      throw new Error("plugin store is not configured for this runtime");
    return ctx.state.pluginStoreRoot;
  }

  // Every plugin mutation reconciles the live plugin set on a config reload.
  // Refuse while a turn is running or an approval/question is pending so the
  // reload cannot tear a plugin out from under a live execution — and, for
  // uninstall, so files are never deleted for a reload that then gets blocked.
  function assertPluginMutationAllowed(): void {
    const blocked = ctx.ports.configReloadBlockedReason?.();
    if (blocked) throw new Error(blocked);
  }

  return {
    async pluginCatalog() {
      const pluginStoreRoot = await requirePluginStore();
      return await listInstalledPlugins({
        pluginStoreRoot,
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
      });
    },
    async pluginInstall(input) {
      const pluginStoreRoot = await requirePluginStore();
      assertPluginMutationAllowed();
      const official = OFFICIAL_PLUGIN_PACKAGES.find(
        (plugin) => plugin.packageName === input.spec,
      );
      const result = official
        ? await installOfficialLocal(pluginStoreRoot, official)
        : await installPlugin({
            pluginStoreRoot,
            spec: input.spec,
            workspaceRoot: ctx.ports.getWorkspaceRoot(),
            runPackageManager: seams?.runPackageManager,
          });
      await ctx.ports.reloadConfigFromDisk?.();
      return result;
    },
    async pluginUninstall(input) {
      const pluginStoreRoot = await requirePluginStore();
      // Uninstall is a delete-then-reload transaction: `uninstallPlugin`
      // removes the package and its lock entry, and only the subsequent config
      // reload actually unloads the plugin from the runtime. Refuse while a
      // turn is running or an approval/question is pending — otherwise the
      // reload is blocked and the files are already gone, leaving a plugin
      // running in memory with no package on disk (audit finding B-01).
      assertPluginMutationAllowed();
      const result = await uninstallPlugin({
        pluginStoreRoot,
        pluginID: input.pluginID,
        runPackageManager: seams?.runPackageManager,
      });
      // The files are already deleted; the reload is what releases the plugin.
      // If it did not apply, the runtime still holds a plugin whose package is
      // gone — surface that instead of reporting a clean uninstall.
      const reload = await ctx.ports.applyConfigFromDisk?.();
      if (reload && !reload.applied) {
        throw new Error(
          reload.reason ??
            `plugin ${input.pluginID} was removed from disk but the runtime did not unload it`,
        );
      }
      return result;
    },
    async pluginSetEnabled(input) {
      const pluginStoreRoot = await requirePluginStore();
      assertPluginMutationAllowed();
      const result = await setPluginEnabled({
        pluginStoreRoot,
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
        pluginID: input.pluginID,
        enabled: input.enabled,
        apply: async () => {
          await ctx.ports.reloadConfigFromDisk?.();
        },
      });
      return result;
    },
  };
}
