import type { ConfigV3 } from "@anthelia/contracts";

export type ConfigScope =
  | "defaults"
  | "global"
  | "project"
  | "local"
  | "environment";

export type ConfigWriteScope = "global" | "project";

export type ConfigPatch = {
  [Key in keyof ConfigV3]?: ConfigV3[Key] extends Array<unknown>
    ? ConfigV3[Key]
    : ConfigV3[Key] extends Record<string, unknown>
      ? ConfigPatchValue<ConfigV3[Key]>
      : ConfigV3[Key];
};

type ConfigPatchValue<Value extends Record<string, unknown>> = {
  [Key in keyof Value]?: Value[Key] extends Array<unknown>
    ? Value[Key]
    : Value[Key] extends Record<string, unknown>
      ? ConfigPatchValue<Value[Key]>
      : Value[Key];
};

export type ConfigSource = {
  scope: ConfigScope;
  path?: string;
  applied: boolean;
  diagnostic?: string;
};

export type ResolvedConfig = {
  config: ConfigV3;
  sources: ConfigSource[];
  projectConfigPath: string;
};
