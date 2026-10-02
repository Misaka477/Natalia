export { nataliaLockSchema } from "@anthelia/contracts";
export type { NataliaLock } from "@anthelia/contracts";
export {
  loadNataliaLock,
  packageDirectory,
  pluginClosurePaths,
  saveNataliaLock,
  type PackageManagerRun,
} from "./closure";
export { listInstalledPlugins, type PluginCatalogRow } from "./catalog";
export { installPlugin, setPluginEnabled, uninstallPlugin } from "./lifecycle";
export {
  initializeOfficialPlugins,
  OFFICIAL_PLUGIN_PACKAGES,
  reinstallOfficialPlugin,
  resolveOfficialPluginPackage,
  type OfficialPluginID,
} from "./official";
export {
  doctorPlugins,
  reconcilePlugins,
  type PluginDoctorFinding,
} from "./maintenance";
export {
  RETIRED_PLUGIN_PACKAGES,
  retiredPluginPackageReason,
  specPackageName,
} from "./retired";
export * from "./update";
export * from "./channel";
