/**
 * Provider and model selection — runtime/provider-selection module.
 *
 * Resolves the effective `provider/model` for a session, refreshes per-session
 * execution context config, and exposes the model catalog and capability
 * helpers. Reads host state and writes the shared provider/model selection
 * through `RuntimeContext` ports at call time.
 */
import {
  buildModelCatalog,
  modelSelectionStatus,
  resolveEffectiveModel,
} from "@anthelia/config";
import { logOf } from "@anthelia/operation-log";
import { modelRefKey, parseModelRef, type ModelRef } from "@anthelia/contracts";
import {
  assertContextBudgetInvariants,
  DEFAULT_TOOL_RESULT_PRUNE_OPTIONS,
  knownModelOutputLimit,
  modelsDevModelLimits,
  providerForModel,
  resolveReservedOutputTokens,
  type StreamingProvider,
} from "@anthelia/runtime";
import { deriveModelRefKey } from "../model-ref-key";
import { modelCatalogInWorker } from "@anthelia/substrate";
import type { AgentDefinition } from "@anthelia/agent";
import type { ConfigV3, ModelCapabilities } from "@anthelia/contracts";
import type { ContextWindowResolver } from "@anthelia/runtime";
import type { SessionExecutionState } from "@anthelia/substrate";
import type { RuntimeContext } from "@anthelia/substrate";
import type { RuntimeContextStatusConfig } from "@anthelia/substrate";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";
import { perfLog } from "@anthelia/runtime-services";

export function defaultContextStatusConfig(): RuntimeContextStatusConfig {
  const max = Math.max(
    32_000,
    Number(process.env.NATALIA_CONTEXT_WINDOW ?? 32_000),
  );
  // A 32k-class window must not reserve a flat 20k output budget: that would
  // trip the reserved-capacity compaction guard on ordinary multi-step turns.
  // Derive the reserve from the same conservative formula the resolved path
  // uses (min(20000, max(4096, window*0.1))) unless an explicit override is set.
  const envReserved = process.env.NATALIA_CONTEXT_RESERVED;
  const reserved = resolveReservedOutputTokens({
    contextWindow: max,
    configuredReserved:
      envReserved === undefined || envReserved === ""
        ? "auto"
        : Number(envReserved),
  });
  return {
    max,
    thresholdPercent: Number(process.env.NATALIA_CONTEXT_THRESHOLD ?? 85),
    reserved: Math.max(1, reserved.tokens),
    reservedSource: reserved.source,
    // Schema defaults, applied here so a pre-config default is still a complete
    // budget rather than a partially-filled one (plan §2.3).
    preservedRecentMessages: 10,
    preservedRecentTokens: 0,
    maxOverflowRetries: 1,
    prune: DEFAULT_TOOL_RESULT_PRUNE_OPTIONS,
  };
}

async function resolveContextStatusConfig(
  config: ConfigV3,
  provider: StreamingProvider | undefined,
  resolver: ContextWindowResolver,
  selectedRef?: string,
) {
  // The policy half of the budget always comes from the workspace config, even
  // when no model was selected (window/reserve then fall back to the env
  // default). Otherwise a workspace that lowers `preservedRecentMessages` would
  // be silently ignored by every stream (plan §2.3).
  const applyPolicy = (
    base: RuntimeContextStatusConfig,
  ): RuntimeContextStatusConfig => {
    const budget: RuntimeContextStatusConfig = {
      ...base,
      preservedRecentMessages: config.context.preservedRecentMessages,
      preservedRecentTokens: config.context.preservedRecentTokens,
      maxOverflowRetries: config.context.maxOverflowRetries,
    };
    assertContextBudgetInvariants(budget);
    return budget;
  };
  if (!selectedRef && !config.defaultModel)
    return applyPolicy(defaultContextStatusConfig());
  const resolveStart = performance.now();
  const mark = (name: string) =>
    perfLog(
      `[perf] resolveContextStatusConfig.${name} model=${selectedRef ?? config.defaultModel} +${(performance.now() - resolveStart).toFixed(1)}ms`,
    );
  const effective = resolveEffectiveModel(
    config,
    selectedRef ?? config.defaultModel!,
  );
  if (!effective) return applyPolicy(defaultContextStatusConfig());
  mark("effective");
  const executingModel = provider?.model ?? effective.ref.model;
  const selectionMatchesProvider = executingModel === effective.ref.model;
  const executingProvider = selectionMatchesProvider
    ? effective.providerID
    : (provider?.provider ?? effective.providerID);
  const providerConfig = config.providers[executingProvider];
  const canProbeExecutingProvider =
    selectionMatchesProvider || !!providerConfig;
  mark("config");
  const contextWindow = await resolver.resolve({
    provider: executingProvider,
    model: executingModel,
    baseURL: providerConfig?.connection?.baseURL,
    apiKey: providerConfig?.connection?.apiKey,
    explicitContextWindow: selectionMatchesProvider
      ? effective.limits.contextWindow
      : undefined,
    providerAdapter:
      config.context.autoDetectWindow &&
      canProbeExecutingProvider &&
      shouldProbeProviderMetadata(providerConfig?.connection?.baseURL)
        ? provider
        : undefined,
    useModelsDevCatalog: config.context.autoDetectWindow,
  });
  mark("resolver");
  const catalog = config.context.autoDetectWindow
    ? await modelsDevModelLimits(executingProvider, executingModel)
    : undefined;
  mark("modelsDev");
  mark("modelsDev2");
  const discoveredOutput =
    contextWindow.maxOutputTokens ??
    catalog?.maxOutputTokens ??
    knownModelOutputLimit(executingModel);
  mark("discoveredOutput");
  const reserved = resolveReservedOutputTokens({
    configuredReserved:
      effective.limits.reservedOutputTokens ??
      config.context.reservedOutputTokens,
    explicitMaxOutputTokens: selectionMatchesProvider
      ? effective.limits.maxOutputTokens
      : undefined,
    providerOutputLimit: discoveredOutput,
    catalogOutputLimit: catalog?.maxOutputTokens,
    contextWindow: contextWindow.tokens,
  });
  mark("reserved");
  const effectiveWindow = Math.min(
    contextWindow.tokens,
    effective.limits.inputLimit ?? contextWindow.tokens,
  );
  const budget: RuntimeContextStatusConfig = {
    max: effectiveWindow,
    thresholdPercent:
      effective.limits.compactionThresholdPercent ??
      config.context.compactionThresholdPercent,
    reserved: Math.min(
      effectiveWindow,
      reserved.source === "config"
        ? reserved.tokens
        : Math.min(20_000, reserved.tokens),
    ),
    reservedSource: reserved.source,
    // `applyPolicy` below fills the preserved-recent / overflow policy from the
    // workspace config for every return path (plan §2.3).
    preservedRecentMessages: config.context.preservedRecentMessages,
    preservedRecentTokens: config.context.preservedRecentTokens,
    maxOverflowRetries: config.context.maxOverflowRetries,
    prune: DEFAULT_TOOL_RESULT_PRUNE_OPTIONS,
  };
  // Config-time invariant: a preserved tail above the compaction threshold can
  // never be satisfied, so reject it here instead of spinning at runtime.
  return applyPolicy(budget);
}

function shouldProbeProviderMetadata(baseURL?: string) {
  if (!baseURL) return true;
  try {
    const hostname = new URL(baseURL).hostname;
    return (
      hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1"
    );
  } catch {
    return false;
  }
}

export function createProviderSelection(
  ctx: RuntimeContext,
  options: RealRuntimeClientOptions,
) {
  return {
    currentModelImageInput,
    modelCapabilitiesForExecution,
    mediaTypeForImage,
    applyAgentProvider,
    refreshExecutionContextConfig,
    modelRefKeyForSelection,
    selectedModelRefKey,
    effectiveMaxSteps,
    redactToolOutputEnabled,
    selectRuntimeModel,
    clientModelCatalog,
    defaultContextStatusConfig,
    resolveContextStatusConfig,
  };

  function currentModelImageInput(
    exec: SessionExecutionState | undefined,
  ): boolean {
    const { getTsRuntimeConfig, getSelectedAgent, getSelectedModel } =
      ctx.ports;
    if (exec?.activeModelCapabilities)
      return exec.activeModelCapabilities.imageInput;
    const ref = modelRefKeyForSelection(
      exec ? exec.selectedAgent : getSelectedAgent(),
      exec ? exec.selectedModel : getSelectedModel(),
    );
    const tsRuntimeConfig = getTsRuntimeConfig();
    if (!ref || !tsRuntimeConfig) return false;
    return (
      resolveEffectiveModel(tsRuntimeConfig, ref)?.capabilities.imageInput ??
      false
    );
  }

  function modelCapabilitiesForExecution(
    exec: SessionExecutionState | undefined,
  ): ModelCapabilities {
    const { getTsRuntimeConfig } = ctx.ports;
    const agent = exec?.selectedAgent;
    const model = exec?.selectedModel;
    const ref = modelRefKeyForSelection(agent, model);
    const tsRuntimeConfig = getTsRuntimeConfig();
    return (
      (ref && tsRuntimeConfig
        ? resolveEffectiveModel(tsRuntimeConfig, ref)?.capabilities
        : undefined) ?? {
        toolCall: true,
        reasoning: true,
        thinking: true,
        imageInput: false,
        videoInput: false,
      }
    );
  }

  function mediaTypeForImage(
    path: string,
  ): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | undefined {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "png") return "image/png";
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "webp") return "image/webp";
    if (ext === "gif") return "image/gif";
    return undefined;
  }

  function applyAgentProvider(exec: SessionExecutionState | undefined) {
    const {
      getTsRuntimeConfig,
      getProvider,
      getProviderSource,
      getSelectedAgent,
      getSelectedModel,
      getActiveExec,
      setProvider,
      publishForSession,
    } = ctx.ports;
    if (options.provider) return;
    // A provider that came from the environment or an explicit injection is
    // never overridden by a selection. `unconfigured` is exactly the case
    // that needs this call: with no default model in the config and no env
    // key, the session's own selection is the ONLY thing that can produce a
    // provider - gating it out left every turn dying at not-configured, which
    // is what a config-only deployment (or a fresh machine that has not set
    // a default model yet) hits.
    const source = getProviderSource();
    if (source === "environment" || source === "explicit") return;
    const tsRuntimeConfig = getTsRuntimeConfig();
    if (!tsRuntimeConfig) return;
    const selectedAgent = getSelectedAgent();
    const selectedModel = getSelectedModel();
    const agent = exec ? exec.selectedAgent : selectedAgent;
    const model = exec ? exec.selectedModel : selectedModel;
    const ref = modelRefKeyForSelection(agent, model);
    if (!ref) {
      publishForSession(exec, {
        type: "diagnostic",
        level: "warning",
        message: `agent ${agent?.name ?? "default"} model override is unavailable: model_not_configured; retaining current provider`,
      });
      return;
    }
    const next = providerForModel(
      tsRuntimeConfig,
      ref,
      agent?.variant ?? model?.variant,
      {
        reasoningEffort: exec?.reasoningEffort,
        // T3: the adapter's diagnostics ride the operation log.
        log: logOf(ctx.state.serviceDirectory),
      },
    );
    if (!next) {
      const status = modelSelectionStatus(tsRuntimeConfig, ref);
      publishForSession(exec, {
        type: "diagnostic",
        level: "warning",
        message: `agent ${agent?.name ?? "default"} model override is unavailable: ${status.reason ?? "provider_not_configured"}; retaining current provider`,
      });
      return;
    }
    if (exec) exec.provider = next;
    if (!exec || exec === getActiveExec()) setProvider(next);
  }

  async function refreshExecutionContextConfig(exec: SessionExecutionState) {
    const {
      getTsRuntimeConfig,
      getContextWindowResolver,
      getActiveExec,
      setRuntimeContextConfig,
    } = ctx.ports;
    const tsRuntimeConfig = getTsRuntimeConfig();
    if (!tsRuntimeConfig) return;
    exec.runtimeContextConfig = await resolveContextStatusConfig(
      tsRuntimeConfig,
      exec.provider,
      getContextWindowResolver(),
      modelRefKeyForSelection(exec.selectedAgent, exec.selectedModel),
    );
    if (exec === getActiveExec())
      setRuntimeContextConfig(exec.runtimeContextConfig);
  }

  /** The canonical `provider/model` key of the effective model selection. */
  function modelRefKeyForSelection(
    agent: AgentDefinition | undefined,
    model: { modelID?: string; variant?: string } | undefined,
  ): string | undefined {
    const { getTsRuntimeConfig } = ctx.ports;
    return deriveModelRefKey({
      agent,
      model,
      defaultModel: getTsRuntimeConfig()?.defaultModel,
    });
  }

  function selectedModelRefKey() {
    const { getSelectedAgent, getSelectedModel } = ctx.ports;
    return modelRefKeyForSelection(getSelectedAgent(), getSelectedModel());
  }

  function effectiveMaxSteps(exec: SessionExecutionState | undefined) {
    const { getSelectedAgent, getMaxSteps } = ctx.ports;
    return (
      (exec ? exec.selectedAgent : getSelectedAgent())?.maxSteps ??
      getMaxSteps() ??
      Number.POSITIVE_INFINITY
    );
  }

  /**
   * Redaction precedence, matching how the other boundaries resolve: an agent
   * that states a value wins, then the workspace `security.redactToolOutput`
   * setting, then the schema default.
   */
  function redactToolOutputEnabled(exec: SessionExecutionState | undefined) {
    const { getSelectedAgent, getTsRuntimeConfig } = ctx.ports;
    return (
      (exec ? exec.selectedAgent : getSelectedAgent())?.permissions
        ?.redactOutput ??
      getTsRuntimeConfig()?.security.redactToolOutput ??
      true
    );
  }

  async function selectRuntimeModel(
    modelID?: string,
    variant?: string,
    exec?: SessionExecutionState | undefined,
  ) {
    const {
      getReady,
      getTsRuntimeConfig,
      getActiveExec,
      setSelectedModel,
      publishForSession,
    } = ctx.ports;
    await getReady();
    const tsRuntimeConfig = getTsRuntimeConfig();
    if (!tsRuntimeConfig) throw new Error("runtime config is unavailable");
    let ref: ModelRef | undefined;
    if (modelID) {
      ref = parseModelRef(modelID);
      const status = modelSelectionStatus(tsRuntimeConfig, ref);
      if (!status.selected)
        throw new Error(`model is unavailable: ${status.reason ?? modelID}`);
    } else if (variant) {
      throw new Error("a variant requires a selected model");
    }
    // V3 dropped model variants: the variant is carried as an opaque label for
    // event/selection compatibility but never validated against a model.
    const nextSelection = ref
      ? { modelID: modelRefKey(ref), variant }
      : undefined;
    if (exec) exec.selectedModel = nextSelection;
    if (exec === getActiveExec()) setSelectedModel(nextSelection);
    applyAgentProvider(exec);
    if (exec) await refreshExecutionContextConfig(exec);
    publishForSession(exec, {
      type: "model.selection",
      modelID: ref ? modelRefKey(ref) : undefined,
      variant,
    });
  }

  async function clientModelCatalog() {
    const { getReady, getTsRuntimeConfig } = ctx.ports;
    await getReady();
    const config = getTsRuntimeConfig();
    if (!config) return [];
    let providers: ReturnType<typeof buildModelCatalog>;
    try {
      providers = await modelCatalogInWorker(config);
    } catch {
      providers = buildModelCatalog(config);
    }
    return providers.flatMap((provider) =>
      provider.models
        .filter(
          (entry) =>
            modelSelectionStatus(
              config,
              modelRefKey({ provider: provider.id, model: entry.id }),
            ).selected,
        )
        .map((entry) => ({
          id: modelRefKey({ provider: provider.id, model: entry.id }),
          name: entry.name,
          provider: provider.id,
          // V3 removed model variants; the catalog exposes none.
          variants: [] as string[],
        })),
    );
  }
}
