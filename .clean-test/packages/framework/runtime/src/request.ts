export type OutputLimitDecision =
  | { kind: "omitted"; diagnostic: string }
  | { kind: "explicit"; tokens: number; diagnostic: string }
  | { kind: "provider-required"; tokens: number; diagnostic: string };

export type ProviderRequestInput = {
  model: string;
  messages: Array<Record<string, unknown>>;
  maxOutputTokens?: number | null;
  providerRequiresOutputLimit?: boolean;
  providerDefaultOutputLimit?: number;
  fieldName?: "max_tokens" | "max_completion_tokens";
};

export function resolveOutputLimit(
  input: ProviderRequestInput,
): OutputLimitDecision {
  if (typeof input.maxOutputTokens === "number") {
    if (input.maxOutputTokens <= 0)
      return {
        kind: "omitted",
        diagnostic: "non-positive output limit treated as omitted",
      };
    return {
      kind: "explicit",
      tokens: input.maxOutputTokens,
      diagnostic: "explicit positive config",
    };
  }
  if (input.providerRequiresOutputLimit) {
    const tokens = input.providerDefaultOutputLimit;
    if (!tokens || tokens <= 0)
      throw new Error(
        "provider requires output limit but adapter did not provide a safe default",
      );
    return {
      kind: "provider-required",
      tokens,
      diagnostic: "provider adapter required output limit",
    };
  }
  return { kind: "omitted", diagnostic: "max output omitted by config" };
}

export function buildProviderRequest(input: ProviderRequestInput) {
  const request: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
  };
  const decision = resolveOutputLimit(input);
  if (decision.kind !== "omitted") {
    request[input.fieldName ?? "max_tokens"] = decision.tokens;
  }
  return { request, outputLimit: decision };
}
