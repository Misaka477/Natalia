export type MigrationDiagnosticLevel = "info" | "warning" | "error";

export type MigrationDiagnostic = {
  level: MigrationDiagnosticLevel;
  code: string;
  message: string;
  path?: string;
  supported: boolean;
};

export type VersionedMigrationStep<T> = {
  id: string;
  fromVersion: number | "legacy";
  toVersion: number;
  apply(input: T): Promise<T> | T;
};

export type VersionedMigrationResult<T> = {
  value: T;
  fromVersion: number | "legacy";
  toVersion: number;
  applied: string[];
  diagnostics: MigrationDiagnostic[];
};

export class VersionedMigrationRegistry<T> {
  private steps: VersionedMigrationStep<T>[] = [];

  constructor(private readonly currentVersion: number) {}

  register(step: VersionedMigrationStep<T>) {
    if (this.steps.some((item) => item.id === step.id))
      throw new Error(`duplicate migration step: ${step.id}`);
    this.steps.push(step);
  }

  async migrate(input: {
    value: T;
    fromVersion: number | "legacy";
    diagnostics?: MigrationDiagnostic[];
  }): Promise<VersionedMigrationResult<T>> {
    let value = input.value;
    let version = input.fromVersion;
    const applied: string[] = [];
    while (version !== this.currentVersion) {
      const step = this.steps.find((item) => item.fromVersion === version);
      if (!step)
        return {
          value,
          fromVersion: input.fromVersion,
          toVersion: this.currentVersion,
          applied,
          diagnostics: [
            ...(input.diagnostics ?? []),
            {
              level: "error",
              code: "migration.unsupported_version",
              message: `No TS migration step from ${version} to ${this.currentVersion}`,
              supported: false,
            },
          ],
        };
      value = await step.apply(value);
      applied.push(step.id);
      version = step.toVersion;
    }
    return {
      value,
      fromVersion: input.fromVersion,
      toVersion: this.currentVersion,
      applied,
      diagnostics: input.diagnostics ?? [],
    };
  }
}
