import {
  CONFIG_READ_DEADLINE,
  CONFIG_READ_WINDOW,
  CONFIG_VERSION,
  configV3Schema,
  configV4Schema,
  type ConfigV4,
} from "@anthelia/contracts";

/**
 * The config's version contract (洞 4 — the only one of the seven
 * load-bearing surfaces that had none).
 *
 * Three refusals and one conversion, in this order:
 *
 *  1. **NEWER than this runtime knows** — a v5 file read by a v4 runtime is
 *     refused with both numbers named. Silently parsing it as v4 would
 *     drop every field v5 added and report success on a config nobody
 *     read. A newer config is never misread.
 *  2. **Below the read window** — versions older than
 *     CURRENT - CONFIG_READ_WINDOW are refused by name.
 *  3. **Past the deadline** — the oldest readable version's window closes
 *     on CONFIG_READ_DEADLINE; after it, a v3 file is refused with the
 *     date named. An unbounded read window is a promise nobody calendared.
 *  4. **The conversion** — v3 → v4: the version bump, plus the fields the
 *     deleted mechanisms left behind are stripped and NAMED in the
 *     warnings. A converter that silently dropped them would leave a
 *     config that claims settings nothing reads.
 *
 * The shapes are otherwise identical, so the conversion is honest about
 * being small: the contract is the work, not a field shuffle.
 */

export type MigrationSummary = {
  fromVersion: number;
  toVersion: number;
  changed: string[];
  warnings: string[];
  backupPath?: string;
};

export type MigrationResult = {
  config: ConfigV4;
  summary: MigrationSummary;
};

/** The fields v3 carried that v4 does not: the deleted mechanisms' leftovers. */
const DROPPED_FROM_V3: Array<{ path: string; because: string }> = [
  {
    path: "backgroundReview.evolutionTrigger",
    because:
      "the S8 trigger law is deleted (D4 is the trigger); the switch gates nothing",
  },
];

export function defaultConfigV4(): ConfigV4 {
  return configV4Schema.parse({ version: CONFIG_VERSION });
}

/** The refusal every path below throws: named versions, named reason. */
function refuse(message: string): never {
  throw new Error(message);
}

function schemaIssues(error: {
  issues: Array<{ path: Array<string | number>; message: string }>;
}): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

export function migrateConfig(
  input: unknown,
  now: Date = new Date(),
): MigrationResult {
  if (typeof input !== "object" || input === null)
    refuse(
      "config carries no version — a config file must be a JSON object with a numeric version",
    );
  const version = (input as { version?: unknown }).version;
  if (typeof version !== "number" || !Number.isInteger(version))
    refuse(
      `config carries no integer version (got ${JSON.stringify(version)}) — this runtime reads v${CONFIG_VERSION}`,
    );

  // 1. NEWER than known: refuse, never misread.
  if (version > CONFIG_VERSION)
    refuse(
      `this config is v${version}; this runtime reads up to v${CONFIG_VERSION} — a newer config is refused rather than silently misread as v${CONFIG_VERSION}`,
    );

  // 2. Below the read window.
  const oldest = CONFIG_VERSION - CONFIG_READ_WINDOW;
  if (version < oldest)
    refuse(
      `config v${version} is below the read window (v${oldest}..v${CONFIG_VERSION}); migrate it forward with a runtime that still reads it`,
    );

  // 3. The current version: parse as-is.
  if (version === CONFIG_VERSION) {
    const parsed = configV4Schema.safeParse(input);
    if (!parsed.success)
      refuse(
        `config v${version} does not match the v${CONFIG_VERSION} schema: ${schemaIssues(parsed.error)}`,
      );
    return {
      config: parsed.data,
      summary: {
        fromVersion: version,
        toVersion: CONFIG_VERSION,
        changed: [],
        warnings: [],
      },
    };
  }

  // 4. The oldest readable version (v3 today): the deadline, then convert.
  const deadline = Date.parse(`${CONFIG_READ_DEADLINE}T23:59:59Z`);
  if (now.getTime() > deadline)
    refuse(
      `config v${version}'s read window closed on ${CONFIG_READ_DEADLINE}; this runtime reads v${oldest}..v${CONFIG_VERSION} and the deadline has passed`,
    );

  const legacy = configV3Schema.safeParse(input);
  if (!legacy.success)
    refuse(
      `config v${version} does not match the v${version} schema it claims: ${schemaIssues(legacy.error)}`,
    );

  const warnings: string[] = [];
  const dropped = DROPPED_FROM_V3.filter(({ path }) =>
    hasPath(input as Record<string, unknown>, path),
  );
  for (const { path, because } of dropped)
    warnings.push(`dropped ${path}: ${because}`);

  const converted = configV4Schema.parse({
    ...stripPaths(
      input as Record<string, unknown>,
      dropped.map(({ path }) => path),
    ),
    version: CONFIG_VERSION,
  });
  return {
    config: converted,
    summary: {
      fromVersion: version,
      toVersion: CONFIG_VERSION,
      changed: [`version ${version} -> v${CONFIG_VERSION}`],
      warnings,
    },
  };
}

function hasPath(root: Record<string, unknown>, path: string): boolean {
  let node: unknown = root;
  for (const segment of path.split(".")) {
    if (typeof node !== "object" || node === null) return false;
    if (!(segment in (node as Record<string, unknown>))) return false;
    node = (node as Record<string, unknown>)[segment];
  }
  return true;
}

function stripPaths(
  root: Record<string, unknown>,
  paths: readonly string[],
): Record<string, unknown> {
  const clone = structuredClone(root);
  for (const path of paths) {
    const segments = path.split(".");
    let node: Record<string, unknown> = clone;
    for (const segment of segments.slice(0, -1)) {
      const next = node[segment];
      if (typeof next !== "object" || next === null) break;
      node = next as Record<string, unknown>;
    }
    delete node[segments.at(-1)!];
  }
  return clone;
}

export function migrationSummaryText(summary: MigrationSummary) {
  const lines = [
    `config migration: v${summary.fromVersion} -> v${summary.toVersion}`,
    ...summary.changed.map((item) => `changed: ${item}`),
    ...summary.warnings.map((item) => `warning: ${item}`),
    summary.backupPath ? `backup: ${summary.backupPath}` : undefined,
  ].filter(Boolean) as string[];
  return lines.join("\n");
}
