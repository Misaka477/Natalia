export type MigratedPluginRule = {
  id: string;
  targets: readonly string[];
  forbidden: ReadonlyArray<{ description: string; pattern: RegExp }>;
};

export type MigratedPluginViolation = {
  pluginID: string;
  description: string;
};
