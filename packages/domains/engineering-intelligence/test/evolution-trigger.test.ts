import { expect, test } from "bun:test";
import {
  EVOLUTION_CONCURRENCY,
  TRIGGER_HOLDOUT_DECLINE,
  TRIGGER_POTENTIAL_FLOOR,
  evolutionTrigger,
} from "../src/evolution-trigger";

/**
 * S8: the loop used to run when a human typed the command. Three gates,
 * each naming itself — a refusal that says only "no" teaches the operator
 * nothing.
 */

test("a regression with a ranked trigger and budget to spare runs a round", () => {
  const decision = evolutionTrigger({
    topPotential: 0.6,
    holdoutDelta: -0.05,
    activeEvolutions: 0,
  });
  expect(decision.run).toBe(true);
  expect(decision.reason).toContain("run a round");
});

test("the budget gate refuses first, and names the scarce resource", () => {
  // We call APIs: the scarce thing is concurrent model calls, not VRAM.
  const decision = evolutionTrigger({
    topPotential: 0.9,
    holdoutDelta: -0.5,
    activeEvolutions: EVOLUTION_CONCURRENCY,
  });
  expect(decision.run).toBe(false);
  expect(decision.reason).toContain("concurrency budget");
  expect(decision.reason).toContain("not VRAM");
});

test("the need gate refuses a catalog nothing ranks in", () => {
  const decision = evolutionTrigger({
    topPotential: TRIGGER_POTENTIAL_FLOOR - 0.01,
    holdoutDelta: -0.5,
    activeEvolutions: 0,
  });
  expect(decision.run).toBe(false);
  expect(decision.reason).toContain("nothing worth answering");
});

test("the signal gate refuses when nothing regressed", () => {
  const flat = evolutionTrigger({
    topPotential: 0.9,
    holdoutDelta: -TRIGGER_HOLDOUT_DECLINE + 0.001,
    activeEvolutions: 0,
  });
  expect(flat.run).toBe(false);
  expect(flat.reason).toContain("there is none");
  const rising = evolutionTrigger({
    topPotential: 0.9,
    holdoutDelta: 0.01,
    activeEvolutions: 0,
  });
  expect(rising.run).toBe(false);
  expect(rising.reason).toContain("up");
});
