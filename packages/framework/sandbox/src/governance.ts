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

/**
 * Whether a path is THIS PROJECT's own source.
 *
 * The self-iteration boundary needs it: a promotion that would write
 * framework source into a workspace that is not this project's repository is
 * refused (see the check in the runtime's merge path). An installed
 * deployment's workspace is the user's own project and ships no source, so
 * without that check a model told to "fix packages/**" writes framework
 * files into somebody's repository.
 *
 * Forward-slash vocabulary, normalized for the host's spelling for the same
 * reason `riskTierForPath` is.
 */
export function isFrameworkSourcePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    /^packages\//u.test(normalized) ||
    /^apps\//u.test(normalized) ||
    /^scripts\//u.test(normalized) ||
    /^(package|bun\.lock|tsconfig)/u.test(normalized)
  );
}

/** The risk tier of one changed path. */
export function riskTierForPath(path: string): SandboxRiskTier {
  // The tier patterns are forward-slash vocabulary; a change record's path
  // arrives in the HOST's spelling (the workspace backend derives it with
  // `relative()` — backslash on Windows). Normalize once, or a change to
  // the tool contract reads as "medium" on Windows and the high-risk
  // promotion gate never fires there (the one gate that protects the
  // contract the whole tool surface is compiled against).
  const normalized = path.replaceAll("\\", "/");
  if (HIGH_RISK.some((pattern) => pattern.test(normalized))) return "high";
  if (/\.(ts|tsx|js|mjs|cjs)$/u.test(normalized)) return "medium";
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
