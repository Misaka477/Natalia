import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import { skillService } from "@anthelia/runtime-services";
import { modelRefKey, parseModelRef } from "@anthelia/contracts";
import { nextContextInstructionsRevision } from "@anthelia/session";
import { discoverProviderModels, updateConfigAtScope } from "@anthelia/config";
import type { RuntimeContext } from "@anthelia/substrate";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";
import { providerFormatFromDriver } from "@anthelia/runtime";
type ClientSurfaceOptions = Pick<RealRuntimeClientOptions, "globalConfigPath">;
type Surface = Pick<
  RuntimeServiceClient,
  | "agents"
  | "selectAgent"
  | "modelCatalog"
  | "modelSelection"
  | "selectModel"
  | "setDefaultModel"
  | "reasoningEffort"
  | "setReasoningEffort"
  | "skills"
  | "skillSetEnabled"
  | "skillRemove"
  | "agentCreate"
  | "agentUpdate"
  | "agentDelete"
  | "providerDiscover"
  | "providerAdd"
  | "providerRemove"
>;
async function selectionExec(ctx: RuntimeContext, sessionID?: string) {
  if (sessionID)
    return (
      ctx.ports
        .getExecutionBySession()
        .get(sessionID as import("@anthelia/contracts").SessionID) ??
      (await ctx.ports.ensureExecution(
        sessionID as import("@anthelia/contracts").SessionID,
      ))
    );
  return ctx.ports.getActiveExec();
}

export function createSelectionSurface(
  ctx: RuntimeContext,
  options: ClientSurfaceOptions,
): Surface {
  return {
    async selectAgent(name, sessionID?) {
      const agent = ctx.ports.getAgentRegistry()?.select(name);
      if (name && !agent) {
        const diagnostic = {
          type: "diagnostic" as const,
          level: "error" as const,
          message: `agent not found: ${name}`,
        };
        const exec = await selectionExec(ctx, sessionID);
        if (exec) ctx.ports.publishForSession(exec, diagnostic);
        else ctx.ports.publish(diagnostic);
        // A diagnostic is not an answer to the caller: a remote UI used to be
        // told the agent was selected and then render the wrong one.
        return { outcome: "rejected", reason: `agent not found: ${name}` };
      }
      const exec = await selectionExec(ctx, sessionID);
      const activeExec = ctx.ports.getActiveExec();
      const isActive = exec === activeExec;
      const publishSessionEvent = (
        event: import("@anthelia/contracts").RuntimeEvent,
      ) => {
        if (exec) ctx.ports.publishForSession(exec, event);
        else ctx.ports.publish(event);
      };
      if (exec?.activeAbort) {
        if (isActive) ctx.ports.setPendingAgent(agent);
        exec.pendingAgent = agent;
        publishSessionEvent({
          type: "agent.selection",
          name: agent?.name,
          pending: true,
        });
        // Deferred, not applied: switching agents mid-turn would change the rules
        // the turn started under.
        return {
          outcome: "pending",
          selected: agent?.name,
          reason: "a turn is running; the selection applies when it ends",
        };
      }
      if (isActive) ctx.ports.setSelectedAgent(agent);
      if (exec) exec.selectedAgent = agent;
      ctx.ports.applyAgentPolicy();
      ctx.ports.applyAgentProvider(exec);
      publishSessionEvent({
        type: "agent.selection",
        name: agent?.name,
        pending: false,
      });
      // ADR Phase C: an agent switch is a prompt-level instruction change 鈥?      // record it as a durable `context.instructions` notice so the UI shows
      // it in the interleaved context stream without mutating history.
      if (exec)
        ctx.ports.publishForSession(exec, {
          type: "context.instructions",
          id: `context:agent:${Date.now().toString(36)}:${nextContextInstructionsRevision(exec.session.events)}`,
          kind: "agent_switch",
          at: new Date().toISOString(),
          revision: nextContextInstructionsRevision(exec.session.events),
          summary: `active agent switched to ${agent?.name ?? "default"}`,
        });
      return { outcome: "applied", selected: agent?.name };
    },
    async agents() {
      await ctx.ports.getReady();
      return (ctx.ports.getAgentRegistry()?.list() ?? []).map((agent) => ({
        name: agent.name,
        description: agent.description,
        mode: agent.mode,
        hidden: agent.hidden,
        color: agent.color,
        model: agent.model,
        variant: agent.variant,
        maxSteps: agent.maxSteps,
        allowedTools: agent.allowedTools,
        excludedTools: agent.excludedTools,
        mcpServers: agent.mcpServers,
        permissions: agent.permissions,
      }));
    },
    async modelCatalog() {
      return await ctx.ports.clientModelCatalog();
    },
    async modelSelection(sessionID?) {
      await ctx.ports.getReady();
      const exec = await selectionExec(ctx, sessionID);
      if (!exec)
        return {
          modelID: ctx.ports.selectedModelRefKey(),
          variant:
            ctx.ports.getSelectedAgent()?.variant ??
            ctx.ports.getSelectedModel()?.variant,
        };
      return {
        modelID: ctx.ports.modelRefKeyForSelection(
          exec.selectedAgent,
          exec.selectedModel,
        ),
        variant: exec.selectedAgent?.variant ?? exec.selectedModel?.variant,
      };
    },
    async selectModel(modelID, variant, sessionID?) {
      const exec = await selectionExec(ctx, sessionID);
      await ctx.ports.selectRuntimeModel(modelID, variant, exec);
    },
    async setDefaultModel(modelID) {
      await ctx.ports.getReady();
      if (!modelID) return { saved: false, reason: "modelID is required" };
      let modelRef;
      try {
        modelRef = parseModelRef(modelID);
      } catch (error) {
        return {
          saved: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      await updateConfigAtScope(
        ctx.ports.getWorkspaceRoot(),
        { defaultModel: modelRef } as never,
        "global",
        { globalPath: options.globalConfigPath },
      );
      await ctx.ports.applyConfigFromDisk().catch(() => undefined);
      return { saved: true };
    },
    async reasoningEffort(sessionID?) {
      await ctx.ports.getReady();
      const exec = await selectionExec(ctx, sessionID);
      return exec?.reasoningEffort;
    },
    async setReasoningEffort(effort, sessionID?) {
      await ctx.ports.getReady();
      if (effort && !isRuntimeReasoningEffort(effort))
        throw new Error(`unsupported reasoning effort: ${effort}`);
      const exec = await selectionExec(ctx, sessionID);
      if (!exec) throw new Error("session execution is unavailable");
      exec.reasoningEffort = effort;
      ctx.ports.publishForSession(exec, {
        type: "model.reasoning.set",
        reasoningEffort: effort,
      });
      ctx.ports.applyAgentProvider(exec);
    },
    async skills() {
      await ctx.ports.getReady();
      return ctx.ports.skillsList().map((skill) => ({
        name: skill.name,
        enabled: skill.enabled,
        qualifiedName: skill.qualifiedName,
        description: skill.description,
        source: skill.source,
        requireApproval: skill.requireApproval,
        sandboxRequired: skill.sandboxRequired,
      }));
    },
    async skillSetEnabled(input: {
      name: string;
      enabled: boolean;
      workspaceID?: string;
    }) {
      await ctx.ports.getReady();
      const services = ctx.state.serviceDirectory.getOptional(skillService);
      if (!services) throw new Error("skill service is unavailable");
      return await services.setSkillEnabled(input.name, input.enabled);
    },
    async skillRemove(input: { name: string; workspaceID?: string }) {
      await ctx.ports.getReady();
      const services = ctx.state.serviceDirectory.getOptional(skillService);
      if (!services) throw new Error("skill service is unavailable");
      return await services.removeSkill(input.name);
    },
    async agentCreate(input) {
      await ctx.ports.getReady();
      const config = ctx.ports.getTsRuntimeConfig();
      if (config && config.agents[input.name])
        return {
          created: false,
          reason: `agent already exists: ${input.name}`,
        };
      await updateConfigAtScope(
        ctx.ports.getWorkspaceRoot(),
        {
          agents: { [input.name]: input.config },
        } as never,
        "project",
        { globalPath: options.globalConfigPath },
      );
      await ctx.ports.applyConfigFromDisk();
      return { created: true };
    },
    async agentUpdate(input) {
      await ctx.ports.getReady();
      const config = ctx.ports.getTsRuntimeConfig();
      if (!config || !config.agents[input.name])
        throw new Error(`agent not found: ${input.name}`);
      await updateConfigAtScope(
        ctx.ports.getWorkspaceRoot(),
        {
          agents: { [input.name]: input.config },
        } as never,
        "project",
        { globalPath: options.globalConfigPath },
      );
      await ctx.ports.applyConfigFromDisk();
      return { updated: true };
    },
    async agentDelete(name) {
      await ctx.ports.getReady();
      const config = ctx.ports.getTsRuntimeConfig();
      if (config && config.defaultAgent === name)
        return {
          deleted: false,
          reason: `agent is the default agent: ${name}`,
        };
      await updateConfigAtScope(
        ctx.ports.getWorkspaceRoot(),
        {
          agents: { [name]: undefined },
        } as never,
        "project",
        { globalPath: options.globalConfigPath },
      );
      await ctx.ports.applyConfigFromDisk();
      return { deleted: true };
    },
    async providerDiscover(input) {
      await ctx.ports.getReady();
      const models = await discoverProviderModels(
        input.type,
        input.baseURL,
        input.apiKey,
        input.headers,
      );
      return { models };
    },
    async providerAdd(input) {
      // Provider config is global-only and does not require a fully-initialized
      // workspace runtime. In read-only workspaces getReady may fail on
      // checkpoint storage, but provider settings must still be writable.
      const config = ctx.ports.getTsRuntimeConfig();
      const sourceName =
        input.previousName && input.previousName !== input.name
          ? input.previousName
          : input.name;
      const current = config?.providers?.[sourceName];
      const provider = {
        ...current,
        name: input.label || input.name,
        driver: input.type,
        enabled: true,
        // Declare the wire format instead of leaving it to be inferred: the
        // resolver falls back to a name guess and warns on every boot until
        // this is written. The vocabulary is the resolver's own
        // (providerFormatFromDriver), so an existing entry keeps its format.
        protocol: {
          ...(current?.protocol ?? {}),
          format:
            current?.protocol?.format ?? providerFormatFromDriver(input.type),
        },
        connection: {
          ...(current?.connection ?? {}),
          baseURL: input.baseURL || current?.connection?.baseURL,
          apiKey: input.apiKey || current?.connection?.apiKey,
        },
        requestDefaults: {
          ...(current?.requestDefaults ?? {}),
          ...(input.headers ? { headers: input.headers } : {}),
        },
      };
      const models =
        input.models !== undefined
          ? Object.fromEntries(
              input.models.map((model) => [
                model.id,
                {
                  name: model.name || model.id,
                  capabilities: {
                    reasoning: model.reasoning ?? false,
                    imageInput: model.image ?? false,
                  },
                  limits: {
                    contextWindow: model.contextWindow ?? "auto",
                  },
                  status: "stable",
                  source: "manual",
                },
              ]),
            )
          : undefined;
      const providerPatch: Record<string, unknown> = {
        [input.name]: provider,
      };
      if (sourceName !== input.name) providerPatch[sourceName] = undefined;

      const catalogProviderPatch: Record<string, unknown> = {};
      if (sourceName !== input.name)
        catalogProviderPatch[sourceName] = undefined;
      if (models) {
        // Config objects deep-merge; explicitly remove IDs missing from the submitted list.
        catalogProviderPatch[input.name] = {
          models: {
            ...Object.fromEntries(
              Object.keys(config?.catalog.providers[input.name]?.models ?? {})
                .filter((id) => !(id in models))
                .map((id) => [id, undefined]),
            ),
            ...models,
          },
        };
      } else if (
        sourceName !== input.name &&
        config?.catalog?.providers?.[sourceName]
      ) {
        catalogProviderPatch[input.name] = config.catalog.providers[sourceName];
      }

      const modelOverridesPatch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(config?.modelOverrides ?? {})) {
        if (!key.startsWith(`${sourceName}/`)) continue;
        const id = key.slice(sourceName.length + 1);
        if (models && !(id in models)) {
          modelOverridesPatch[key] = undefined;
        } else if (sourceName !== input.name) {
          modelOverridesPatch[key] = undefined;
          modelOverridesPatch[`${input.name}/${id}`] = value;
        }
      }

      await updateConfigAtScope(
        ctx.ports.getWorkspaceRoot(),
        {
          providers: providerPatch,
          ...(Object.keys(catalogProviderPatch).length
            ? { catalog: { providers: catalogProviderPatch } }
            : {}),
          ...(Object.keys(modelOverridesPatch).length
            ? { modelOverrides: modelOverridesPatch }
            : {}),
        } as never,
        "global",
        { globalPath: options.globalConfigPath },
      );
      try {
        await ctx.ports.applyConfigFromDisk();
      } catch (error) {
        // The config file is already persisted. A reload failure in a
        // read-only workspace must not make provider management look broken.
        ctx.ports.publish({
          type: "diagnostic",
          level: "warning",
          message: `provider saved but config reload deferred: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return { saved: true };
    },
    async providerRemove(name) {
      await ctx.ports.getReady();
      const config = ctx.ports.getTsRuntimeConfig();
      if (!config) throw new Error("provider configuration unavailable");
      const modelPrefix = `${name}/`;
      const blocked: string[] = [];
      const defaultModelReferencesProvider =
        config.defaultModel?.provider === name;
      for (const [agentName, agent] of Object.entries(config.agents ?? {})) {
        if (agent.model?.startsWith(modelPrefix))
          blocked.push(`agent:${agentName}`);
      }
      for (const [modeName, mode] of Object.entries(config.agentModes ?? {})) {
        if (mode.model?.startsWith(modelPrefix))
          blocked.push(`agentMode:${modeName}`);
      }
      for (const exec of ctx.ports.getExecutionBySession().values()) {
        if (
          exec.selectedModel?.modelID?.startsWith(modelPrefix) ||
          exec.selectedAgent?.model?.startsWith(modelPrefix) ||
          exec.pendingAgent?.model?.startsWith(modelPrefix)
        )
          blocked.push(`session:${exec.session.id}`);
        for (const [stream, profile] of [
          ["navi", exec.naviChatModelProfile],
          ["nia", exec.niaChatModelProfile],
        ] as const) {
          if (!profile) continue;
          if (
            profile.normal?.modelID?.startsWith(modelPrefix) ||
            profile.expert?.modelID?.startsWith(modelPrefix)
          )
            blocked.push(`session:${exec.session.id}:${stream}`);
        }
      }
      if (blocked.length)
        return {
          removed: false,
          reason: `provider is referenced by ${blocked.join(", ")}`,
        };

      let newDefaultModel: { provider: string; model: string } | undefined;
      if (defaultModelReferencesProvider) {
        const currentModelID =
          ctx.ports.getActiveExec()?.selectedModel?.modelID ??
          ctx.ports.getSelectedModel()?.modelID;
        if (currentModelID && !currentModelID.startsWith(modelPrefix)) {
          try {
            newDefaultModel = parseModelRef(currentModelID);
          } catch {
            newDefaultModel = undefined;
          }
        }
        if (!newDefaultModel) {
          for (const [providerID, catalogProvider] of Object.entries(
            config.catalog?.providers ?? {},
          )) {
            if (providerID === name) continue;
            const firstModel = Object.keys(
              (catalogProvider as { models?: Record<string, unknown> })
                ?.models ?? {},
            )[0];
            if (firstModel) {
              newDefaultModel = { provider: providerID, model: firstModel };
              break;
            }
          }
        }
        if (!newDefaultModel)
          return {
            removed: false,
            reason:
              "provider is the only configured provider; cannot remove without creating another provider",
          };
      }

      const modelOverrides = Object.fromEntries(
        Object.keys(config.modelOverrides ?? {})
          .filter((key) => key.startsWith(modelPrefix))
          .map((key) => [key, undefined]),
      );
      await updateConfigAtScope(
        ctx.ports.getWorkspaceRoot(),
        {
          providers: { [name]: undefined },
          catalog: { providers: { [name]: undefined } },
          modelOverrides,
          ...(newDefaultModel ? { defaultModel: newDefaultModel } : {}),
        } as never,
        "global",
        { globalPath: options.globalConfigPath },
      );
      await ctx.ports.applyConfigFromDisk();
      return {
        removed: true,
        ...(newDefaultModel
          ? { defaultModel: modelRefKey(newDefaultModel) }
          : {}),
      };
    },
  };
}

function isRuntimeReasoningEffort(
  value: unknown,
): value is import("@anthelia/contracts").RuntimeReasoningEffort {
  return (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}
