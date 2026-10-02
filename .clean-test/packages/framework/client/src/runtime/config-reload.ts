/**
 * Config reload — runtime/config-reload.ts.
 *
 * `applyConfigFromDisk` and `reloadConfigFromDisk` re-read the resolved config
 * and apply it live: runtime limits, permission settings, the agent registry,
 * the default plugin catalog and provider re-selection. Reads and writes host
 * state through `RuntimeContext` ports.
 */
import { agentsFromConfig } from "@anthelia/agent";
import { logOf } from "@anthelia/operation-log";
import { compositionProfile } from "@anthelia/composition";
import { renderSubagentTypes } from "@anthelia/subagents";
import { resolveConfig } from "@anthelia/config";
import { ensureBashCommandParser } from "@anthelia/tools";
import {
  ProviderConcurrencyLimiter,
  providerForModel,
} from "@anthelia/runtime";
import { nextContextInstructionsRevision } from "@anthelia/session";
import { projectedConstitutionRules } from "@anthelia/session";
import {
  checkpointFactory,
  type CheckpointFactory,
} from "@anthelia/checkpoint";
import { ObjectStore } from "@anthelia/object-store";
import { buildGeneration, storeGeneration } from "@anthelia/composition";
import { generationAdapterRows, generationPrompts } from "./generation-inputs";
import type { RuntimeContext } from "@anthelia/substrate";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";
import type { ConfigV3, ConstitutionRule } from "@anthelia/contracts";
import { resolve } from "node:path";
import { resolveWorkspaceObjectsRoot } from "@anthelia/platform";
import {
  providerAdapterModuleRequests,
  reloadProviderAdapterModules,
} from "@anthelia/runtime";

/**
 * The checkpoint factory owns per-session controllers; a config reload must
 * reset them so the next initialization reads the new checkpoint settings.
 */
/**
 * Re-render the `agent_spawn` description from the current agent registry.
 *
 * The request builder reads each tool's description per step, so mutating it in
 * place is enough — no re-registration, and the tool's identity (name,
 * parameters) is untouched so the request prefix does not churn.
 */

/**
 * The constitution rows a generation carries (study §4.1): the active
 * ledger projected from the session's journal, normalized from the
 * `rule_added` event shape into contract rows. Empty only when no session
 * exists yet — there is no active constitution to violate.
 */
export function activeConstitutionRows(
  ctx: RuntimeContext,
): ConstitutionRule[] {
  const exec = [...ctx.ports.getExecutionBySession().values()][0];
  if (!exec?.session) return [];
  return projectedConstitutionRules(exec.session.events).map((event) => ({
    id: event.ruleID,
    statement: event.statement,
    scope: event.scope,
    priority: event.priority,
    source: event.source,
    enforcement: event.enforcement,
    overridePolicy: event.overridePolicy,
    evidenceRefs: event.evidenceRefs ?? [],
  }));
}

function refreshAgentSpawnDescription(
  ctx: RuntimeContext,
  registry: import("@anthelia/agent").AgentRegistry,
) {
  const spawn = ctx.state.tools.get("agent_spawn");
  if (!spawn) return;
  spawn.description = [
    "Spawn an isolated TS/Bun subagent task.",
    renderSubagentTypes(
      registry.list().map((agent) => ({
        name: agent.name,
        description: agent.description,
        mode: agent.mode,
        allowedTools: agent.allowedTools,
        excludedTools: agent.excludedTools,
      })),
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

function resetCheckpointFactory(ctx: RuntimeContext) {
  const checkpointClose = ctx.state.serviceDirectory.getOptional(
    checkpointFactory,
  ) as (CheckpointFactory & { close?(): void }) | undefined;
  checkpointClose?.close?.();
}

let lastGenerationID: string | undefined;

export function createConfigReload(
  ctx: RuntimeContext,
  options: RealRuntimeClientOptions,
) {
  let reloadQueue = Promise.resolve<{
    read: boolean;
    providerReconfigured: boolean;
    reason?: string;
  }>({ read: false, providerReconfigured: false });

  return {
    configReloadBlockedReason,
    applyConfigFromDisk,
    reloadConfigFromDisk,
  };

  function configReloadBlockedReason() {
    const { getExecutionBySession, getInteractive } = ctx.ports;
    if ([...getExecutionBySession().values()].some((exec) => exec.activeTurnID))
      return "runtime config cannot be applied while a turn is running";
    if (getInteractive()?.hasPendingWaiters())
      return "runtime config cannot be applied while an approval or question is pending";
    return undefined;
  }

  /**
   * Reloads config from disk and applies it, answering value-style. Shared by
   * `reloadConfig` and `updateConfig` so the two write-apply paths cannot
   * drift.
   */
  async function applyConfigFromDisk(): Promise<{
    applied: boolean;
    reason?: string;
  }> {
    const { publish, scheduleRuntimeStatusSnapshot } = ctx.ports;
    const blocked = configReloadBlockedReason();
    if (blocked) return { applied: false, reason: blocked };
    const reloaded = await reloadConfigFromDisk();
    if (!reloaded.read) {
      const reason = "runtime config on disk could not be read";
      publish({ type: "diagnostic", level: "warning", message: reason });
      return { applied: false, reason };
    }
    if (reloaded.reason) {
      publish({
        type: "diagnostic",
        level: "warning",
        message: reloaded.reason,
      });
      return { applied: false, reason: reloaded.reason };
    }
    publish({
      type: "diagnostic",
      level: "info",
      message: reloaded.providerReconfigured
        ? "runtime config reloaded; provider reconfigured from disk"
        : "runtime config reloaded; provider unchanged",
    });
    // ADR Phase C: a config reload is a prompt-level instruction change.
    // Record it as a durable `context.instructions` notice per session so the
    // interleaved context stream shows it — appended with a higher revision,
    // never mutating earlier messages (D3/D6).
    for (const exec of ctx.ports.getExecutionBySession().values()) {
      const revision = nextContextInstructionsRevision(exec.session.events);
      ctx.ports.publishForSession(exec, {
        type: "context.instructions",
        id: `context:config:${Date.now().toString(36)}:${revision}`,
        kind: "config_reload",
        at: new Date().toISOString(),
        revision,
        summary: reloaded.providerReconfigured
          ? "runtime config reloaded; provider reconfigured from disk"
          : "runtime config reloaded; provider unchanged",
      });
    }
    scheduleRuntimeStatusSnapshot();
    const candidateID = await stageCandidate("config.reload");
    if (candidateID) commitCandidate(candidateID, "config.reload");
    return { applied: true };
  }

  /**
   * Stages the reloaded composition as a content-addressed candidate and
   * publishes the attempt (P2 / NGM G2). The candidate is stored before the
   * switch is decided, so a failed apply leaves a proposal in the journal
   * with no matching switch — the record of what was tried.
   */
  async function stageCandidate(reason: string): Promise<string | undefined> {
    try {
      const config = ctx.ports.getTsRuntimeConfig();
      if (!config) return undefined;
      const store = new ObjectStore(
        resolveWorkspaceObjectsRoot(ctx.ports.getWorkspaceRoot()),
      );
      const catalog = ctx.ports.getPluginsController().catalog();
      const candidateID = await storeGeneration(
        store,
        buildGeneration({
          config,
          catalog,
          policyRows: activeConstitutionRows(ctx),
          prompts: generationPrompts(ctx.ports.getWorkspaceRoot()),
          rows: generationAdapterRows(ctx),
        }),
      );
      ctx.ports.publish({ type: "composition.proposed", candidateID, reason });
      return candidateID;
    } catch (error) {
      ctx.ports.publish({
        type: "diagnostic",
        level: "warning",
        message: `composition record failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return undefined;
    }
  }

  /**
   * Commits the staged candidate as the running generation (P2 / NGM G1/G2).
   * The from-link comes from this closure's memory of the last committed
   * generation; the journal remains the durable record either way.
   */
  function commitCandidate(candidateID: string, reason: string) {
    const profile = ctx.state.serviceDirectory.getOptional(compositionProfile);
    ctx.ports.publish({
      type: "composition.switched",
      ...(lastGenerationID ? { from: lastGenerationID } : {}),
      ...(profile ? { compositionHash: profile.hash } : {}),
      to: candidateID,
      reason,
    });
    lastGenerationID = candidateID;
  }

  async function reloadConfigFromDisk(): Promise<{
    read: boolean;
    providerReconfigured: boolean;
    reason?: string;
  }> {
    const reload = reloadQueue.then(applyReloadFromDisk, applyReloadFromDisk);
    reloadQueue = reload;
    return await reload;
  }

  async function applyReloadFromDisk(): Promise<{
    read: boolean;
    providerReconfigured: boolean;
    reason?: string;
  }> {
    const {
      getWorkspaceRoot,
      publish,
      getExecutionBySession,
      setTsRuntimeConfig,
      setMaxSteps,
      setRetryPolicy,
      setProviderConcurrencyLimiter,
      getSelectedAgent,
      setSelectedAgent,
      setAgentRegistry,
      getPermissionMode,
      getSelectedPermissionProfile,
      getTools,
      getPluginsController,
      applyAgentPolicy,
      setProvider,
      setProviderSource,
      getContextWindowResolver,
      refreshExecutionContextConfig,
      modelRefKeyForSelection,
      runPluginLifecyclePostReconcile,
      publishToolCatalogChanges,
    } = ctx.ports;
    const workspaceRoot = getWorkspaceRoot();
    const previous = captureReloadState();
    try {
      const tsConfig = await resolveConfig({
        workspaceRoot,
        globalPath: options.globalConfigPath,
      });
      setTsRuntimeConfig(tsConfig.config);
      resetCheckpointFactory(ctx);
      setMaxSteps(tsConfig.config.runtime.maxStepsPerTurn);
      setRetryPolicy({
        maxAttemptsPerStep:
          tsConfig.config.runtime.maxAttemptsPerStep ??
          tsConfig.config.runtime.retry.maxAttemptsPerStep,
        initialBackoffMs: tsConfig.config.runtime.retry.initialBackoffMs,
        maxBackoffMs: tsConfig.config.runtime.retry.maxBackoffMs,
        jitterMs: tsConfig.config.runtime.retry.jitterMs,
      });
      setProviderConcurrencyLimiter(
        new ProviderConcurrencyLimiter(
          tsConfig.config.runtime.providerConcurrency ?? {},
        ),
      );
      const selectedAgentName = getSelectedAgent()?.name;
      const agentRegistry = agentsFromConfig(tsConfig.config);
      setAgentRegistry(agentRegistry);
      // Re-render the advertised spawn types: the request builder reads each
      // tool's description per step, so updating it in place keeps the types
      // current without disturbing the tool's identity or the request prefix.
      refreshAgentSpawnDescription(ctx, agentRegistry);
      setSelectedAgent(
        selectedAgentName
          ? (agentRegistry.select(selectedAgentName) ?? agentRegistry.default())
          : agentRegistry.default(),
      );
      for (const exec of getExecutionBySession().values()) {
        const name = exec.selectedAgent?.name;
        exec.selectedAgent = name
          ? (agentRegistry.select(name) ?? agentRegistry.default())
          : agentRegistry.default();
      }
      // Permission changes (default profile switch, auto/ask flip, profile
      // edits) apply immediately, not on the next restart.
      ctx.ports.reloadPermissionSettings(tsConfig.config);
      await ctx.state.frameworkServices?.refreshRuntimeConfig();
      const permissionMode = getPermissionMode();
      const selectedPermissionProfile = getSelectedPermissionProfile();
      for (const exec of getExecutionBySession().values()) {
        exec.permissionMode = permissionMode;
        exec.permissionProfile = selectedPermissionProfile;
      }
      const toolsBeforeReconcile = new Set(getTools().keys());
      const selectedSkills = new Map(
        [...getExecutionBySession().entries()].flatMap(([id, exec]) =>
          exec.activeSkill ? [[id, exec.activeSkill.qualifiedName]] : [],
        ),
      );
      await getPluginsController().reconcileDesired(
        [],
        tsConfig.config.plugins,
      );
      await runPluginLifecyclePostReconcile(selectedSkills);
      publishToolCatalogChanges(toolsBeforeReconcile);
      applyAgentPolicy();
      if (
        selectedPermissionProfile?.commandRules &&
        selectedPermissionProfile.commandRules.mode !== "none"
      )
        await ensureBashCommandParser().catch(() => undefined);
      if (!options.provider) {
        // Adapter modules track the configured set: without this, a reload that
        // adds or removes an `endpointProtocol.module` leaves the old set live,
        // and `providerForModel` below resolves a format from it. Withdrawing
        // first also keeps the second load from tripping the duplicate-format
        // guard, which would fail the reload rather than replace the adapter.
        const adapterResults = await reloadProviderAdapterModules({
          workspaceRoot: getWorkspaceRoot(),
          requests: providerAdapterModuleRequests(tsConfig.config.providers),
        });
        for (const result of adapterResults) {
          if (!result.ok)
            publish({
              type: "diagnostic",
              level: "warning",
              message:
                `provider adapter module for "${result.providerID}" did not ` +
                `load (${result.module}): ${result.error}`,
            });
        }
        const configured = providerForModel(
          tsConfig.config,
          getSelectedAgent()?.model ?? tsConfig.config.defaultModel,
          getSelectedAgent()?.variant,
          {
            // T3: the adapter's diagnostics ride the operation log.
            log: logOf(ctx.state.serviceDirectory),
          },
        );
        if (configured) {
          setProvider(configured);
          setProviderSource("ts_config");
          for (const exec of getExecutionBySession().values())
            ctx.ports.applyAgentProvider(exec);
          ctx.ports.setRuntimeContextConfig(
            await ctx.ports.resolveContextStatusConfig(
              tsConfig.config,
              configured,
              getContextWindowResolver(),
              modelRefKeyForSelection(getSelectedAgent(), undefined),
            ),
          );
          for (const exec of getExecutionBySession().values())
            await refreshExecutionContextConfig(exec);
          return { read: true, providerReconfigured: true };
        }
      }
      ctx.ports.setRuntimeContextConfig(
        await ctx.ports.resolveContextStatusConfig(
          tsConfig.config,
          ctx.ports.getProvider(),
          getContextWindowResolver(),
          modelRefKeyForSelection(getSelectedAgent(), undefined),
        ),
      );
      for (const exec of getExecutionBySession().values())
        await refreshExecutionContextConfig(exec);
      return { read: true, providerReconfigured: false };
    } catch (error) {
      let rollbackError: unknown;
      try {
        await rollbackReload(previous);
      } catch (failure) {
        rollbackError = failure;
      }
      const reason = error instanceof Error ? error.message : String(error);
      return {
        read: true,
        providerReconfigured: false,
        reason: `runtime config could not be applied: ${reason}${
          rollbackError === undefined
            ? ""
            : `; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        }`,
      };
    }
  }

  function captureReloadState() {
    const ports = ctx.ports;
    return {
      config: ports.getTsRuntimeConfig(),
      maxSteps: ports.getMaxSteps(),
      retryPolicy: ports.getRetryPolicy(),
      limiter: ports.getProviderConcurrencyLimiter(),
      agentRegistry: ports.getAgentRegistry(),
      selectedAgent: ports.getSelectedAgent(),
      permissionMode: ports.getPermissionMode(),
      selectedPermissionProfile: ports.getSelectedPermissionProfile(),
      defaultPermissionMode: ports.getDefaultPermissionMode(),
      defaultPermissionProfile: ports.getDefaultPermissionProfile(),
      provider: ports.getProvider(),
      providerSource: ports.getProviderSource(),
      runtimeContextConfig: ports.getRuntimeContextConfig(),
      executions: new Map(
        [...ports.getExecutionBySession()].map(([id, exec]) => [
          id,
          {
            selectedAgent: exec.selectedAgent,
            permissionMode: exec.permissionMode,
            permissionProfile: exec.permissionProfile,
            provider: exec.provider,
            runtimeContextConfig: exec.runtimeContextConfig,
            activeSkill: exec.activeSkill?.qualifiedName,
          },
        ]),
      ),
    };
  }

  async function rollbackReload(
    previous: ReturnType<typeof captureReloadState>,
  ) {
    const ports = ctx.ports;
    ports.setTsRuntimeConfig(previous.config);
    resetCheckpointFactory(ctx);
    ports.setMaxSteps(previous.maxSteps);
    ports.setRetryPolicy(previous.retryPolicy);
    ports.setProviderConcurrencyLimiter(previous.limiter);
    if (previous.agentRegistry) {
      ports.setAgentRegistry(previous.agentRegistry);
      // The reload re-derived the agent_spawn description from the new registry
      // in place; restoring the registry alone would leave that description stale,
      // so re-derive it from the registry we just put back.
      refreshAgentSpawnDescription(ctx, previous.agentRegistry);
    }
    ports.setSelectedAgent(previous.selectedAgent);
    ports.setPermissionMode(previous.permissionMode);
    ports.setSelectedPermissionProfile(previous.selectedPermissionProfile);
    ports.setDefaultPermissionMode(previous.defaultPermissionMode);
    ports.setDefaultPermissionProfile(previous.defaultPermissionProfile);
    await ctx.state.frameworkServices?.refreshRuntimeConfig();
    ports.setProvider(previous.provider);
    ports.setProviderSource(previous.providerSource);
    // Third rollback gap: the forward reload swaps the provider adapter
    // module set (withdrawing the previous config's, loading the new one's).
    // Restore the previous set and publish the same diagnostics the forward
    // path does, so the restored provider can still resolve a module format.
    if (!options.provider && previous.config) {
      const adapterResults = await reloadProviderAdapterModules({
        workspaceRoot: ports.getWorkspaceRoot(),
        requests: providerAdapterModuleRequests(previous.config.providers),
      });
      for (const result of adapterResults)
        if (!result.ok)
          ports.publish({
            type: "diagnostic",
            level: "warning",
            message: `provider adapter module for "${result.providerID}" did not load (${result.module}): ${result.error}`,
          });
    }
    ports.setRuntimeContextConfig(previous.runtimeContextConfig);
    for (const [id, state] of previous.executions) {
      const exec = ports.getExecutionBySession().get(id);
      if (!exec) continue;
      exec.selectedAgent = state.selectedAgent;
      exec.permissionMode = state.permissionMode;
      exec.permissionProfile = state.permissionProfile;
      exec.provider = state.provider;
      exec.runtimeContextConfig = state.runtimeContextConfig;
    }
    ports.applyAgentPolicy();
    if (!previous.config) return;
    // A reload that failed after it published the new config's tool catalog
    // leaves the UI projecting tools the restored registry no longer has.
    // Reconcile back and re-publish the diff, mirroring the forward path.
    const toolsBeforeRollback = new Set(ports.getTools().keys());
    await ports
      .getPluginsController()
      .reconcileDesired([], previous.config.plugins);
    const selectedSkills = new Map(
      [...previous.executions].flatMap(([id, state]) =>
        state.activeSkill ? [[id, state.activeSkill]] : [],
      ),
    );
    await ports.runPluginLifecyclePostReconcile(selectedSkills);
    ports.publishToolCatalogChanges(toolsBeforeRollback);
  }
}
