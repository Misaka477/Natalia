export * from "./rows";
export * from "./profile";
export * from "./service-tokens";
export * from "./switch";
export * from "./verification";
import { ObjectStore } from "@anthelia/object-store";
import type {
  ConfigV3,
  ConstitutionRule,
  RuntimeEvent,
} from "@anthelia/contracts";
import { createCompositionRowRegistry } from "./profile";
import { compositionRowRegistrations } from "./rows";

/** The live row registry — the caps vocabulary's home (G6). */
const rowRegistry = createCompositionRowRegistry(compositionRowRegistrations);
import {
  GENERATION_SCHEMA,
  type CompositionPointer,
  type Generation,
  type GenerationAdapterRef,
  type GenerationPluginRef,
  type GenerationPrompts,
} from "@anthelia/contracts";

/**
 * The composition generation store (master plan P2 / NGM study G1).
 *
 * A generation is content-addressed through the object store: identical
 * content produces the identical id, so generations deduplicate for free and
 * the id is a stable handle for the journal's `composition.switched` events.
 * Nothing here mutates a stored generation — a change is a new object, which
 * is what makes the running composition immutable and the candidate/rollback
 * model (G2-G4) possible on top.
 */

/** Serializes a generation deterministically. */
export function serializeGeneration(generation: Generation): string {
  return JSON.stringify(generation);
}

/** Parses and schema-checks a stored generation. */
export function parseGeneration(text: string): Generation {
  const parsed = JSON.parse(text) as Generation;
  if (parsed?.schema !== GENERATION_SCHEMA)
    throw new Error(
      `unknown generation schema: ${String(parsed?.schema)} (expected ${GENERATION_SCHEMA})`,
    );
  if (!Array.isArray(parsed.plugins))
    throw new Error("generation is missing its plugin catalog");
  // Generations stored before the constitution face existed carry no rows;
  // reading them as "carries no policy" is honest (the gate then fails
  // closed against active rules rather than inventing rows). The same
  // fail-soft for the prompt/adapter fields added later: an older
  // generation reads as carrying none, and its hash simply differs from a
  // current one — the surface moved, and the difference is visible.
  return {
    ...parsed,
    policyRows: parsed.policyRows ?? [],
    prompts: parsed.prompts ?? { perRoleStatic: {}, docs: [] },
    adapters: parsed.adapters ?? {},
  };
}

/** Stores a generation, returning its content id. */
export async function storeGeneration(
  store: ObjectStore,
  generation: Generation,
): Promise<string> {
  return await store.put(serializeGeneration(generation));
}

/** Loads a generation by content id. */
export async function loadGeneration(
  store: ObjectStore,
  id: string,
): Promise<Generation> {
  const bytes = await store.get(id);
  return parseGeneration(bytes.toString("utf8"));
}

/** Builds a generation from the live config, catalog, policy, prompts and seams. */
export function buildGeneration(input: {
  config: ConfigV3;
  catalog: ReadonlyArray<{
    id: string;
    enabled: boolean;
    fingerprint: string;
  }>;
  /**
   * The constitution rows this generation carries. Required rather than
   * defaulted: a generation that silently carries no policy would pass the
   * gate's constitution face by emptiness while the user's rules are active.
   */
  policyRows: readonly ConstitutionRule[];
  /**
   * The prompt surface, hashed. Required for the same reason: a generation
   * that silently carries no prompts would make a prompt edit invisible to
   * the generation hash, and the RINA cache scope would keep serving under
   * the old prompts (the study's cache-aware rule needs the hashes).
   */
  prompts: GenerationPrompts;
  /**
   * The seam rows the composition selected (the profile's effective rows).
   * Recorded as the generation's adapter bindings: an impl selection is a
   * runtime-shaping fact (decision 17's factory), so it belongs inside the
   * hash — a backend switch changes the generation.
   */
  rows?: ReadonlyArray<{ id: string; impl?: string }>;
  /**
   * The caps each row's selected impl DECLARES, by row id (G6). The
   * caller owns the knowledge (the wiring reads the live backend's);
   * the compose owns the discipline — a key outside the row's registered
   * vocabulary is a lie and the compose refuses.
   */
  rowCaps?: Readonly<
    Record<string, Readonly<Record<string, boolean | string | number>>>
  >;
}): Generation {
  const plugins: GenerationPluginRef[] = input.catalog
    .map(({ id, enabled, fingerprint }) => ({ id, enabled, fingerprint }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const policyRows = [...input.policyRows].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const adapters: Record<string, GenerationAdapterRef> = {};
  // The vocabulary check runs over the CALLER'S WHOLE map, not only the
  // rows this composition selected: a capability entry for a row that is
  // not selected (or not registered at all) is the same lie — an
  // unregistered capability is a capability nobody can be held to. (The
  // first cut validated per selected row and a test caught the hole: an
  // unknown row's caps were silently dropped.)
  for (const [rowID, declared] of Object.entries(input.rowCaps ?? {})) {
    const vocabulary = rowRegistry.get(rowID)?.capKeys ?? [];
    for (const key of Object.keys(declared))
      if (!vocabulary.includes(key))
        throw new Error(
          `composition row ${rowID} declares unknown capability "${key}" — the registered vocabulary is [${vocabulary.join(", ")}]`,
        );
  }
  for (const row of input.rows ?? []) {
    const declared = input.rowCaps?.[row.id];
    adapters[row.id] = {
      ...(row.impl !== undefined ? { impl: row.impl } : {}),
      ...(declared !== undefined ? { caps: { ...declared } } : {}),
    };
  }
  return {
    schema: GENERATION_SCHEMA,
    config: input.config,
    plugins,
    policyRows,
    prompts: input.prompts,
    adapters,
  };
}

/**
 * Derives the composition pointer from an event stream.
 *
 * `current`/`previous` come from the recorded switches: the last switch wins,
 * its `from` becomes the rollback target. `candidate` is the most recent
 * proposal that was never switched to — the staged-but-uncommitted state.
 * A proposal that a later switch commits stops being a candidate. A stream
 * without any of these has no pointer, which is a valid state: the
 * composition existed before anyone pointed at it.
 */
export function deriveCompositionPointer(
  events: Iterable<RuntimeEvent>,
): CompositionPointer {
  let current: string | undefined;
  let previous: string | undefined;
  let candidate: string | undefined;
  for (const event of events) {
    if (event.type === "composition.switched") {
      previous = event.from ?? previous;
      current = event.to;
      if (candidate === event.to) candidate = undefined;
      continue;
    }
    if (event.type === "composition.proposed") candidate = event.candidateID;
  }
  return {
    ...(current ? { current } : {}),
    ...(previous ? { previous } : {}),
    ...(candidate ? { candidate } : {}),
  };
}
