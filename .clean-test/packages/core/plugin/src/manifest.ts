import { z } from "zod";
import type {
  PluginPackageConfig,
  PluginPackageSource,
} from "@anthelia/contracts";

export const PLUGIN_API_VERSION = 2;

export const pluginScopeSchema = z.enum(["process", "workspace", "session"]);

const pluginIDSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/u);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/iu);

export const pluginManifestV1Schema = z.object({
  apiVersion: z.literal(1),
  id: pluginIDSchema,
  version: versionSchema,
  name: z.string().min(1),
  description: z.string().default(""),
  entry: z.string().default("index.ts"),
  capabilities: z.array(z.enum(["tools", "events", "commands"])).default([]),
  scope: pluginScopeSchema.default("session"),
  provides: z.array(z.string()).default([]),
  requires: z.array(z.string()).default([]),
});

export const pluginIntegrationPointSchema = z.enum([
  "tools",
  "commands",
  "events",
  "services",
  "resources",
  "projections",
  "workflows",
  "settingsSchema",
  "adapters",
  "schedulerJobs",
  "cache",
]);

export const pluginDependencySchema = z.object({
  id: pluginIDSchema,
  spec: z.string().min(1),
  optional: z.boolean().default(false),
  peer: z.boolean().default(false),
});

export const pluginLifecycleHooksSchema = z.object({}).strict().default({});

export const uiPanelRequirementSchema = z.union([
  z.object({ type: z.literal("plugin"), id: z.string().min(1) }),
  z.object({ type: z.literal("capability"), id: z.string().min(1) }),
  z.object({ type: z.literal("method"), name: z.string().min(1) }),
]);

export const uiPanelMetaSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  region: z.enum(["main", "side", "bottom", "topbar", "settings"]).optional(),
  group: z.string().optional(),
  icon: z.string().optional(),
  order: z.number().int().nonnegative().optional(),
  description: z.string().optional(),
  requires: z.array(uiPanelRequirementSchema).optional(),
});

export const pluginUiManifestSchema = z.object({
  entry: z.string().min(1),
  // The contract mirror (events.ts PluginUiManifest) has always carried
  // it and the web loader has always read it; the schema silently
  // stripped it — a half-wired field, now aligned.
  css: z.string().optional(),
  panels: z.array(uiPanelMetaSchema).optional(),
});

/**
 * A plugin's shipped skills: the package-relative directory holding
 * SKILL.md files (the CU fit study's missing base surface — a plugin
 * used to have to smuggle skill docs through workspace directories,
 * a remote index, or its own tool). Declared, like facets, because
 * content ships in the package; the skills plugin discovers the
 * declared directory like any other root.
 */
export const pluginSkillsDeclarationSchema = z
  .object({
    dir: z.string().min(1).default("skills"),
  })
  .strict();

/**
 * A plugin's logging declaration (interface spec §2.4): the package's
 * own logs land in this directory — a CONVENTION, not a gate: the
 * runtime never reads, journals, or enforces it (decisions §8.3
 * "约定优于实现"; a plugin's logs never enter the runtime journal). The
 * declaration exists so a plugin author has somewhere to say it, and so
 * the installer can refuse a directory that escapes the package (the
 * same escape discipline the facet entries get at load).
 */
export const pluginLoggingDeclarationSchema = z
  .object({
    dir: z.string().min(1).default("logs").refine(safeDeclaredDir, {
      message:
        "the logging directory must be a package-relative path (no absolute paths, no ..)",
    }),
  })
  .strict();

export const pluginManifestV2Schema = z.object({
  apiVersion: z.literal(PLUGIN_API_VERSION),
  id: pluginIDSchema,
  version: versionSchema,
  name: z.string().min(1),
  description: z.string().default(""),
  entry: z.string().default("index.ts"),
  scope: pluginScopeSchema.default("session"),
  provides: z.array(z.string()).default([]),
  requires: z.array(z.string()).default([]),
  optionalRequires: z.array(z.string()).default([]),
  conflicts: z.array(pluginIDSchema).default([]),
  dependencies: z.array(pluginDependencySchema).default([]),
  hooks: pluginLifecycleHooksSchema,
  integrationPoints: z.array(pluginIntegrationPointSchema).default([]),
  ui: pluginUiManifestSchema.optional(),
  skills: pluginSkillsDeclarationSchema.optional(),
  logging: pluginLoggingDeclarationSchema.optional(),
});

/**
 * The env registry (interface spec §2.3): `web` is WIRED today — the
 * browser renderer is what the catalog row, the web loader, the CLI
 * bundle service and the CEF host all read. `tui` is a RESERVED,
 * UNWIRED key: no TUI consumer exists, so the runtime does not
 * interpret a `tui` facet — the degradation law's first clause (a
 * facet for an env the runtime does not serve is a silent no-row).
 * Facet KEYS are open in the schema (only the value shape is closed);
 * this constant is what a consumer checks against, never a validation
 * set — an unknown env fails no load, it simply serves nobody.
 */
export const PLUGIN_FACET_ENVS = ["web", "tui"] as const;
export type PluginFacetEnv = (typeof PLUGIN_FACET_ENVS)[number];

/** A renderer-side facet: the shape v2's `ui` carried, generalized. */
export const pluginFacetSchema = z.object({
  entry: z.string().min(1),
  css: z.string().optional(),
  panels: z.array(uiPanelMetaSchema).optional(),
});

/**
 * v3 (interface spec §2.2–2.3): v2 in full plus the facets
 * generalization — one renderer package per env in one map — and
 * `ui` REJECTED (a v2 manifest's `ui` is exactly its `facets.web`;
 * carrying both would let the two drift). Strict so the refusal names
 * the key. The logging self-convention declaration of the spec's field
 * table is deliberately NOT here yet: a field nothing reads is the
 * half-wired shape this house refuses (see the integrity landing); it
 * lands with its first consumer.
 */
export const pluginManifestV3Schema = z
  .object({
    apiVersion: z.literal(3),
    id: pluginIDSchema,
    version: versionSchema,
    name: z.string().min(1),
    description: z.string().default(""),
    entry: z.string().default("index.ts"),
    scope: pluginScopeSchema.default("session"),
    provides: z.array(z.string()).default([]),
    requires: z.array(z.string()).default([]),
    optionalRequires: z.array(z.string()).default([]),
    conflicts: z.array(pluginIDSchema).default([]),
    dependencies: z.array(pluginDependencySchema).default([]),
    hooks: pluginLifecycleHooksSchema,
    integrationPoints: z.array(pluginIntegrationPointSchema).default([]),
    facets: z.record(z.string(), pluginFacetSchema).optional(),
    skills: pluginSkillsDeclarationSchema.optional(),
    logging: pluginLoggingDeclarationSchema.optional(),
  })
  .strict();

export const pluginManifestSchema = z.discriminatedUnion("apiVersion", [
  pluginManifestV1Schema,
  pluginManifestV2Schema,
  pluginManifestV3Schema,
]);

export type PluginManifestV1 = z.infer<typeof pluginManifestV1Schema>;
export type PluginManifestV2 = z.infer<typeof pluginManifestV2Schema>;
export type PluginManifestV3 = z.infer<typeof pluginManifestV3Schema>;
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginIntegrationPoint = z.infer<
  typeof pluginIntegrationPointSchema
>;
export type PluginUiManifestFromSchema = z.infer<typeof pluginUiManifestSchema>;
export type PluginFacet = z.infer<typeof pluginFacetSchema>;

/**
 * The migration mapping, one function (spec §2.3): a v2 manifest's
 * `ui` IS its `facets.web`, and a v3 manifest reads its facet for the
 * env. Every face that wants a renderer package asks for
 * (manifest, env) — never "the ui field" — so the version distinction
 * lives in exactly one place and the loader paths stay version-blind.
 */
export function pluginFacetFor(
  manifest: PluginManifest,
  env: string,
): PluginFacet | undefined {
  if (manifest.apiVersion === 2)
    return env === "web" ? (manifest.ui as PluginFacet) : undefined;
  if (manifest.apiVersion === 3) return manifest.facets?.[env];
  return undefined;
}

/**
 * The declared skills directory, or undefined when the plugin ships
 * none. `skills: {}` (or a bare `skills`) means the default
 * `skills/` directory — the declaration is present, the dir defaulted.
 */
/**
 * A declared package-relative directory: POSIX-shaped, inside the
 * package. The escape boundary for every package-relative declaration
 * (logging's home today; skills' dir checks at its own consumer).
 */
export function safeDeclaredDir(dir: string): boolean {
  if (!dir) return false;
  if (dir.includes("\\") || dir.includes("\0")) return false;
  if (dir.startsWith("/")) return false;
  if (/^[A-Za-z]:/u.test(dir)) return false;
  return dir.split("/").every((segment) => segment !== ".." && segment !== "");
}

export function pluginSkillDir(manifest: PluginManifest): string | undefined {
  const declared = (manifest as { skills?: { dir?: string } }).skills;
  return declared ? (declared.dir ?? "skills") : undefined;
}

/**
 * The declared logging directory, or undefined when the plugin ships no
 * declaration. `logging: {}` means the default `logs/` — the convention
 * stated, the override absent. The runtime never reads it: the path is
 * the plugin package's own business (its logs never enter the journal).
 */
export function pluginLogDir(manifest: PluginManifest): string | undefined {
  const declared = (manifest as { logging?: { dir?: string } }).logging;
  return declared ? (declared.dir ?? "logs") : undefined;
}

export type { PluginPackageSource } from "@anthelia/contracts";

export type PluginInstallationMetadata = {
  id: string;
  source: PluginPackageSource;
  resolvedVersion: string;
  /** The package manager's tarball digest (provenance, from package-lock). */
  integrity?: string;
  /**
   * The INSTALLED PACKAGE's content hash (our pin): what is on disk at
   * install time, verified at load. Detects the electron-incident class
   * — a manifest or entry drifting after install — which a tarball
   * digest cannot see.
   */
  contentHash?: string;
  signature?: string;
  scope: "process" | "workspace" | "session";
  dependencies: Array<{
    id: string;
    resolvedVersion: string;
    optional?: boolean;
    peer?: boolean;
  }>;
};

export type InstalledPluginPackage = PluginPackageConfig;

export function manifestIntegrationPoints(
  manifest: PluginManifest,
): PluginIntegrationPoint[] {
  // v2 and v3 carry the declared list; v1 predates it (its capabilities
  // plus provides-as-services is the reconstructed equivalent).
  if (manifest.apiVersion === 2 || manifest.apiVersion === 3)
    return manifest.integrationPoints;
  return [
    ...manifest.capabilities,
    ...(manifest.provides.length ? (["services"] as const) : []),
  ];
}
