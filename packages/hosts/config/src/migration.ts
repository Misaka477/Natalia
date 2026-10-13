import {
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
 * Two refusals, one conversion, and one honest gap, in this order:
 *
 *  1. **NEWER than this runtime knows** — a v5 file read by a v4 runtime is
 *     refused with both numbers named. Silently parsing it as v4 would
 *     drop every field v5 added and report success on a config nobody
 *     read. A newer config is never misread.
 *  2. **Below the read window** — versions more than CONFIG_READ_WINDOW
 *     major versions behind are refused by name. The window IS the
 *     migration room, and it is version-based so it moves when a version
 *     ships rather than on a date somebody had to remember.
 *  3. **The conversion** — v3 → v4: the version bump, plus the fields the
 *     deleted mechanisms left behind are stripped and NAMED in the
 *     warnings. A converter that silently dropped them would leave a
 *     config that claims settings nothing reads.
 *  4. **In the window with no converter** — a version this runtime accepts
 *     by age but has never seen a shape for is refused saying exactly
 *     that, rather than guessed at. (Today that is v2: inside the window,
 *     no converter. When v5 ships the window slides to v3..v5 and v3 keeps
 *     its converter.)
 *
 * There is deliberately NO date deadline. The deadline IS the version at
 * which the window slides past the old form — an upgrade at vN is refused
 * at vN+2, so the room is two major versions and it needs no calendar. The
 * upgrade tooling that makes the room usable is `natalia config migrate`
 * (a rewrite in place with a timestamped backup): the loader's transparent
 * conversion keeps an old file WORKING, but only a rewrite survives the
 * window sliding past it, and a version-anchored refusal with no tool to
 * escape through is the failure this rule exists to prevent.
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

/**
 * The legacy converters this runtime carries, by the version they read.
 * A version inside the read window with no entry here is refused saying so
 * (see the module doc's case 4) — never guessed at.
 */
const LEGACY_CONVERTERS: Record<
  number,
  {
    schema: typeof configV3Schema;
    /** The fields this version carried that v4 does not, with the reason. */
    dropped: Array<{ path: string; because: string }>;
  }
> = {
  3: {
    schema: configV3Schema,
    dropped: [
      {
        path: "backgroundReview.evolutionTrigger",
        because:
          "the S8 trigger law is deleted (D4 is the trigger); the switch gates nothing",
      },
    ],
  },
};

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

export function migrateConfig(input: unknown): MigrationResult {
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

  // 4. Inside the window: convert, if this runtime has a converter for the
  // version. No path reads the clock — there is no deadline to enforce.
  const legacy = LEGACY_CONVERTERS[version];
  if (!legacy)
    refuse(
      `config v${version} is inside the read window (v${oldest}..v${CONFIG_VERSION}) but this runtime has no converter for it — it has never seen a v${version} shape; migrate it forward with a runtime that still reads it, or write a v${CONFIG_VERSION} config by hand`,
    );

  const parsedLegacy = legacy.schema.safeParse(input);
  if (!parsedLegacy.success)
    refuse(
      `config v${version} does not match the v${version} schema it claims: ${schemaIssues(parsedLegacy.error)}`,
    );

  const warnings: string[] = [];
  const dropped = legacy.dropped.filter(({ path }) =>
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
