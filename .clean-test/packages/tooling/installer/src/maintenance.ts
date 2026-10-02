import { discoverPluginManifests } from "@anthelia/plugin";
import {
  loadNataliaLock,
  packageDirectory,
  pluginClosurePaths,
  runNpm,
  type PackageManagerRun,
} from "./closure";
import { installPlugin } from "./lifecycle";
import { sourceSpec } from "./package-metadata";

export type PluginDoctorFinding = {
  pluginID: string;
  code: "package_missing" | "manifest_mismatch";
  message: string;
};

type ReconcileSeams = { installPlugin?: typeof installPlugin };

export async function doctorPlugins(
  pluginStoreRoot: string,
): Promise<PluginDoctorFinding[]> {
  const lock = await loadNataliaLock(pluginStoreRoot);
  const findings: PluginDoctorFinding[] = [];
  for (const [id, entry] of Object.entries(lock.plugins)) {
    const manifest = (
      await discoverPluginManifests(
        packageDirectory(
          pluginClosurePaths(pluginStoreRoot).pluginsDir,
          entry.packageName,
        ),
        { nodeModules: false },
      )
    )[0]?.manifest;
    if (!manifest)
      findings.push({
        pluginID: id,
        code: "package_missing",
        message: `plugin ${id} package is missing from the installation closure`,
      });
    else if (
      manifest.id !== id ||
      manifest.version !== entry.metadata.resolvedVersion
    )
      findings.push({
        pluginID: id,
        code: "manifest_mismatch",
        message: `plugin ${id} manifest does not match natalia.lock`,
      });
  }
  return findings;
}

export async function reconcilePlugins(
  pluginStoreRoot: string,
  runPackageManager: PackageManagerRun = runNpm,
  seams: ReconcileSeams = {},
) {
  const lock = await loadNataliaLock(pluginStoreRoot);
  const findings = await doctorPlugins(pluginStoreRoot);
  for (const finding of findings) {
    if (finding.code !== "package_missing") continue;
    const entry = lock.plugins[finding.pluginID];
    if (!entry) continue;
    await (seams.installPlugin ?? installPlugin)({
      pluginStoreRoot,
      spec: sourceSpec(entry.metadata.source),
      runPackageManager,
    });
  }
  return {
    reconciled: true as const,
    findings,
    remaining: await doctorPlugins(pluginStoreRoot),
  };
}
