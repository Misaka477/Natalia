import { governanceViews } from "@natalia/governance-ledger";

/**
 * The CST3 command face (constitution/decision ledger plan §5): the
 * workspace's governance facts as user-readable commands. The fold lives
 * in the governance ledger (one projection, the same one the runtime's
 * faces serve); this module is the PRESENTATION — the doctor/workgraph
 * pattern: human lines by default, `--json` for machines.
 *
 *   natalia governance list              — the effective rules + decisions + overrides
 *   natalia governance show <ruleID>     — one rule, its overrides, its tombstone
 *   natalia governance why <decisionID>  — one decision's rationale and rejected options
 *
 * The override PROPOSE/APPROVE half of CST3 is deliberately not here: it
 * runs the interactive approval seam, which belongs to a live runtime
 * (the RPC `requestOverride`/`approveOverride` is in place for that
 * face). This face answers "what is the law and why", never grants.
 */

export type GovernanceShow = {
  found: boolean;
  rule?: NonNullable<ReturnType<typeof governanceViews>["rules"][number]>;
  state: "active" | "disabled" | "removed" | "unknown";
  overrides: ReturnType<typeof governanceViews>["overrides"];
  removedAt?: string;
};

export function governanceShow(
  workspaceRoot: string | undefined,
  ruleID: string,
): GovernanceShow {
  const views = governanceViews(workspaceRoot);
  const active = views.rules.find((rule) => rule.ruleID === ruleID);
  if (active)
    return {
      found: true,
      rule: active,
      state: "active",
      overrides: views.overrides.filter(
        (override) => override.ruleID === ruleID,
      ),
    };
  const disabled = views.disabled.find((rule) => rule.ruleID === ruleID);
  if (disabled)
    return {
      found: true,
      rule: disabled,
      state: "disabled",
      overrides: views.overrides.filter(
        (override) => override.ruleID === ruleID,
      ),
    };
  const tombstone = views.removed.find((entry) => entry.ruleID === ruleID);
  if (tombstone)
    return {
      found: true,
      state: "removed",
      overrides: [],
      removedAt: tombstone.at,
    };
  return { found: false, state: "unknown", overrides: [] };
}

export function governanceWhy(
  workspaceRoot: string | undefined,
  decisionID: string,
): {
  found: boolean;
  decision?: ReturnType<typeof governanceViews>["decisions"][number];
} {
  const decision = governanceViews(workspaceRoot).decisions.find(
    (candidate) => candidate.id === decisionID,
  );
  return decision ? { found: true, decision } : { found: false };
}

function ruleLine(
  rule: ReturnType<typeof governanceViews>["rules"][number],
): string {
  return `  ${rule.ruleID} [${rule.priority}/${rule.enforcement}] ${rule.statement} (scope: ${rule.scope}, override: ${rule.overridePolicy})`;
}

/** The human face of `list` (the doctor/workgraph line pattern). */
export function governanceListLines(
  workspaceRoot: string | undefined,
): string[] {
  const views = governanceViews(workspaceRoot);
  if (views.degraded)
    return [
      "governance store unreadable — the answer is unknown, not empty (check .natalia/governance/)",
    ];
  const lines: string[] = [
    `Constitution rules: ${views.rules.length} active · ${views.disabled.length} disabled · ${views.removed.length} removed`,
    ...views.rules.map(ruleLine),
  ];
  if (views.disabled.length)
    lines.push(
      ...views.disabled.map(
        (rule) => `  ${rule.ruleID} [disabled] ${rule.statement}`,
      ),
    );
  lines.push(`Decisions: ${views.decisions.length}`);
  for (const decision of views.decisions)
    lines.push(`  ${decision.id} [${decision.status}] ${decision.decision}`);
  lines.push(`Scoped overrides granted: ${views.overrides.length}`);
  for (const override of views.overrides)
    lines.push(
      `  ${override.ruleID} — ${override.reason}${override.expiresAt ? ` (expires ${override.expiresAt})` : ""}`,
    );
  return lines;
}

/** The human face of `show`. */
export function governanceShowLines(
  workspaceRoot: string | undefined,
  ruleID: string,
): string[] {
  const show = governanceShow(workspaceRoot, ruleID);
  if (!show.found)
    return [`no constitution rule ${ruleID} — see: natalia governance list`];
  if (show.state === "removed")
    return [
      `${ruleID} was removed at ${show.removedAt ?? "an unknown time"} — history is complete, the rule no longer applies`,
    ];
  const rule = show.rule!;
  const lines = [
    `${rule.ruleID} — ${show.state === "disabled" ? "disabled (reversible, still in the journal)" : "active"}`,
    `  statement: ${rule.statement}`,
    `  scope: ${rule.scope} · priority: ${rule.priority} · enforcement: ${rule.enforcement}`,
    `  override policy: ${rule.overridePolicy}`,
    ...(rule.evidenceRefs?.length
      ? [`  evidence: ${rule.evidenceRefs.join(", ")}`]
      : []),
    `  overrides granted: ${show.overrides.length}`,
    ...show.overrides.map(
      (override) =>
        `    ${override.reason}${override.paths?.length ? ` (paths: ${override.paths.join(", ")})` : ""}${override.taskID ? ` (task: ${override.taskID})` : ""}${override.expiresAt ? ` (expires: ${override.expiresAt})` : ""}`,
    ),
  ];
  return lines;
}

/** The human face of `why` — the decision's reasons, not just its text. */
export function governanceWhyLines(
  workspaceRoot: string | undefined,
  decisionID: string,
): string[] {
  const { found, decision } = governanceWhy(workspaceRoot, decisionID);
  if (!found || !decision)
    return [`no decision ${decisionID} — see: natalia governance list`];
  return [
    `${decision.id} — ${decision.status}`,
    `  decision: ${decision.decision}`,
    ...(decision.rationale?.length
      ? ["  rationale:", ...decision.rationale.map((line) => `    - ${line}`)]
      : []),
    ...(decision.alternatives?.length
      ? [
          "  alternatives considered:",
          ...decision.alternatives.map(
            (alternative) =>
              `    - ${alternative.option}${alternative.rejectedReason ? ` — rejected: ${alternative.rejectedReason}` : ""}`,
          ),
        ]
      : []),
    ...(decision.consequences?.length
      ? [
          "  consequences:",
          ...decision.consequences.map((line) => `    - ${line}`),
        ]
      : []),
  ];
}
