import { z } from "zod";
export const agentPermissionRulesSchema = z.object({
  tools: z
    .object({
      allow: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
    })
    .optional(),
  files: z
    .object({
      readPaths: z
        .array(
          z.object({
            pattern: z.string(),
            allow: z.boolean().optional(),
            reason: z.string().optional(),
          }),
        )
        .default([]),
      writePaths: z
        .array(
          z.object({
            pattern: z.string(),
            allow: z.boolean().optional(),
            reason: z.string().optional(),
          }),
        )
        .default([]),
    })
    .optional(),
  commands: z
    .object({
      allowPatterns: z.array(z.string()).default([]),
      denyPatterns: z.array(z.string()).default([]),
    })
    .optional(),
  network: z
    .object({
      allowedHosts: z.array(z.string()).default([]),
      denyHosts: z.array(z.string()).default([]),
      allowLocalhost: z.boolean().optional(),
      allowPrivate: z.boolean().optional(),
    })
    .optional(),
  env: z.object({ allowlist: z.array(z.string()).default([]) }).optional(),
  redactOutput: z.boolean().optional(),
});

export const bashCommandRuleSchema = z.object({
  command: z.string().min(1),
  reason: z.string().min(1).optional(),
});

export const permissionProfileCommandRulesSchema = z.object({
  mode: z.enum(["blacklist", "whitelist", "none"]),
  rules: z.array(bashCommandRuleSchema).default([]),
});

/**
 * Launch commands that may take over a pane as an interactive program, such as
 * an editor, a REPL or a database client. By default it is an explicit
 * allowlist. `allowAny` is an intentionally high-risk escape hatch selected by
 * the user; foreground-process confirmation still applies.
 */
export const interactiveProgramRulesSchema = z.object({
  allowAny: z.boolean().default(false),
  allow: z.array(bashCommandRuleSchema).default([]),
});

/** Extension stages can only narrow the profile's extension boundary. */
export const extensionRulesSchema = z.object({
  skills: z.boolean().optional(),
  mcp: z.boolean().optional(),
});

export const permissionProfileSchema = z.object({
  approval: z.enum(["ask", "auto", "read_only"]),
  description: z.string().default(""),
  permissions: agentPermissionRulesSchema.optional(),
  commandRules: permissionProfileCommandRulesSchema.optional(),
  interactivePrograms: interactiveProgramRulesSchema.optional(),
  extensions: extensionRulesSchema.optional(),
});

/**
 * Unified agent runtime mode. This replaces the separate permission profile
 * plus mode split: one mode owns the workflow preset and the security boundary.
 * The built-in ask/auto/read_only modes remain available and non-editable.
 */
export const agentModeSchema = z.object({
  description: z.string().default(""),
  approval: z.enum(["ask", "auto", "read_only"]),
  systemPrompt: z.string().default(""),
  model: z.string().optional(),
  allowedTools: z.array(z.string()).default([]),
  excludedTools: z.array(z.string()).default([]),
  permissions: agentPermissionRulesSchema.optional(),
  commandRules: permissionProfileCommandRulesSchema.optional(),
  interactivePrograms: interactiveProgramRulesSchema.optional(),
  extensions: extensionRulesSchema.optional(),
  skills: z.boolean().default(true),
  mcpServers: z.array(z.string()).default([]),
});

export const agentConfigSchema = z.object({
  description: z.string().default(""),
  systemPrompt: z.string().default(""),
  mode: z.enum(["primary", "subagent", "all"]).default("primary"),
  hidden: z.boolean().default(false),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/u)
    .optional(),
  model: z.string().optional(),
  variant: z.string().optional(),
  maxSteps: z.number().int().positive().optional(),
  allowedTools: z.array(z.string()).default([]),
  excludedTools: z.array(z.string()).default([]),
  mcpServers: z.array(z.string()).default([]),
  permissions: agentPermissionRulesSchema.optional(),
});
