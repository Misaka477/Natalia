import { configV3Schema, type ConfigV3 } from "@anthelia/contracts";

export type MigrationSummary = {
  fromVersion: number;
  toVersion: 3;
  changed: string[];
  warnings: string[];
  backupPath?: string;
};

export type MigrationResult = {
  config: ConfigV3;
  summary: MigrationSummary;
};

export function defaultConfigV3(): ConfigV3 {
  return configV3Schema.parse({ version: 3 });
}

export function migrateConfig(input: unknown): MigrationResult {
  const parsed = configV3Schema.safeParse(input);
  if (parsed.success) {
    return {
      config: parsed.data,
      summary: {
        fromVersion: 3,
        toVersion: 3,
        changed: [],
        warnings: [],
      },
    };
  }

  throw new Error("only Config v3 JSON configuration is supported");
}

export function migrationSummaryText(summary: MigrationSummary) {
  const lines = [
    `config migration: ${summary.fromVersion} -> v${summary.toVersion}`,
    ...summary.changed.map((item) => `changed: ${item}`),
    ...summary.warnings.map((item) => `warning: ${item}`),
    summary.backupPath ? `backup: ${summary.backupPath}` : undefined,
  ].filter(Boolean) as string[];
  return lines.join("\n");
}
