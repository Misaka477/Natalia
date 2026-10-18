/**
 * A subagent's own model — `modelProfile` resolved, or explicitly not (B8).
 *
 * The defect this closes is a budget that belonged to the wrong model: the child
 * ran on the parent's provider AND the parent's context window, so a child told
 * to use a 1M-window model was compacted at the parent's 32k, and one told to use
 * a 32k model believed it had 1M — wrong in the direction that overflows the
 * provider. A window is the third ruler applied to memory: a number with a scope,
 * and the scope has to be the model that actually runs.
 */
import { expect, test } from "bun:test";
import {
  resolveSubagentModel,
  subagentModelChoice,
} from "../src/runtime/initialize/subagent-model-profile";
import type {
  RuntimeContextStatusConfig,
  StreamingProvider,
} from "@anthelia/substrate";

const provider = { provider: "test", model: "test" } as StreamingProvider;
const budget = { max: 32_000 } as RuntimeContextStatusConfig;

test("a modelProfile naming a provider/model is the child's own model", () => {
  const choice = subagentModelChoice("grok/grok-4.6");
  expect(choice.kind).toBe("own");
  if (choice.kind === "own")
    expect(choice.ref).toMatchObject({ provider: "grok" });
});

test("no profile, or a bare label, inherits — and says why", async () => {
  for (const profile of [undefined, "", "   "]) {
    expect(subagentModelChoice(profile)).toMatchObject({ kind: "inherited" });
    const resolved = await resolveSubagentModel({
      ...(profile === undefined ? {} : { profile }),
      inheritedProvider: provider,
      inheritedBudget: budget,
    });
    expect(resolved).toMatchObject({ provider, budget, own: false });
    expect(resolved.reason).toContain("no modelProfile");
  }
  // The field predates this resolution, so a label it never promised to resolve
  // is not an error — it is an inheritance that STATES itself.
  const label = await resolveSubagentModel({
    profile: "strong",
    inheritedProvider: provider,
    inheritedBudget: budget,
  });
  expect(label.own).toBe(false);
  expect(label.reason).toContain("not a provider/model reference");
  expect(label.budget).toBe(budget);
});

test("a model reference this runtime cannot build keeps the parent's, visibly", async () => {
  const resolved = await resolveSubagentModel({
    profile: "grok/grok-4.6",
    inheritedProvider: provider,
    inheritedBudget: budget,
  });
  expect(resolved.own).toBe(false);
  expect(resolved.provider).toBe(provider);
  expect(resolved.budget).toBe(budget);
  expect(resolved.reason).toContain("no model configuration");
});
