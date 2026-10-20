/**
 * Permission mode, profile and tool policy layers — runtime/permissions module.
 *
 * Owns the derivation of the agent and profile tool policy layers, the
 * permission-mode/profile reload on config change, and the extension gates
 * (skills/mcp). Reads host state and writes the shared permission
 * state through `RuntimeContext` ports at call time.
 */
import {
  deriveAgentToolPolicy,
  deriveProfileToolPolicy,
} from "../tool-policy-derivation";
import { derivePermissionSettings } from "../permission-settings";
import type { AgentDefinition } from "@anthelia/agent";
import type { ConfigV4 } from "@anthelia/contracts";
import type { PermissionProfileCommandRules } from "@anthelia/tools";
import type { ToolPolicyHookLayer } from "@anthelia/runtime-services";
import { toolPolicy } from "@natalia/tool-policy";
import { type ToolPolicyService } from "@anthelia/runtime-services";
import type { SessionExecutionState } from "@anthelia/substrate";
import type { RuntimeContext } from "@anthelia/substrate";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";

type PermissionProfile = import("@anthelia/contracts").PermissionProfile;

export function createPermissions(
  ctx: RuntimeContext,
  options: RealRuntimeClientOptions,
) {
  return {
    applyAgentPolicy,
    createToolPolicyLayer,
    agentPolicyLayer,
    permissionProfileLayer,
    reloadPermissionSettings,
    isToolAllowed,
    extensionEnabled,
    extensionToolPermission,
  };

  function applyAgentPolicy() {}

  function agentPolicyLayer(agent: AgentDefinition | undefined) {
    const { getTsRuntimeConfig, resolveService } = ctx.ports;
    const tsRuntimeConfig = getTsRuntimeConfig();
    const mode =
      tsRuntimeConfig?.agentModes?.[tsRuntimeConfig.defaultAgentMode] ??
      tsRuntimeConfig?.agentModes[tsRuntimeConfig.defaultAgentMode];
    return resolveService<ToolPolicyService>(toolPolicy.id)!.createHookLayer(
      deriveAgentToolPolicy({ agent, mode }),
    );
  }

  function permissionProfileLayer(profile: PermissionProfile | undefined) {
    return ctx.ports
      .resolveService<ToolPolicyService>(toolPolicy.id)!
      .createHookLayer(deriveProfileToolPolicy({ profile }));
  }

  function createToolPolicyLayer(
    exec: SessionExecutionState | undefined,
  ): ToolPolicyHookLayer {
    const policy = ctx.state.serviceDirectory.get(toolPolicy);
    if (!policy)
      throw new Error("tool pipeline unavailable (natalia-tool-pipeline)");
    const agent = exec?.selectedAgent ?? ctx.ports.getSelectedAgent();
    const profile =
      exec?.permissionProfile ?? ctx.ports.getSelectedPermissionProfile();
    const base = policy.createHookLayer(options.toolPolicy);
    const agentLayer = agentPolicyLayer(agent);
    const profileLayer = permissionProfileLayer(profile);
    const layers = [base, agentLayer, profileLayer];
    return {
      ...policy.createHookLayer(undefined, {
        preExecute: async (event) => {
          for (const layer of layers) {
            const result = await layer.preExecute(event);
            if (!result.allowed) return result;
          }
          const args = ctx.ports.tryParseToolArguments(event.arguments);
          for (const rules of [agent?.permissions, profile?.permissions]) {
            const result = policy.evaluatePermissionRules(
              rules,
              event.toolName,
              args,
              ctx.ports.getWorkspaceRoot(),
            );
            if (!result.allowed) return result;
          }
          const terminalCommandBuffer = ctx.ports.getTerminalCommandBuffer();
          const bufferedProfileCommandPermission =
            await terminalCommandBuffer.evaluate(
              [profile?.commandRules].filter(
                (rules): rules is PermissionProfileCommandRules =>
                  Boolean(rules),
              ),
              event.toolName,
              args,
              [profile?.interactivePrograms],
            );
          const profileCommandPermission =
            bufferedProfileCommandPermission ??
            (await ctx.state.initialize.evaluatePermissionProfileCommandRules(
              profile?.commandRules,
              event.toolName,
              args,
            ));
          if (!profileCommandPermission.allowed)
            return profileCommandPermission;
          const extensionResult = extensionToolPermission(
            event.toolName,
            profile,
          );
          if (!extensionResult.allowed) return extensionResult;
          return (
            (await options.hooks?.preExecute?.(event)) ?? {
              allowed: true,
              diagnostics: [],
            }
          );
        },
        postExecute: options.hooks?.postExecute,
      }),
      isToolAllowed: (toolName: string) =>
        layers.every((layer) => layer.isToolAllowed(toolName)),
    };
  }

  /**
   * Re-derives the permission mode and selected profile from the given config
   * and rebuilds the tool policy layers. Called at initialize and on every
   * config reload, so switching the default profile or flipping auto/ask in
   * the settings dialog takes effect immediately instead of after a restart.
   * A requested profile (options.permissionProfile) that vanished from disk
   * keeps the current selection; the caller decides whether that is fatal.
   */
  function reloadPermissionSettings(config: ConfigV4) {
    const {
      getPermissionMode,
      setSelectedPermissionProfile,
      setPermissionMode,
      setDefaultPermissionMode,
      setDefaultPermissionProfile,
    } = ctx.ports;
    const derived = derivePermissionSettings({
      config,
      requestedProfile: options.permissionProfile,
      optionMode: options.permissionMode,
      permissionMode: getPermissionMode(),
    });
    if (!derived.found) return;
    const previousMode = getPermissionMode();
    setSelectedPermissionProfile(derived.selectedProfile);
    // The PORTS value follows the deployment default only where no session has
    // chosen its own rung: the active session override wins, exactly as the
    // exec does below.
    setPermissionMode(
      ctx.ports.getActiveExec()?.permissionModeOverride ?? derived.mode,
    );
    setDefaultPermissionMode(derived.defaultMode);
    setDefaultPermissionProfile(derived.defaultProfile);
    // Reported only on a real change. The projector derives a session's mode by
    // scanning its events, and nothing emitted this one, so the projected mode
    // was always undefined — a pure replay cannot see process state, only events.
    //
    // That publish is GONE, and its removal is the fix rather than a cleanup.
    // `reloadPermissionSettings` runs at INITIALIZE — before any attach has
    // reconciled a session's journal onto the exec it just built — so this loop
    // cannot tell "a session that never chose" from "a session that chose in an
    // earlier process" (`exec.session.events` is still empty here; the history
    // loads around the exec afterwards). It published `derived.mode` — the
    // DEPLOYMENT default — as a durable `session.permission.mode` at the TAIL of
    // every such session's journal, and the attach that followed read the tail:
    // the human's `auto` was overwritten by the default, durably, on every
    // restart. Measured on the user's own store: a session on `auto` came back
    // on `read_only` with a fresh row naming the default, and the user had never
    // chosen `read`.
    //
    // The in-memory move stays (the environment block and the tool policy read
    // it), and the front end's answer comes from `status.snapshot`, which the
    // reload schedules immediately after. A deployment default is not a session
    // choice and has no business in a session's journal: the only durable record
    // of a rung is `applySessionRung`'s, and it writes BOTH axes.
    if (previousMode !== derived.mode)
      for (const exec of ctx.ports.getExecutionBySession().values()) {
        // A SESSION THAT CHOSE KEEPS ITS RUNG. `applySessionRung` records the
        // choice in `permissionModeOverride`, and the whole point of that field
        // is that a config reload refreshes the deployment default underneath a
        // session that never chose while leaving a session that did choose alone.
        if (exec.permissionModeOverride !== undefined) continue;
        exec.permissionMode = derived.mode;
        ctx.ports.publishForSession(exec, {
          type: "session.permission.mode",
          mode: derived.mode,
        });
      }
  }

  function isToolAllowed(
    toolName: string,
    exec: SessionExecutionState | undefined,
  ) {
    const { getSelectedPermissionProfile } = ctx.ports;
    return (
      createToolPolicyLayer(exec).isToolAllowed(toolName) &&
      extensionToolPermission(
        toolName,
        exec ? exec.permissionProfile : getSelectedPermissionProfile(),
      ).allowed
    );
  }

  function extensionEnabled(
    extension: "skills" | "mcp",
    profile:
      | PermissionProfile
      | undefined = ctx.ports.getSelectedPermissionProfile(),
  ) {
    return profile?.extensions?.[extension] !== false;
  }

  function extensionToolPermission(
    toolName: string,
    profile:
      | PermissionProfile
      | undefined = ctx.ports.getSelectedPermissionProfile(),
  ) {
    const extension =
      toolName === "skill_load"
        ? "skills"
        : toolName.startsWith("mcp_")
          ? "mcp"
          : undefined;
    if (!extension || extensionEnabled(extension, profile))
      return { allowed: true, diagnostics: [] };
    const source = "permission profile";
    return {
      allowed: false,
      diagnostics: [`${extension} extensions are disabled by ${source}`],
    };
  }
}
