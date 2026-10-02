import { z } from "zod";
import { agentConfigSchema, agentModeSchema } from "./schema-workflow";
import {
  alertChannelConfigSchema,
  dataSourceConfigSchema,
  experimentalConfigSchema,
  issueTargetConfigSchema,
} from "./schema-governance";
import {
  backgroundReviewConfigSchema,
  checkpointConfigSchema,
  contextConfigSchema,
  modelCatalogSchema,
  modelOverrideSchema,
  modelRefSchema,
  providerConfigSchema,
  runtimeConfigSchema,
  confinementConfigSchema,
  sandboxConfigSchema,
  goalConfigSchema,
  teamConfigSchema,
} from "./schema-foundation";
export const skillsConfigSchema = z.object({
  urls: z.array(z.string().url()).default([]),
});

export const pluginPackageSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("registry"), spec: z.string().min(1) }),
  z.object({ type: z.literal("tarball"), url: z.string().min(1) }),
  z.object({
    type: z.literal("git"),
    url: z.string().min(1),
    ref: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("path"), path: z.string().min(1) }),
]);

export const pluginPackageConfigSchema = z.object({
  source: pluginPackageSourceSchema,
  version: z.string().min(1),
  integrity: z.string().min(1).optional(),
  signature: z.string().min(1).optional(),
  scope: z.enum(["process", "workspace", "session"]),
});

export const pluginLockEntrySchema = z.object({
  packageName: z.string().min(1),
  manifest: z.string().min(1),
  metadata: z.object({
    id: z.string().min(1),
    source: pluginPackageSourceSchema,
    resolvedVersion: z.string().min(1),
    integrity: z.string().min(1).optional(),
    contentHash: z.string().min(1).optional(),
    signature: z.string().min(1).optional(),
    scope: z.enum(["process", "workspace", "session"]),
    dependencies: z.array(
      z.object({
        id: z.string().min(1),
        resolvedVersion: z.string().min(1),
        optional: z.boolean().optional(),
        peer: z.boolean().optional(),
      }),
    ),
  }),
});

export const nataliaLockSchema = z.object({
  version: z.literal(1),
  plugins: z.record(pluginLockEntrySchema).default({}),
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
]);

export const pluginConfigSchema = z.object({
  enabled: z.record(z.boolean()).default({}),
  paths: z.array(z.string()).default([]),
  capabilities: z.record(z.array(pluginIntegrationPointSchema)).default({}),
  readOnly: z.record(z.boolean()).default({}),
  // Per-plugin config, keyed by plugin id. The runtime does not interpret these
  // values: each plugin validates its own entry with the config schema it
  // declares, so an invalid entry fails that plugin's load instead of silently
  // reaching its setup.
  settings: z.record(z.unknown()).default({}),
  packages: z.record(pluginPackageConfigSchema).default({}),
});

/** Paths containing legacy out-of-tree tool family manifests. */
export const toolsConfigSchema = z.object({
  paths: z.array(z.string()).default([]),
});

export const mcpServerConfigSchema = z.object({
  type: z.enum(["stdio", "http"]),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().url().optional(),
  headers: z.record(z.string()).default({}),
  environment: z.record(z.string()).default({}),
  cwd: z.string().optional(),
  timeoutSec: z.number().int().positive().default(30),
  allowedTools: z.array(z.string()).default([]),
  excludedTools: z.array(z.string()).default([]),
  readOnly: z.boolean().default(false),
  enabled: z.boolean().default(true),
  // Interactive remote authentication is recognized only to emit a local unsupported diagnostic.
  auth: z.union([z.literal(false), z.object({}).passthrough()]).optional(),
});

export const workspaceConfigSchema = z.object({
  root: z.string().default(""),
  additionalDirs: z.array(z.string()).default([]),
});

export const instructionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  includeReadme: z.boolean().default(true),
  includeDocs: z.boolean().default(false),
  extraFiles: z.array(z.string()).default([]),
});

export const webSearchConfigSchema = z.object({
  endpoint: z.string().url().nullable().default(null),
  providerPriority: z.array(z.string()).default(["configured", "duckduckgo"]),
});

export const browserConfigSchema = z.object({
  enabled: z.boolean().default(true),
  binary: z.string().default(""),
  persistentProfile: z.boolean().default(false),
  profileDir: z.string().default(""),
  userAgent: z.string().default(""),
  locale: z.string().default(""),
  timezone: z.string().default(""),
  headers: z.record(z.string()).default({}),
});

export const networkConfigSchema = z.object({
  allowedHosts: z.array(z.string()).default([]),
  allowedSchemes: z.array(z.string()).default(["https", "http"]),
  allowLocalhost: z.boolean().default(false),
  allowPrivate: z.boolean().default(false),
});

export const securityConfigSchema = z.object({
  envAllowlist: z.array(z.string()).default([]),
  redactToolOutput: z.boolean().default(true),
});
export const configV3Schema = z.object({
  version: z.literal(3),
  runtime: runtimeConfigSchema.default({}),
  sandbox: sandboxConfigSchema.default({}),
  confinement: confinementConfigSchema.default({}),
  goal: goalConfigSchema.default({}),
  team: teamConfigSchema.default({}),
  context: contextConfigSchema.default({}),
  backgroundReview: backgroundReviewConfigSchema,
  checkpoint: checkpointConfigSchema,
  providers: z.record(providerConfigSchema).default({}),
  catalog: modelCatalogSchema,
  modelOverrides: z.record(modelOverrideSchema).default({}),
  defaultModel: modelRefSchema.nullable().default(null),
  agentModes: z.record(agentModeSchema).default({
    ask: {
      approval: "ask",
      description: "Ask before write, process, or shell actions",
    },
    auto: {
      approval: "auto",
      description: "Automatically approve actions",
    },
    read_only: {
      approval: "read_only",
      description: "Reject write and execution actions",
    },
  }),
  defaultAgentMode: z.string().default("ask"),
  agents: z.record(agentConfigSchema).default({}),
  defaultAgent: z.string().default(""),
  mcpServers: z.record(mcpServerConfigSchema).default({}),
  skills: skillsConfigSchema.default({}),
  plugins: pluginConfigSchema.default({}),
  tools: toolsConfigSchema.default({}),
  workspace: workspaceConfigSchema.default({}),
  instructions: instructionConfigSchema.default({}),
  webSearch: webSearchConfigSchema.default({}),
  browser: browserConfigSchema.default({}),
  network: networkConfigSchema.default({}),
  security: securityConfigSchema.default({}),
  issueTargets: z.record(issueTargetConfigSchema).default({}),
  dataSources: z.record(dataSourceConfigSchema).default({}),
  alertChannels: z.record(alertChannelConfigSchema).default({}),
  experimental: experimentalConfigSchema.default({}),
});
