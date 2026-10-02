import type { GrowthTrigger } from "./growth-trigger";

/**
 * The trigger→NGM wiring (the user-approved block ②): a growth trigger
 * becomes a PROPOSAL, routed by the constitution's class policy. The
 * study's approval policy is the shape — **growth 默认不自授权**:
 *
 *   "宪法规则决定哪类 growth 可自动应用（如"新增技能"可自动、"改策略行"
 *    需人类、"改内核世代"需人类+验证门）"
 *
 * This module decides WHERE a proposal lands and WHAT approval it
 * needs. It never applies anything: the promotion's output is a FACT
 * (the journal's `growth.promoted`) whose `next` names the human- or
 * auto-applicable step, and the actual switch stays the composition
 * machine's `apply_generation` with its existing approval floor. A
 * promotion that applied itself would be the self-authorization the
 * constitution forbids.
 */

/** The destination a growth proposal routes to. */
export type GrowthDestination =
  /** A new skill (the study's auto-applyable class). */
  | "skill"
  /** A constitution/policy row (the human's class). */
  | "policy"
  /** A kernel generation change (the human + verification's class). */
  | "generation";

/** The class policy's row: the destination, its approval, its surface. */
export type GrowthClassPolicy = {
  destination: GrowthDestination;
  /** What the approval requires (the study's words, kept verbatim). */
  approval: "auto" | "human" | "human_plus_verification";
  /** The face that applies it (the composition's apply, the skills'
   * writer, the human's decision). */
  appliedBy: string;
  note: string;
};

/**
 * The class policy table — the study's mapping, one row per destination.
 * The default (an unmapped class) is the HUMAN: a growth whose class
 * nobody has ruled on does not get to apply itself.
 */
export const GROWTH_CLASS_POLICY: Record<GrowthDestination, GrowthClassPolicy> =
  {
    skill: {
      destination: "skill",
      approval: "auto",
      appliedBy: "the skills writer (the self-review's boundary)",
      note: "新增技能可自动：the class the study names auto-applyable",
    },
    policy: {
      destination: "policy",
      approval: "human",
      appliedBy: "apply_generation (its approval floor is the human)",
      note: "改策略行需人类：the candidate carries the row, the human applies",
    },
    generation: {
      destination: "generation",
      approval: "human_plus_verification",
      appliedBy: "apply_generation (the four-face verification gate)",
      note: "改内核世代需人类+验证门：the full gate runs, the human confirms",
    },
  };

/** The trigger's class mapped to its destination (the policy's key). */
export function growthDestinationOf(trigger: GrowthTrigger): GrowthDestination {
  if (trigger.class === "skill") return "skill";
  if (trigger.class === "policy") return "policy";
  // rule, generation — and anything unmapped: the human's floor.
  if (trigger.class === "rule") return "policy";
  return "generation";
}

export type GrowthPromotion = {
  /** The trigger this promotion came from (its provenance). */
  trigger: {
    rule: GrowthTrigger["rule"];
    capability: string;
    evidence: Record<string, number | string>;
    reason: string;
  };
  destination: GrowthDestination;
  approval: GrowthClassPolicy["approval"];
  appliedBy: string;
  /** What the promotion asks for next (the class policy's step). */
  next: string;
  reason: string;
};

/**
 * The promotion: one trigger, one named destination, one named
 * approval. The evidence rides along verbatim — a promotion without
 * its trigger's numbers is an assertion.
 */
export function deriveGrowthPromotion(trigger: GrowthTrigger): GrowthPromotion {
  const destination = growthDestinationOf(trigger);
  const policy = GROWTH_CLASS_POLICY[destination];
  return {
    trigger: {
      rule: trigger.rule,
      capability: trigger.capability,
      evidence: trigger.evidence,
      reason: trigger.reason,
    },
    destination,
    approval: policy.approval,
    appliedBy: policy.appliedBy,
    next:
      policy.approval === "auto"
        ? `stage the candidate and apply through ${policy.appliedBy}`
        : `await the human's decision — applied by ${policy.appliedBy}`,
    reason: `${trigger.reason} — routed to ${destination} (${policy.note})`,
  };
}

/** Which of the triggers the caller asked to promote (by capability). */
export function selectTrigger(
  triggers: readonly GrowthTrigger[],
  capability: string,
): GrowthTrigger | undefined {
  return triggers.find((trigger) => trigger.capability === capability);
}
