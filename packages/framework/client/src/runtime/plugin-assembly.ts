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
import { providerForModel } from "@anthelia/runtime";

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
      // P2-21: a catalog change mid-session is announced, not silently
      // absorbed. A session that loaded a skill at version N learns the listed
      // set moved (and exactly which skills arrived or left), so its snapshot
      // is knowingly stale rather than quietly wrong — the 2026-10-08 audit
      // watched the skills change three times mid-session with nothing said.
      onCatalogChange: (change: {
        version: number;
        added: string[];
        removed: string[];
      }) => {
        const parts = [
          `skills catalog is now version ${change.version}`,
          ...(change.added.length ? [`added: ${change.added.join(", ")}`] : []),
          ...(change.removed.length
            ? [`removed: ${change.removed.join(", ")}`]
            : []),
        ];
        ctx.ports.publish({
          type: "diagnostic",
          level: "info",
          owner: "natalia-skills",
          message: `${parts.join("; ")}. A skill loaded earlier in this session was loaded against the previous catalog — reload it if the change affects it.`,
        });
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
        if (getProvider() || options.provider) return;
        const fromEnvironment = providerFromEnvironment();
        if (fromEnvironment) {
          setProvider(fromEnvironment);
          setProviderSource("environment");
          return;
        }
        // The config is the source of truth, so a deployment that configured
        // its provider in `.natalia/global-config.json` and exported no env
        // must still get a live provider at boot. Without this the runtime
        // sits at `model: not-configured` until something else triggers a
        // config RELOAD (the settings write, or model.select) - and a fresh
        // serve/CEF launch that never touches either never gets one, which
        // is every turn dying with a silent stopReason error. This is the
        // same resolution the reload path (config-reload.ts) performs, run
        // once here at startup.
        const tsConfig = ctx.ports.getTsRuntimeConfig?.();
        const ref =
          ctx.ports.getSelectedModel?.()?.modelID ?? tsConfig?.defaultModel;
        if (!ref || !tsConfig) return;
        const provider = providerForModel(tsConfig, ref, undefined, {
          log: logOf(ctx.state.serviceDirectory),
          sessionID: ctx.ports.getActiveExec?.()?.session.id,
        });
        if (provider) {
          setProvider(provider);
          setProviderSource("ts_config");
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
