/**
 * Framework subsystem composition — initialize/framework-runtime-status.ts.
 *
 * The shared runtime status projection (and the /help, /doctor, /status and
 * /diagnostics commands built on it) is a framework-internal subsystem, not a
 * plugin: this module constructs the status snapshot controller directly and
 * contributes it as the `status.snapshot.controller` service.
 */
import { createStatusSnapshotController } from "@anthelia/runtime-status";
import type { PluginCommandInvocation } from "@anthelia/plugin";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import {
  sandboxService,
  subagentsService,
  type SandboxService,
  type SubagentsService,
} from "@anthelia/runtime-services";
import { EGRESS_ADVISORY } from "../../egress-advisory";
import type { RuntimeContext } from "@anthelia/substrate";
import { wireProcessSettledNotices } from "./process-settled-notices";
import { statusSnapshotController } from "@anthelia/runtime-status";
import type { StatusSnapshotController } from "@anthelia/runtime-status";

export type RuntimeStatusHandle = { close(): void };

export function wireRuntimeStatus(ctx: RuntimeContext): RuntimeStatusHandle {
  const registry = ctx.state.capabilityRegistry;
  const deps = ctx.state.initialize;
  const owner = registry.registerOwner({
    id: "natalia-runtime-ui",
    name: "Runtime UI",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services", "commands"],
  });
  const commands = {
    list: () =>
      ctx.ports.commandCatalogEntries().map((command) => ({
        name: command.name,
        title: command.title,
        description: command.description,
        acceptsArguments: command.acceptsArguments,
        category: command.category,
      })),
    session: async (sessionID: SessionID) => {
      const exec = ctx.state.executionBySession.get(sessionID);
      if (!exec) throw new Error(`session not found: ${sessionID}`);
      const statusController = ctx.state.serviceDirectory.get(
        statusSnapshotController,
      );
      return {
        provider: exec.provider,
        providerSource: ctx.ports.getProviderSource(),
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
        sessionID,
        toolsSize: ctx.state.tools.size,
        selectedAgentName: exec.selectedAgent?.name,
        skillsCount: ctx.ports.skillsList().length,
        diagnostics: [
          ...ctx.state.runtimeDiagnostics,
          ...(ctx.state.runtimeDiagnosticsBySession.get(sessionID) ?? []),
        ],
        snapshot: await statusController.snapshotFor({
          provider: exec.provider,
          context: exec.context,
          permissionMode: exec.permissionMode,
        }),
      };
    },
    publish: (sessionID: SessionID, event: RuntimeEvent) => {
      const exec = ctx.state.executionBySession.get(sessionID);
      if (!exec) throw new Error(`session not found: ${sessionID}`);
      ctx.ports.publishForSession(exec, event);
    },
    egressAdvisory: EGRESS_ADVISORY,
  };
  const session = async (invocation?: PluginCommandInvocation) => {
    if (!invocation?.sessionID)
      throw new Error("runtime UI command requires a session");
    return await commands.session(invocation.sessionID as SessionID);
  };
  const controller: StatusSnapshotController = createStatusSnapshotController({
    provider: ctx.ports.getProvider,
    context: ctx.ports.getRuntimeContext,
    workspaceRoot: ctx.ports.getWorkspaceRoot(),
    permissionMode: ctx.ports.getPermissionMode,
    runningCount: async () =>
      (ctx.state.serviceDirectory
        .getOptional(subagentsService)
        ?.runningCount() ?? 0) +
      (ctx.state.serviceDirectory
        .getOptional(sandboxService)
        ?.runningResourceCount() ?? 0) +
      ((await deps.capabilityRegistry
        .service<{
          runningCount(input: { workspaceRoot: string }): Promise<number>;
        }>("managedProcessRegistry")
        ?.runningCount({
          workspaceRoot: ctx.ports.getWorkspaceRoot(),
        })) ?? 0),
    publish: ctx.ports.publish,
    commands,
  });
  // The controller binds through the service directory; the owner stays for
  // the commands contributions below.
  ctx.state.serviceDirectory.provide(statusSnapshotController, controller);
  // Managed-process exits reach the session that started them. Wired here
  // because this is where the capability registry is already in hand.
  const unwatchProcesses = wireProcessSettledNotices(ctx, {
    service: <T>(name: string) => registry.service<T>(name),
    onServiceUpdate: (listener: () => void) =>
      registry.onServiceUpdate(listener),
  });
  owner.contribute("commands", "help", {
    name: "help",
    title: "Help",
    run: () =>
      [
        "Natalia TS7 agent shell commands:",
        ...commands
          .list()
          .map(
            (command) =>
              `/${command.name}${command.acceptsArguments ? " <args>" : ""} - ${command.description ?? command.title}`,
          ),
        "Use Ctrl-C to cancel an active turn and Ctrl-D on an empty composer to exit.",
      ].join("\n"),
  });
  owner.contribute("commands", "doctor", {
    name: "doctor",
    title: "Doctor",
    async run(invocation: PluginCommandInvocation) {
      const state = await session(invocation);
      commands.publish(state.sessionID, state.snapshot);
      const configured = state.provider
        ? `${state.provider.provider}/${state.provider.model} (${state.providerSource})`
        : "not configured";
      return [
        "Natalia TS7 runtime doctor",
        `provider: ${configured}`,
        `workspace: ${state.workspaceRoot}`,
        `session: ${state.sessionID}`,
        `native tools: ${state.toolsSize}`,
        `agent: ${state.selectedAgentName ?? "default"}`,
        `skills: ${state.skillsCount}`,
        state.provider
          ? "provider check: configured; submit a short prompt to verify live streaming"
          : "provider check: set NATALIA_OPENAI_API_KEY (or OPENAI_API_KEY), or configure a provider in .natalia/config.json, then restart the TUI",
        "safety: write/shell/process actions require approval unless permissionMode=auto is explicitly configured by a caller",
        commands.egressAdvisory,
      ].join("\n");
    },
  });
  owner.contribute("commands", "status", {
    name: "status",
    title: "Status",
    async run(invocation: PluginCommandInvocation) {
      const state = await session(invocation);
      commands.publish(state.sessionID, state.snapshot);
      return [
        `provider: ${state.snapshot.provider}/${state.snapshot.model} (${state.providerSource})`,
        `context: ${state.snapshot.context}`,
        `steps: ${state.snapshot.step}`,
        `workspace: ${state.snapshot.cwd}`,
        `background: ${state.snapshot.background}`,
      ].join("\n");
    },
  });
  owner.contribute("commands", "diagnostics", {
    name: "diagnostics",
    title: "Diagnostics",
    async run(invocation: PluginCommandInvocation) {
      const state = await session(invocation);
      const value = invocation?.args.join(" ").trim() ?? "";
      const limit = value ? Number(value) : 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new Error(
          "diagnostics limit must be an integer between 1 and 500",
        );
      const entries = state.diagnostics.slice(-limit);
      return entries.length
        ? entries
            .map(
              (entry) =>
                `${entry.at}${entry.owner ? ` [${entry.owner}]` : ""} ${entry.level}: ${entry.message}`,
            )
            .join("\n")
        : "no diagnostics recorded";
    },
  });

  return {
    close() {
      controller.dispose();
      unwatchProcesses();
    },
  };
}
