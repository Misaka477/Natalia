export { configPatch } from "./service-merge";
export {
  defaultGlobalConfigPath,
  GLOBAL_MODEL_CONFIG_KEYS,
  resolveConfig,
} from "./service-resolution";
export {
  migrateProjectModelConfigToGlobal,
  updateConfig,
  updateConfigAtScope,
  updateGlobalConfig,
} from "./service-write";
export type {
  ConfigPatch,
  ConfigScope,
  ConfigSource,
  ConfigWriteScope,
  ResolvedConfig,
} from "./service-types";
