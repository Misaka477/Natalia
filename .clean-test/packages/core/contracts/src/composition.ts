import type { ConstitutionRule } from "./schema-types";
import type { ConfigV3 } from "./schema-types";

/**
 * Composition generations (master plan P2, NGM study G1).
 *
 * A generation is a named, addressable snapshot of what the runtime is made
 * of. The study's full shape carries prompts, skills, policy rows and adapter
 * bindings; skills are deliberately absent (no fingerprint catalog exists —
 * skills are directory-discovered at runtime, and a field without a producer
 * is a stub), everything else is here.
 *
 * Plugins are referenced by identity plus the catalog's content fingerprint
 * rather than by embedding manifests: the fingerprint is the entry's content
 * hash, so a generation entry addresses exactly the content it was resolved
 * against, and the catalog itself stays the one place manifests live.
 */

export const GENERATION_SCHEMA = "natalia.generation/1" as const;

export type GenerationPluginRef = {
  id: string;
  enabled: boolean;
  /** The desired-catalog fingerprint of the plugin's content. */
  fingerprint: string;
};

/**
 * The prompt surface a generation carries (study §4.1): a hash per role's
 * STATIC system prompt (ADR D1's byte-stable block) and per instruction
 * document. Hashes, not bodies — the generation addresses the content, the
 * same discipline as the plugin fingerprints. The prompt hash is what makes
 * the study's cache-aware rule decidable: only a role whose prompt hash
 * changed needs the deferred boundary. The document hashes are the loader's
 * own change-detection identity, passed through: the generation addresses
 * exactly the content the runtime would read, under the runtime's own name
 * for it.
 */
export type GenerationPrompts = {
  /** sha256 of each role's static system prompt, by role id. */
  perRoleStatic: Record<string, string>;
  /** The loader's content hash of each instruction document, by path. */
  docs: Array<{ path: string; sha256: string }>;
};

/**
 * The adapter bindings a generation carries (study §4.1 / G6): one entry
 * per seam row the composition selected. The seam REGISTRY is the
 * composition row registry — code registers what can be bound, the profile
 * row selects what is bound — so this map is the generation's snapshot of
 * that selection. An absent impl means the backend is discovered at
 * runtime, not selected (the confinement row's shape).
 */
/**
 * A seam binding's DECLARED capabilities (G6's declarative caps, the
 * provider-caps discipline: "声明才开、绝不猜"). The vocabulary a row's
 * impls may declare is registered with the row (`capKeys`), and a
 * generation's snapshot may only live inside it — a cap outside the
 * vocabulary is a lie the compose refuses and the gate re-checks.
 *
 * What the objectstore row declares today is real and earned: the native
 * crate can read packs (the reader Phase A left in TS), its GC is
 * incremental (a pack whose every object is kept is not re-read), and it
 * serves the resident index daemon. The TypeScript impl declares none.
 */
export type GenerationAdapterRef = {
  impl?: string;
  caps?: Readonly<Record<string, boolean | string | number>>;
};

export type Generation = {
  schema: typeof GENERATION_SCHEMA;
  /** The resolved runtime config this generation was composed with. */
  config: ConfigV3;
  /** The desired plugin catalog, by identity and content fingerprint. */
  plugins: GenerationPluginRef[];
  /**
   * The constitution rules this generation carries (study §4.1). The
   * verification gate compares them against the active ledger: a candidate
   * may add policy but may never drop or weaken a critical/high rule the
   * user's constitution still enforces.
   */
  policyRows: ConstitutionRule[];
  /** The prompt surface, hashed (study §4.1). */
  prompts: GenerationPrompts;
  /** The seam bindings, by composition row id (study §4.1 / G6). */
  adapters: Record<string, GenerationAdapterRef>;
};

/**
 * The generation pointer. It is derived from the journal rather than stored
 * beside it: the journal is the single source of truth, and a pointer record
 * that disagreed with the event stream would be a second source of truth.
 */
export type CompositionPointer = {
  /** The generation running now, if any switch has been recorded. */
  current?: string;
  /** The generation before the current one: the rollback target. */
  previous?: string;
  /** A staged candidate, once candidate staging exists. */
  candidate?: string;
};
