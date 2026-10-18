/**
 * A subagent's OWN model — `modelProfile` resolved into a provider and a budget,
 * or explicitly not.
 *
 * THE GAP THIS CLOSES. `SpawnOptions.modelProfile` has always been a recorded
 * string and nothing more: the child ran on the parent's provider and, worse, on
 * the parent's context budget. So a child told to run on a 1M window model was
 * compacted at the parent's 32k, and one told to run on a 32k model believed it
 * had the parent's 1M — a number that is wrong in the direction that overflows
 * the provider. A budget that does not belong to the model actually executing is
 * the third ruler's failure mode in miniature: a green (or a window) with a scope
 * nobody can see.
 *
 * The resolution is the SAME path the session itself uses — `providerForModel`
 * and `resolveContextStatusConfig` — because a second resolution path is a second
 * answer. A `modelProfile` that is not a `provider/model` reference is NOT an
 * error (the field predates this, and an arbitrary label is what its callers
 * wrote): it falls back to the parent's model and window, and says so, so the
 * fallback is visible instead of being the silent default.
 */
import {
  modelRefKey,
  parseModelRef,
  type ConfigV4,
  type ModelRef,
} from "@anthelia/contracts";
import {
  providerForModel,
  type ContextWindowResolver,
  type StreamingProvider,
} from "@anthelia/runtime";
import type { RuntimeContextStatusConfig } from "@anthelia/substrate";
import { resolveContextStatusConfig } from "../provider-selection";

export type SubagentModelChoice =
  | { kind: "inherited"; reason: string }
  | { kind: "own"; ref: ModelRef };

/** Whether `modelProfile` names a model this runtime can resolve. Pure. */
export function subagentModelChoice(
  profile: string | undefined,
): SubagentModelChoice {
  const text = profile?.trim() ?? "";
  if (text.length === 0)
    return { kind: "inherited", reason: "no modelProfile was set" };
  try {
    return { kind: "own", ref: parseModelRef(text) };
  } catch {
    return {
      kind: "inherited",
      reason: `modelProfile "${text}" is not a provider/model reference`,
    };
  }
}

/**
 * The provider and budget a subagent runs with.
 *
 * `own: true` means both came from the child's own `modelProfile`. `own: false`
 * means the parent's were inherited, and `reason` says why — a caller must be
 * able to show that, because "this child ran on the parent's window" is a fact a
 * reader may need to know.
 */
export async function resolveSubagentModel(input: {
  profile?: string;
  inheritedProvider: StreamingProvider;
  inheritedBudget: RuntimeContextStatusConfig;
  config?: ConfigV4;
  resolver?: ContextWindowResolver;
  sessionID?: string;
}): Promise<{
  provider: StreamingProvider;
  budget: RuntimeContextStatusConfig;
  own: boolean;
  reason: string;
}> {
  const inherited = {
    provider: input.inheritedProvider,
    budget: input.inheritedBudget,
    own: false,
  } as const;
  const choice = subagentModelChoice(input.profile);
  if (choice.kind === "inherited")
    return { ...inherited, reason: choice.reason };
  if (!input.config || !input.resolver)
    return {
      ...inherited,
      reason: `modelProfile "${input.profile}" cannot be resolved here: this runtime exposes no model configuration`,
    };
  const provider = providerForModel(input.config, choice.ref, undefined, {
    ...(input.sessionID ? { sessionID: input.sessionID } : {}),
  });
  if (!provider)
    return {
      ...inherited,
      reason: `modelProfile "${input.profile}" names a model this runtime cannot build a provider for (unconfigured, or missing its key)`,
    };
  // The same resolution the session uses, so the child's window is the window of
  // the model it will actually call — not the configured one, not the parent's.
  const budget = await resolveContextStatusConfig(
    input.config,
    provider,
    input.resolver,
    modelRefKey(choice.ref),
  );
  return {
    provider,
    budget,
    own: true,
    reason: `running on ${modelRefKey(choice.ref)} with its own ${budget.max}-token window`,
  };
}
