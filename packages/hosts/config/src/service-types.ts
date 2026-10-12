import type { ConfigV4 } from "@anthelia/contracts";

export type ConfigScope =
  | "defaults"
  | "global"
  | "project"
  | "local"
  | "environment";

export type ConfigWriteScope = "global" | "project";

export type ConfigPatch = {
  [Key in keyof ConfigV4]?: ConfigV4[Key] extends Array<unknown>
    ? ConfigV4[Key]
    : ConfigV4[Key] extends Record<string, unknown>
      ? ConfigPatchValue<ConfigV4[Key]>
      : ConfigV4[Key];
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
  config: ConfigV4;
  sources: ConfigSource[];
  projectConfigPath: string;
};
