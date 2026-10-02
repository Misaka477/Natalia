import type { ConfigV3, ModelRef } from "@anthelia/contracts";
import { modelRefKey, parseModelRef } from "@anthelia/contracts";
import { resolveEffectiveModel } from "./catalog";

export type SetupContextWindowResolution = {
  tokens: number;
  source: string;
  confidence: string;
  diagnostic: string;
};

export type SetupSnapshot = {
  provider: string;
  model: string;
  contextWindow: {
    tokens: number;
    source: string;
    confidence: string;
    diagnostic: string;
    manualOverrideAllowed: true;
  };
  outputLimit: {
    value: number | null;
    semantics: "omitted" | "explicit-positive";
  };
  secretFields: string[];
};

export function createSetupSnapshot(
  config: ConfigV3,
  ref: ModelRef | string,
  resolution: SetupContextWindowResolution,
): SetupSnapshot {
  const modelRef = typeof ref === "string" ? parseModelRef(ref) : ref;
  const effective = resolveEffectiveModel(config, modelRef);
  if (!effective)
    throw new Error(`unknown model config: ${modelRefKey(modelRef)}`);
  return {
    provider: effective.providerID,
    model: modelRef.model,
    contextWindow: {
      tokens: resolution.tokens,
      source: resolution.source,
      confidence: resolution.confidence,
      diagnostic: resolution.diagnostic,
      manualOverrideAllowed: true,
    },
    outputLimit: {
      value: effective.limits.maxOutputTokens ?? null,
      semantics: effective.limits.maxOutputTokens
        ? "explicit-positive"
        : "omitted",
    },
    secretFields: ["providers.*.connection.apiKey"],
  };
}
