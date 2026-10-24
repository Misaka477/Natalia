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
import { projectSession } from "@anthelia/session";
import { compositionProfile } from "@anthelia/composition";
import { effectiveConfinementMode } from "../tool-execution/execute-context";
import { EGRESS_ADVISORY } from "../../egress-advisory";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";

import { statusSnapshotController } from "@anthelia/runtime-status";
import type { StatusSnapshotController } from "@anthelia/runtime-status";

export type RuntimeStatusHandle = { close(): void };

/**
 * Provider steps this session has run: one per `runtime.step_usage`, the
 * figure the usage bar counts.
 *
 * CACHED like the session snapshot's own projection, because this call site is
 * not rare: `runtimeStatus` and every `/status` refresh ask for it, and a
 * full-log fold per ask slowed whole acceptance scenarios into their timeouts
 * (measured — the plan build/verify/switch pair went red on exactly this).
 * The cache is keyed by the event count, the same guard `snapshot.ts` uses, so
 * a grown session refolds and an unchanged one costs a comparison.
 */
function providerStepsFor(exec: SessionExecutionState): number {
  const events = exec.session.events;
  const cached = exec.snapshotProjection;
  if (cached && cached.eventCount === events.length)
    return cached.value.usage.main.steps;
  const projection = projectSession(exec.session);
  exec.snapshotProjection = { eventCount: events.length, value: projection };
  return projection.usage.main.steps;
}

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
          ...(exec.sandboxModeOverride
            ? { confinement: exec.sandboxModeOverride }
            : {}),
          steps: providerStepsFor(exec),
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
    // THE ACTIVE SESSION'S RUNG, NOT THE PROCESS-WIDE DEFAULT.
    //
    // `getPermissionMode()` is the runtime-global value the config derivation
    // stamped; a session that moved its own rung carries a different one on its
    // execution. Publishing the global value meant every periodic status snapshot
    // re-asserted the deployment default AFTER the durable rung fact had been
    // replayed — and since the front end folds events in order, the last one won:
    // a restarted session showed the deployment's mode, not the rung its human
    // chose (measured: replay said auto + workspace-write, the status snapshot
    // that followed said ask + danger-full-access, and the projection ended on
    // ask + danger-full-access).
    permissionMode: () =>
      ctx.ports.getActiveExec()?.permissionMode ??
      ctx.ports.getPermissionMode(),
    // The session's own sandbox rung outranks the deployment default, the same
    // precedence `resolveSandboxPolicy` applies when a tool actually executes.
    // Without this the status event carried only the approval half, so a
    // restarted front end could not pair the rung it was standing on.
    confinement: () => {
      const active = ctx.ports.getActiveExec();
      return (
        active?.sandboxModeOverride ??
        effectiveConfinementMode({
          profile: ctx.state.serviceDirectory.getOptional(compositionProfile),
          configMode: ctx.ports.getTsRuntimeConfig()?.confinement?.mode,
        })
      );
    },
    // WHO the snapshot above is about. The periodic refresh resolves the rung
    // through the active exec, so the event has to name that exec's session or
    // a front end folds one session's rung into another's view — measured: a
    // session on `auto` displayed `read` after a restart because the last
    // snapshot to arrive described a different session and said nothing about
    // it.
    sessionID: () => ctx.ports.getActiveExec()?.session.id,
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
  // Managed-process exits reach the session that started them through the
  // SETTLEMENT spine (`ManagedProcessRegistry.notifySettled` → `deliverSettlement`
  // → a durable notice plus a next-step injection or a woken turn). They used to
  // arrive twice: a second subscription appended a `process_settled:<id>` dynamic
  // entry for the same exit, so the model read two tellings of one fact — the
  // thing that file's own comment set out to prevent.
  const unwatchProcesses = () => {};
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
          : "provider check: set NATALIA_OPENAI_API_KEY (or OPENAI_API_KEY), or configure a provider in .natalia/config.json, then restart Natalia",
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
        // The provider-step figure, the same number the session usage bar
        // counts. `snapshot.step` is the journal's entry count and stays an
        // internal stamp: printing it here as "steps" is how one run came to
        // be reported as 422 steps here and 140 on the usage bar.
        `steps: ${state.snapshot.steps ?? 0}`,
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
