/**
 * Single tool call execution — runtime/tool-execution/execute-one.ts.
 *
 * `executeOneTool` runs one provider tool call through the reorderable policy
 * pipeline: the tool-layer preExecute, read-only and constitution pre stages,
 * then the execute stage (approval + execution, split into
 * `execute-run.ts`), then the postExecute-on-success post stage. Reads host
 * state through `RuntimeContext` at call time.
 */
import { readOnlyToolMessage } from "@anthelia/runtime-services";
import { toolPolicy as toolPolicyToken } from "@natalia/tool-policy";
import {
  terminalController,
  type TerminalController,
  type ToolPolicyService,
} from "@anthelia/runtime-services";
import type { ProviderToolCall } from "@anthelia/runtime";
import type { RuntimeTool } from "@anthelia/tools";
import type { RuntimeEvent } from "@anthelia/contracts";
import { runExecuteStage } from "./execute-run";
import {
  clearRepeat,
  recordRepeat,
  repeatKey,
  REPEAT_MAX,
  REPEAT_WINDOW_MS,
} from "./repeat-guard";
import type { RuntimeContext } from "@anthelia/substrate";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";

const WAITING_TOOLS = new Set(["terminal_observe"]);

export function createExecuteOne(
  ctx: RuntimeContext,
  options: RealRuntimeClientOptions,
) {
  return {
    executeOneTool,
  };

  async function executeOneTool(
    turnID: string,
    call: ProviderToolCall,
    tool: RuntimeTool,
    attachImage?: (path: string) => Promise<void>,
  ) {
    const {
      getSessionID,
      publishForSession,
      publishWorkGraphToolCall,
      checkConstitutionForTool,
      createToolPolicyLayer,
      tryParseToolArguments,
    } = ctx.ports;
    const { executionBySession, turnSession, toolCalls } = ctx.state;
    const sessionID = getSessionID();
    // D2: same shadowing as `executeToolCalls` — this segment's events and
    // ledger belong to the turn's session.
    const exec = executionBySession.get(turnSession.get(turnID) ?? sessionID);
    if (!exec) throw new Error(`no execution state for turn ${turnID}`);
    const toolLayer = createToolPolicyLayer(exec);
    const toolPolicy = ctx.state.serviceDirectory.get(toolPolicyToken);
    if (!toolPolicy)
      throw new Error("tool pipeline unavailable (natalia-tool-pipeline)");
    const terminal = ctx.state.serviceDirectory.getOptional(terminalController);
    const publish = (event: RuntimeEvent) => publishForSession(exec, event);
    const toolID = `${turnID}:${call.id}`;
    const dedupKey = repeatKey(
      tool.name,
      call.arguments,
      ctx.ports.getWorkspaceRoot(),
    );
    const sessionToolCalls = exec?.toolCalls ?? toolCalls;
    const repeat = recordRepeat(sessionToolCalls, dedupKey);
    if (repeat.blocked && !WAITING_TOOLS.has(tool.name)) {
      const message = `blocked repeated tool call after ${repeat.count} identical attempts within ${Math.round(REPEAT_WINDOW_MS / 1000)}s (max ${REPEAT_MAX}): ${tool.name}`;
      publish({
        type: "tool.update",
        id: toolID,
        name: tool.name,
        callID: call.id,
        status: "failed",
        summary: message,
        result: message,
        endedAt: Date.now(),
      });
      publishWorkGraphToolCall(turnID, call.id, tool.name, "failed");
      return `ERROR: ${message}`;
    }
    const hookEvent = {
      turnID,
      toolName: tool.name,
      toolCallID: call.id,
      arguments: call.arguments,
    };
    // The policy chain is a reorderable pipeline now: preExecute, read-only and
    // constitution are pre stages (the first denial stops the run), and the
    // approval-and-execution block below is the execute stage's content. The
    // outcome is a frozen result the caller cannot rewrite.
    const pipeline = toolPolicy!
      .createExecutionPipeline()
      .preStage(async () => {
        const preResult = await toolLayer.preExecute(hookEvent);
        for (const diagnostic of preResult.diagnostics) {
          publishForSession(exec, {
            type: "diagnostic",
            level: "info",
            message: diagnostic,
          });
        }
        if (preResult.allowed) return { decision: "allow" as const };
        if (preResult.clearTerminal) {
          const terminalID = (
            tryParseToolArguments(call.arguments) as Record<string, unknown>
          ).id;
          if (typeof terminalID === "string") {
            try {
              await terminal?.write(terminalID, "\x15");
              publish({
                type: "diagnostic",
                level: "warning",
                message: `cleared blocked terminal command buffer for ${terminalID}`,
              });
            } catch (error) {
              publish({
                type: "diagnostic",
                level: "warning",
                message: `could not clear blocked terminal command buffer for ${terminalID}: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          }
        }
        const reason = preResult.diagnostics.join("; ");
        publish({
          type: "policy.decision",
          turnID,
          toolName: tool.name,
          toolCallID: call.id,
          decision: "deny",
          reason,
        });
        publish({
          type: "tool.update",
          id: toolID,
          name: tool.name,
          callID: call.id,
          status: "failed",
          summary: reason,
          result: reason,
          endedAt: Date.now(),
        });
        publishWorkGraphToolCall(turnID, call.id, tool.name, "failed");
        return { decision: "deny" as const, reason };
      })
      .preStage(() => {
        if (!(exec?.permissionMode === "read_only" && tool.requiresApproval))
          return { decision: "allow" as const };
        const message = readOnlyToolMessage(tool.name);
        publish({
          type: "policy.decision",
          turnID,
          toolName: tool.name,
          toolCallID: call.id,
          decision: "deny",
          reason: message,
        });
        publish({
          type: "tool.update",
          id: toolID,
          name: tool.name,
          callID: call.id,
          status: "rejected",
          summary: message,
          result: message,
          endedAt: Date.now(),
        });
        publishWorkGraphToolCall(turnID, call.id, tool.name, "rejected");
        return { decision: "deny" as const, reason: message };
      })
      .preStage(async () => {
        const blocked = await checkConstitutionForTool(
          turnID,
          call.id,
          tool.name,
          tool.name,
          // `apply_edits` reports the whole-workspace scope `"."` because it can
          // touch many files; `write_file`/`edit_file` report their single path.
          // Anything else has no path scope and falls through to "global".
          toolPolicy!.workspaceWritePathForTool(
            tool.name,
            tryParseToolArguments(call.arguments),
          ) ?? "global",
          toolPolicy!.commandTextForTool(
            tool.name,
            tryParseToolArguments(call.arguments),
          ),
        );
        if (!blocked) return { decision: "allow" as const };
        publish({
          type: "tool.update",
          id: toolID,
          name: tool.name,
          callID: call.id,
          status: "failed",
          summary: blocked,
          argumentsDelta: call.arguments,
          ...(call.thoughtSignature
            ? { thoughtSignature: call.thoughtSignature }
            : {}),
        });
        publishWorkGraphToolCall(turnID, call.id, tool.name, "failed");
        return { decision: "deny" as const, reason: blocked };
      })
      .execute(
        async () =>
          await runExecuteStage({
            exec,
            publish,
            toolID,
            tool,
            call,
            turnID,
            attachImage,
            ctx,
            options,
            sessionID,
            workspaceRoot: ctx.ports.getWorkspaceRoot(),
          }),
      )
      .postStage(async (_input, content) => {
        // postExecute-on-success is the post waterfall's accept stage; the
        // error-reporting postExecute calls stay in the execute stage where
        // they already fire.
        await toolLayer.postExecute({ ...hookEvent, result: content });
        return { decision: "accept" as const };
      });
    let run: Awaited<ReturnType<typeof pipeline.run>>;
    try {
      run = await pipeline.run({
        name: tool.name,
        args: tryParseToolArguments(call.arguments),
        context: { workspaceRoot: ctx.ports.getWorkspaceRoot() },
      });
    } catch (error) {
      // The execute stage throws on refusal and on failure after publishing
      // its own events; the caller turns the reason into the model-visible
      // result. A cancellation is not a failure: it propagates so the turn
      // coordinator settles the turn as cancelled.
      if (exec?.activeAbort?.signal.aborted) throw error;
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (run.status === "denied") return `ERROR: ${run.reason}`;
    if (run.status === "asking")
      return `ERROR: ${run.decision.reason ?? "approval required"}`;
    if (run.status === "blocked") return `ERROR: ${run.feedback}`;
    clearRepeat(sessionToolCalls, dedupKey);
    return run.result.content;
  }
}
