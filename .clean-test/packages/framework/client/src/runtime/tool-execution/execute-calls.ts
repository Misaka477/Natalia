/**
 * Tool call execution orchestration — runtime/tool-execution/execute-calls.ts.
 *
 * `executeToolCalls` runs a provider's tool-call batch for one turn: it
 * materializes image attachments gated by the model's input
 * capabilities, resolves every call against the tool registry, publishes the
 * denial/failure facts, executes each call through `executeOneTool`, and
 * assembles the tool-result provider messages. `toolResultContent` shapes what
 * the model actually reads. Reads host state through `RuntimeContext` at call
 * time.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  projectedConstitutionOverrides,
  projectedConstitutionRules,
  sessionFactConstitutionOverrides,
  sessionFactConstitutionRules,
} from "@anthelia/session";
import { readOnlyToolMessage } from "@anthelia/runtime-services";
import { workLedgerController as workLedgerControllerToken } from "@natalia/work-ledger";
import { toolPolicy as toolPolicyToken } from "@natalia/tool-policy";
import { type ToolPolicyService } from "@anthelia/runtime-services";
import {
  uniqueProviderToolCallIds,
  type ProviderToolCall,
  type ProviderMessage,
} from "@anthelia/runtime";
import type {
  ProviderContentPart,
  ProviderReasoningBlock,
  RuntimeEvent,
} from "@anthelia/contracts";
import type { ToolMaterialization } from "@anthelia/tools";
import type { RuntimeContext } from "@anthelia/substrate";
import { ensureCompleteSessionFactState } from "@anthelia/substrate";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";
import type { WorkLedgerController } from "@natalia/work-ledger";

/**
 * The constitution self-protection patterns: shell and terminal input that must
 * never run, regardless of permission profile or approval. The same source the
 * command policy extracts command text from, so every shell surface is judged
 * from one place.
 */
const SELF_PROTECTION_PATTERNS = [
  {
    pattern: /pkill\s+-f\s+wezterm-mux-server/i,
    ruleID: "C-TERM-001",
    statement: "禁止直接杀掉 wezterm-mux-server",
  },
  {
    pattern: /rm\s+-rf\s+\/run\/user\/\d+\/natalia/i,
    ruleID: "C-TERM-002",
    statement: "禁止删除 Natalia 运行时目录",
  },
  {
    pattern: /rm\s+-rf\s+\/tmp\/natalia/i,
    ruleID: "C-TERM-003",
    statement: "禁止删除 Natalia 临时目录",
  },
];

export function createExecuteCalls(
  ctx: RuntimeContext,
  options: RealRuntimeClientOptions,
) {
  return {
    executeToolCalls,
    toolResultContent,
    checkConstitutionForTool,
  };

  /**
   * Checks constitution rules and the self-protection patterns. Returns the
   * blocked reason or undefined.
   *
   * `commandText` is whatever the call would actually run, extracted by the
   * same function the command policy uses, so shell and terminal input are
   * judged from one source. This check runs before approval, which is what
   * makes it a block rather than a prompt: an approval that is skipped, cached
   * or auto-granted cannot let a self-protection violation through.
   */
  async function checkConstitutionForTool(
    turnID: string,
    callID: string,
    toolName: string,
    toolAction: string,
    toolResource: string,
    commandText?: string,
  ): Promise<string | undefined> {
    const { executionForTurn, publishForSession } = ctx.ports;
    const workLedgerController = ctx.state.serviceDirectory.get(
      workLedgerControllerToken,
    );
    const sessionID = ctx.ports.getSessionID();
    const exec =
      executionForTurn(turnID) ??
      ctx.ports.getExecutionBySession().get(sessionID as never);
    if (!exec) return undefined;
    const publish = (event: RuntimeEvent) => publishForSession(exec, event);
    // Constitution is a security boundary: only evaluate it against the complete
    // fact state. A fast-attach tail is completed from paged history; if no store
    // can serve the pages this falls back to the explicit full load, and a load
    // failure aborts the call (fail-closed).
    await ensureCompleteSessionFactState(ctx, exec);
    const rules =
      exec.factStateComplete === true && exec.factState
        ? sessionFactConstitutionRules(exec.factState)
        : projectedConstitutionRules(exec.session.events);
    const overrides =
      exec.factStateComplete === true && exec.factState
        ? sessionFactConstitutionOverrides(exec.factState)
        : projectedConstitutionOverrides(exec.session.events);
    let blocked: string | undefined;

    if (commandText) {
      for (const entry of SELF_PROTECTION_PATTERNS)
        if (entry.pattern.test(commandText)) {
          publish({
            type: "constitution.check",
            id: `${turnID}:constitution:${entry.ruleID.toLowerCase()}`,
            ruleID: entry.ruleID,
            statement: entry.statement,
            priority: "critical",
            enforcement: "deny",
            action: toolAction,
            resource: `command:${commandText.slice(0, 120)}`,
            conflict: true,
          });
          // CST4: the blocked call is constrained by the rule that stopped it.
          // The tool-call node for a failed call is published by the caller, so
          // the edge's source exists once the call settles; a conflict is the
          // only check worth an edge (a pass-through rule is not news).
          publish(
            workLedgerController.constitutionCheckEdge({
              turnID,
              callID,
              ruleID: entry.ruleID,
            }),
          );
          blocked = `blocked by constitution: ${entry.statement}. Use terminal.kill or terminal.close instead.`;
          break;
        }
    }

    for (const rule of rules) {
      if (rule.enforcement !== "deny" && rule.enforcement !== "warn") continue;
      const applies = journalRuleApplies(
        rule.ruleID,
        commandText,
        toolResource,
      );
      if (!applies) continue;
      const override = matchingOverride(overrides, rule.ruleID, toolResource);
      const denyWithoutOverride =
        rule.enforcement === "deny" && applies && !override;
      publish({
        type: "constitution.check",
        id: `${turnID}:constitution:${rule.ruleID.toLowerCase()}`,
        ruleID: rule.ruleID,
        statement: rule.statement,
        priority: rule.priority,
        enforcement: rule.enforcement,
        action: toolAction,
        resource: toolResource,
        conflict: denyWithoutOverride,
        ...(override
          ? {
              override: {
                reason: override.reason,
                approvedBy: override.approvedBy,
              },
            }
          : {}),
      });
      if (denyWithoutOverride && !blocked) {
        publish(
          workLedgerController.constitutionCheckEdge({
            turnID,
            callID,
            ruleID: rule.ruleID,
          }),
        );
        blocked = `blocked by constitution: ${rule.statement}`;
      }
    }
    return blocked;
  }

  function journalRuleApplies(
    ruleID: string,
    commandText: string | undefined,
    toolResource: string,
  ) {
    if (ruleID.startsWith("C-TERM-")) return false;
    if (ruleID === "C-REL-001")
      return Boolean(
        commandText && /\bgit\s+(commit|push)\b/iu.test(commandText),
      );
    if (ruleID === "C-REL-002") return false;
    return toolResource !== "global";
  }

  function matchingOverride(
    overrides: ReturnType<
      typeof import("@anthelia/session").projectedConstitutionOverrides
    >,
    ruleID: string,
    toolResource: string,
  ) {
    return overrides.find((override) => {
      if (override.ruleID !== ruleID) return false;
      if (!override.paths?.length) return true;
      return override.paths.some(
        (path) => toolResource === path || toolResource.includes(path),
      );
    });
  }

  /**
   * The tool result the model actually reads. In an internal module episode the
   * call ID is prepended to the content of text-shaped results, because
   * models reliably read content but routinely ignore the protocol-level
   * tool_call_id — without this the model cannot know its own call ID and
   * guesses evidenceRefs. JSON-shaped results stay untouched: the model
   * consumes them verbatim.
   */
  function toolResultContent(
    content: string,
    callID: string,
    moduleContext: unknown,
  ): string {
    if (!moduleContext) return content;
    const trimmed = content.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return content;
    return `[tool call ID: ${callID}] ${content}`;
  }

  async function executeToolCalls(
    turnID: string,
    calls: ProviderToolCall[],
    assistant: string,
    materialized: ToolMaterialization,
    reasoning?: {
      content?: string;
      field?: string;
      signature?: string;
      redacted?: boolean;
      blocks?: ProviderReasoningBlock[];
      parts?: ProviderContentPart[];
      providerMetadata?: Record<string, unknown>;
      textSignature?: string;
    },
  ): Promise<ProviderMessage[]> {
    const {
      getSessionID,
      getWorkspaceRoot,
      getRuntimeContext,
      publishForSession,
      publishWorkGraphToolCall,
      currentModelImageInput,
      mediaTypeForImage,
      isToolAllowed,
      extensionToolPermission,
      executeOneTool,
    } = ctx.ports;
    const { executionBySession, turnSession, tools } = ctx.state;
    const sessionID = getSessionID();
    const workspaceRoot = getWorkspaceRoot();
    const runtimeContext = getRuntimeContext();
    const policy = ctx.state.serviceDirectory.get(toolPolicyToken);
    if (!policy)
      throw new Error("tool pipeline unavailable (natalia-tool-pipeline)");
    // B: the model can attach an image (a screenshot it took) so the next
    // provider step shows it back to the model, gated by the model's image
    // input capability.
    const pendingImages: Array<{
      mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      dataURL: string;
    }> = [];
    const exec = executionBySession.get(turnSession.get(turnID) ?? sessionID);
    if (!exec) throw new Error(`no execution state for turn ${turnID}`);
    const attachImage = currentModelImageInput(exec)
      ? async (path: string) => {
          const mediaType = mediaTypeForImage(path);
          if (!mediaType)
            throw new Error(
              `unsupported image attachment type for ${path}; expected png, jpeg, webp or gif`,
            );
          const bytes = await readFile(resolve(workspaceRoot, path));
          pendingImages.push({
            mediaType,
            dataURL: `data:${mediaType};base64,${bytes.toString("base64")}`,
          });
        }
      : undefined;
    // D2: a tool segment belongs to the session its turn was submitted to. The
    // local bindings shadow the activity-scoped globals for the whole segment,
    // so every publish lands in that session's journal with its stamp, and the
    // context ledger touched is the turn's own.
    const publish = (event: RuntimeEvent) => publishForSession(exec, event);
    const execContext = exec?.context ?? runtimeContext;
    // Defensive boundary for callers that bypass provider-runner: the provider
    // protocol requires a unique tool_call_id per assistant tool call, and a
    // duplicate would otherwise become two tool messages with the same id.
    const reservedCallIDs = new Set(
      execContext
        .snapshot()
        .entries.flatMap((entry) => (entry.pairID ? [entry.pairID] : [])),
    );
    const normalizedCalls = uniqueProviderToolCallIds(calls, reservedCallIDs);
    if (normalizedCalls.duplicates.length)
      publish({
        type: "diagnostic",
        level: "warning",
        message: `tool batch contained duplicate tool_call_id(s); remapped before execution: ${normalizedCalls.duplicates.join(", ")}`,
      });
    const effectiveCalls = normalizedCalls.calls;
    const assistantMessage: ProviderMessage = {
      role: "assistant",
      content: assistant,
      ...(reasoning?.content !== undefined
        ? { reasoningContent: reasoning.content }
        : {}),
      ...(reasoning?.field ? { reasoningField: reasoning.field } : {}),
      ...(reasoning?.signature
        ? { reasoningSignature: reasoning.signature }
        : {}),
      ...(reasoning?.redacted ? { reasoningRedacted: true } : {}),
      ...(reasoning?.blocks?.length
        ? { reasoningBlocks: reasoning.blocks }
        : {}),
      ...(reasoning?.parts?.length ? { contentParts: reasoning.parts } : {}),
      ...(reasoning?.providerMetadata
        ? { providerMetadata: reasoning.providerMetadata }
        : {}),
      ...(reasoning?.textSignature
        ? { textSignature: reasoning.textSignature }
        : {}),
      toolCalls: effectiveCalls,
    };
    const messages: ProviderMessage[] = [assistantMessage];
    for (const [index, call] of effectiveCalls.entries()) {
      execContext.add({
        id: `${turnID}:${call.id}:call`,
        role: "tool_call",
        content: `${call.name} ${call.arguments}`,
        pairID: call.id,
        ...(call.thoughtSignature
          ? { thoughtSignature: call.thoughtSignature }
          : {}),
        ...(index === 0 && reasoning?.content !== undefined
          ? { reasoningContent: reasoning.content }
          : {}),
        ...(index === 0 && reasoning?.field
          ? { reasoningField: reasoning.field }
          : {}),
        ...(index === 0 && reasoning?.signature
          ? { reasoningSignature: reasoning.signature }
          : {}),
        ...(index === 0 && reasoning?.redacted
          ? { reasoningRedacted: true }
          : {}),
        ...(index === 0 && reasoning?.blocks?.length
          ? { reasoningBlocks: reasoning.blocks }
          : {}),
        ...(index === 0 && reasoning?.parts?.length
          ? { contentParts: reasoning.parts }
          : {}),
        ...(index === 0 && reasoning?.providerMetadata
          ? { providerMetadata: reasoning.providerMetadata }
          : {}),
        ...(index === 0 && reasoning?.textSignature
          ? { textSignature: reasoning.textSignature }
          : {}),
      });
    }
    for (const call of effectiveCalls) {
      if (!call.name.trim()) {
        const reason =
          "provider emitted a tool call without a name; check OpenAI-compatible streaming format";
        publish({
          type: "diagnostic",
          level: "warning",
          message: reason,
        });
        publish({
          type: "tool.update",
          id: `${turnID}:${call.id}`,
          name: "invalid_tool_call",
          callID: call.id,
          status: "failed",
          summary: reason,
          result: reason,
          endedAt: Date.now(),
        });
        publishWorkGraphToolCall(
          turnID,
          call.id,
          "invalid_tool_call",
          "failed",
        );
        messages.push({
          role: "tool",
          toolCallID: call.id,
          toolName: "invalid_tool_call",
          content: toolResultContent(`ERROR: ${reason}`, call.id, undefined),
        });
        execContext.add({
          id: `${turnID}:${call.id}:result`,
          role: "tool_result",
          content: `ERROR: ${reason}`,
          pairID: call.id,
        });
        continue;
      }
      const resolved = materialized.resolve(call.name);
      if (resolved.status !== "ready") {
        const reason = resolved.error;
        const registered = tools.get(call.name);
        if (
          registered &&
          (!isToolAllowed(call.name, exec) ||
            (exec?.permissionMode === "read_only" &&
              registered.requiresApproval))
        )
          publish({
            type: "policy.decision",
            turnID,
            toolName: call.name,
            toolCallID: call.id,
            decision: "deny",
            reason:
              exec?.permissionMode === "read_only" &&
              registered.requiresApproval
                ? readOnlyToolMessage(call.name)
                : (extensionToolPermission(call.name, exec?.permissionProfile)
                    .diagnostics[0] ??
                  "tool is excluded from the runtime catalog by policy"),
          });
        publish({
          type: "tool.update",
          id: `${turnID}:${call.id}`,
          name: call.name,
          callID: call.id,
          status: "failed",
          summary: reason,
          result: reason,
          endedAt: Date.now(),
        });
        publishWorkGraphToolCall(
          turnID,
          call.id,
          call.name,
          registered && exec?.permissionMode === "read_only"
            ? "rejected"
            : "failed",
        );
        messages.push({
          role: "tool",
          toolCallID: call.id,
          toolName: call.name,
          content: toolResultContent(`ERROR: ${reason}`, call.id, undefined),
        });
        execContext.add({
          id: `${turnID}:${call.id}:result`,
          role: "tool_result",
          content: `ERROR: ${reason}`,
          pairID: call.id,
        });
        continue;
      }
      const result = await executeOneTool(
        turnID,
        call,
        resolved.tool,
        attachImage,
      );
      messages.push({
        role: "tool",
        toolCallID: call.id,
        toolName: call.name,
        content: toolResultContent(result, call.id, undefined),
      });
      execContext.add({
        id: `${turnID}:${call.id}:result`,
        role: "tool_result",
        content: result,
        pairID: call.id,
      });
    }
    if (pendingImages.length)
      messages.push({
        role: "user",
        content:
          "Rendered page images are attached as the result of the preceding tool call. Read every image in attachment order. A visual attachment means vision was explicitly requested; it does not by itself prove the page is scanned. Do not claim that local OCR was used.",
        images: pendingImages,
      });
    return messages;
  }
}
