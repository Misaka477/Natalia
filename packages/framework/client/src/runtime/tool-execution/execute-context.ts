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
import { compositionProfile } from "@anthelia/composition";
import { resolveSandboxPolicy } from "../sandbox-policy";
import { sandboxEscalationID } from "../sandbox-rung";
import { SandboxRefusal } from "@anthelia/contracts";
import { isInsideRoot } from "../sandbox-policy";
import {
  CONFINEMENT_COMPOSITION_ROW_ID,
  CONFINEMENT_MODES,
} from "@anthelia/contracts";
import type { ConfinementMode } from "@anthelia/confinement";
import { enforceableConfinementMode } from "@anthelia/confinement";
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
 * The composition-default file-effect mode — a re-export of the policy
 * home's own resolution (sandbox-policy.ts), kept here because this is
 * where the three readers historically imported it from. The logic moved
 * because every write path must ask ONE resolve: the shell tool's spawn,
 * the fs tools' judgement, the terminal pane's spawn, the sandbox
 * controller's candidate commands. Two spellings of the precedence is how
 * "bash circles one root, fs another" starts.
 */
export {
  resolveDeploymentMode as effectiveConfinementMode,
  resolveSandboxPolicy,
  type SandboxPolicy,
} from "../sandbox-policy";

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
  // 洞 2's ladder: the session's rung override (the human widening the
  // sandbox mid-session) beats the deployment default here — the policy
  // home's own precedence, read through the same resolve. The root is this
  // call's own (a sub-agent's worktree when the fan-out scoped it), so it
  // rides as the session root with the configured root as its fallback.
  const effectiveMode = resolveSandboxPolicy({
    profile: ctx.state.serviceDirectory.getOptional(compositionProfile),
    configMode: getTsRuntimeConfig()?.confinement?.mode,
    sessionRoot: workspaceRoot,
    deploymentRoot: workspaceRoot,
    ...(exec?.sandboxModeOverride
      ? { sessionMode: exec.sandboxModeOverride }
      : {}),
  }).mode;
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
          sandboxEscalationID(toolID, requestedMode),
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
    // The tool's own progress line: the same row, republished while it runs. A
    // nine-minute validation that says "running" and nothing else is the black
    // box this closes — and it closes it in the product, not in a log file.
    reportProgress: (update: { summary: string }) => {
      publish({
        type: "tool.update",
        id: toolID,
        name: tool.name,
        callID: call.id,
        status: "running",
        summary: update.summary,
      });
    },
    ...(attachImage ? { attachImage } : {}),
    // The host-injected self-iteration handoff, when there is one. A
    // runtime is bound to ONE workspace, so this is the only way a tool
    // reaches a session in another tree; absent in hosts without a
    // workspace manager, where the tool says so rather than reaching.
    // Read through the optional form: a context built by a test (or any
    // host that wires a partial port set) has no such port, and calling it
    // unconditionally would fail the whole tool context for a field the
    // tool itself treats as optional.
    ...(typeof ctx.ports.iterateBranch === "function" &&
    ctx.ports.iterateBranch()
      ? { iterateBranch: ctx.ports.iterateBranch()! }
      : {}),
    workspaceReadAuthorize: (request: { toolName: string; paths: string[] }) =>
      authorizeWorkspaceRead(request, exec),
    // The write half of the same containment (洞 2's acceptance: no write
    // path escapes the writable set). The main agent's fs writes are
    // IN-PROCESS — no kernel fence wraps them (the study's threat model:
    // untrusted PATHS get canonicalize-then-contain, untrusted CODE gets
    // the shell's kernel sandbox) — and `workspacePath`'s lexical check is
    // not the answer to that: a symlink inside the workspace spells its
    // way in while the kernel creates the file outside. The landed
    // judgement is, and it is the SAME law the sub-agent's file domain and
    // the mode's writable roots are judged by — one spelling, three heights.
    workspaceWriteAuthorize: async ({
      toolName,
      path,
    }: {
      toolName: string;
      path: string;
    }) => {
      if (isInsideRoot(path, workspaceRoot)) return;
      throw new SandboxRefusal({
        rule: `workspace containment under ${workspaceRoot}`,
        path,
        reason: `write refused (${toolName}): the path lands outside the workspace — a symlink or a traversal inside the workspace spelling its way out; write inside the workspace or ask for a sandbox escalation`,
      });
    },
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
