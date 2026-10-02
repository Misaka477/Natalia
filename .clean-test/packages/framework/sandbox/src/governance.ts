/**
 * Governance risk tiers for sandbox promotions (P9).
 *
 * Not every change a self-modifying agent makes is equally risky. A data or
 * config edit is low risk; a tool implementation edit is medium; a change to
 * the tool contract or the capability kernel is high. The tier decides how much
 * human approval a promotion needs — the stricter the change, the stricter the
 * gate. The classification is path-based and deliberately conservative: a path
 * that cannot be told apart from source is treated as source.
 */
import type { SandboxChange } from "./index";

export type SandboxRiskTier = "low" | "medium" | "high";

const HIGH_RISK = [
  /packages\/core\/tools\/src\/types\.ts$/u,
  /packages\/core\/capability\/src\//u,
  /packages\/core\/plugin\/src\//u,
];

/** The risk tier of one changed path. */
export function riskTierForPath(path: string): SandboxRiskTier {
  if (HIGH_RISK.some((pattern) => pattern.test(path))) return "high";
  if (/\.(ts|tsx|js|mjs|cjs)$/u.test(path)) return "medium";
  return "low";
}

/** The risk tier of a candidate's full change set: the highest change wins. */
export function riskTierForChanges(changes: SandboxChange[]): SandboxRiskTier {
  let tier: SandboxRiskTier = "low";
  for (const change of changes) {
    const changeTier = riskTierForPath(change.path);
    if (changeTier === "high") return "high";
    if (changeTier === "medium") tier = "medium";
  }
  return tier;
}

/**
 * Whether a candidate's tier clears the approval gate: a promotion that
 * requires `"high"` approval must not proceed on a `"medium"` candidate's own
 * say-so. Equal or higher tiers pass; a higher-risk candidate always needs the
 * stricter gate.
 */
export function requiresApproval(
  tier: SandboxRiskTier,
  required: SandboxRiskTier,
): boolean {
  const order: Record<SandboxRiskTier, number> = { low: 0, medium: 1, high: 2 };
  return order[tier] >= order[required];
}
