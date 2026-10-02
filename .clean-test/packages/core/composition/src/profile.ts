import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * The composition profile — interface spec §6: a row is one bindable
 * fact `{ id, impl?, config?, disabled? }` in four namespaces
 * (anthelia./natalia./plugin:/facet:), loaded from three layers with
 * fixed order and per-row origin (spec §6.3):
 *
 *   <app>/composition.base.json          shipped, read-only
 *   <home>/.natalia/composition.d/*.json user layer, lexicographic
 *   <ws>/.natalia/composition.d/*.json   workspace layer, lexicographic
 *
 * Override semantics are §6.2's, not a priority merge: same id, each
 * top-level field the upper layer MENTIONS replaces wholesale (config
 * included — no deep merge), unmentioned fields keep the lower layer's,
 * and deletion is inexpressible (retire a row with `disabled: true`;
 * absence from an overlay must never look like a delete — the base is
 * shared). Unknown row ids/impls and invalid configs fail at activation
 * with the FILE and every legal value named (§6.4), because an error
 * that does not say what is allowed is half an error.
 *
 * Every file is a versioned envelope — the same "data never contains
 * code" guarantee as JSON config, applied structurally.
 */

export const COMPOSITION_PROFILE_SCHEMA =
  "natalia.composition-profile/1" as const;
export const COMPOSITION_BASE_FILENAME = "composition.base.json";
const ROW_NAMESPACES = ["anthelia.", "natalia.", "plugin:", "facet:"] as const;
const ENVELOPE_KEYS = ["schema", "rows"];
const ROW_KEYS = ["id", "impl", "config", "disabled"];

export type CompositionProfileLayer = "base" | "user" | "workspace";

export type CompositionRowOrigin = {
  layer: CompositionProfileLayer;
  file: string;
};

export type CompositionRow = {
  id: string;
  impl?: string;
  config?: Record<string, unknown>;
  disabled?: boolean;
};

export type PositionedCompositionRow = CompositionRow & {
  origin: CompositionRowOrigin;
};

export type CompositionProfile = {
  schema: typeof COMPOSITION_PROFILE_SCHEMA;
  rows: PositionedCompositionRow[];
  /**
   * §6.6's composition hash: the canonical form of these rows (sorted
   * by id, ORIGINS STRIPPED, present-keys-only JSON) under SHA-256 —
   * computed ONCE at load so every consumer (the switched event's
   * compositionHash, RINA's cache key, later speculative/manifest
   * keys) reads one derivation instead of recomputing. Content-
   * addressed, never sequential.
   */
  hash: string;
};

/**
 * A registered row's config schema, structurally: zod's safeParse
 * satisfies this without profile.ts importing zod (the registration
 * sites pass their real schemas; tsc checks the shape at that seam).
 */
export type CompositionConfigSchema = {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: Record<string, unknown> }
    | { success: false; error: { issues: ReadonlyArray<{ message: string }> } };
};

export type CompositionRowRegistration = {
  rowID: string;
  /** Selectable impls for the row; empty = none exist yet (§6.1). */
  implIDs: readonly string[];
  /** Names every legal value an error must list (§6.4). */
  legalSummary: string;
  /**
   * The capability keys this row's impls may DECLARE (G6). Empty or
   * absent = the row declares no capabilities. A key outside this list,
   * in a generation's adapter snapshot, is rejected at compose and
   * re-checked at the gate — a capability nobody registered cannot be
   * sworn to.
   */
  capKeys?: readonly string[];
  configSchema: CompositionConfigSchema;
  /**
   * The schema's import site — the ORIGIN the spec's §6.5 codegen
   * annotates (nixpkgs `declarations`) and the type it derives
   * `z.input<…>` from: composition.d.ts IMPORTS the real schema instead
   * of re-spelling it, so the file cannot drift from the code.
   */
  configSchemaRef?: { from: string; name: string };
};

export type CompositionRowRegistry = {
  get(rowID: string): CompositionRowRegistration | undefined;
  ids(): string[];
};

export function createCompositionRowRegistry(
  registrations: readonly CompositionRowRegistration[],
): CompositionRowRegistry {
  const map = new Map<string, CompositionRowRegistration>();
  for (const registration of registrations) {
    if (!registration.rowID)
      throw new Error("composition row registration has no row id");
    if (!ROW_NAMESPACES.some((prefix) => registration.rowID.startsWith(prefix)))
      throw new Error(
        `composition row "${registration.rowID}" is outside the four namespaces (legal prefixes: ${ROW_NAMESPACES.join(" / ")})`,
      );
    if (map.has(registration.rowID))
      throw new Error(
        `composition row "${registration.rowID}" registered twice`,
      );
    map.set(registration.rowID, registration);
  }
  return {
    get: (rowID) => map.get(rowID),
    ids: () => [...map.keys()].sort(),
  };
}

type ParsedLayerRow = {
  id: string;
  implPresent: boolean;
  impl?: string;
  configPresent: boolean;
  config?: Record<string, unknown>;
  disabledPresent: boolean;
  disabled?: boolean;
};

const own = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

async function readEnvelope(file: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(
      `composition profile "${file}" unreadable: ${(error as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `composition profile "${file}" is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(
      `composition profile "${file}" must be an envelope object {schema, rows}`,
    );
  const envelope = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(envelope).filter(
    (key) => !ENVELOPE_KEYS.includes(key),
  );
  if (unknownKeys.length)
    throw new Error(
      `composition profile "${file}" has unknown keys [${unknownKeys.join(", ")}] (legal: ${ENVELOPE_KEYS.join(", ")})`,
    );
  if (envelope.schema !== COMPOSITION_PROFILE_SCHEMA)
    throw new Error(
      `composition profile "${file}" has schema ${JSON.stringify(envelope.schema)} (expected ${COMPOSITION_PROFILE_SCHEMA})`,
    );
  if (!Array.isArray(envelope.rows))
    throw new Error(`composition profile "${file}": rows must be an array`);
  return envelope.rows;
}

function validateRow(
  file: string,
  raw: unknown,
  index: number,
  registry: CompositionRowRegistry,
): ParsedLayerRow {
  const at = `${file}: row #${index}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error(`${at} must be an object`);
  const row = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(row).filter((key) => !ROW_KEYS.includes(key));
  if (unknownKeys.length)
    throw new Error(
      `${at} has unknown keys [${unknownKeys.join(", ")}] (legal: ${ROW_KEYS.join(", ")})`,
    );
  const id = row.id;
  if (typeof id !== "string" || !id)
    throw new Error(`${at} needs a non-empty string id`);
  const registration = registry.get(id);
  if (!registration)
    throw new Error(
      `${file}: row "${id}" is not a registered composition row (registered: ${registry.ids().join(", ")})`,
    );
  let impl: string | undefined;
  if (own(row, "impl")) {
    if (typeof row.impl !== "string" || !row.impl)
      throw new Error(`${file}: row "${id}" impl must be a non-empty string`);
    if (!registration.implIDs.includes(row.impl))
      throw new Error(
        `${file}: row "${id}" impl "${row.impl}" is unknown (impls for this row: ${registration.implIDs.join(", ") || "none — the backend is discovered at runtime, not selected"})`,
      );
    impl = row.impl;
  }
  let config: Record<string, unknown> | undefined;
  let configPresent = false;
  if (own(row, "config")) {
    if (
      typeof row.config !== "object" ||
      row.config === null ||
      Array.isArray(row.config)
    )
      throw new Error(`${file}: row "${id}" config must be an object`);
    const parsed = registration.configSchema.safeParse(row.config);
    if (!parsed.success)
      throw new Error(
        `${file}: row "${id}" config invalid — ${parsed.error.issues.map((issue) => issue.message).join("; ")} — legal values: ${registration.legalSummary}`,
      );
    config = parsed.data;
    configPresent = true;
  }
  let disabled: boolean | undefined;
  if (own(row, "disabled")) {
    if (typeof row.disabled !== "boolean")
      throw new Error(`${file}: row "${id}" disabled must be a boolean`);
    disabled = row.disabled;
  }
  return {
    id,
    implPresent: own(row, "impl"),
    impl,
    configPresent,
    config,
    disabledPresent: own(row, "disabled"),
    disabled,
  };
}

/** §6.2: whole-field override per top level key; new ids insert. */
function applyLayerRow(
  effective: Map<string, { row: CompositionRow; origin: CompositionRowOrigin }>,
  layerRow: ParsedLayerRow,
  origin: CompositionRowOrigin,
): void {
  const existing = effective.get(layerRow.id);
  if (!existing) {
    effective.set(layerRow.id, {
      row: {
        id: layerRow.id,
        ...(layerRow.implPresent ? { impl: layerRow.impl } : {}),
        ...(layerRow.configPresent ? { config: layerRow.config } : {}),
        ...(layerRow.disabledPresent ? { disabled: layerRow.disabled } : {}),
      },
      origin,
    });
    return;
  }
  if (layerRow.implPresent) existing.row.impl = layerRow.impl;
  if (layerRow.configPresent) existing.row.config = layerRow.config;
  if (layerRow.disabledPresent) existing.row.disabled = layerRow.disabled;
  // The last defining layer owns the attribution: origin is what tells
  // the user "your override" apart from "the shipped default".
  existing.origin = origin;
}

/**
 * Read one layer file, validated row by row against the registry — the
 * same validation `loadCompositionProfile` applies per layer, exposed for
 * faces that validate a layer BEFORE it becomes one. §6.4's fail-fast at
 * the earliest resolvable point: the alternative is a boot-time error the
 * user cannot trace back to the command that wrote the file.
 */
export async function readCompositionLayer(
  file: string,
  registry: CompositionRowRegistry,
): Promise<CompositionRow[]> {
  const rows = await readEnvelope(file);
  return rows.map((raw, index) => {
    const parsed = validateRow(file, raw, index, registry);
    return {
      id: parsed.id,
      ...(parsed.implPresent ? { impl: parsed.impl } : {}),
      ...(parsed.configPresent ? { config: parsed.config } : {}),
      ...(parsed.disabledPresent ? { disabled: parsed.disabled } : {}),
    };
  });
}

async function listLayerFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(
      `composition drop-in layer "${dir}" unreadable: ${(error as Error).message}`,
    );
  }
  return entries
    .filter(
      (entry) => entry.name.endsWith(".json") && entry.isDirectory() === false,
    )
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => join(dir, entry.name))
    .sort();
}

/**
 * The canonical composition form (§6.6): rows sorted by id, ORIGINS
 * STRIPPED (they are provenance, not composition), each row reduced to
 * its present keys in a fixed order — then SHA-256 of that JSON.
 */
export function compositionProfileHash(
  rows: readonly PositionedCompositionRow[],
): string {
  const canonical = [...rows]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => ({
      id: row.id,
      ...(row.impl === undefined ? {} : { impl: row.impl }),
      ...(row.config === undefined ? {} : { config: row.config }),
      ...(row.disabled === undefined ? {} : { disabled: row.disabled }),
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export async function loadCompositionProfile(input: {
  baseFile: string;
  globalDir?: string | undefined;
  workspaceDir?: string | undefined;
  registry: CompositionRowRegistry;
}): Promise<CompositionProfile> {
  const effective = new Map<
    string,
    { row: CompositionRow; origin: CompositionRowOrigin }
  >();
  const applyFile = async (
    file: string,
    layer: CompositionProfileLayer,
  ): Promise<void> => {
    const rows = await readEnvelope(file);
    const origin: CompositionRowOrigin = { layer, file };
    rows.forEach((raw, index) =>
      applyLayerRow(
        effective,
        validateRow(file, raw, index, input.registry),
        origin,
      ),
    );
  };
  await applyFile(input.baseFile, "base");
  if (input.globalDir)
    for (const file of await listLayerFiles(input.globalDir))
      await applyFile(file, "user");
  if (input.workspaceDir)
    for (const file of await listLayerFiles(input.workspaceDir))
      await applyFile(file, "workspace");
  const rows: PositionedCompositionRow[] = [...effective.values()]
    .map(({ row, origin }) => ({ ...row, origin }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    schema: COMPOSITION_PROFILE_SCHEMA,
    rows,
    hash: compositionProfileHash(rows),
  };
}

/**
 * Candidate paths for the SHIPPED base, in order: the environment
 * override (an exact file), then `composition.base.json` at each start
 * directory and its ancestors — the script directory (bun-run bundles),
 * the executable's directory (installed standalone), and the source
 * directory (dev: walks to the repo root). Every mode of running has a
 * home for the file; nothing depends on the caller's cwd.
 */
export function profileSearchCandidates(input: {
  explicitFile?: string | undefined;
  sourceDir: string;
  execPath: string;
  argvScript?: string | undefined;
}): string[] {
  const starts: string[] = [];
  if (input.argvScript && isFilePath(input.argvScript))
    starts.push(dirname(resolve(input.argvScript)));
  starts.push(dirname(resolve(input.execPath)));
  starts.push(resolve(input.sourceDir));
  const candidates: string[] = input.explicitFile ? [input.explicitFile] : [];
  const seen = new Set<string>();
  for (const start of starts) {
    let dir = start;
    for (;;) {
      const candidate = join(dir, COMPOSITION_BASE_FILENAME);
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return candidates;
}

function isFilePath(path: string): boolean {
  try {
    return statSync(resolve(path)).isFile();
  } catch {
    return false;
  }
}

export function findBaseProfileFile(
  candidates: readonly string[],
): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

/** The shipped base is REQUIRED: a package without it is a broken package. */
export function requireBaseProfileFile(candidates: readonly string[]): string {
  const found = findBaseProfileFile(candidates);
  if (found) return found;
  throw new Error(
    `composition.base.json not found — checked: ${candidates.join(", ")} (set NATALIA_BASE_PROFILE to point at one)`,
  );
}
