import { z } from "zod";
export const constitutionRuleSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  scope: z.enum(["project", "package", "sandbox", "task", "release"]),
  priority: z.enum(["critical", "high", "medium", "low"]),
  /** `agent_proposed` marks a model-authored rule approved by the user (EI §3.8 P-1.c). */
  source: z.enum(["user", "master_plan", "policy", "agent_proposed"]),
  enforcement: z.enum(["deny", "approval", "warn"]),
  overridePolicy: z.enum(["forbidden", "user_scoped", "user_explicit"]),
  evidenceRefs: z.array(z.string()).default([]),
});

export const decisionRecordSchema = z.object({
  id: z.string().min(1),
  decision: z.string().min(1),
  rationale: z.array(z.string()).default([]),
  alternatives: z
    .array(
      z.object({
        option: z.string(),
        rejectedReason: z.string().optional(),
      }),
    )
    .default([]),
  consequences: z.array(z.string()).default([]),
  status: z.enum(["proposed", "accepted", "superseded"]),
  scope: z.array(z.string()).default([]),
  linkedPlans: z.array(z.string()).default([]),
  linkedConstraints: z.array(z.string()).default([]),
});

export const decisionScopeSchema = z.enum(["session", "workspace"]);

export const validationRunSchema = z.object({
  command: z.string(),
  target: z.string(),
  result: z.enum(["passed", "failed", "skipped"]),
  durationMs: z.number().int().positive().optional(),
  outputArtifact: z.string().optional(),
  safeSummary: z.string(),
});

export const completionEvidenceSchema = z.object({
  id: z.string().min(1),
  taskID: z.string().min(1),
  objective: z.string().min(1),
  status: z.enum([
    "planned",
    "implemented",
    "validated",
    "accepted",
    "promoted",
    "blocked",
    "failed",
    "partial",
  ]),
  changes: z
    .array(
      z.object({
        path: z.string(),
        changeType: z.enum(["added", "modified", "deleted"]),
        summary: z.string(),
      }),
    )
    .default([]),
  validations: z.array(validationRunSchema).default([]),
  knownGaps: z.array(z.string()).default([]),
  rollback: z
    .object({
      checkpointID: z.string().optional(),
      sandboxID: z.string().optional(),
    })
    .optional(),
  workGraphRefs: z.array(z.string()).default([]),
});

export const workGraphNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "goal",
    "constraint",
    "decision",
    "plan",
    "plan_step",
    "agent_action",
    "tool_call",
    "approval",
    "checkpoint",
    "validation",
    "workspace_change",
  ]),
  summary: z.string(),
  actor: z.string().optional(),
  target: z.string().optional(),
  journalOffset: z.number().int().nonnegative().optional(),
  sessionID: z.string().optional(),
  turnID: z.string().optional(),
  stepID: z.string().optional(),
  /** The plan this node belongs to (B7 provenance: which plan's commitment). */
  planID: z.string().optional(),
});

export const sessionIntelligenceSnapshotSchema = z.object({
  id: z.string().min(1),
  agentStatus: z.string(),
  currentStep: z.string().optional(),
  activeTool: z.string().optional(),
  changedFiles: z.number().int().nonnegative().default(0),
  unvalidatedChanges: z.number().int().nonnegative().default(0),
  recentOutput: z.string().max(2000).optional(),
  hasPTY: z.boolean().default(false),
  hasSandbox: z.boolean().default(false),
});

export const driftFindingSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(["advisory", "warning", "high"]),
  confidence: z.number().min(0).max(1),
  originalObjective: z.string().min(1),
  currentActivity: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  applicableConstraints: z.array(z.string()).default([]),
  status: z.enum([
    "open",
    "explained",
    "disputed",
    "dismissed",
    "corrected",
    "detour_declared",
  ]),
  options: z
    .array(
      z.object({
        label: z.string(),
        action: z.string(),
      }),
    )
    .default([]),
});

export const toolCanonicalRegistrationSchema = z.object({
  name: z.string().min(1),
  owner: z.string().min(1),
  scope: z.enum(["process", "workspace", "session"]),
  recovery: z
    .enum(["none", "retry", "restart", "fail_closed"])
    .default("retry"),
  precedence: z.number().int().default(0),
  grants: z.array(z.string()).default([]),
  requiresApproval: z.boolean().default(false),
});

export const capabilityManifestSchema = z.object({
  apiVersion: z.literal(1),
  id: z.string().min(1),
  version: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  scope: z.enum(["process", "workspace", "session"]),
  dependencies: z.array(z.string()).default([]),
  grants: z
    .array(
      z.enum([
        "tools",
        "commands",
        "settings",
        "settingsSchema",
        "workflows",
        "projection",
        "projections",
        "resources",
        "adapters",
        "schedulerJobs",
        "listeners",
        "services",
      ]),
    )
    .default([]),
});

export const workGraphEdgeSchema = z.object({
  id: z.string().min(1),
  sourceID: z.string().min(1),
  targetID: z.string().min(1),
  kind: z.enum([
    "requested_by",
    "constrained_by",
    "planned_by",
    "executed_by",
    "caused",
    "modified",
    "validated_by",
    "approved_by",
    // A refusal is a fact too. Recording one as `approved_by` would make the
    // graph answer "who authorized this side effect" with someone who refused it.
    "rejected_by",
    "checkpointed_by",
    "superseded_by",
    "rolled_back_by",
  ]),
  reason: z.string().optional(),
});

export const scopedOverrideSchema = z.object({
  id: z.string().min(1),
  ruleID: z.string().min(1),
  reason: z.string().min(1),
  scope: z.object({
    paths: z.array(z.string()).optional(),
    taskID: z.string().optional(),
    expiresAt: z.string().optional(),
  }),
  approvedBy: z.literal("user"),
});

export const policyStatementSchema = z.object({
  effect: z.enum(["allow", "deny"]),
  action: z.string().min(1),
  resource: z.string().min(1),
});

export const experimentalConfigSchema = z.object({
  policies: z.array(policyStatementSchema).default([]),
});

export const issueTargetConfigSchema = z.object({
  kind: z.enum(["gitea", "github"]),
  baseURL: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  /** Bot credential. It stays in configuration and never enters a task, a flow, a prompt or the model context. */
  token: z.string().default(""),
  label: z.string().default(""),
  enabled: z.boolean().default(true),
});

/**
 * Append-only source a task consumes incrementally: an application log, an
 * exported report, an audit trail, or anything else that only grows. The path is
 * deployment specific, so it lives in configuration rather than in the
 * version-controlled task document, and the model never chooses it.
 */
export const dataSourceConfigSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["offset", "timestamp"]).default("offset"),
  /**
   * Required by `kind: "timestamp"`: the JSON field each line carries its own
   * time in. The operator names it, because guessing at log formats would mean
   * shipping a vendor adapter per source. Ignored by `kind: "offset"`.
   */
  timestampField: z.string().default(""),
  maxBytes: z.number().int().positive().default(65536),
  enabled: z.boolean().default(true),
});

/**
 * Where a task alert is delivered. The journal channel is the durable queue and
 * the process output itself; a webhook is an external endpoint. Credentials stay
 * here and never enter a task document, a prompt, a systemd unit or the queue.
 */
export const alertChannelConfigSchema = z.object({
  kind: z.enum(["journal", "webhook"]),
  url: z.string().default(""),
  token: z.string().default(""),
  timeoutMs: z.number().int().positive().default(10_000),
  enabled: z.boolean().default(true),
});
