/**
 * The execute stage of a single tool call — runtime/tool-execution/execute-run.ts.
 *
 * `runExecuteStage` is the execute-stage content of `executeOneTool`: it
 * publishes the awaiting/queued fact, runs the interactive approval, drives the
 * tool with the session-scoped cancellation signal and write lock, records the
 * mutation attribution, bounds and redacts the output, publishes the outcome
 * facts, and settles the in-flight audit. Split into its own file so
 * `execute-one.ts` stays within the source line limit.
 */
import type { ProviderToolCall } from "@anthelia/runtime";
import {
  requiresForcedGitApprovalAst,
  timeoutSecOr,
  validateToolOutput,
  type RuntimeTool,
} from "@anthelia/tools";
import type { RuntimeEvent } from "@anthelia/contracts";
import { type ToolPolicyService } from "@anthelia/runtime-services";
import { workLedgerController as workLedgerControllerToken } from "@natalia/work-ledger";
import { toolPolicy as toolPolicyToken } from "@natalia/tool-policy";
import { workspaceMutations, workspaceWriteLock } from "@anthelia/workspace";
import { buildToolExecutionContext } from "./execute-context";
import type { SessionExecutionState } from "@anthelia/substrate";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";
import type { RuntimeContext } from "@anthelia/substrate";
import { activePlanForExec } from "@natalia/collab";
import type { WorkLedgerController } from "@natalia/work-ledger";
import { OPAQUE_WORKSPACE_WRITERS, rinaCache } from "@anthelia/rina";
import { executeWithReadCache } from "./read-cache";

export type ExecuteStageInput = {
  exec: SessionExecutionState | undefined;
  publish: (event: RuntimeEvent) => void;
  toolID: string;
  tool: RuntimeTool;
  call: ProviderToolCall;
  turnID: string;
  attachImage?: (path: string) => Promise<void>;
  ctx: RuntimeContext;
  options: RealRuntimeClientOptions;
  sessionID: import("@anthelia/contracts").SessionID;
  workspaceRoot: string;
};

export async function runExecuteStage(
  input: ExecuteStageInput,
): Promise<string> {
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
  } = input;
  const {
    publishWorkGraphToolCall,
    waitIfPaused,
    setInFlightOperationFor,
    getTerminalCommandBuffer,
    setEndTurnWaitingHuman,
    getInteractive,
    scheduleRuntimeStatusSnapshot,
  } = ctx.ports;
  const toolLayer = ctx.ports.createToolPolicyLayer(exec);
  const toolPolicy = ctx.state.serviceDirectory.get(toolPolicyToken);
  if (!toolPolicy)
    throw new Error("tool pipeline unavailable (natalia-tool-pipeline)");
  const writeLock = ctx.state.serviceDirectory.get(workspaceWriteLock);
  const terminalCommandBuffer = getTerminalCommandBuffer();
  const interactive = getInteractive();
  const mutationRegistry =
    ctx.state.serviceDirectory.getOptional(workspaceMutations);
  const workLedgerController = ctx.state.serviceDirectory.get(
    workLedgerControllerToken,
  );
  const redactToolOutput = ctx.ports.redactToolOutput;
  const redactToolOutputEnabled = ctx.ports.redactToolOutputEnabled;
  const waitForToolExecution = ctx.ports.waitForToolExecution;
  const boundToolOutput = ctx.ports.boundToolOutput;
  const isManagedResourceTool = ctx.ports.isManagedResourceTool;
  const tryParseToolArguments = ctx.ports.tryParseToolArguments;
  const parseToolArguments = ctx.ports.parseToolArguments;
  const validateToolParameters = ctx.ports.validateToolParameters;
  const parsedForApproval = tryParseToolArguments(call.arguments);
  const commandTextForApproval = toolPolicy.commandTextForTool(
    tool.name,
    (typeof parsedForApproval === "object" && parsedForApproval !== null
      ? parsedForApproval
      : {}) as Record<string, unknown>,
  );
  const forcedApproval = await requiresForcedGitApprovalAst(
    commandTextForApproval,
  );
  const approvalRequired = tool.requiresApproval || Boolean(forcedApproval);
  publish({
    type: "tool.update",
    id: toolID,
    name: tool.name,
    callID: call.id,
    status: approvalRequired ? "awaiting_approval" : "queued",
    summary: approvalRequired ? "awaiting approval" : "queued",
    argumentsDelta: call.arguments,
    ...(call.thoughtSignature
      ? { thoughtSignature: call.thoughtSignature }
      : {}),
  });
  publish({
    type: "policy.decision",
    turnID,
    toolName: tool.name,
    toolCallID: call.id,
    decision: approvalRequired ? "approval_required" : "allow",
  });
  if (approvalRequired) {
    const refusal = await interactive.requireApproval(
      toolID,
      tool,
      call,
      turnID,
      forcedApproval
        ? { force: true, reason: forcedApproval.reason }
        : undefined,
    );
    if (refusal) {
      // Reported like a policy denial: the call did not run, the turn keeps
      // going, and the model receives the reason as this call's result.
      publish({
        type: "tool.update",
        id: toolID,
        name: tool.name,
        callID: call.id,
        status: "rejected",
        summary: refusal.reason,
        result: refusal.reason,
        argumentsDelta: call.arguments,
        ...(call.thoughtSignature
          ? { thoughtSignature: call.thoughtSignature }
          : {}),
        endedAt: Date.now(),
      });
      publishWorkGraphToolCall(turnID, call.id, tool.name, "rejected");
      await toolLayer.postExecute({
        ...{
          turnID,
          toolName: tool.name,
          toolCallID: call.id,
          arguments: call.arguments,
        },
        error: refusal.reason,
      });
      throw new Error(refusal.reason);
    }
  }
  await waitIfPaused(exec);
  publish({
    type: "tool.update",
    id: toolID,
    name: tool.name,
    callID: call.id,
    status: "running",
    summary: "running",
    startedAt: Date.now(),

    metadata: tool.output?.presentCall
      ? {
          call: tool.output.presentCall(tryParseToolArguments(call.arguments)),
        }
      : undefined,
  });
  let executionAudited = false;
  let releaseWriteLock: (() => void) | undefined;
  try {
    const parsed = parseToolArguments(call.arguments);
    const paramErrors = validateToolParameters(tool.parameters, parsed);
    if (paramErrors.length) {
      const detail = paramErrors
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ");
      throw new Error(
        `tool "${tool.name}" parameter validation failed: ${detail}`,
      );
    }
    const parsedRecord =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    const requestedTimeoutSec = parsedRecord.timeoutSec;
    const effectiveTimeoutSec =
      tool.timeoutSec !== undefined && tool.maxTimeoutSec !== undefined
        ? timeoutSecOr(requestedTimeoutSec, tool.timeoutSec, tool.maxTimeoutSec)
        : tool.timeoutSec;
    if (!exec) throw new Error("session execution state unavailable");
    await setInFlightOperationFor(exec, {
      kind: "tool_execution",
      turnID,
      toolName: tool.name,
      toolCallID: call.id,
      startedAt: new Date().toISOString(),
    });
    executionAudited = true;
    const executionController = new AbortController();
    // The cancellation listener binds the turn's own exec, not the activity
    // closure: a background turn's tool must stop when its session is
    // cancelled, never when the attached session is.
    const cancelExecution = () =>
      executionController.abort(
        exec?.activeAbort?.signal.reason ?? new Error("tool cancelled"),
      );
    const execSignal = exec?.activeAbort?.signal;
    if (execSignal?.aborted) cancelExecution();
    else execSignal?.addEventListener("abort", cancelExecution, { once: true });
    const timeoutTimer = effectiveTimeoutSec
      ? setTimeout(
          () =>
            executionController.abort(
              new Error(
                `tool ${tool.name} timed out after ${effectiveTimeoutSec}s`,
              ),
            ),
          effectiveTimeoutSec * 1000,
        )
      : undefined;
    const signal = executionController.signal;
    // D2: workspace writes serialise across sessions.

    const writePathForLock = toolPolicy.workspaceWritePathForTool(
      tool.name,
      parsed as Record<string, unknown>,
    );
    releaseWriteLock = writePathForLock
      ? await writeLock.acquire(exec.session.id, [writePathForLock])
      : undefined;
    // E1: create a pre-tool checkpoint for side-effecting calls so a tool card
    // can offer a precise "restore to just before this call".  The checkpoint
    // captures the workspace object tree and the Main Agent context before the
    // tool actually runs.  Failure is surfaced as a diagnostic rather than
    // blocking the side effect: rollback remains best-effort for calls where
    // the checkpoint system could not capture a safe snapshot.
    try {
      const checkpointPath = toolPolicy.workspaceWritePathForTool(
        tool.name,
        parsed as Record<string, unknown>,
      );
      const command = toolPolicy.commandTextForTool(
        tool.name,
        parsed as Record<string, unknown>,
      );
      if (exec && (checkpointPath || command)) {
        const checkpointController =
          await ctx.ports.initializeCheckpointController(exec);
        if (checkpointController?.isEnabled()) {
          const created = await checkpointController.createCheckpoint({
            reason: "pre_tool",
            context: exec.context,
            step: exec.context.journalStatus().messageCount,
            turnID,
            stepID: toolID,
            model: exec.provider?.model,
            status: tool.name,
          });
          // B7: the checkpoint carries its plan provenance so the Work Graph
          // can answer "which plan's commitment does this rollback point
          // belong to". Best-effort — a failed node never blocks the side
          // effect.
          try {
            const workLedger = ctx.ports.resolveService<
              import("@natalia/collab").WorkLedgerController
            >(workLedgerControllerToken.id);
            const activePlan = activePlanForExec(ctx, exec);
            if (workLedger && created && activePlan)
              ctx.ports.publishForSession(
                exec,
                workLedger.checkpointNode({
                  checkpointID: created.id,
                  planID: activePlan.planID,
                  sessionID: exec.session.id,
                  turnID,
                  reason: "pre_tool",
                }),
              );
          } catch {
            // pre-tool status publish is best-effort
          }
        }
      }
    } catch (error) {
      ctx.ports.publishForSession(exec, {
        type: "diagnostic",
        level: "warning",
        message: `pre-tool checkpoint failed for ${tool.name}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    // WG4 Phase 3: register the expected mutation before the tool runs.
    const writePath = toolPolicy.workspaceWritePathForTool(
      tool.name,
      parsed as Record<string, unknown>,
    );
    if (writePath) {
      mutationRegistry?.register({
        sessionID: exec.session.id,
        turnID,
        callID: call.id,
        toolName: tool.name,
        authorizedPaths: [writePath],
        expectedOperations: ["modified", "added", "deleted", "renamed"],
      });
    }
    const rina = ctx.state.serviceDirectory.getOptional(rinaCache);
    const completeResult = await waitForToolExecution(
      executeWithReadCache({
        fabric: rina,
        toolName: tool.name,
        parsed,
        execute: () =>
          tool.execute(
            parsed,
            buildToolExecutionContext({
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
              timeoutSec: effectiveTimeoutSec,
              parsed,
            }),
          ),
      }),
      signal,
    ).finally(() => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      exec?.activeAbort?.signal.removeEventListener("abort", cancelExecution);
      // An opaque workspace writer just finished — or failed after writing
      // — so tree-scoped results (glob/grep listings) can no longer be
      // trusted: the study's invalidate-on-write for the writer the
      // mutation declarations cannot see into.
      if (OPAQUE_WORKSPACE_WRITERS.has(tool.name)) rina?.markTreeChanged();
    });
    // A declared output shape is a contract for the tools whose result is JSON.
    // One that has drifted from its implementation fails here, naming the paths,
    // instead of handing the model a shape it was told to expect differently.
    const outputErrors = tool.output
      ? validateToolOutput(tool.output.schema, completeResult)
      : [];
    if (outputErrors.length > 0) {
      throw new Error(
        `tool "${tool.name}" returned output that does not match its ` +
          `declared schema: ${outputErrors
            .map((error) => `${error.path}: ${error.message}`)
            .join("; ")}`,
      );
    }
    // The tool.s own final content invariant runs exactly once, pre-redaction.
    const finalizedContent =
      tool.output?.finalizeContent?.(completeResult) ?? completeResult;
    const bounded = await boundToolOutput(
      workspaceRoot,
      redactToolOutput(finalizedContent, redactToolOutputEnabled(exec)),
    );
    const result = bounded.text;
    // The tool's own output projection becomes part of the event metadata, so
    // a client can draw the result as the card the tool described instead of
    // guessing from the string.
    const projectedRender = tool.output?.presentResult?.(
      tryParseToolArguments(call.arguments),
      result,
    );
    if (
      tool.name === "interactive_terminal_start" ||
      tool.name === "interactive_terminal_stop"
    ) {
      const terminalID = (parsed as Record<string, unknown>).id;
      if (typeof terminalID === "string")
        terminalCommandBuffer.clear(terminalID);
    }
    publish({
      type: "tool.update",
      id: toolID,
      name: tool.name,
      callID: call.id,
      status: "succeeded",
      summary: result.slice(0, 200),
      result,
      argumentsDelta: call.arguments,
      ...(call.thoughtSignature
        ? { thoughtSignature: call.thoughtSignature }
        : {}),
      metadata: {
        ...(bounded.outputPath
          ? {
              outputPath: bounded.outputPath,
              ...(bounded.truncated
                ? {
                    truncated: true,
                    page: bounded.page,
                    totalPages: bounded.totalPages,
                    ...(bounded.nextPagePath
                      ? { nextPagePath: bounded.nextPagePath }
                      : {}),
                    ...(bounded.totalBytes === undefined
                      ? {}
                      : { totalBytes: bounded.totalBytes }),
                  }
                : {}),
            }
          : {}),
        ...(projectedRender ? { render: projectedRender } : {}),
      },
      endedAt: Date.now(),
    });
    publishWorkGraphToolCall(turnID, call.id, tool.name, "succeeded");
    // Only after success: a write that failed did not change the workspace, and
    // a graph that says otherwise sends a reader looking for a change that is
    // not there.
    const changedPath = toolPolicy.workspaceWritePathForTool(
      tool.name,
      tryParseToolArguments(call.arguments),
    );
    if (changedPath) {
      publish(
        workLedgerController.workspaceChangeNode({
          turnID,
          path: changedPath,
          toolName: tool.name,
          sessionID: exec.session.id,
        }),
      );
      publish(
        workLedgerController.workspaceChangeEdge({
          turnID,
          callID: call.id,
          path: changedPath,
        }),
      );
    }
    if (isManagedResourceTool(tool.name)) scheduleRuntimeStatusSnapshot();
    // TERM-M.3 (c): request_human with endTurn=true ends the current turn as
    // waiting_human; the runtime resumes with a new turn once the human
    // releases the pane.
    if (tool.name === "interactive_terminal_request_human") {
      const requestArgs = tryParseToolArguments(call.arguments) as {
        id?: unknown;
        reason?: unknown;
        endTurn?: unknown;
      };
      if (
        requestArgs?.endTurn === true &&
        typeof requestArgs.id === "string" &&
        typeof requestArgs.reason === "string"
      ) {
        const marker = {
          terminalID: requestArgs.id,
          reason: requestArgs.reason,
        };
        if (exec) exec.endTurnWaitingHuman = marker;
        else setEndTurnWaitingHuman(marker);
      }
    }
    return result;
  } catch (error) {
    // WG4 Phase 3: a failed write did not change the workspace — drop the
    // expected mutation so it cannot attribute a later unrelated hint.
    if (
      toolPolicy.workspaceWritePathForTool(
        tool.name,
        tryParseToolArguments(call.arguments),
      )
    )
      mutationRegistry?.forget(call.id);
    const message = error instanceof Error ? error.message : String(error);
    publish({
      type: "tool.update",
      id: toolID,
      name: tool.name,
      callID: call.id,
      status: "failed",
      summary: message,
      result: message,
      argumentsDelta: call.arguments,
      ...(call.thoughtSignature
        ? { thoughtSignature: call.thoughtSignature }
        : {}),
      endedAt: Date.now(),
    });
    // A failed call is as much a fact as a successful one; the error text stays
    // out of the graph.
    publishWorkGraphToolCall(turnID, call.id, tool.name, "failed");
    await toolLayer.postExecute({
      ...{
        turnID,
        toolName: tool.name,
        toolCallID: call.id,
        arguments: call.arguments,
      },
      error: message,
    });
    throw new Error(message);
  } finally {
    releaseWriteLock?.();
    if (executionAudited && exec)
      await setInFlightOperationFor(exec, undefined);
  }
}
