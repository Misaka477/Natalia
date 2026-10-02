import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { updateConfig } from "@anthelia/config";
import type { NataliaLock } from "@anthelia/contracts";
import {
  closureDependencies,
  loadNataliaLock,
  npmInstallArgs,
  npmUninstallArgs,
  packageDirectory,
  pluginClosurePaths,
  runNpm,
  saveNataliaLock,
  withStoreLock,
  type PackageManagerRun,
} from "./closure";
import { validateStagedPackage } from "./package-metadata";
import { packageSource, sourceSpec } from "./package-metadata";
import { retiredPluginPackageReason } from "./retired";

const workspaceOperations = new Map<string, Promise<void>>();

export async function serialized<T>(
  pluginStoreRoot: string,
  operation: () => Promise<T>,
) {
  await mkdir(resolve(pluginStoreRoot), { recursive: true, mode: 0o700 });
  const key = await realpath(resolve(pluginStoreRoot));
  const previous = workspaceOperations.get(key) ?? Promise.resolve();
  const result = previous
    .catch(() => undefined)
    .then(() => withStoreLock(key, "operation", operation));
  const pending = result.then(
    () => undefined,
    () => undefined,
  );
  workspaceOperations.set(key, pending);
  return await result.finally(() => {
    if (workspaceOperations.get(key) === pending)
      workspaceOperations.delete(key);
  });
}

export type InstallerConfigOptions = { globalPath?: string };
type LifecycleSeams = {
  saveLock?: typeof saveNataliaLock;
  updateConfig?: typeof updateConfig;
};

export async function installPlugin(input: {
  pluginStoreRoot: string;
  spec: string;
  workspaceRoot?: string;
  config?: InstallerConfigOptions;
  runPackageManager?: PackageManagerRun;
  seams?: LifecycleSeams;
}) {
  return await serialized(input.pluginStoreRoot, async () => {
    // The kill list asks FIRST — before paths, before the package manager,
    // before anything is staged: a retired package is a door, not a cleanup,
    // so a refusal leaves no trace on disk.
    const retired = retiredPluginPackageReason(input.spec);
    if (retired) throw new Error(retired);
    const paths = pluginClosurePaths(input.pluginStoreRoot);
    const run = input.runPackageManager ?? runNpm;
    const [beforeLock, beforeDependencies] = await Promise.all([
      loadNataliaLock(input.pluginStoreRoot),
      closureDependencies(paths.pluginsDir),
    ]);
    try {
      await run({
        cwd: input.pluginStoreRoot,
        args: npmInstallArgs(paths.pluginsDir, input.spec),
      });
      const afterDependencies = await closureDependencies(paths.pluginsDir);
      const packageName = resolveInstalledPackageName({
        spec: input.spec,
        beforeDependencies,
        afterDependencies,
        lock: beforeLock,
      });
      const installed = await validateStagedPackage(
        paths.pluginsDir,
        input.spec,
        packageName,
      );
      assertPackageOwnership(
        beforeLock,
        installed.packageName,
        installed.manifest.id,
      );
      const lock = structuredClone(beforeLock);
      lock.plugins[installed.manifest.id] = {
        packageName: installed.packageName,
        manifest: join(
          packageDirectory(paths.pluginsDir, installed.packageName),
          installed.relativeManifest,
        ),
        metadata: installed.metadata,
      };
      await (input.seams?.saveLock ?? saveNataliaLock)(
        input.pluginStoreRoot,
        lock,
      );
      if (input.workspaceRoot)
        await (input.seams?.updateConfig ?? updateConfig)(
          input.workspaceRoot,
          {
            plugins: { enabled: { [installed.manifest.id]: true } },
          },
          input.config,
        );
      return {
        installed: true as const,
        pluginID: installed.manifest.id,
        packageName: installed.packageName,
        metadata: installed.metadata,
        ...(input.workspaceRoot
          ? { enabled: true as const, workspaceRoot: input.workspaceRoot }
          : {}),
      };
    } catch (error) {
      const afterDependencies = await closureDependencies(paths.pluginsDir);
      const extras = Object.keys(afterDependencies).filter(
        (name) => beforeDependencies[name] !== afterDependencies[name],
      );
      for (const packageName of extras)
        try {
          await run({
            cwd: input.pluginStoreRoot,
            args: npmUninstallArgs(paths.pluginsDir, packageName),
          });
        } catch {
          // Keep the original install failure; leftover packages are best-effort.
        }
      throw error;
    }
  });
}

export async function setPluginEnabled(input: {
  pluginStoreRoot: string;
  workspaceRoot: string;
  pluginID: string;
  enabled: boolean;
  apply?: () => Promise<void>;
  config?: InstallerConfigOptions;
  seams?: LifecycleSeams;
}) {
  return await serialized(input.pluginStoreRoot, async () => {
    const lock = await loadNataliaLock(input.pluginStoreRoot);
    if (!lock.plugins[input.pluginID])
      throw new Error(`unknown plugin: ${input.pluginID}`);
    await (input.seams?.updateConfig ?? updateConfig)(
      input.workspaceRoot,
      {
        plugins: { enabled: { [input.pluginID]: input.enabled } },
      },
      input.config,
    );
    await input.apply?.();
    return { pluginID: input.pluginID, enabled: input.enabled };
  });
}

export async function uninstallPlugin(input: {
  pluginStoreRoot: string;
  pluginID: string;
  runPackageManager?: PackageManagerRun;
  seams?: LifecycleSeams;
}) {
  return await serialized(input.pluginStoreRoot, async () => {
    const lock = await loadNataliaLock(input.pluginStoreRoot);
    const installed = lock.plugins[input.pluginID];
    if (!installed) throw new Error(`unknown plugin: ${input.pluginID}`);
    const paths = pluginClosurePaths(input.pluginStoreRoot);
    await (input.runPackageManager ?? runNpm)({
      cwd: input.pluginStoreRoot,
      args: npmUninstallArgs(paths.pluginsDir, installed.packageName),
    });
    delete lock.plugins[input.pluginID];
    await (input.seams?.saveLock ?? saveNataliaLock)(
      input.pluginStoreRoot,
      lock,
    );
    return {
      uninstalled: true,
      pluginID: input.pluginID,
      disposition: "removed" as const,
    };
  });
}

function resolveInstalledPackageName(input: {
  spec: string;
  beforeDependencies: Record<string, string>;
  afterDependencies: Record<string, string>;
  lock: NataliaLock;
}) {
  const changed = Object.keys(input.afterDependencies).filter(
    (name) => input.beforeDependencies[name] !== input.afterDependencies[name],
  );
  if (changed.length === 1) return changed[0]!;
  const source = packageSource(input.spec);
  if (source.type === "registry") {
    const packageName = registryPackageName(source.spec);
    if (packageName && input.afterDependencies[packageName]) return packageName;
  }
  const locked = Object.values(input.lock.plugins).filter(
    (entry) => sourceSpec(entry.metadata.source) === sourceSpec(source),
  );
  if (changed.length === 0 && locked.length === 1)
    return locked[0]!.packageName;
  if (changed.length === 0 && Object.keys(input.afterDependencies).length === 1)
    return Object.keys(input.afterDependencies)[0]!;
  throw new Error(
    `plugin install must change exactly one direct dependency; found ${changed.length}`,
  );
}

function registryPackageName(spec: string) {
  const match = /^(?<name>@[^/]+\/[^@]+|[^@/][^@]*)?(?:@.*)?$/u.exec(spec);
  return match?.groups?.name;
}

function assertPackageOwnership(
  lock: NataliaLock,
  packageName: string,
  pluginID: string,
) {
  const idOwner = lock.plugins[pluginID];
  if (idOwner && idOwner.packageName !== packageName)
    throw new Error(
      `plugin id ${pluginID} is already owned by package ${idOwner.packageName}`,
    );
  const packageOwner = Object.entries(lock.plugins).find(
    ([, entry]) => entry.packageName === packageName,
  );
  if (packageOwner && packageOwner[0] !== pluginID)
    throw new Error(
      `package ${packageName} is already installed as plugin ${packageOwner[0]}; changing plugin id to ${pluginID} is not supported`,
    );
}
