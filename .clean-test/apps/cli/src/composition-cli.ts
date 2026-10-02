/**
 * Decision 12's v1 CLI face over the composition machine (interface spec
 * §6): `list` / `status` / `apply` / `switch`, all on the workspace's
 * drop-in layer (`<ws>/.natalia/composition.d/`), validated before a
 * patch becomes a layer.
 *
 * The machine is the boot's own: one shared row registry (the same list
 * the boot, the `composition.d.ts` codegen and its freshness gate read),
 * the same three-layer load with per-row origin and §6.6 hash, and the
 * same §6.4 fail-fast. This module adds no mechanism — it is the user
 * face for the mechanism, which is why the gap matrix could call the
 * decision "machine complete, face missing".
 *
 * `switch` here is decision 17's factory selection (the row's `impl`),
 * NOT the NGM generation switch — that one is the runtime's gated
 * `apply_generation` flow with verification and rollback, and nothing in
 * this face touches it.
 */
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import {
  COMPOSITION_PROFILE_SCHEMA,
  compositionRowRegistrations,
  createCompositionRowRegistry,
  loadCompositionProfile,
  profileSearchCandidates,
  readCompositionLayer,
  requireBaseProfileFile,
  type CompositionProfile,
  type CompositionRow,
  type CompositionRowRegistry,
} from "@anthelia/composition";

/** The one registry — the boot's list, not a CLI-private copy. */
export function compositionRegistry(): CompositionRowRegistry {
  return createCompositionRowRegistry(compositionRowRegistrations);
}

/** The shipped base file, by the boot's own discovery order. */
export function compositionBaseFile(): string {
  return requireBaseProfileFile(
    profileSearchCandidates({
      explicitFile: process.env.NATALIA_BASE_PROFILE,
      sourceDir: import.meta.dir,
      execPath: process.execPath,
      argvScript: process.argv[1],
    }),
  );
}

export type CompositionRowView = {
  rowID: string;
  implIDs: string[];
  legalSummary: string;
};

/** `list`: what can be bound at all — the registry, never the profile. */
export function compositionRowViews(
  registry: CompositionRowRegistry = compositionRegistry(),
): CompositionRowView[] {
  return registry.ids().map((rowID) => {
    const registration = registry.get(rowID)!;
    return {
      rowID,
      implIDs: [...registration.implIDs],
      legalSummary: registration.legalSummary,
    };
  });
}

export type CompositionStatusRow = CompositionRow & {
  origin: { layer: string; file: string };
};

export type CompositionStatus = {
  hash: string;
  rows: CompositionStatusRow[];
};

/**
 * `status`: the effective profile as the next boot would load it — three
 * layers applied, per-row origin, §6.6 hash. A pure read: nothing is
 * written, nothing is reloaded.
 */
export async function compositionStatus(input: {
  workspace: string;
  home?: string | undefined;
  baseFile?: string | undefined;
  registry?: CompositionRowRegistry;
}): Promise<CompositionStatus> {
  const profile: CompositionProfile = await loadCompositionProfile({
    baseFile: input.baseFile ?? compositionBaseFile(),
    globalDir: input.home
      ? join(input.home, ".natalia", "composition.d")
      : undefined,
    workspaceDir: join(input.workspace, ".natalia", "composition.d"),
    registry: input.registry ?? compositionRegistry(),
  });
  return {
    hash: profile.hash,
    rows: profile.rows.map((row) => ({
      id: row.id,
      ...(row.impl !== undefined ? { impl: row.impl } : {}),
      ...(row.config !== undefined ? { config: row.config } : {}),
      ...(row.disabled !== undefined ? { disabled: row.disabled } : {}),
      origin: row.origin,
    })),
  };
}

/**
 * A drop-in filename: a bare name in the layer directory. An absolute
 * path or any traversal segment is refused — the precedent is the plugin
 * UI bundle's rel-escape check (apps/cli/src/plugin-ui.ts), and the
 * reason is the same: a write target derived from user input never
 * leaves its directory.
 */
function dropInName(raw: string): string {
  const name = basename(raw);
  if (!name || name !== raw || isAbsolute(raw))
    throw new Error(
      `composition drop-in name must be a bare filename (got ${JSON.stringify(raw)}); the workspace layer owns the directory`,
    );
  return name;
}

/**
 * A row id as a filename stem: `plugin:<id>` ids are legal row ids but a
 * colon is not a legal filename on Windows, so every non-portable
 * character becomes a dash. One row, one file — never two row ids
 * colliding on one drop-in.
 */
function rowFileName(rowID: string): string {
  return rowID.replace(/[^a-zA-Z0-9.-]/gu, "-");
}

export type CompositionApplyResult = {
  /** The layer file the patch now lives in. */
  file: string;
  /** The rows it contributed (validated, §6.4). */
  rows: CompositionRow[];
};

/**
 * `apply <patch-file>`: validate the patch against the registry FIRST
 * (§6.4's fail-fast at the earliest resolvable point — the alternative is
 * a boot-time error the user cannot trace back to this command), then
 * copy it into the workspace drop-in layer. Same-id same-field rows
 * override by the layer order; the file's own name orders it
 * lexicographically inside the layer (systemd's `.d` discipline).
 */
export async function applyCompositionPatch(input: {
  file: string;
  workspace: string;
  name?: string | undefined;
  registry?: CompositionRowRegistry;
}): Promise<CompositionApplyResult> {
  const registry = input.registry ?? compositionRegistry();
  const rows = await readCompositionLayer(input.file, registry);
  const dir = join(input.workspace, ".natalia", "composition.d");
  await mkdir(dir, { recursive: true });
  const target = join(dir, dropInName(input.name ?? basename(input.file)));
  await copyFile(input.file, target);
  return { file: target, rows };
}

/**
 * `switch <row-id> [--impl X] [--disabled]`: decision 17's factory
 * selection as one row. Synthesizes a single-row drop-in named after the
 * row (colons sanitized — `plugin:<id>` ids are legal row ids but not
 * legal filenames on Windows) and applies it through the same validated
 * path as `apply`. Every legal value is named on refusal, as everywhere.
 */
export async function switchCompositionRow(input: {
  rowID: string;
  impl?: string | undefined;
  config?: Record<string, unknown> | undefined;
  disabled?: boolean | undefined;
  workspace: string;
  registry?: CompositionRowRegistry;
}): Promise<CompositionApplyResult> {
  const registry = input.registry ?? compositionRegistry();
  const registration = registry.get(input.rowID);
  if (!registration)
    throw new Error(
      `composition row ${JSON.stringify(input.rowID)} is not registered (registered: ${registry.ids().join(", ")})`,
    );
  if (input.impl !== undefined && !registration.implIDs.includes(input.impl))
    throw new Error(
      `row ${JSON.stringify(input.rowID)} has no impl ${JSON.stringify(input.impl)} (legal: ${registration.implIDs.join(", ") || "none — the backend is discovered at runtime"})`,
    );
  const row: CompositionRow = {
    id: input.rowID,
    ...(input.impl !== undefined ? { impl: input.impl } : {}),
    ...(input.config !== undefined ? { config: input.config } : {}),
    ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
  };
  const patch = join(
    input.workspace,
    `.natalia-composition-switch-${rowFileName(input.rowID)}.json`,
  );
  await writeFile(
    patch,
    `${JSON.stringify({ schema: COMPOSITION_PROFILE_SCHEMA, rows: [row] }, null, 2)}\n`,
  );
  try {
    return await applyCompositionPatch({
      file: patch,
      workspace: input.workspace,
      name: `row-${rowFileName(input.rowID)}.json`,
      registry,
    });
  } finally {
    // The staged patch is a means; the layer file is the fact. Leaving
    // the temp copy behind would give the workspace two sources of truth.
    await rm(patch, { force: true });
  }
}

/** The human face of a loaded status (the `workgraph`/`doctor` pattern). */
export function compositionStatusLines(status: CompositionStatus): string[] {
  return [
    `composition hash: ${status.hash}`,
    ...status.rows.map((row) => {
      const fields = [
        row.impl !== undefined ? `impl: ${row.impl}` : undefined,
        row.disabled === true ? "disabled" : undefined,
        row.config !== undefined
          ? `config: ${JSON.stringify(row.config)}`
          : undefined,
      ].filter((field): field is string => field !== undefined);
      return `  ${row.id}${fields.length ? ` (${fields.join(", ")})` : ""} — ${row.origin.layer}: ${row.origin.file}`;
    }),
  ];
}
