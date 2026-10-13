import type { ConstitutionRule } from "./schema-types";
import type { ConfigV4 } from "./schema-types";

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

/**
 * One edit in the friendly batch editor's shape (`apply_edits`): the
 * precise-text-replacement spelling a model actually produces. A unified
 * diff used to be the other source kind and was REMOVED — models emit
 * half-diffs, and the diff's context requirements make a small slip fail
 * the whole patch with an error that names nothing. These operations
 * verify before anything is written (all-or-nothing), and their failures
 * name the file and the reason.
 */
export type GenerationEdit = {
  path: string;
  operation: "replace" | "create" | "delete";
  /** For replace: the exact text that must occur ONCE in the file. */
  oldText?: string;
  /** For replace/create: the text it becomes (or the whole file). */
  newText?: string;
};

/**
 * One file in a code tree: its content hash, and the hash it was cut FROM
 * when that differs (the three-way base). Studied from git and rebuilt on
 * what we already have: the object store is content-addressed, so a tree is
 * a manifest of path → hash, and a promotion is a per-file three-way check
 * (workspace == base → take next; workspace == next → already there;
 * anything else → a named conflict, never a silent overwrite).
 */
export type GenerationTreeFile = {
  path: string;
  /** The content hash the tree carries (null = the file is deleted). */
  next: string | null;
  /** The hash the tree was cut from, when the promotion must three-way. */
  base?: string;
};

/**
 * The SOURCE a generation may carry — the L3 lane's payload (洞 3).
 *
 * Config, plugins, prompts, policy rows and adapters compose a generation
 * of the runtime's SURFACE; `source` addresses the CODE underneath it, so
 * a candidate that changed `packages/**` fits in a generation at all.
 * Three spellings, ALL of them on our own infrastructure — the git study
 * was absorbed, not routed around:
 *
 *  - **edits** — the friendly lane: precise text edits applied by our own
 *    verify-then-write editor (all-or-nothing, named failures).
 *  - **tree** — the version-control lane: a content-addressed snapshot of
 *    the code, promoted into the workspace by our own three-way check over
 *    the object store's hashes, with our own diff engine reporting what
 *    moved. This is what the sandbox's promotion hands back, and it needs
 *    no external tool to be true.
 *  - **staged-build** — the deployment lane: a BUILT distribution staged
 *    through the installer's own probeVersion + swapSymlink sequence (the
 *    atomic switch, with an automatic rollback on a failed probe).
 *
 * There is deliberately NO git-ref kind. A branch name was the one spelling
 * that needed an external binary to mean anything; the tree is the same
 * fact (this content, cut from that content) in our own vocabulary, and a
 * deployment without git is not a degraded one.
 *
 * The field's PRESENCE is the switch's routing fact: a surface-only
 * generation switches in-process (a config reload), a source-carrying one
 * must drain the live turns, land the code, and restart (洞 5).
 */
export type GenerationSource =
  | {
      kind: "edits";
      /** The complete edit list, applied in order, verified before any write. */
      edits: GenerationEdit[];
    }
  | {
      kind: "tree";
      /** The files this tree carries, with their three-way bases. */
      files: GenerationTreeFile[];
    }
  | {
      kind: "staged-build";
      /** The version the staged build reports (the probe's expected answer). */
      version: string;
      /**
       * The object-store key of the build's manifest: `{files:
       * [{name, content(base64)}]}`. Content-addressed, so the generation
       * stays self-contained and the build survives its sandbox.
       */
      artifact: string;
    };

export type Generation = {
  schema: typeof GENERATION_SCHEMA;
  /** The resolved runtime config this generation was composed with. */
  config: ConfigV4;
  /**
   * The code this generation carries, when it changed any (L3). Absent
   * for a surface-only generation — and absent is what routes the switch
   * to the cheap in-process reload.
   */
  source?: GenerationSource;
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
