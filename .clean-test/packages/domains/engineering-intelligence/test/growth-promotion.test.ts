import { expect, test } from "bun:test";
import {
  deriveGrowthPromotion,
  growthDestinationOf,
  GROWTH_CLASS_POLICY,
  selectTrigger,
} from "../src/growth-promotion";
import type { GrowthTrigger } from "../src/growth-trigger";

/**
 * The trigger→NGM wiring's contract: the class policy's routing
 * (skill auto / policy human / generation human+verification), the
 * evidence riding verbatim, and the unmapped class falling to the
 * human — a promotion never applies itself.
 */

const trigger = (
  rule: GrowthTrigger["rule"],
  className: GrowthTrigger["class"],
  capability: string,
): GrowthTrigger => ({
  rule,
  class: className,
  capability,
  evidence: { runs: 4, successes: 1 },
  reason: `the trigger named ${capability}`,
});

test("the study's class policy routes each trigger to its destination", () => {
  // 新增技能可自动.
  expect(
    deriveGrowthPromotion(trigger("capability_gap", "skill", "add a tool")),
  ).toMatchObject({
    destination: "skill",
    approval: "auto",
    next: expect.stringContaining("stage") as unknown as string,
  });
  // 改策略行需人类.
  expect(
    deriveGrowthPromotion(trigger("correction_pattern", "rule", "no network")),
  ).toMatchObject({
    destination: "policy",
    approval: "human",
    next: expect.stringContaining("await the human") as unknown as string,
  });
  // 改内核世代需人类+验证门.
  expect(
    deriveGrowthPromotion(
      trigger("benchmark_gap", "generation", "kernel bump"),
    ),
  ).toMatchObject({
    destination: "generation",
    approval: "human_plus_verification",
  });
});

test("a class nobody has ruled on falls to the human+verification floor", () => {
  // The policy table covers the study's classes; a NEW class a future
  // trigger carries must not be able to apply itself — the fallback is
  // the strictest destination. (Cast: the union's own classes are all
  // mapped, so the fallback is exercised by what the union doesn't say.)
  const unmapped = {
    rule: "capability_gap",
    class: "telepathy" as unknown as "skill",
    capability: "x",
    evidence: {},
    reason: "r",
  } satisfies GrowthTrigger;
  expect(growthDestinationOf(unmapped)).toBe("generation");
  expect(GROWTH_CLASS_POLICY[growthDestinationOf(unmapped)].approval).toBe(
    "human_plus_verification",
  );
});

test("the promotion carries the trigger's evidence verbatim and never applies", () => {
  const promotion = deriveGrowthPromotion(
    trigger("capability_gap", "skill", "no ripgrep tool"),
  );
  expect(promotion.trigger.evidence).toEqual({ runs: 4, successes: 1 });
  expect(promotion.reason).toContain("no ripgrep tool");
  expect(promotion.reason).toContain("routed to skill");
  // The promotion's shape has no apply/switch: the destination's
  // appliedBy names the face, and the composition's apply_generation
  // keeps its own approval floor.
  expect(Object.keys(promotion).sort()).toEqual([
    "appliedBy",
    "approval",
    "destination",
    "next",
    "reason",
    "trigger",
  ]);
});

test("the selection by capability is exact (one trigger, or none)", () => {
  const triggers = [
    trigger("capability_gap", "skill", "a"),
    trigger("capability_gap", "rule", "b"),
  ];
  expect(selectTrigger(triggers, "b")?.capability).toBe("b");
  expect(selectTrigger(triggers, "zzz")).toBeUndefined();
});
