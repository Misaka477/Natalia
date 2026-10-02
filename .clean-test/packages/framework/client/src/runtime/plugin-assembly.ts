/**
 * Default plugin input assembly — runtime/plugin-assembly.ts.
 *
 * Builds the input objects for runtime default plugins from resolved config:
 * skills, terminal, workspace, provider-model, compaction, MCP and local-tools
 * inputs. Reads host state through `RuntimeContext` at call time.
 */
import { resolve } from "node:path";
import { logOf } from "@anthelia/operation-log";
import { verifyTrust } from "@anthelia/config";
import { toolFamilyCapabilityID } from "../capabilities/tool-family-capabilities";
import type { ConfigV3, SessionID } from "@anthelia/contracts";
import type { RuntimeContext } from "@anthelia/substrate";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";
import type { SkillMetadata } from "@anthelia/runtime-services";
import { expireSessionConsults } from "@natalia/collaboration";

export function createPluginAssembly(
  ctx: RuntimeContext,
  options: RealRuntimeClientOptions,
) {
  const pluginEnabled = (config: ConfigV3, id: string) =>
    config.plugins.enabled[id] !== false;
  return {
    skillsPluginInput,
    providerModelPluginInput,
    mcpPluginInput,
    localToolsPluginInput,
  };

  function skillsPluginInput(config: ConfigV3) {
    const {
      getWorkspaceRoot,
      getUserSkillRoot,
      getExecutionBySession,
      getActiveExec,
      setActiveSkill,
      extensionEnabled,
    } = ctx.ports;
    const workspaceRoot = getWorkspaceRoot();
    if (!pluginEnabled(config, "natalia-skills") || !extensionEnabled("skills"))
      return undefined;
    return {
      workspaceRoot,
      userRoot: getUserSkillRoot(),
      remoteURLs: config.skills.urls,
      // The loaded plugins' shipped skills: read live at each discovery,
      // so an install or uninstall lands on this plugin's next reload
      // (the fingerprint mechanism reloads it on every catalog change —
      // skillsInput is one of the controller's host-input services).
      pluginDirs: () => ctx.ports.getPluginsController().skillDirs(),
      commandSession: {
        active: (sessionID: SessionID) =>
          getExecutionBySession().get(sessionID)?.activeSkill,
        activate: (sessionID: SessionID, skill: SkillMetadata) => {
          const owner = getExecutionBySession().get(sessionID);
          if (!owner) throw new Error(`session not found: ${sessionID}`);
          owner.activeSkill = skill;
          if (owner === getActiveExec()) setActiveSkill(skill);
          owner.context.add({
            id: `skill:${skill.qualifiedName}:${owner.context.journalStatus().journalOffset}`,
            role: "system",
            content: `Active skill ${skill.name}: ${skill.description}\n${skill.body}`,
          });
        },
      },
      onLoad: (
        skill: SkillMetadata,
        output: string,
        context: { sessionID?: string },
      ) => {
        const owner = context.sessionID
          ? getExecutionBySession().get(context.sessionID as SessionID)
          : undefined;
        if (!owner) return;
        owner.activeSkill = skill;
        if (owner === getActiveExec()) setActiveSkill(skill);
        owner.context.add({
          id: `skill:${skill.qualifiedName}:${owner.context.journalStatus().journalOffset}`,
          role: "system",
          content: output,
        });
      },
    };
  }

  function providerModelPluginInput(): import("@anthelia/provider-model").ProviderModelControllerInput {
    const {
      getProvider,
      setProvider,
      setProviderSource,
      providerFromEnvironment,
      getExecutionBySession,
      publishForSession,
      runNaviChatTurn,
      runNiaChatTurn,
      wakeNavi,
      wakeNia,
      providerRunnerInput,
      clientModelCatalog,
      selectRuntimeModel,
    } = ctx.ports;
    return {
      initialize: () => {
        if (!getProvider() && !options.provider) {
          const provider = providerFromEnvironment();
          if (provider) {
            setProvider(provider);
            setProviderSource("environment");
          }
        }
      },
      runnerInput: providerRunnerInput,
      // T3: the collaborator turns' telemetry rides the operation log (the
      // controller's [navi-turn]/[nia-turn] records); an absent runtime log
      // degrades to the noop inside the controller.
      log: logOf(ctx.state.serviceDirectory),
      commands: {
        catalog: clientModelCatalog,
        select: async (sessionID, modelID, variant) => {
          const exec = getExecutionBySession().get(sessionID);
          if (!exec) throw new Error(`session not found: ${sessionID}`);
          await selectRuntimeModel(modelID, variant, exec);
        },
      },
      navi: {
        available: (id) => getExecutionBySession().has(id),
        publish: (id, event) =>
          publishForSession(getExecutionBySession().get(id), event),
        runBody: async (input, signal) => {
          const exec = getExecutionBySession().get(input.sessionID);
          if (!exec)
            throw new Error(
              `no execution state for session ${input.sessionID}`,
            );
          try {
            await runNaviChatTurn({ ...input, exec }, signal);
          } finally {
            // The synchronous consult line (advisor block A): a navi
            // turn that ended without answering a pending question
            // settles it unavailable — the main turn must not wait out
            // the whole timeout for an advisor that is already gone.
            expireSessionConsults(
              input.sessionID,
              "the advisor's turn ended without answering",
            );
          }
        },
        wake: async (id) => {
          const exec = getExecutionBySession().get(id);
          if (exec) await wakeNavi(exec);
        },
      },
      nia: {
        available: (id) => getExecutionBySession().has(id),
        publish: (id, event) =>
          publishForSession(getExecutionBySession().get(id), event),
        runBody: async (input, signal) => {
          const exec = getExecutionBySession().get(input.sessionID);
          if (!exec)
            throw new Error(
              `no execution state for session ${input.sessionID}`,
            );
          await runNiaChatTurn({ ...input, exec }, signal);
        },
        wake: async (id) => {
          const exec = getExecutionBySession().get(id);
          if (exec) await wakeNia(exec);
        },
      },
    };
  }

  function mcpPluginInput(config: ConfigV3) {
    const { getTsRuntimeConfig, extensionEnabled, publish } = ctx.ports;
    if (!pluginEnabled(config, "natalia-mcp") || !extensionEnabled("mcp"))
      return undefined;
    return {
      servers: () => {
        const runtimeConfig = getTsRuntimeConfig();
        const mode =
          runtimeConfig?.agentModes?.[runtimeConfig?.defaultAgentMode ?? ""];
        const selected = mode?.mcpServers;
        // An agent mode controls MCP exactly as a whitelist: no selected MCP
        // means this mode exposes none, even if servers are globally enabled.
        if (!selected || !selected.length) return {};
        const all = runtimeConfig?.mcpServers ?? {};
        return Object.fromEntries(
          Object.entries(all).filter(([name]) => selected.includes(name)),
        );
      },
      workspaceRoot: ctx.ports.getWorkspaceRoot(),
      enabled: () => extensionEnabled("mcp"),
      publish,
      identity: config.mcpServers,
    };
  }

  function localToolsPluginInput(config: ConfigV3) {
    const { getWorkspaceRoot, publish, hotReloadToolFamily } = ctx.ports;
    const workspaceRoot = getWorkspaceRoot();
    if (
      options.tools ||
      !config.tools.paths.length ||
      !pluginEnabled(config, "natalia-local-tools")
    )
      return undefined;
    return {
      roots: config.tools.paths.map((path) => resolve(workspaceRoot, path)),
      onError: (id: string, error: unknown) =>
        publish({
          type: "diagnostic",
          level: "warning",
          owner: "natalia-tools",
          message: `tool family ${id} failed to load: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
      trust: {
        workspaceRoot,
        verify: (key: string, entryPath: string) =>
          verifyTrust(workspaceRoot, key, entryPath),
      },
      onChange: async (familyID: string, entryPath: string) => {
        const verified = await verifyTrust(
          workspaceRoot,
          resolve(entryPath, ".."),
          entryPath,
        );
        if (verified.expected && !verified.verified) {
          publish({
            type: "diagnostic",
            level: "warning",
            owner: toolFamilyCapabilityID(familyID),
            message: `tool family ${familyID} changed on disk without a promotion — refusing to hot reload`,
          });
          return;
        }
        try {
          await hotReloadToolFamily(familyID);
          publish({
            type: "diagnostic",
            level: "info",
            owner: toolFamilyCapabilityID(familyID),
            message: `tool family ${familyID} hot-reloaded`,
          });
        } catch (error) {
          publish({
            type: "diagnostic",
            level: "warning",
            owner: toolFamilyCapabilityID(familyID),
            message: `tool family ${familyID} hot reload failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      },
    };
  }
}
