/**
 * Tool execution policy surface — runtime/tool-execution/policy.ts.
 *
 * The sandbox/workspace authorization checks, the pause waiter, and the
 * resolved tool settings (network/browser/env/egress) that tool execution
 * reads. Reads host state through `RuntimeContext` at call time.
 */
import { mergeContributedToolSettings } from "../../capability-settings";
import type { ToolHookEvent } from "@anthelia/runtime-services";
import { toolPolicy as toolPolicyToken } from "@natalia/tool-policy";
import { type ToolPolicyService } from "@anthelia/runtime-services";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";

export function createToolPolicySurface(ctx: RuntimeContext) {
  return {
    authorizeSandboxMerge,
    authorizeSandboxManagement,
    authorizeWorkspaceRead,
    waitIfPaused,
    toolSettings,
  };

  async function authorizeSandboxMerge(
    input: { id: string; paths: string[] },
    exec: SessionExecutionState | undefined = ctx.ports.getActiveExec(),
  ) {
    const { getActiveTurnID, getSessionID, publishForSession } = ctx.ports;
    const toolLayer = ctx.ports.createToolPolicyLayer(exec);
    const activeTurnID = getActiveTurnID();
    const sessionID = getSessionID();
    for (const path of input.paths) {
      const hookEvent: ToolHookEvent = {
        turnID:
          exec?.activeTurnID ??
          activeTurnID ??
          `sandbox:${exec?.session.id ?? sessionID}`,
        toolName: "sandbox_merge",
        toolCallID: `sandbox:${input.id}:${path}`,
        arguments: JSON.stringify({ id: input.id, path }),
      };
      const preResult = await toolLayer.preExecute(hookEvent);
      for (const diagnostic of preResult.diagnostics)
        publishForSession(exec, {
          type: "diagnostic",
          level: "info",
          message: diagnostic,
        });
      if (!preResult.allowed)
        throw new Error(
          `sandbox merge denied for "${path}": ${preResult.diagnostics.join("; ")}`,
        );
    }
  }

  async function authorizeSandboxManagement(
    toolName: "sandbox_merge" | "sandbox_delete" | "sandbox_resource_stop",
    arguments_: Record<string, string>,
    exec: SessionExecutionState = ctx.ports.getActiveExec()!,
  ) {
    const { publishForSession } = ctx.ports;
    const toolLayer = ctx.ports.createToolPolicyLayer(exec);
    const hookEvent: ToolHookEvent = {
      turnID: exec.activeTurnID ?? `sandbox:${exec.session.id}`,
      toolName,
      toolCallID: `sandbox:manage:${toolName}:${arguments_.id}`,
      arguments: JSON.stringify(arguments_),
    };
    const result = await toolLayer.preExecute(hookEvent);
    for (const diagnostic of result.diagnostics)
      publishForSession(exec, {
        type: "diagnostic",
        level: "info",
        message: diagnostic,
      });
    if (!result.allowed)
      throw new Error(
        `${toolName} denied: ${result.diagnostics.join("; ") || "runtime policy denied operation"}`,
      );
  }

  async function authorizeWorkspaceRead(
    input: {
      toolName: string;
      paths: string[];
    },
    exec: SessionExecutionState | undefined = ctx.ports.getActiveExec(),
  ) {
    const { getSelectedAgent, getWorkspaceRoot, publishForSession } = ctx.ports;
    const policy = ctx.state.serviceDirectory.get(toolPolicyToken);
    if (!policy)
      throw new Error("tool pipeline unavailable (natalia-tool-pipeline)");
    const selectedAgent = getSelectedAgent();
    const agent = exec ? exec.selectedAgent : selectedAgent;
    for (const path of input.paths) {
      const permission = policy.evaluatePermissionRules(
        agent?.permissions,
        input.toolName,
        { path },
        getWorkspaceRoot(),
      );
      if (permission.allowed) continue;
      for (const diagnostic of permission.diagnostics)
        publishForSession(exec, {
          type: "diagnostic",
          level: "info",
          message: diagnostic,
        });
      throw new Error(
        `${input.toolName} denied for "${path}": ${permission.diagnostics.join("; ")}`,
      );
    }
  }

  async function waitIfPaused(
    exec: SessionExecutionState | undefined = ctx.ports.getActiveExec(),
  ) {
    const { getActiveExec, getPaused, getPauseWaiters } = ctx.ports;
    const activeExec = getActiveExec();
    const state = exec ?? activeExec;
    while (state ? state.paused : getPaused()) {
      await new Promise<void>((resolveWaiter) => {
        if (state) state.pauseWaiters.push(resolveWaiter);
        else getPauseWaiters().push(resolveWaiter);
      });
    }
  }

  function toolSettings(
    exec: SessionExecutionState | undefined = ctx.ports.getActiveExec(),
  ) {
    const {
      getSelectedPermissionProfile,
      getSelectedAgent,
      getTsRuntimeConfig,
      getWorkspaceCapabilityView,
      getCapabilityRegistry,
    } = ctx.ports;
    const selectedPermissionProfile = getSelectedPermissionProfile();
    const selectedAgent = getSelectedAgent();
    const tsRuntimeConfig = getTsRuntimeConfig();
    const profile = exec ? exec.permissionProfile : selectedPermissionProfile;
    const agent = exec ? exec.selectedAgent : selectedAgent;
    const profileNetwork = profile?.permissions?.network;
    const agentNetwork = agent?.permissions?.network;
    const effectiveNetwork = agentNetwork ?? profileNetwork;
    const agentAllowedHosts = agentNetwork?.allowedHosts.length
      ? agentNetwork.allowedHosts
      : tsRuntimeConfig?.network.allowedHosts;
    const allowedHostGroups = [
      profileNetwork?.allowedHosts,
      agentAllowedHosts,
    ].filter((hosts): hosts is string[] => Boolean(hosts?.length));
    const base = {
      webSearchEndpoint: tsRuntimeConfig?.webSearch.endpoint ?? undefined,
      webSearchProviderPriority: tsRuntimeConfig?.webSearch.providerPriority,
      browserEnabled: tsRuntimeConfig?.browser.enabled,
      browserBinary: tsRuntimeConfig?.browser.binary || undefined,
      browserUserAgent: tsRuntimeConfig?.browser.userAgent || undefined,
      browserHeaders: tsRuntimeConfig?.browser.headers,
      browserPersistentProfile: tsRuntimeConfig?.browser.persistentProfile,
      browserProfileDir: tsRuntimeConfig?.browser.profileDir || undefined,
      browserLocale: tsRuntimeConfig?.browser.locale || undefined,
      browserTimezone: tsRuntimeConfig?.browser.timezone || undefined,
      allowedHosts: agentAllowedHosts,
      allowedHostGroups: allowedHostGroups.length
        ? allowedHostGroups
        : undefined,
      allowedSchemes: tsRuntimeConfig?.network.allowedSchemes,
      deniedHosts: [
        ...(profileNetwork?.denyHosts ?? []),
        ...(agentNetwork?.denyHosts ?? []),
      ],
      allowLocalhost:
        profileNetwork?.allowLocalhost === false ||
        agentNetwork?.allowLocalhost === false
          ? false
          : (effectiveNetwork?.allowLocalhost ??
            tsRuntimeConfig?.network.allowLocalhost),
      allowPrivate:
        profileNetwork?.allowPrivate === false ||
        agentNetwork?.allowPrivate === false
          ? false
          : (effectiveNetwork?.allowPrivate ??
            tsRuntimeConfig?.network.allowPrivate),
      envAllowlist:
        agent?.permissions?.env?.allowlist ??
        tsRuntimeConfig?.security.envAllowlist,
    };
    // The `settings` grant's first host consumer: capability contributions
    // provide defaults that explicit config and permission values override.
    return mergeContributedToolSettings(base, [
      ...(getWorkspaceCapabilityView()?.contributions("settings") ?? []),
      ...getCapabilityRegistry().contributions("settings"),
    ]);
  }
}
