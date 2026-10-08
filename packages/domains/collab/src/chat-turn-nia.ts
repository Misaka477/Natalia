import { parseToolArguments, validateToolParameters } from "@anthelia/tools";
import {
  MAX_STEPS_PROMPT,
  MISSING_FINAL_RESPONSE_FALLBACK,
  nativeToolCallCorrection,
  normalizeRawToolCallProtocol,
  providerForModel,
  requestHeaderKey,
  requireNativeToolCallProtocol,
} from "@anthelia/runtime";
import type {
  ProviderFinishReason,
  ProviderMessage,
  ProviderToolCall,
  StreamingProvider,
} from "@anthelia/runtime";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import { ensureCompleteSessionFactState } from "@anthelia/substrate";
import { activePlanForExec } from "./plan-doc-runtime";
import { logOf } from "@anthelia/operation-log";
import {
  type ConcreteRuntimeEvent,
  niaChatHistory,
  collabMessagesForExec,
  chatModelCapabilities,
  compactChatBeforeProviderStep,
  applyChatAttachments,
  applyChatHistoryAttachments,
  promptData,
  streamEvent,
} from "./chat-turn-common";
import { ensureSessionFullEvents } from "@anthelia/substrate";

const MAX_PROTOCOL_CORRECTIONS = 2;

export function createNiaChatTurn(ctx: RuntimeContext) {
  return { runNiaChatTurn };

  async function runNiaChatTurn(
    input: {
      text: string;
      responseMessageID: string;
      exec: SessionExecutionState;
      internal?: boolean;
      detourReview?: { detourID: string; planID: string; reason: string };
      model?: { modelID?: string; variant?: string };
      reasoningEffort?: import("@anthelia/contracts").RuntimeReasoningEffort;
      attachments?: import("@anthelia/contracts").LocalAttachment[];
    },
    signal: AbortSignal,
  ) {
    // The system prompt and transcript read the incremental hot state. On a
    // fast-attach tail, complete it by streaming the log into the state rather
    // than materialising the whole journal; only fall back to the full load when
    // no store can serve the pages.
    await ensureCompleteSessionFactState(ctx, input.exec);
    const activeProvider = niaProvider(input);
    if (!activeProvider) throw new Error("provider unavailable for Nia chat");
    const profileModel = input.exec.niaChatModelProfile?.normal;
    const chatModel = input.model?.modelID
      ? input.model
      : profileModel?.modelID
        ? profileModel
        : undefined;
    const activeModelCapabilities = chatModelCapabilities(
      ctx,
      activeProvider,
      chatModel,
    );
    const tsRuntimeConfig = ctx.ports.getTsRuntimeConfig();
    const activeContextBudget = tsRuntimeConfig
      ? await ctx.ports.resolveContextStatusConfig(
          tsRuntimeConfig,
          activeProvider,
          ctx.ports.getContextWindowResolver(),
          ctx.ports.modelRefKeyForSelection(undefined, chatModel),
        )
      : input.exec.runtimeContextConfig;
    input.exec.niaTokenMeter.setContextWindow(
      "stream",
      activeContextBudget.max,
    );
    const reportAttachmentDiagnostic = (message: string) =>
      ctx.ports.publishForSession(input.exec, {
        type: "diagnostic",
        level: "warning",
        message,
      });
    logOf(ctx.state.serviceDirectory).info("nia-chat-turn", "start", {
      sessionID: input.exec.session.id,
      responseMessageID: input.responseMessageID,
      internal: input.internal === true,
      adapter: activeProvider.constructor.name,
      provider: activeProvider.provider,
      model: activeProvider.model,
    });
    const {
      publishForSession,
      nextChatSequence,
      niaChatPersona,
      niaChatLiveContext,
      niaChatTools,
      effectiveMaxSteps,
      chatToolSummary,
      chatToolCard,
      redactToolOutput,
      getWorkspaceRoot,
    } = ctx.ports;
    const publish = (
      event: Extract<ConcreteRuntimeEvent, { type: `nia.chat.${string}` }>,
    ) => publishForSession(input.exec, streamEvent(event));
    const publishTokenSnapshot = () => {
      const projection = input.exec.niaTokenMeter.project("stream");
      publishForSession(input.exec, {
        type: "nia.context.snapshot",
        usedTokens:
          projection.projectedTokens ??
          projection.pressureTokens ??
          input.exec.niaChatLedger.effectiveTokens(),
        ...(projection.pressureTokens === undefined
          ? {}
          : { pressureTokens: projection.pressureTokens }),
        ...(projection.projectedTokens === undefined
          ? {}
          : { projectedTokens: projection.projectedTokens }),
        ...(projection.contextWindow === undefined
          ? {}
          : { contextWindow: projection.contextWindow }),
        ...(projection.systemTokens === undefined
          ? {}
          : { systemTokens: projection.systemTokens }),
        ...(projection.toolsTokens === undefined
          ? {}
          : { toolsTokens: projection.toolsTokens }),
        ...(projection.messageTokens === undefined
          ? {}
          : { messageTokens: projection.messageTokens }),
        source: projection.source,
        at: new Date().toISOString(),
      });
    };
    // Same as the navi channel: the rebuilt history needs the whole durable
    // log, not the fast-attach tail.
    // A consumer without a store (an embedded/test runtime) has no full log to
    // load, and a turn must not die because the history could not be widened:
    // the rebuild still runs over whatever the exec holds.
    try {
      await ensureSessionFullEvents(ctx, input.exec);
    } catch (error) {
      logOf(ctx.state.serviceDirectory).warn(
        "collab-chat",
        "full event load failed; the history rebuild uses the exec window",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
    const history = niaChatHistory(input.exec, input.responseMessageID);
    const consumedMessageIDs = history.messageIDs;
    // ADR D1/D2: the system message is the static persona only; the live work
    // context is an appended `<runtime_context>` user message with a
    // turn-local revision, placed directly before the turn's request so the
    // model reads "current context → request" (D6).
    let runtimeContextRevision = 0;
    const liveContextMessage = () => {
      runtimeContextRevision += 1;
      const context = niaChatLiveContext(input.exec);
      if (!context.trim()) return undefined;
      return {
        role: "user" as const,
        content: `<runtime_context source="collab" trust="untrusted" revision="${runtimeContextRevision}">\n${context}\n</runtime_context>`,
      };
    };
    const applyLiveContext = (target: ProviderMessage[]) => {
      const message = liveContextMessage();
      if (!message) return;
      // Insert before the trailing user request; when the request is not the
      // last message (mid-turn refresh), append after the conversation so the
      // fresh snapshot still precedes the new step messages pushed next.
      const insertAt =
        target.at(-1)?.role === "user" ? target.length - 1 : target.length;
      target.splice(insertAt, 0, message);
    };
    const messages: ProviderMessage[] = [
      { role: "system", content: niaChatPersona() },
      ...history.messages,
    ];
    if (input.detourReview)
      messages.push({
        role: "user",
        content:
          `A detour was declared for plan ${input.detourReview.planID} ` +
          `(detour ${input.detourReview.detourID}): ${input.detourReview.reason}. ` +
          `Read the accepted WorkContract with work_contract_read and the detour ` +
          `with work_graph_query, then record your independent review with ` +
          `detour_review (approve or reject, with a rationale). Your verdict is ` +
          `a reference for the user, who makes the final decision through the ` +
          `detour gate. Do not call audit_report for this. This is not a user ` +
          `message.`,
      });
    else if (input.internal)
      messages.push({
        role: "user",
        content:
          "Your audit wake request has arrived. Start by pulling the full chain — read the accepted WorkContract with work_contract_read and the plan's graph with work_graph_query(planID) — then read the active plan and shared context, perform the audit, and call audit_report with planID and verdict passed or gaps. Use collab_chat to send concrete findings to Natalia. If Natalia claims fixes after a re-audit, verify the actual workspace and plan before passing. Be concise and exact.",
      });
    applyLiveContext(messages);
    await applyChatHistoryAttachments(ctx, {
      messages: history.messages,
      attachments: history.attachments,
      modelCapabilities: activeModelCapabilities,
      provider: activeProvider,
      onDiagnostic: reportAttachmentDiagnostic,
    });
    if (
      !history.attachments.some((attachments) => attachments?.length) &&
      input.attachments?.length
    ) {
      const initialUserMessage = messages.findLast(
        (message) => message.role === "user",
      );
      if (initialUserMessage)
        await applyChatAttachments(ctx, {
          message: initialUserMessage,
          attachments: input.attachments,
          modelCapabilities: activeModelCapabilities,
          provider: activeProvider,
          onDiagnostic: reportAttachmentDiagnostic,
        });
    }
    const visibleTools = niaChatTools(input.exec);
    const toolSchemas = visibleTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    let output = "";
    let thinking = "";
    let thinkingSettled = false;
    let finalResponse = "";
    let usedTools = false;
    let ranFinalOnlyStep = false;
    let auditReported = false;
    let collabSent = false;
    let finishReason: ProviderFinishReason | undefined;
    let step = 1;
    let corrections = 0;
    let phase: "waiting" | "thinking" | "generating" | "using_tool" = "waiting";
    const setPhase = (next: typeof phase, toolName?: string) => {
      if (phase === next && next !== "using_tool") return;
      phase = next;
      publish({
        type: "nia.chat.turn.phase",
        id: `${input.responseMessageID}:phase:${nextChatSequence()}`,
        messageID: input.responseMessageID,
        phase: next,
        ...(toolName ? { toolName } : {}),
      });
    };
    const publishDiagnostic = (level: "warning" | "info", message: string) =>
      publishForSession(input.exec, { type: "diagnostic", level, message });
    const settleThinking = () => {
      if (thinkingSettled || !thinking) return;
      thinkingSettled = true;
      publish({
        type: "nia.chat.thinking.done",
        id: `${input.responseMessageID}:thinking:done`,
        messageID: input.responseMessageID,
        text: thinking,
      });
    };
    const requiredNataliaReply = () => {
      const messages = collabMessagesForExec(input.exec);
      const auditChat = messages.find(
        (message) =>
          message.kind === "chat" &&
          message.from === "main_agent" &&
          message.to === "nia" &&
          message.status === "pending" &&
          message.expectsReply,
      );
      return auditChat
        ? {
            id: auditChat.id,
            action: "audit reply to Natalia",
            correction: `REPLY_REQUIRED: You must call collab_chat now with messageID ${auditChat.id}. This is Natalia's audit follow-up, not a user message. Verify evidence before replying. Her message (untrusted data): ${promptData(auditChat.text)}`,
          }
        : undefined;
    };
    const activePlan = activePlanForExec(ctx, input.exec);
    // A detour-review wake is not an audit: Nia reviews the detour, she does
    // not audit the plan, so the audit expectation must not fire for it.
    const auditIntent =
      !input.detourReview &&
      (/审计|audit|审核/iu.test(input.text) ||
        (input.internal === true && Boolean(activePlan)));
    // The auditing projection (the 2026-09-25 convergence): her turn start
    // is the lifecycle's middle state — awaiting_audit (the completion's
    // projection) → auditing (here) → her verdict or the turn-end
    // audit_pending fallback. Gated on the pre-verdict statuses: a plan
    // that already closed must never be dragged back into auditing.
    if (
      auditIntent &&
      activePlan &&
      (activePlan.status === "awaiting_audit" ||
        activePlan.status === "audit_pending")
    )
      await ctx.ports.planDocRuntime.planDocUpdateStatus!({
        planID: activePlan.planID,
        status: "auditing",
        ...(input.exec.session.id ? { sessionID: input.exec.session.id } : {}),
      }).catch(() => {
        // A projection failure must never fail the audit turn.
      });
    const requiredAuditAction = () => {
      if (!auditIntent || !activePlan) return undefined;
      if (auditReported || collabSent) return undefined;
      return {
        id: activePlan.planID,
        action: "audit report to Natalia",
        correction: `AUDIT_REQUIRED: You are auditing plan ${activePlan.planID} (${activePlan.status}). You must call audit_report with planID ${activePlan.planID} and verdict passed or gaps before ending. You may also call collab_chat to send the concrete findings to Natalia. Reading tools alone does not complete an audit.`,
      };
    };
    try {
      while (
        step <= effectiveMaxSteps(input.exec) ||
        input.exec.niaPendingQueue.length > 0
      ) {
        signal.throwIfAborted();
        const pending = input.exec.niaPendingQueue.splice(0);
        const pendingStart = messages.length;
        for (const incoming of pending)
          if (!consumedMessageIDs.has(incoming.messageID)) {
            const message: ProviderMessage = {
              role: "user",
              content: incoming.text,
            };
            messages.push(message);
            consumedMessageIDs.add(incoming.messageID);
            await applyChatAttachments(ctx, {
              message,
              attachments: incoming.attachments,
              modelCapabilities: activeModelCapabilities,
              provider: activeProvider,
              onDiagnostic: reportAttachmentDiagnostic,
            });
          }
        if (pending.length) {
          // ADR D3/D6: append a fresh live-context snapshot (higher revision)
          // before the new messages instead of mutating the system prompt —
          // mutating an earlier message would reset the cacheable prefix.
          const context = liveContextMessage();
          if (context) messages.splice(pendingStart, 0, context);
        }
        const requiredReply = requiredNataliaReply();
        const finalOnly =
          step >= effectiveMaxSteps(input.exec) &&
          !requiredReply &&
          pending.length === 0 &&
          input.exec.niaPendingQueue.length === 0;
        ranFinalOnlyStep ||= finalOnly;
        const calls: ProviderToolCall[] = [];
        let stepOutput = "";
        let stepThinking = "";
        let stepThinkingField: string | undefined;
        let stepThinkingSignature: string | undefined;
        let stepThinkingRedacted = false;
        let protocolViolation = "";
        const compactedMessages = await compactChatBeforeProviderStep(
          ctx,
          input.exec,
          input.exec.niaChatLedger,
          activeProvider,
          messages,
          signal,
          {
            meter: input.exec.niaTokenMeter,
            tools: toolSchemas,
            contextWindow: activeContextBudget.max,
            compactionID: `nia-chat:${input.exec.session.id}`,
            durableMessages: history.durableMessages,
            prune: step === 1,
            instruction:
              "Compact the older Nia audit chat history while preserving concrete user goals, decisions, identifiers, tool outcomes, findings, and unresolved questions.",
            publishCompacted: (summary, compactedThroughMessageID) =>
              publish(
                streamEvent({
                  type: "nia.chat.compacted",
                  id: `nia-chat:${input.exec.session.id}:${Date.now().toString(36)}:${ctx.ports.nextPlanSequence()}`,
                  messageID: `nia-chat-compacted:${input.exec.session.id}:${Date.now().toString(36)}`,
                  summary,
                  compactedThroughMessageID,
                  at: new Date().toISOString(),
                }),
              ),
            publishCompactionEvent: (
              event: Extract<
                ConcreteRuntimeEvent,
                { type: "compaction.begin" | "compaction.end" }
              >,
            ) =>
              publish(
                streamEvent({
                  type: "nia.chat.compaction",
                  id: event.id,
                  state:
                    event.type === "compaction.begin" ? "started" : "finished",
                  ...(event.type === "compaction.begin"
                    ? { beforeTokens: event.beforeTokens }
                    : {
                        beforeTokens: event.beforeTokens,
                        afterTokens: event.afterTokens,
                        success: event.success,
                      }),
                }),
              ),
          },
        );
        if (compactedMessages !== messages)
          messages.splice(0, messages.length, ...compactedMessages);
        publishTokenSnapshot();
        let providerUsage:
          | {
              inputTokens: number;
              outputTokens: number;
              cacheCreationInputTokens?: number;
              cacheReadInputTokens?: number;
            }
          | undefined;
        const raw = activeProvider.stream({
          messages: finalOnly
            ? [...messages, { role: "assistant", content: MAX_STEPS_PROMPT }]
            : messages,
          tools: finalOnly ? undefined : toolSchemas,
          toolChoice: finalOnly ? "none" : undefined,
          signal,
        });
        for await (const chunk of finalOnly
          ? raw
          : requireNativeToolCallProtocol(normalizeRawToolCallProtocol(raw))) {
          logOf(ctx.state.serviceDirectory).debug("nia-chat-turn", "chunk", {
            type: chunk.type,
            textLength: "text" in chunk ? String(chunk.text?.length ?? "") : "",
          });
          if (chunk.type === "thinking") {
            setPhase("thinking");
            if (chunk.text) {
              thinking += chunk.text;
              stepThinking += chunk.text;
            }
            if (chunk.field) stepThinkingField = chunk.field;
            if (chunk.signature) stepThinkingSignature = chunk.signature;
            if (chunk.redacted) stepThinkingRedacted = true;
            if (chunk.text)
              publish({
                type: "nia.chat.thinking.delta",
                id: `${input.responseMessageID}:thinking:${nextChatSequence()}`,
                messageID: input.responseMessageID,
                text: chunk.text,
              });
            continue;
          }
          if (chunk.type === "content") {
            setPhase("generating");
            output += chunk.text;
            stepOutput += chunk.text;
            publish({
              type: "nia.chat.message.delta",
              id: `${input.responseMessageID}:delta:${nextChatSequence()}`,
              messageID: input.responseMessageID,
              text: chunk.text,
            });
          }
          if (chunk.type === "tool_call") calls.push(...chunk.calls);
          if (chunk.type === "tool_protocol_violation")
            protocolViolation = chunk.text;
          if (chunk.type === "done") finishReason = chunk.finishReason;
          if (chunk.type === "usage")
            providerUsage = {
              inputTokens: chunk.inputTokens,
              outputTokens: chunk.outputTokens,
              ...(chunk.cacheCreationInputTokens === undefined
                ? {}
                : { cacheCreationInputTokens: chunk.cacheCreationInputTokens }),
              ...(chunk.cacheReadInputTokens === undefined
                ? {}
                : { cacheReadInputTokens: chunk.cacheReadInputTokens }),
            };
        }
        if (providerUsage) {
          // The main provider runner emits one `runtime.step_usage` per step.
          // Chat turns call the provider directly, so mirror it here or the
          // session usage dashboard silently excludes Navi/Nia.
          publishForSession(input.exec, {
            type: "nia.runtime.step_usage",
            id: `${input.responseMessageID}:usage:${nextChatSequence()}`,
            inputTokens: providerUsage.inputTokens,
            outputTokens: providerUsage.outputTokens,
            ...(providerUsage.cacheCreationInputTokens === undefined
              ? {}
              : {
                  cacheCreationInputTokens:
                    providerUsage.cacheCreationInputTokens,
                }),
            ...(providerUsage.cacheReadInputTokens === undefined
              ? {}
              : { cacheReadInputTokens: providerUsage.cacheReadInputTokens }),
          });
          const scope = "stream";
          const system =
            messages[0]?.role === "system" ? messages[0].content : undefined;
          input.exec.niaTokenMeter.setContextWindow(
            scope,
            activeContextBudget.max,
          );
          input.exec.niaTokenMeter.recordUsage(scope, providerUsage, {
            headerKey: requestHeaderKey({ system, tools: toolSchemas }),
            surfaceTokens: input.exec.niaTokenMeter.observeSurface(
              scope,
              messages,
            ),
          });
          publishTokenSnapshot();
        }
        usedTools ||= calls.length > 0;
        for (const call of calls) {
          let callAuditVerdict: string | undefined;
          if (call.name === "audit_report") {
            auditReported = true;
            try {
              callAuditVerdict = (
                JSON.parse(call.arguments) as { verdict?: string }
              ).verdict;
            } catch {
              // Ignore malformed audit_report arguments; generic execution reports it.
            }
            // The audit_report tool result carries noWakeNatalia when passed;
            // no mid-conversation system injection is needed.
          }
          if (call.name === "collab_chat") collabSent = true;
        }
        const outstandingAudit = requiredAuditAction();
        if (
          finishReason === "length" ||
          finishReason === "content_filter" ||
          finishReason === "error"
        )
          throw new Error(
            `provider stopped before completing the response (${finishReason})`,
          );
        if (finishReason === "tool_calls" && !calls.length)
          throw new Error(
            "provider reported tool_calls without a complete native tool call",
          );
        const outstanding = requiredNataliaReply() ?? outstandingAudit;
        if (finalOnly || !calls.length) {
          if (outstanding) {
            setPhase("waiting");
            if (++corrections > MAX_PROTOCOL_CORRECTIONS)
              throw new Error(
                `model repeatedly ended without ${outstanding.action} ${outstanding.id}`,
              );
            publishDiagnostic(
              "warning",
              `Correcting missing ${outstanding.action} ${outstanding.id} (attempt ${corrections})`,
            );
            messages.push(
              { role: "assistant", content: stepOutput },
              { role: "system", content: outstanding.correction },
            );
            continue;
          }
          if (protocolViolation) {
            setPhase("waiting");
            if (++corrections > MAX_PROTOCOL_CORRECTIONS)
              throw new Error(
                "model repeatedly emitted malformed textual chat tool calls",
              );
            publishDiagnostic(
              "warning",
              `Correcting textual chat tool call; native tool calling required (attempt ${corrections})`,
            );
            messages.push(
              { role: "assistant", content: protocolViolation },
              {
                role: "system",
                content: nativeToolCallCorrection(corrections),
              },
            );
            continue;
          }
          // A user message can arrive after this step drained the queue but
          // before its stream completed. Preserve this reply in context and run
          // one more Nia-only provider step rather than stranding the message.
          if (input.exec.niaPendingQueue.length) {
            step += 1;
            messages.push({ role: "assistant", content: stepOutput });
            continue;
          }
          if (finalOnly && calls.length)
            publishDiagnostic(
              "warning",
              "Provider emitted a chat tool call after tools were disabled; ignored the call and finalized with text",
            );
          finalResponse = stepOutput;
          break;
        }
        step += 1;
        messages.push({
          role: "assistant",
          content: stepOutput,
          ...(stepThinking ? { reasoningContent: stepThinking } : {}),
          ...(stepThinkingField ? { reasoningField: stepThinkingField } : {}),
          ...(stepThinkingSignature
            ? { reasoningSignature: stepThinkingSignature }
            : {}),
          ...(stepThinkingRedacted ? { reasoningRedacted: true } : {}),
          toolCalls: calls,
        });
        for (const call of calls) {
          const tool = visibleTools.find(
            (candidate) => candidate.name === call.name,
          );
          if (!tool) {
            messages.push({
              role: "tool",
              toolCallID: call.id,
              toolName: call.name,
              content: `ERROR: Nia chat does not expose tool "${call.name}"`,
            });
            continue;
          }
          let parsed: unknown;
          try {
            parsed = parseToolArguments(call.arguments);
          } catch (error) {
            messages.push({
              role: "tool",
              toolCallID: call.id,
              toolName: call.name,
              content: `ERROR: ${String(error)}`,
            });
            continue;
          }
          const validation = validateToolParameters(tool.parameters, parsed);
          if (validation.length) {
            messages.push({
              role: "tool",
              toolCallID: call.id,
              toolName: call.name,
              content: `ERROR: parameter validation failed for ${call.name}`,
            });
            continue;
          }
          if (
            tool.name === "collab_chat" &&
            auditIntent &&
            activePlan &&
            !auditReported
          ) {
            messages.push({
              role: "tool",
              toolCallID: call.id,
              toolName: call.name,
              content: `AUDIT_ORDER: call audit_report with planID ${activePlan.planID} and verdict passed or gaps before sending collab_chat to Natalia.`,
            });
            continue;
          }
          setPhase("using_tool", tool.name);
          let result: string;
          try {
            result = await tool.execute(parsed, {
              workspaceRoot: getWorkspaceRoot(),
              signal,
              sessionID: input.exec.session.id,
            });
          } catch (error) {
            result = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
          }
          publish({
            type: "nia.chat.tool.used",
            id: `${input.responseMessageID}:tool:${nextChatSequence()}`,
            messageID: input.responseMessageID,
            toolName: tool.name,
            status: result.startsWith("ERROR:") ? "failed" : "succeeded",
            summary: chatToolSummary(
              tool.name,
              parsed as Record<string, unknown>,
              result,
            ),
            result,
            argumentsRaw: call.arguments,
            // The tool's own card and facts (R4): computed here because a
            // Chat turn executes its tools directly, and a chat row that
            // carries no card renders as a plain sentence.
            ...chatToolCard(
              tool.output,
              parsed as Record<string, unknown>,
              result,
            ),
            // Pairs this result with the assistant toolCalls entry when the
            // history is rebuilt for the next turn (issue: P30).
            ...(call.id ? { toolCallID: call.id } : {}),
            at: new Date().toISOString(),
          });
          setPhase("waiting");
          messages.push({
            role: "tool",
            content: result,
            toolCallID: call.id,
            toolName: call.name,
          });
        }
      }
      signal.throwIfAborted();
      const unresolvedReply = requiredNataliaReply();
      if (unresolvedReply)
        throw new Error(
          `Nia reached its step limit without ${unresolvedReply.action} ${unresolvedReply.id}`,
        );
      if (
        (usedTools || ranFinalOnlyStep || input.internal) &&
        !finalResponse.trim()
      ) {
        output += MISSING_FINAL_RESPONSE_FALLBACK;
        setPhase("generating");
        publish({
          type: "nia.chat.message.delta",
          id: `${input.responseMessageID}:delta:${nextChatSequence()}`,
          messageID: input.responseMessageID,
          text: MISSING_FINAL_RESPONSE_FALLBACK,
        });
        publishDiagnostic(
          "warning",
          "Provider omitted the required internal chat response; emitted a deterministic fallback",
        );
      }
      settleThinking();
      const finalText = redactToolOutput(output.trim() || "(no reply)", true);
      logOf(ctx.state.serviceDirectory).info("nia-chat-turn", "final", {
        sessionID: input.exec.session.id,
        responseMessageID: input.responseMessageID,
        internal: input.internal === true,
        finishReason,
        finalText: finalText.slice(0, 240),
      });
      publish({
        type: "nia.chat.message.new",
        id: `${input.responseMessageID}:chat`,
        messageID: input.responseMessageID,
        role: "chat",
        text: finalText,
        at: new Date().toISOString(),
      });
      // EI §3.9 兜底降级: an audit turn that ends without audit_report leaves the
      // plan stuck in "auditing" forever. Mark it audit_pending so it is visibly
      // recoverable (re-wake / restart) instead of deadlocked.
      if (auditIntent && activePlan && !auditReported) {
        try {
          await ctx.ports.planDocRuntime.planDocUpdateStatus({
            planID: activePlan.planID,
            status: "audit_pending",
            sessionID: input.exec.session.id,
          });
        } catch {
          // A failed status update must not fail the whole Nia turn.
        }
      }
      return { text: output };
    } finally {
      settleThinking();
    }
  }

  function niaProvider(input: {
    exec: SessionExecutionState;
    model?: { modelID?: string; variant?: string };
    reasoningEffort?: import("@anthelia/contracts").RuntimeReasoningEffort;
  }): StreamingProvider | undefined {
    const profile = input.exec.niaChatModelProfile?.normal;
    const model = input.model?.modelID
      ? input.model
      : profile?.modelID
        ? profile
        : undefined;
    const config = ctx.ports.getTsRuntimeConfig();
    return (
      (config && model?.modelID
        ? providerForModel(config, model.modelID, model.variant, {
            reasoningEffort: input.reasoningEffort ?? profile?.reasoningEffort,
          })
        : undefined) ??
      ctx.ports.getChatDefaultProvider() ??
      (config?.defaultModel
        ? providerForModel(config, config.defaultModel, undefined, {
            reasoningEffort: input.reasoningEffort ?? profile?.reasoningEffort,
          })
        : undefined) ??
      ctx.ports.providerFromEnvironment?.()
    );
  }
}
