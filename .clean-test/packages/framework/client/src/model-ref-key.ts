/**
 * Model reference key derivation.
 *
 * The canonical `provider/model` key for an effective model selection: an
 * agent's own model wins, then the session's selected model, then the default
 * model. This is pure config/selection → key, so the precedence rules are
 * testable without the runtime state they read.
 */
import { modelRefKey, type ModelRef } from "@anthelia/contracts";

export function deriveModelRefKey(input: {
  agent: { model?: string | ModelRef } | undefined;
  model: { modelID?: string; variant?: string } | undefined;
  defaultModel: string | ModelRef | null | undefined;
}): string | undefined {
  const candidate =
    input.agent?.model ??
    input.model?.modelID ??
    input.defaultModel ??
    undefined;
  if (!candidate) return undefined;
  return typeof candidate === "string" ? candidate : modelRefKey(candidate);
}
