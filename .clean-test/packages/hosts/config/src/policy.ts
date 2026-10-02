import {
  modelRefKey,
  parseModelRef,
  type ConfigV3,
  type ModelRef,
  type PolicyStatement,
} from "@anthelia/contracts";

export type PolicyEffect = PolicyStatement["effect"];

export function evaluatePolicy(
  statements: readonly PolicyStatement[],
  action: string,
  resource: string,
  fallback: PolicyEffect,
): PolicyEffect {
  for (let index = statements.length - 1; index >= 0; index--) {
    const statement = statements[index]!;
    if (
      matches(action, statement.action) &&
      matches(resource, statement.resource)
    ) {
      return statement.effect;
    }
  }
  return fallback;
}

export type ModelSelectionStatus = {
  ref: ModelRef;
  key: string;
  configured: boolean;
  usable: boolean;
  policyAllowed: boolean;
  selected: boolean;
  reason?: string;
};

export function modelSelectionStatus(
  config: ConfigV3,
  ref: ModelRef | string,
): ModelSelectionStatus {
  const modelRef = typeof ref === "string" ? parseModelRef(ref) : ref;
  const key = modelRefKey(modelRef);
  const provider = config.providers[modelRef.provider];
  if (!provider)
    return {
      ref: modelRef,
      key,
      configured: false,
      usable: false,
      policyAllowed: false,
      selected: false,
      reason: "provider_not_configured",
    };
  const catalogModel =
    config.catalog?.providers?.[modelRef.provider]?.models?.[modelRef.model];
  const override = config.modelOverrides[key];
  if (!catalogModel && !override)
    return {
      ref: modelRef,
      key,
      configured: false,
      usable: false,
      policyAllowed: false,
      selected: false,
      reason: "model_not_configured",
    };
  if (override?.enabled === false)
    return {
      ref: modelRef,
      key,
      configured: true,
      usable: false,
      policyAllowed: false,
      selected: false,
      reason: "model_disabled",
    };
  if (!provider.enabled)
    return {
      ref: modelRef,
      key,
      configured: true,
      usable: false,
      policyAllowed: false,
      selected: false,
      reason: "provider_disabled",
    };
  if (!provider.connection?.apiKey)
    return {
      ref: modelRef,
      key,
      configured: true,
      usable: false,
      policyAllowed: false,
      selected: false,
      reason: "provider_credentials_unavailable",
    };
  const policy = evaluateModelPolicy(
    config.experimental.policies,
    modelRef.provider,
    modelRef.model,
  );
  if (policy !== "allow")
    return {
      ref: modelRef,
      key,
      configured: true,
      usable: true,
      policyAllowed: false,
      selected: false,
      reason: "provider_policy_denied",
    };
  return {
    ref: modelRef,
    key,
    configured: true,
    usable: true,
    policyAllowed: true,
    selected: true,
  };
}

export function evaluateModelPolicy(
  statements: readonly PolicyStatement[],
  provider: string,
  model: string,
) {
  const providerPolicy = evaluatePolicy(
    statements,
    "provider.use",
    provider,
    "allow",
  );
  const modelRules = statements.filter(
    (statement) =>
      statement.action === "provider.use" && statement.resource.includes("/"),
  );
  return evaluatePolicy(
    modelRules,
    "provider.use",
    `${provider}/${model}`,
    providerPolicy,
  );
}

function matches(value: string, pattern: string) {
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`, "u").test(value);
}
