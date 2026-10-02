import type { ContextEntry, ProviderUsageView } from "@anthelia/runtime";
import type {
  InitializeOptions,
  ProviderToolCall,
  RuntimeContext,
  RuntimeEvent,
  RuntimeTool,
  SessionID,
  StreamingProvider,
  SubagentRunnerContext,
  SubagentSupport,
  SubagentsService,
} from "@anthelia/substrate";
import {
  TokenMeter,
  contextEntriesToProviderMessages,
  requestHeaderKey,
  type ContextBudget,
} from "@anthelia/runtime";
import { createInitializeRuntime } from "./runtime";
import { retryService } from "@anthelia/retry";
import { contextLedgerFactory } from "@natalia/context-ledger";
import { compactionService } from "@anthelia/compaction";
import { subagentsService } from "@anthelia/runtime-services";
import type { CompactionService, RetryService } from "@anthelia/runtime";
import type {
  ContextLedgerFactory,
  RuntimeContextLedger,
} from "@natalia/context-ledger";

export async function createSubagentSupport(
  ctx: RuntimeContext,
  _options: InitializeOptions,
): Promise<SubagentSupport> {
  const scope = createInitializeRuntime(ctx);
  const subagents = scope.serviceDirectory.getOptional(subagentsService);
  const ledgerFactory = scope.serviceDirectory.get(contextLedgerFactory);
  const resolvedContextLedgerFactory = ledgerFactory;
  const resolvedCompactionService =
    scope.serviceDirectory.get(compactionService);
  const resolvedRetryService = scope.serviceDirectory.get(retryService);
  let sandboxedSubagentActive = 0;
  const sandboxedSubagentWaiters: Array<{
    resume: () => void;
    signal: AbortSignal;
    abort: () => void;
  }> = [];
  async function acquireSandboxedSubagentSlot(signal: AbortSignal) {
    const limit = scope.tsRuntimeConfig?.team?.maxConcurrent ?? 4;
    if (signal.aborted)
      throw new DOMException("subagent cancelled", "AbortError");
    if (sandboxedSubagentActive >= limit) {
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          signal,
          resume: () => {
            signal.removeEventListener("abort", waiter.abort);
            // Transfer the released slot before waking the waiter so a new
            // spawn cannot steal it between promise resolution and resume.
            sandboxedSubagentActive++;
            resolve();
          },
          abort: () => {
            const index = sandboxedSubagentWaiters.indexOf(waiter);
            if (index >= 0) sandboxedSubagentWaiters.splice(index, 1);
            reject(new DOMException("subagent cancelled", "AbortError"));
          },
        };
        sandboxedSubagentWaiters.push(waiter);
        signal.addEventListener("abort", waiter.abort, { once: true });
        // Cover cancellation between the pre-wait check and listener setup.
        if (signal.aborted) waiter.abort();
      });
      return;
    }
    sandboxedSubagentActive++;
  }
  function releaseSandboxedSubagentSlot() {
    sandboxedSubagentActive--;
    while (sandboxedSubagentWaiters.length) {
      const waiter = sandboxedSubagentWaiters.shift()!;
      if (waiter.signal.aborted) continue;
      waiter.resume();
      break;
    }
  }
  function publishSubagentEvent(
    runner: SubagentRunnerContext,
    event: RuntimeEvent,
  ) {
    const parentSessionID = subagents?.get(runner.agentId)?.parentSessionID as
      | SessionID
      | undefined;
    scope.publishForSession(
      parentSessionID
        ? scope.executionBySession.get(parentSessionID)
        : scope.activeExec,
      parentSessionID && event.sessionID === undefined
        ? { ...event, sessionID: parentSessionID, agentID: runner.agentId }
        : { ...event, agentID: runner.agentId },
    );
  }
  function subagentTurnID(runner: SubagentRunnerContext) {
    const continuation = subagents?.get(runner.agentId)?.continuation ?? 0;
    return continuation
      ? `subagent:${runner.agentId}:continuation:${continuation}`
      : `subagent:${runner.agentId}`;
  }
  function beginSubagentConversation(
    runner: SubagentRunnerContext,
    task: string,
  ) {
    const id = subagentTurnID(runner);
    const parentSessionID = subagents?.get(runner.agentId)?.parentSessionID as
      | SessionID
      | undefined;
    if (parentSessionID) scope.turnSession.set(id, parentSessionID);
    scope.turnAgent.set(id, runner.agentId);
    publishSubagentEvent(runner, {
      type: "turn.submitted",
      id,
      text: task,
      byteLength: new TextEncoder().encode(task).byteLength,
      lineCount: scope.lineCount(task),
      sha256: scope.createHash("sha256").update(task).digest("hex"),
    });
    publishSubagentEvent(runner, { type: "turn.started", id });
  }
  function finishSubagentConversation(
    runner: SubagentRunnerContext,
    stopReason: "done" | "cancelled" | "error",
  ) {
    const id = subagentTurnID(runner);
    publishSubagentEvent(runner, {
      type: "turn.finished",
      id,
      stopReason,
    });
    scope.turnSession.delete(id);
    scope.turnAgent.delete(id);
  }
  function createSubagentContext(
    system: string,
    task: string,
    planPointer?: { planID: string; documentPath: string; version: number },
    forkSeed?: { entries: readonly ContextEntry[] },
  ) {
    const ledger = resolvedContextLedgerFactory.create();
    ledger.add({ id: "system", role: "system", content: system });
    // A forked child inherits the completed turns of its parent's conversation
    // before its own task, so it can continue work in progress rather than
    // re-deriving it from a one-line description.
    for (const entry of forkSeed?.entries ?? []) ledger.add(entry);
    ledger.add({ id: "task", role: "user", content: task });
    // ADR D4/B2: the plan正文 is never injected — the subagent reads the plan
    // file itself with read_file. Only the low-churn pointer (planID + path +
    // version) travels as a `<runtime_context source="plan_ptr">` user
    // message, so the subagent can find and read the current plan.
    if (planPointer)
      ledger.add({
        id: "plan_ptr",
        role: "dynamic",
        content: `<runtime_context source="plan_ptr" trust="runtime" revision="1">\nThe session has an active plan you must follow:\nplanID: ${planPointer.planID} · version: ${planPointer.version}\npath: ${planPointer.documentPath}\nRead the plan file with read_file before acting on it. If the path is missing or the read fails, say so instead of guessing the plan.\n</runtime_context>`,
      });
    return ledger;
  }
  /**
   * The live ledger of every subagent currently inside a run.
   *
   * Steering a running child means appending to this, because the child's
   * provider messages are rebuilt from the ledger on every step — so a message
   * added here is in front of the child at its nearest step, and nowhere else
   * can put it there. The map is dropped when the run ends, which is why a
   * message that arrives with no entry is queued on the record instead.
   */
  const liveSubagentLedgers = new Map<string, RuntimeContextLedger>();
  /** First call registers the ledger; later calls return it for steering. */
  function registerSubagentLedger(
    agentId: string,
    ledger: RuntimeContextLedger,
  ) {
    if (!liveSubagentLedgers.has(agentId))
      liveSubagentLedgers.set(agentId, ledger);
    return liveSubagentLedgers.get(agentId)!;
  }
  function unregisterSubagentLedger(agentId: string) {
    liveSubagentLedgers.delete(agentId);
  }
  /** Queue a message for a subagent that has no live runner. */
  function queueSubagentMessage(agentId: string, message: string) {
    const record = subagents?.get(agentId);
    if (!record) return false;
    const pending = [...(record.pendingMessages ?? []), message];
    // The record is persisted by the store, so the message survives the child's
    // next continuation rather than living only in this process.
    return subagents?.setPendingMessages?.(agentId, pending) ?? false;
  }
  const tokenMeters = new WeakMap<RuntimeContextLedger, TokenMeter>();
  function tokenMeterFor(ledger: RuntimeContextLedger): TokenMeter {
    let meter = tokenMeters.get(ledger);
    if (meter === undefined) {
      meter = new TokenMeter();
      tokenMeters.set(ledger, meter);
    }
    return meter;
  }
  function subagentProviderMessages(ledger: RuntimeContextLedger) {
    return scope.contextEntriesToProviderMessages(ledger.snapshot().entries);
  }
  function subagentToolSchemas(tools: RuntimeTool[]) {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
  function publishSubagentTokenSnapshot(
    ledger: RuntimeContextLedger,
    runner: SubagentRunnerContext,
  ) {
    const meter = tokenMeterFor(ledger);
    const projection = meter.project(`subagent:${runner.agentId}`);
    publishSubagentEvent(runner, {
      type: "context.snapshot",
      usedTokens:
        projection.projectedTokens ??
        projection.pressureTokens ??
        ledger.effectiveTokens(),
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
  }
  function measureSubagentRequest(
    ledger: RuntimeContextLedger,
    runner: SubagentRunnerContext,
    tools: RuntimeTool[],
    contextConfig: ContextBudget,
  ): number {
    const meter = tokenMeterFor(ledger);
    const measured = meter.measureRequest(`subagent:${runner.agentId}`, {
      tools: subagentToolSchemas(tools),
      messages: subagentProviderMessages(ledger),
      contextWindow: contextConfig.max,
    });
    publishSubagentTokenSnapshot(ledger, runner);
    return Math.max(ledger.effectiveTokens(), measured.totalTokens);
  }
  async function runSubagentProviderStep(
    ledger: RuntimeContextLedger,
    visibleTools: RuntimeTool[],
    runner: SubagentRunnerContext,
    step: number,
    activeProvider: StreamingProvider,
    activeContextConfig: ContextBudget,
    allowToolCalls = true,
  ) {
    const id = subagentTurnID(runner);
    const runStep = () =>
      resolvedRetryService.run(
        { id, operation: "llm_step", step },
        async ({ attempt }) => {
          let output = "";
          let thinking = "";
          const calls: ProviderToolCall[] = [];
          let protocolViolation = "";
          let providerUsage:
            | Pick<
                ProviderUsageView,
                | "inputTokens"
                | "outputTokens"
                | "cacheCreationInputTokens"
                | "cacheReadInputTokens"
              >
            | undefined;
          const providerMessages = subagentProviderMessages(ledger);
          const toolSchemas = subagentToolSchemas(visibleTools);
          const stream = scope.withProviderConcurrency(
            scope.providerConcurrencyLimiter,
            activeProvider.provider,
            () =>
              activeProvider.stream({
                messages: providerMessages,
                tools: allowToolCalls ? toolSchemas : undefined,
                toolChoice: allowToolCalls ? undefined : "none",
                signal: runner.signal,
              }),
            runner.signal,
          );
          const normalized = allowToolCalls
            ? scope.requireNativeToolCallProtocol(
                scope.normalizeRawToolCallProtocol(stream),
              )
            : stream;
          for await (const chunk of normalized) {
            if (chunk.type === "thinking") {
              thinking += chunk.text;
              publishSubagentEvent(runner, {
                type: "thinking.delta",
                id,
                text: chunk.text,
                attempt,
              });
            }
            if (chunk.type === "content") {
              output += chunk.text;
              publishSubagentEvent(runner, {
                type: "content.delta",
                id,
                text: chunk.text,
                attempt,
              });
            }
            if (chunk.type === "tool_call") calls.push(...chunk.calls);
            if (chunk.type === "tool_protocol_violation")
              protocolViolation = chunk.text;
            if (chunk.type === "usage")
              providerUsage = {
                inputTokens: chunk.inputTokens,
                outputTokens: chunk.outputTokens,
                // Cache metrics are what say whether a subagent's prefix is being
                // reused. Dropping them here left the subagent pane reporting
                // full-price input on every step however warm its cache was, so
                // nothing could tell a subagent from a bad one.
                ...(chunk.cacheCreationInputTokens === undefined
                  ? {}
                  : {
                      cacheCreationInputTokens: chunk.cacheCreationInputTokens,
                    }),
                ...(chunk.cacheReadInputTokens === undefined
                  ? {}
                  : { cacheReadInputTokens: chunk.cacheReadInputTokens }),
              };
          }
          if (providerUsage) {
            const meter = tokenMeterFor(ledger);
            const scopeKey = `subagent:${runner.agentId}`;
            const system =
              providerMessages[0]?.role === "system"
                ? providerMessages[0].content
                : undefined;
            meter.setContextWindow(scopeKey, activeContextConfig.max);
            meter.recordUsage(scopeKey, providerUsage, {
              headerKey: requestHeaderKey({ system, tools: toolSchemas }),
              surfaceTokens: meter.observeSurface(scopeKey, providerMessages),
            });
            publishSubagentTokenSnapshot(ledger, runner);
            // Mirror the main runner's per-step usage event so the subagent
            // pane can show the same token/latency bar as Natalia/Navi/Nia.
            publishSubagentEvent(runner, {
              type: "runtime.step_usage",
              id: `${id}:usage:${attempt}`,
              inputTokens: providerUsage.inputTokens,
              outputTokens: providerUsage.outputTokens,
              // Forwarded rather than dropped: the event already carries them and
              // the store already folds them, so this was the one link missing
              // between a subagent's cache behaviour and its reported cost.
              ...(providerUsage.cacheCreationInputTokens === undefined
                ? {}
                : {
                    cacheCreationInputTokens:
                      providerUsage.cacheCreationInputTokens,
                  }),
              ...(providerUsage.cacheReadInputTokens === undefined
                ? {}
                : {
                    cacheReadInputTokens: providerUsage.cacheReadInputTokens,
                  }),
            });
          }
          return { output, thinking, calls, protocolViolation };
        },
        {
          signal: runner.signal,
          onEvent: (event) => {
            publishSubagentEvent(runner, event);
            if (event.type === "step.retry")
              runner.log(
                `provider retry ${event.attempt}/${event.maxAttempts ?? "unlimited"} after ${event.reason} (${event.waitMs}ms)`,
              );
          },
        },
      );
    let correction = 0;
    let result;
    while (true) {
      runner.signal.throwIfAborted();
      const meter = tokenMeterFor(ledger);
      const scopeKey = `subagent:${runner.agentId}`;
      const providerMessages = subagentProviderMessages(ledger);
      const toolSchemas = subagentToolSchemas(visibleTools);
      await resolvedCompactionService.prepareContextRequest({
        id,
        ledger,
        meter,
        scope: scopeKey,
        system:
          providerMessages[0]?.role === "system"
            ? providerMessages[0].content
            : undefined,
        tools: toolSchemas,
        contextWindow: activeContextConfig.max,
        // The exec budget carries the preserved tail and prune options; the
        // subagent no longer reads raw config for its own copy (plan §2.3).
        budget: activeContextConfig,
        // Prune once per subagent turn, on its first provider request. A
        // per-request prune would rewrite the ledger between requests and
        // invalidate the prefix cache each of them just wrote.
        prune: step === 1,
        outbound: providerMessages,
        rebuildOutbound: (
          entries: Parameters<typeof contextEntriesToProviderMessages>[0],
        ) => contextEntriesToProviderMessages(entries),
        // Subagents share the model-free prune path with the main runner; the
        // prune options and preserved tail come from the exec budget.
        provider: activeProvider,
        instruction:
          "Compact before this subagent provider request while preserving the active task.",
        compactionEnabled:
          scope.tsRuntimeConfig?.context.compactionEnabled ?? true,
        signal: runner.signal,
        publish: (event: RuntimeEvent) => publishSubagentEvent(runner, event),
        emitStatus: () => {},
        emitSnapshot: () => publishSubagentTokenSnapshot(ledger, runner),
      });
      // Drop the pre-compaction provider anchor before re-measuring.
      meter.clear(scopeKey);
      // Publish the compacted projection before the provider request starts.
      measureSubagentRequest(ledger, runner, visibleTools, activeContextConfig);
      result = await resolvedCompactionService.runWithContextLimitRecovery({
        id,
        step,
        compactionID: `${id}:context-limit:${step}`,
        ledger,
        provider: activeProvider,
        budget: activeContextConfig,
        preservedRecentMessages: activeContextConfig.preservedRecentMessages,
        preservedRecentTokens: activeContextConfig.preservedRecentTokens,
        maxOverflowRetries: activeContextConfig.maxOverflowRetries,
        instruction: "Recover this subagent from the provider context limit.",
        signal: runner.signal,
        runStep,
        onEvent: (event: RuntimeEvent) => {
          publishSubagentEvent(runner, event);
          if (event.type === "compaction.end" && event.success) {
            // Context-limit recovery rewrites the ledger in place; drop the
            // pre-compaction anchor and publish the post-compaction meter before
            // the retried provider request.
            tokenMeterFor(ledger).clear(`subagent:${runner.agentId}`);
            measureSubagentRequest(
              ledger,
              runner,
              visibleTools,
              activeContextConfig,
            );
          }
        },
      });
      if (!result.protocolViolation) break;
      correction += 1;
      if (correction > scope.MAX_PROTOCOL_CORRECTIONS)
        throw new Error(
          "model repeatedly emitted malformed textual tool calls instead of the provider's native tool protocol",
        );
      ledger.add({
        id: `${runner.agentId}:${step}:protocol:${correction}:assistant`,
        role: "assistant",
        content: result.protocolViolation,
      });
      ledger.add({
        id: `${runner.agentId}:${step}:protocol:${correction}:system`,
        role: "system",
        content: scope.nativeToolCallCorrection(correction),
      });
      runner.log(
        `correcting textual tool call; native tool calling required (attempt ${correction})`,
      );
    }
    if (result.thinking)
      publishSubagentEvent(runner, {
        type: "thinking.done",
        id,
        text: result.thinking,
      });
    if (result.output)
      publishSubagentEvent(runner, {
        type: "content.done",
        id,
        text: result.output,
      });
    return result;
  }

  function appendSubagentAssistant(
    ledger: RuntimeContextLedger,
    runner: SubagentRunnerContext,
    step: number,
    output: string,
    calls: ProviderToolCall[],
  ) {
    if (output)
      ledger.add({
        id: `${runner.agentId}:${step}:assistant`,
        role: "assistant",
        content: output,
      });
    for (const call of calls)
      ledger.add({
        id: `${runner.agentId}:${step}:${call.id}:call`,
        role: "tool_call",
        content: `${call.name} ${call.arguments}`,
        pairID: call.id,
      });
  }
  function appendSubagentToolResult(
    ledger: RuntimeContextLedger,
    runner: SubagentRunnerContext,
    step: number,
    call: ProviderToolCall,
    content: string,
  ) {
    ledger.add({
      id: `${runner.agentId}:${step}:${call.id}:result`,
      role: "tool_result",
      content,
      pairID: call.id,
    });
  }
  return {
    acquireSandboxedSubagentSlot,
    releaseSandboxedSubagentSlot,
    publishSubagentEvent,
    subagentTurnID,
    beginSubagentConversation,
    finishSubagentConversation,
    createSubagentContext,
    registerSubagentLedger,
    unregisterSubagentLedger,
    queueSubagentMessage,
    liveSubagentLedgerCount: () => liveSubagentLedgers.size,
    runSubagentProviderStep,
    appendSubagentAssistant,
    appendSubagentToolResult,
  };
}
