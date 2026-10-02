/**
 * Tool execution context builder — runtime/tool-execution/execute-context.ts.
 *
 * Builds the `ToolExecutionContext` handed to a tool's `execute` call: the
 * session-scoped bindings, interactive question bridge, subagent/terminal/
 * sandbox controllers, workspace/sandbox authorization, resolved config and
 * settings, and the sandbox/workspace event hooks. Split into its own file so
 * `execute-run.ts` stays within the source line limit.
 */
import type { ProviderToolCall } from "@anthelia/runtime";
import {
  compositionProfile,
  type CompositionProfile,
} from "@anthelia/composition";
import {
  CONFINEMENT_COMPOSITION_ROW_ID,
  CONFINEMENT_MODES,
} from "@anthelia/contracts";
import type { ConfinementMode } from "@anthelia/confinement";
import { rinaCache } from "@anthelia/rina";
import type { RuntimeTool } from "@anthelia/tools";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  sandboxService,
  subagentsService,
  terminalController,
  type SandboxService,
  type SubagentsService,
  type TerminalController,
} from "@anthelia/runtime-services";
import { workLedgerController as workLedgerControllerToken } from "@natalia/work-ledger";
import { workspaceMutations } from "@anthelia/workspace";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";
import type { WorkLedgerController } from "@natalia/work-ledger";

/**
 * The composition-default file-effect mode (sandbox study: policy
 * rides the call; this is the default it rides FROM). Precedence: the
 * composition profile's `anthelia.sandbox` row — the plane the master
 * plan P3 base profile ships — then the legacy config key as its
 * fallback (retire the row with `disabled: true` in a drop-in to hand
 * the key back), then the schema's default. Both sources are validated
 * at their own boundary; this guard re-checks membership so a hand-built
 * profile cannot smuggle a mode past either.
 */
export function effectiveConfinementMode(input: {
  profile?: CompositionProfile | undefined;
  configMode?: string | undefined;
}): ConfinementMode {
  const legal = (mode: string | undefined): mode is ConfinementMode =>
    typeof mode === "string" &&
    (CONFINEMENT_MODES as readonly string[]).includes(mode);
  const row = input.profile?.rows.find(
    (candidate) =>
      candidate.id === CONFINEMENT_COMPOSITION_ROW_ID && !candidate.disabled,
  );
  const rowMode =
    typeof row?.config?.mode === "string" ? row.config.mode : undefined;
  if (legal(rowMode)) return rowMode;
  if (legal(input.configMode)) return input.configMode;
  return "workspace-write";
}

export type BuildContextInput = {
  exec: SessionExecutionState | undefined;
  publish: (event: RuntimeEvent) => void;
  toolID: string;
  tool: RuntimeTool;
  call: ProviderToolCall;
  turnID: string;
  attachImage?: (path: string) => Promise<void>;
  ctx: RuntimeContext;
  sessionID: import("@anthelia/contracts").SessionID;
  workspaceRoot: string;
  signal: AbortSignal;
  timeoutSec?: number;
  parsed: unknown;
};

export function buildToolExecutionContext(input: BuildContextInput) {
  const {
    exec,
    publish,
    toolID,
    tool,
    call,
    turnID,
    attachImage,
    ctx,
    sessionID,
    workspaceRoot,
    signal,
    timeoutSec,
  } = input;
  const {
    getCapabilityRegistry,
    getTsRuntimeConfig,
    getInteractive,
    authorizeWorkspaceRead,
    authorizeSandboxMerge,
    toolSettings,
    scheduleRuntimeStatusSnapshot,
  } = ctx.ports;
  const { sandboxResourcesByID } = ctx.state;
  const subagents = ctx.state.serviceDirectory.getOptional(subagentsService);
  const terminal = ctx.state.serviceDirectory.getOptional(terminalController);
  const sandboxes = ctx.state.serviceDirectory.getOptional(sandboxService);
  // The file-effect mode for this call: composition default, per-call
  // truth rides down to runShell (sandbox study: policy rides the call).
  // Captured once so the escalation's audit fact can name the mode the
  // call escalates FROM.
  const effectiveMode = effectiveConfinementMode({
    profile: ctx.state.serviceDirectory.getOptional(compositionProfile),
    configMode: getTsRuntimeConfig()?.confinement?.mode,
  });
  return {
    workspaceRoot,
    signal,
    ...(timeoutSec === undefined ? {} : { timeoutSec }),
    sessionID: exec?.session.id ?? sessionID,
    confinement: effectiveMode,
    // The escalation channel, closed over this call's identity — the same
    // approval seam tools already use, routed by turn so the permission
    // floors decide (read_only refuses, auto grants, ask prompts).
    sandboxApprover: {
      request: async ({
        requestedMode,
        justification,
      }: {
        requestedMode: ConfinementMode;
        justification: string;
      }) => {
        const interactive = getInteractive();
        if (!interactive) return "unavailable";
        const refusal = await interactive.requireApproval(
          `${toolID}:sandbox`,
          tool,
          call,
          turnID,
          { reason: `escalate sandbox to ${requestedMode}: ${justification}` },
        );
        if (refusal) return "rejected";
        // Sandbox study §6b①: entering a wider mode is a journal fact —
        // the audit trail and the (coming) danger indicator read this one
        // event, never a second state. The grant is per-call; the event
        // records the entry, and the call's own events bound it.
        publish({
          type: "confinement.escalated",
          at: new Date().toISOString(),
          from: effectiveMode,
          to: requestedMode,
          justification,
          toolID,
          ...(exec ? { sessionID: exec.session.id } : {}),
        });
        return "allowed-once";
      },
    },
    askQuestion: async (input: {
      title: string;
      questions: Array<{
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description?: string }>;
        multiple?: boolean;
        custom?: boolean;
      }>;
    }) =>
      await getInteractive().requireQuestion(
        `${toolID}:question`,
        turnID,
        input,
      ),
    askInteractive: async (input: {
      kind: string;
      title: string;
      payload: unknown;
      responseSchema?: Record<string, unknown>;
      expiresAt?: string;
      priority?: number;
      requestID?: string;
      validate?(response: unknown): string[] | void;
    }) =>
      await getInteractive().requireInteractive({
        requestID: input.requestID ?? `${toolID}:interactive`,
        turnID,
        kind: input.kind,
        title: input.title,
        payload: input.payload as import("@anthelia/contracts").JsonValue,
        ...(input.responseSchema
          ? {
              responseSchema:
                input.responseSchema as import("@anthelia/contracts").JsonSchema,
            }
          : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.validate
          ? {
              validate: (response) =>
                input.validate?.(response) as string[] | void,
            }
          : {}),
      }),
    subagents,
    terminal,
    sandboxes,
    ...(attachImage ? { attachImage } : {}),
    workspaceReadAuthorize: (request: { toolName: string; paths: string[] }) =>
      authorizeWorkspaceRead(request, exec),
    sandboxMergeAuthorize: (request: { id: string; paths: string[] }) =>
      authorizeSandboxMerge(request, exec),
    // The resolved config as a service: a tool family reads it by
    // name (e.g. `sandbox.backend`) instead of re-parsing config.
    runtimeConfig: () => getCapabilityRegistry().service("runtime.config"),
    settings: toolSettings(exec),
    // The turn's own session, not the attached one: a background turn's
    // subagents and terminal starts belong to its session (I1/I3).
    parentSessionID: exec?.session.id ?? sessionID,
    maxSubagentDepth: getTsRuntimeConfig()?.runtime.subagentDepth,
    onSandboxEvent: (event: { [key: string]: unknown; type: string }) => {
      const update = event as Extract<RuntimeEvent, { type: "sandbox.update" }>;
      publish(update);
      if (sandboxResourcesByID.get(update.id) !== update.runningResources) {
        if (update.runningResources === 0)
          sandboxResourcesByID.delete(update.id);
        else sandboxResourcesByID.set(update.id, update.runningResources);
        scheduleRuntimeStatusSnapshot();
      }
    },
    onWorkspaceChange: (changes: Array<{ path: string }>) => {
      // Invalidate-on-write (RINA law 2): the paths a settled tool changed
      // drop out of the read cache immediately; tree-scoped kinds go with
      // them (any write can move a listing).
      ctx.state.serviceDirectory
        .getOptional(rinaCache)
        ?.invalidatePaths(changes.map((change) => change.path));
      // WG4 Phase 3: the tool settled successfully — the expected
      // mutation stops matching unrelated later hints, but its identity
      // stays available for attributing the change it caused.
      ctx.state.serviceDirectory
        .getOptional(workspaceMutations)
        ?.settle(call.id);
      if (!exec?.session) return;
      const workLedgerController = ctx.state.serviceDirectory.get(
        workLedgerControllerToken,
      );
      if (!workLedgerController)
        throw new Error("work ledger unavailable (natalia-work-ledger)");
      for (const change of changes) {
        publish(
          workLedgerController.workspaceChangeNode({
            turnID,
            path: change.path,
            toolName: tool.name,
            sessionID: exec.session.id,
          }),
        );
        publish(
          workLedgerController.workspaceChangeEdge({
            turnID,
            callID: call.id,
            path: change.path,
          }),
        );
      }
    },
  };
}
