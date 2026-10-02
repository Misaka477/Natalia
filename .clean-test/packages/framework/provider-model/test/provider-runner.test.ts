import { expect, test } from "bun:test";
import { staticSystemPrompt } from "@natalia/agent-prompts";
import {
  AnthropicProvider,
  ContextLedger,
  DEFAULT_TOOL_RESULT_PRUNE_OPTIONS,
  TokenMeter,
  estimateTokens,
  providerError,
} from "@anthelia/runtime";
import type {
  ContextBudget,
  ProviderStreamChunk,
  ProviderStreamRequest,
  ProviderToolCall,
  StreamingProvider,
} from "@anthelia/runtime";
import type { RuntimeEvent } from "@anthelia/contracts";
import type { ProjectDocumentSnapshot } from "@anthelia/runtime-services";
import { ToolRegistry } from "@anthelia/tools";
import {
  createProviderRunner,
  estimateProviderMessages,
} from "../src/provider-runner";
import { createRetryService } from "@anthelia/retry";
import { createAttachmentService } from "@anthelia/attachments";
import { createCompactionService } from "@anthelia/compaction";

function content(text: string): ProviderStreamChunk {
  return { type: "content", text };
}

/**
 * Completes a partial test budget with the ContextBudget policy defaults, so
 * fixtures only spell out the fields a test actually varies (plan §2.3).
 */
function withBudgetDefaults(
  budget: Pick<ContextBudget, "max" | "thresholdPercent" | "reserved"> &
    Partial<ContextBudget>,
): ContextBudget {
  return {
    reservedSource: "config",
    preservedRecentMessages: 10,
    preservedRecentTokens: 0,
    maxOverflowRetries: 1,
    prune: DEFAULT_TOOL_RESULT_PRUNE_OPTIONS,
    ...budget,
  };
}

function thinking(text: string): ProviderStreamChunk {
  return { type: "thinking", text };
}

function toolCall(calls: ProviderToolCall[]): ProviderStreamChunk {
  return { type: "tool_call", calls };
}

function usage(inputTokens: number, outputTokens: number): ProviderStreamChunk {
  return { type: "usage", inputTokens, outputTokens };
}

function makeHarness(
  provider: StreamingProvider | undefined,
  options?: {
    takeLiveUserMessages?: () => Array<{
      source: "user" | "navi";
      text: string;
    }>;
    takeStepInputs?: (step: number) => Array<{ id: string; text: string }>;
    hasPendingStepInputs?: () => boolean;
    isTurnAnnounced?: (id: string) => boolean;
    markTurnAnnounced?: (id: string) => void;
    naviSuggestions?: Array<{
      id: string;
      suggestion: string;
      priority: string;
      rationale?: string;
    }>;
    naviIntro?: boolean;
    naviAnswers?: Array<{ questionID: string; answer: string }>;
    naviChats?: Array<{
      id: string;
      threadID: string;
      from: "live_chat" | "main_agent";
      to: "live_chat" | "main_agent";
      text: string;
      round: number;
      expectsReply: boolean;
      status: string;
    }>;
    activePlan?: {
      planID: string;
      version: number;
      title: string;
      objective: string;
      steps: Array<{
        id: string;
        title: string;
        detail?: string;
        verification?: string;
      }>;
      constraints: string[];
      verification: string[];
      riskNotes: string[];
    };
    projectDocuments?: ProjectDocumentSnapshot;
    confinementMode?: import("@anthelia/contracts").ConfinementMode;
    log?: {
      info(
        component: string,
        message: string,
        fields?: Record<string, unknown>,
      ): void;
      error(
        component: string,
        message: string,
        fields?: Record<string, unknown>,
      ): void;
      debug(
        component: string,
        message: string,
        fields?: Record<string, unknown>,
      ): void;
    };
    retryPolicy?: {
      maxAttemptsPerStep: number | null;
      initialBackoffMs: number;
      maxBackoffMs: number;
      jitterMs: number;
      maxRetryAfterMs: number;
    };
    maxSteps?: number;
    workspaceRoot?: string;
    permissionMode?: "ask" | "auto" | "read_only";
    tools?: ToolRegistry;
    runtimeContextConfig?: {
      max: number;
      thresholdPercent: number;
      reserved: number;
      reservedSource?: import("@anthelia/runtime").ContextBudget["reservedSource"];
      preservedRecentMessages?: number;
      preservedRecentTokens?: number;
      maxOverflowRetries?: number;
      prune?: import("@anthelia/runtime").ToolResultPruneOptions;
    };
    preservedRecentMessages?: number;
    tokenMeter?: TokenMeter;
  },
) {
  const events: RuntimeEvent[] = [];
  const ledger = new ContextLedger();
  const checkpoints: Array<{ reason: string; step: number }> = [];
  const executedCalls: Array<{ call: ProviderToolCall }> = [];
  let activeAbort: AbortController | undefined;
  let activeTurnID: string | undefined;
  let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
  const retry = createRetryService({
    policy: () =>
      options?.retryPolicy ?? {
        maxAttemptsPerStep: 1,
        initialBackoffMs: 1,
        maxBackoffMs: 1,
        jitterMs: 0,
        maxRetryAfterMs: 1,
      },
  });
  const runner = createProviderRunner({
    staticSystemPrompt,
    provider: () => provider,
    session: () => undefined,
    context: () => ledger,
    tools: () => options?.tools ?? new ToolRegistry(),
    attachmentReferences: () => new Map(),
    attachments: createAttachmentService("/tmp/ws"),
    compaction: createCompactionService({ retry }),
    mcp: () => undefined,
    agentRegistry: () => undefined,
    activeAbort: () => activeAbort,
    setActiveAbort: (controller) => {
      activeAbort = controller;
    },
    activeTurnID: () => activeTurnID,
    setActiveTurnID: (id) => {
      activeTurnID = id;
    },
    selectedAgent: () => undefined,
    setSelectedAgent: () => undefined,
    pendingAgent: () => undefined,
    setPendingAgent: () => undefined,
    selectedModel: () => undefined,
    modelCapabilities: () => ({
      toolCall: true,
      reasoning: true,
      thinking: true,
      imageInput: false,
      videoInput: false,
    }),
    setActiveModelCapabilities: () => undefined,
    permissionMode: () => options?.permissionMode ?? "auto",
    workspaceRoot: () => options?.workspaceRoot ?? "/tmp/ws",
    tsRuntimeConfig: () =>
      options?.preservedRecentMessages === undefined
        ? undefined
        : ({
            version: 3,
            instructions: { enabled: true },
            defaultAgentMode: "",
            agentModes: {},
            context: {
              preservedRecentMessages: options.preservedRecentMessages,
            },
          } as unknown as import("@anthelia/contracts").ConfigV3),
    runtimeContextConfig: () => {
      // The budget is the canonical source (plan §2.3) and is derived from the
      // ts config, so the harness option that models
      // `tsRuntimeConfig().context.preservedRecentMessages` is applied last.
      const explicit = options?.runtimeContextConfig ?? {
        max: 200000,
        thresholdPercent: 85,
        reserved: 8192,
      };
      const budget = withBudgetDefaults(explicit);
      const preservedRecentMessages = options?.preservedRecentMessages;
      return preservedRecentMessages === undefined
        ? budget
        : { ...budget, preservedRecentMessages };
    },
    activeSkill: () => undefined,
    skillsList: () => [],
    takeLiveUserMessages: () => options?.takeLiveUserMessages?.() ?? [],
    takeStepInputs: (step) => options?.takeStepInputs?.(step) ?? [],
    hasPendingStepInputs: () => options?.hasPendingStepInputs?.() ?? false,
    isTurnAnnounced: (id) => options?.isTurnAnnounced?.(id) ?? false,
    markTurnAnnounced: (id) => options?.markTurnAnnounced?.(id),
    naviSuggestions: () => options?.naviSuggestions ?? [],
    naviIntro: () => options?.naviIntro ?? false,
    naviAnswers: () => options?.naviAnswers ?? [],
    naviChats: () => options?.naviChats ?? [],
    activePlan: () => options?.activePlan,
    projectDocuments: () => options?.projectDocuments,
    confinementMode: () => options?.confinementMode ?? "workspace-write",
    log: options?.log,
    ...(options?.tokenMeter ? { tokenMeter: () => options.tokenMeter! } : {}),
    retry,
    lastProviderUsage: () => lastUsage,
    setLastProviderUsage: (usage) => {
      lastUsage = usage;
    },
    publish: (event) => events.push(event),
    applyAgentPolicy: () => undefined,
    applyAgentProvider: () => undefined,
    persistInboxPromotion: async () => undefined,
    createTurnCheckpoint: async (input) => {
      checkpoints.push({ reason: input.reason, step: input.step });
    },
    isToolAllowed: () => true,
    setInFlightOperation: async () => undefined,
    executeToolCalls: async (
      turnID,
      calls,
      assistant,
      _materialized,
      reasoning,
    ) => {
      for (const call of calls) executedCalls.push({ call });
      return [
        {
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
          ...(reasoning?.parts?.length
            ? { contentParts: reasoning.parts }
            : {}),
          ...(reasoning?.providerMetadata
            ? { providerMetadata: reasoning.providerMetadata }
            : {}),
          ...(reasoning?.textSignature
            ? { textSignature: reasoning.textSignature }
            : {}),
          toolCalls: calls,
        },
        {
          role: "tool",
          toolCallID: calls[0]?.id ?? "call_1",
          toolName: calls[0]?.name ?? "read_file",
          content: "ok",
        },
      ];
    },
    reloadConfig: async () => ({ providerReconfigured: false }),
    runtimeStatusSnapshot: async () =>
      ({
        type: "diagnostic",
        level: "info",
        message: "snapshot",
      }) as RuntimeEvent,
    effectiveMaxSteps: () => options?.maxSteps ?? 10,
    waitIfPaused: async () => undefined,
    waitingHuman: () => undefined,
  });
  return {
    runner,
    events,
    ledger,
    checkpoints,
    executedCalls,
    abortController: () => activeAbort,
    activeTurnID: () => activeTurnID,
  };
}

const turn = {
  id: "t1",
  text: "hello",
  attachments: [],
  resources: [],
  agents: [],
};

test("Natalia main transcript receives Anthropic thinking without chat events", async () => {
  const provider = new AnthropicProvider({
    apiKey: "test-only",
    model: "step-3.7-flash",
    maxTokens: 4096,
    fetch: (async () =>
      new Response(
        [
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "main " },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "reasoning" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "main answer" },
          },
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      )) as unknown as typeof fetch,
  });
  const { runner, events } = makeHarness(provider);
  await runner.runTurn(turn);
  expect(
    events
      .filter((event) => event.type === "thinking.delta")
      .map((event) => event.text)
      .join(""),
  ).toBe("main reasoning");
  expect(events.find((event) => event.type === "content.done")?.text).toBe(
    "main answer",
  );
  expect(
    events.some(
      (event) =>
        event.type.startsWith("navi.chat.") ||
        event.type.startsWith("nia.chat."),
    ),
  ).toBe(false);
});

test("a turn streams content and usage, finishes done, and clears turn state", async () => {
  const { runner, events, ledger, checkpoints, abortController, activeTurnID } =
    makeHarness({
      provider: "scripted",
      model: "m1",
      async *stream() {
        yield thinking("reasoning…");
        yield content("hello ");
        yield content("world");
        yield usage(10, 5);
      },
    });
  await runner.runTurn(turn);
  const finished = events.find(
    (event): event is Extract<RuntimeEvent, { type: "turn.finished" }> =>
      event.type === "turn.finished",
  );
  expect(finished?.stopReason).toBe("done");
  expect(finished?.reason).toBeUndefined();
  expect(events.some((event) => event.type === "thinking.delta")).toBe(true);
  const done = events.find(
    (event): event is Extract<RuntimeEvent, { type: "content.done" }> =>
      event.type === "content.done",
  );
  expect(done?.text).toBe("hello world");
  expect(checkpoints).toEqual([{ reason: "turn_begin", step: 1 }]);
  const roles = ledger.snapshot().entries.map((entry) => entry.role);
  expect(roles).toContain("user");
  expect(roles).toContain("assistant");
  expect(events.some((event) => event.type === "context.checkpoint")).toBe(
    true,
  );
  // The finally block must release the turn-shaped state.
  expect(abortController()).toBeUndefined();
  expect(activeTurnID()).toBeUndefined();
});

test("thinking.done is published before the first content delta", async () => {
  const { runner, events } = makeHarness({
    provider: "scripted",
    model: "m1",
    async *stream() {
      yield thinking("reasoning only");
      yield content("answer");
    },
  });
  await runner.runTurn(turn);
  const types = events.map((event) => event.type);
  const thinkingDoneIndex = types.indexOf("thinking.done");
  const contentDeltaIndex = types.indexOf("content.delta");
  expect(thinkingDoneIndex).toBeGreaterThanOrEqual(0);
  expect(contentDeltaIndex).toBeGreaterThanOrEqual(0);
  expect(thinkingDoneIndex).toBeLessThan(contentDeltaIndex);
  const thinkingDone = events.find(
    (event): event is Extract<RuntimeEvent, { type: "thinking.done" }> =>
      event.type === "thinking.done",
  );
  expect(thinkingDone?.text).toBe("reasoning only");
  expect(thinkingDone?.attempt).toBe(1);
  expect(events.filter((event) => event.type === "thinking.done")).toHaveLength(
    1,
  );
});

test("no provider and no reconfigured reload finishes with an error diagnostic", async () => {
  const { runner, events, checkpoints } = makeHarness(undefined);
  await runner.runTurn(turn);
  const finished = events.find(
    (event): event is Extract<RuntimeEvent, { type: "turn.finished" }> =>
      event.type === "turn.finished",
  );
  expect(finished?.stopReason).toBe("error");
  expect(
    events.some(
      (event) =>
        event.type === "diagnostic" &&
        event.level === "error" &&
        event.message.includes("No real provider configured"),
    ),
  ).toBe(true);
  expect(checkpoints).toEqual([]);
});

test("tool calls with an empty final answer emit a deterministic fallback", async () => {
  let streamCalls = 0;
  const { runner, events, executedCalls } = makeHarness({
    provider: "scripted",
    model: "m1",
    async *stream() {
      streamCalls += 1;
      if (streamCalls === 1) {
        yield toolCall([
          { id: "call_1", name: "read_file", arguments: '{"path":"a"}' },
        ]);
      }
    },
  });
  await runner.runTurn(turn);
  expect(streamCalls).toBe(2);
  expect(executedCalls.map((entry) => entry.call.name)).toEqual(["read_file"]);
  const finished = events.find(
    (event): event is Extract<RuntimeEvent, { type: "turn.finished" }> =>
      event.type === "turn.finished",
  );
  expect(finished?.stopReason).toBe("done");
  // The turn reports done, but the model never produced a closing answer: the
  // runtime substituted its fallback, and a consumer must be able to tell.
  expect(finished?.reason).toBe("missing_final_response");
  expect(
    events
      .filter(
        (event): event is Extract<RuntimeEvent, { type: "content.delta" }> =>
          event.type === "content.delta",
      )
      .map((event) => event.text)
      .join(""),
  ).toContain("Tool execution completed");
});

test("complete textual tool calls are normalized and executed once", async () => {
  let streamCalls = 0;
  const { runner, events, executedCalls } = makeHarness({
    provider: "scripted",
    model: "m1",
    async *stream() {
      streamCalls += 1;
      if (streamCalls === 1) {
        yield content(
          "Inspecting. <tool_call><function=read_file><parameter=path>&quot;a.txt&quot;</parameter></function></tool_call>",
        );
        return;
      }
      yield content("Finished.");
    },
  });
  await runner.runTurn(turn);
  expect(executedCalls).toEqual([
    {
      call: {
        id: "raw_xml_tool_0",
        name: "read_file",
        arguments: '{"path":"a.txt"}',
      },
    },
  ]);
  expect(
    events
      .filter(
        (event): event is Extract<RuntimeEvent, { type: "content.delta" }> =>
          event.type === "content.delta",
      )
      .map((event) => event.text),
  ).toEqual(["Inspecting. ", "Finished."]);
  expect(
    events.filter(
      (event) =>
        event.type === "diagnostic" &&
        event.message.includes("native tool calling required"),
    ),
  ).toHaveLength(0);
});

test("assistant reasoning_content is preserved for the tool-call follow-up", async () => {
  const requests: ProviderStreamRequest[] = [];
  let streamCalls = 0;
  const { runner } = makeHarness({
    provider: "scripted",
    model: "m1",
    async *stream(request) {
      streamCalls += 1;
      requests.push(request);
      if (streamCalls === 1) {
        yield thinking("deepseek reasoning");
        yield toolCall([
          {
            id: "call_1",
            name: "read_file",
            arguments: '{"path":"a.txt"}',
          },
        ]);
        return;
      }
      yield content("done");
    },
  });

  await runner.runTurn(turn);

  expect(requests).toHaveLength(2);
  const assistant = requests[1]?.messages.find(
    (message) => message.role === "assistant" && message.toolCalls?.length,
  );
  expect(assistant?.reasoningContent).toBe("deepseek reasoning");
});

test("signed thinking and tool-call thought signatures survive the tool-call follow-up", async () => {
  const requests: ProviderStreamRequest[] = [];
  let streamCalls = 0;
  const { runner } = makeHarness({
    provider: "scripted",
    model: "m1",
    async *stream(request) {
      streamCalls += 1;
      requests.push(request);
      if (streamCalls === 1) {
        yield { type: "thinking", text: "signed plan", signature: "sig-1" };
        yield toolCall([
          {
            id: "call_1",
            name: "read_file",
            arguments: '{"path":"a.txt"}',
            thoughtSignature: "tool-sig",
          },
        ]);
        return;
      }
      yield content("done");
    },
  });

  await runner.runTurn(turn);

  expect(requests).toHaveLength(2);
  const assistant = requests[1]?.messages.find(
    (message) => message.role === "assistant" && message.toolCalls?.length,
  );
  expect(assistant?.reasoningContent).toBe("signed plan");
  expect(assistant?.reasoningSignature).toBe("sig-1");
  expect(assistant?.toolCalls?.[0]?.thoughtSignature).toBe("tool-sig");
});

test("multiple signed thinking blocks survive the tool-call follow-up", async () => {
  const requests: ProviderStreamRequest[] = [];
  let streamCalls = 0;
  const { runner } = makeHarness({
    provider: "scripted",
    model: "m1",
    async *stream(request) {
      streamCalls += 1;
      requests.push(request);
      if (streamCalls === 1) {
        yield { type: "thinking", text: "plan A", blockIndex: 0 };
        yield {
          type: "thinking",
          text: "",
          signature: "sig-A",
          blockIndex: 0,
        };
        yield { type: "thinking", text: "plan B", blockIndex: 1 };
        yield {
          type: "thinking",
          text: "",
          signature: "sig-B",
          blockIndex: 1,
        };
        yield toolCall([
          {
            id: "call_1",
            name: "read_file",
            arguments: '{"path":"a.txt"}',
          },
        ]);
        return;
      }
      yield content("done");
    },
  });

  await runner.runTurn(turn);

  expect(requests).toHaveLength(2);
  const assistant = requests[1]?.messages.find(
    (message) => message.role === "assistant" && message.toolCalls?.length,
  );
  expect(assistant?.reasoningBlocks).toEqual([
    { text: "plan A", signature: "sig-A" },
    { text: "plan B", signature: "sig-B" },
  ]);
});

test("provider content parts survive the tool-call follow-up in order", async () => {
  const requests: ProviderStreamRequest[] = [];
  let streamCalls = 0;
  const { runner } = makeHarness({
    provider: "scripted",
    model: "m1",
    async *stream(request) {
      streamCalls += 1;
      requests.push(request);
      if (streamCalls === 1) {
        yield { type: "thinking", text: "plan", blockIndex: 0 };
        yield { type: "content", text: "visible " };
        yield { type: "content", text: "answer" };
        yield toolCall([
          {
            id: "call_1",
            name: "read_file",
            arguments: '{"path":"a.txt"}',
            thoughtSignature: "call-sig",
          },
        ]);
        return;
      }
      yield content("done");
    },
  });

  await runner.runTurn(turn);

  expect(requests).toHaveLength(2);
  const assistant = requests[1]?.messages.find(
    (message) => message.role === "assistant" && message.toolCalls?.length,
  );
  expect(assistant?.contentParts).toEqual([
    { type: "thinking", text: "plan" },
    { type: "text", text: "visible answer" },
    {
      type: "tool_call",
      id: "call_1",
      name: "read_file",
      arguments: '{"path":"a.txt"}',
      thoughtSignature: "call-sig",
    },
  ]);
});

test("provider metadata survives the tool-call follow-up", async () => {
  const requests: ProviderStreamRequest[] = [];
  let streamCalls = 0;
  const providerMetadata = {
    openrouter: {
      reasoning_details: [
        { type: "reasoning.text", text: "thinking", index: 0 },
      ],
    },
  };
  const { runner } = makeHarness({
    provider: "scripted",
    model: "m1",
    async *stream(request) {
      streamCalls += 1;
      requests.push(request);
      if (streamCalls === 1) {
        yield { type: "content" as const, text: "answer" };
        yield {
          type: "done" as const,
          finishReason: "tool_calls" as const,
          providerMetadata,
        };
        yield toolCall([
          {
            id: "call_1",
            name: "read_file",
            arguments: '{"path":"a.txt"}',
          },
        ]);
        return;
      }
      yield content("done");
    },
  });

  await runner.runTurn(turn);

  expect(requests).toHaveLength(2);
  const assistant = requests[1]?.messages.find(
    (message) => message.role === "assistant" && message.toolCalls?.length,
  );
  expect(assistant?.providerMetadata).toEqual(providerMetadata);
});

test("Gemini text part signatures survive the tool-call follow-up", async () => {
  const requests: ProviderStreamRequest[] = [];
  let streamCalls = 0;
  const { runner } = makeHarness({
    provider: "scripted",
    model: "m1",
    async *stream(request) {
      streamCalls += 1;
      requests.push(request);
      if (streamCalls === 1) {
        yield {
          type: "content" as const,
          text: "visible answer",
          textSignature: "text-sig",
        };
        yield toolCall([
          {
            id: "call_1",
            name: "read_file",
            arguments: '{"path":"a.txt"}',
          },
        ]);
        return;
      }
      yield content("done");
    },
  });

  await runner.runTurn(turn);

  expect(requests).toHaveLength(2);
  const assistant = requests[1]?.messages.find(
    (message) => message.role === "assistant" && message.toolCalls?.length,
  );
  expect(assistant?.content).toBe("visible answer");
  expect(assistant?.textSignature).toBe("text-sig");
});

test("the configured final step preserves XML-like text without another request", async () => {
  let streamCalls = 0;
  const requests: ProviderStreamRequest[] = [];
  const { runner, events, executedCalls } = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream(request) {
        streamCalls += 1;
        requests.push(request);
        if (streamCalls === 1) {
          yield toolCall([
            {
              id: "call_1",
              name: "read_file",
              arguments: '{"path":"a"}',
            },
          ]);
          return;
        }
        yield content(
          "<function=run_shell><parameter=command>git status</parameter></function>",
        );
      },
    },
    { maxSteps: 2 },
  );

  await runner.runTurn(turn);

  expect(executedCalls.map((entry) => entry.call.name)).toEqual(["read_file"]);
  expect(streamCalls).toBe(2);
  expect(requests[1]).toMatchObject({ tools: undefined, toolChoice: "none" });
  expect(
    events
      .filter(
        (event): event is Extract<RuntimeEvent, { type: "content.delta" }> =>
          event.type === "content.delta",
      )
      .map((event) => event.text),
  ).toEqual([
    "<function=run_shell><parameter=command>git status</parameter></function>",
  ]);
  expect(
    events.find(
      (event): event is Extract<RuntimeEvent, { type: "turn.finished" }> =>
        event.type === "turn.finished",
    )?.reason,
  ).toBeUndefined();
  expect(
    requests[1]?.messages.some((message) =>
      message.content.includes("MAXIMUM STEPS REACHED"),
    ),
  ).toBe(true);
});

test("structured calls on the configured final step are ignored with fallback text", async () => {
  const requests: ProviderStreamRequest[] = [];
  const { runner, events, executedCalls } = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream(request) {
        requests.push(request);
        yield toolCall([
          { id: "call_forbidden", name: "read_file", arguments: "{}" },
        ]);
      },
    },
    { maxSteps: 1 },
  );

  await runner.runTurn(turn);

  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ tools: undefined, toolChoice: "none" });
  expect(executedCalls).toEqual([]);
  expect(
    events.some(
      (event) =>
        event.type === "content.delta" &&
        event.text.includes("Tool execution completed"),
    ),
  ).toBe(true);
});

test("malformed textual tool calls fail after bounded corrections", async () => {
  let streamCalls = 0;
  const { runner, events, executedCalls } = makeHarness({
    provider: "scripted",
    model: "m1",
    async *stream() {
      streamCalls += 1;
      yield content(
        "<tool_call><function=read_file><parameter=path>a.txt</function></tool_call>",
      );
    },
  });

  await runner.runTurn(turn);

  expect(streamCalls).toBe(3);
  expect(executedCalls).toEqual([]);
  expect(
    events.find(
      (event): event is Extract<RuntimeEvent, { type: "turn.finished" }> =>
        event.type === "turn.finished",
    )?.stopReason,
  ).toBe("error");
});

test("a hard provider finish reason fails instead of completing ready", async () => {
  const { runner, events } = makeHarness({
    provider: "scripted",
    model: "m1",
    async *stream() {
      yield content("partial response");
      yield { type: "done", finishReason: "length" };
    },
  });

  await runner.runTurn(turn);
  const finished = events.find(
    (event): event is Extract<RuntimeEvent, { type: "turn.finished" }> =>
      event.type === "turn.finished",
  );
  expect(finished?.stopReason).toBe("error");
  expect(
    events.some(
      (event) =>
        event.type === "diagnostic" &&
        event.message.includes("provider stopped before completing"),
    ),
  ).toBe(true);
});

test("aborting the turn mid-stream finishes cancelled with a warning", async () => {
  const { runner, events, abortController } = makeHarness({
    provider: "scripted",
    model: "m1",
    async *stream(request) {
      yield content("half an answer");
      await new Promise<void>((resolve) => {
        request.signal?.addEventListener("abort", () => resolve());
      });
      throw new Error("stream aborted");
    },
  });
  const running = runner.runTurn(turn);
  await new Promise((resolve) => setTimeout(resolve, 10));
  abortController()?.abort();
  await running;
  const finished = events.find(
    (event): event is Extract<RuntimeEvent, { type: "turn.finished" }> =>
      event.type === "turn.finished",
  );
  expect(finished?.stopReason).toBe("cancelled");
  expect(
    events.some(
      (event) => event.type === "diagnostic" && event.level === "warning",
    ),
  ).toBe(true);
});

test("a retried partial stream is attempt-stamped and only successful usage commits", async () => {
  let attempts = 0;
  const { runner, events, ledger } = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream() {
        attempts++;
        if (attempts === 1) {
          yield content("discarded partial");
          yield usage(90, 9);
          throw providerError({ kind: "server", message: "temporary outage" });
        }
        yield content("clean answer");
        yield usage(10, 2);
      },
    },
    {
      retryPolicy: {
        maxAttemptsPerStep: 2,
        initialBackoffMs: 1,
        maxBackoffMs: 1,
        jitterMs: 0,
        maxRetryAfterMs: 1,
      },
    },
  );
  await runner.runTurn(turn);
  expect(
    events
      .filter(
        (event): event is Extract<RuntimeEvent, { type: "content.delta" }> =>
          event.type === "content.delta",
      )
      .map((event) => ({ text: event.text, attempt: event.attempt })),
  ).toEqual([
    { text: "discarded partial", attempt: 1 },
    { text: "clean answer", attempt: 2 },
  ]);
  expect(ledger.snapshot().checkpoint).toMatchObject({
    inputTokens: 10,
    outputTokens: 2,
  });
});

test("the main agent keeps retrying transient failures until recovery", async () => {
  let attempts = 0;
  const { runner, events } = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream() {
        attempts++;
        if (attempts < 6)
          throw providerError({ kind: "server", message: "temporary outage" });
        yield content("recovered after prolonged outage");
      },
    },
    {
      retryPolicy: {
        maxAttemptsPerStep: null,
        initialBackoffMs: 1,
        maxBackoffMs: 1,
        jitterMs: 0,
        maxRetryAfterMs: 1,
      },
    },
  );
  await runner.runTurn(turn);
  expect(attempts).toBe(6);
  expect(events.filter((event) => event.type === "step.retry")).toHaveLength(5);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "step.retry.cleared",
      attempts: 6,
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "turn.finished",
      stopReason: "done",
    }),
  );
});

test("context-limit recovery keeps compacted context and recovered tool results for later steps", async () => {
  let calls = 0;
  const requests: ProviderStreamRequest[] = [];
  const { runner, ledger } = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream(request) {
        calls++;
        requests.push(request);
        if (calls === 1)
          throw providerError({ kind: "context_limit", message: "too long" });
        if (calls === 2) {
          yield content(CONFORMING_SUMMARY);
          return;
        }
        if (calls === 3) {
          yield toolCall([
            { id: "call_recovered", name: "read_file", arguments: "{}" },
          ]);
          return;
        }
        expect(
          request.messages.some(
            (message) =>
              message.role === "system" &&
              message.content.includes(CONFORMING_SUMMARY),
          ),
        ).toBe(true);
        expect(
          request.messages.some(
            (message) =>
              message.role === "tool" &&
              message.toolCallID === "call_recovered" &&
              message.content === "ok",
          ),
        ).toBe(true);
        yield content("recovered final");
      },
    },
    { preservedRecentMessages: 0 },
  );
  for (let index = 0; index < 3; index++)
    ledger.add({
      id: `old-${index}`,
      role: index % 2 ? "assistant" : "user",
      content: `old context ${index}`,
    });
  await runner.runTurn(turn);
  expect(calls).toBe(4);
  expect(requests).toHaveLength(4);
});

test("context-limit recovery clears the stale token anchor before publishing the compacted snapshot", async () => {
  let calls = 0;
  const meter = new TokenMeter();
  meter.setContextWindow("main", 1_000_000);
  const staleSurface = meter.observeSurface("main", [
    { role: "user", content: "x".repeat(4000) },
  ]);
  meter.recordUsage(
    "main",
    { inputTokens: 900_000, outputTokens: 0 },
    { headerKey: "stale", surfaceTokens: staleSurface },
  );
  const { runner, ledger, events } = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream() {
        calls++;
        if (calls === 1)
          throw providerError({ kind: "context_limit", message: "too long" });
        yield content(CONFORMING_SUMMARY);
      },
    },
    { preservedRecentMessages: 0, tokenMeter: meter },
  );
  // Large enough that a conforming summary is genuinely smaller, so the shrink
  // check lets the compaction through and this test can observe the anchor.
  for (let index = 0; index < 3; index++)
    ledger.add({
      id: `old-${index}`,
      role: index % 2 ? "assistant" : "user",
      content: `old context ${index} ${"y".repeat(20_000)}`,
      tokens: 5_000,
    });

  await runner.runTurn(turn);

  const compactionEndIndex = events.findIndex(
    (event) => event.type === "compaction.end" && event.success,
  );
  expect(compactionEndIndex).toBeGreaterThanOrEqual(0);
  const snapshots = events
    .slice(compactionEndIndex + 1)
    .filter(
      (event): event is Extract<RuntimeEvent, { type: "context.snapshot" }> =>
        event.type === "context.snapshot",
    );
  expect(snapshots.length).toBeGreaterThan(0);
  const compacted = snapshots.at(-1)!;
  expect(compacted.usedTokens).toBeLessThan(10_000);
  expect(compacted.projectedTokens ?? 0).toBeLessThan(10_000);
});

/** A summary satisfying the compaction contract, for stub providers. */
const CONFORMING_SUMMARY = [
  "## Objective",
  "- Keep the request honest.",
  "",
  "## Important Details",
  "- The contract is enforced now.",
  "",
  "## Work State",
  "### Completed",
  "- (none)",
  "",
  "### Active",
  "- Compacting the request.",
  "",
  "### Blocked",
  "- (none)",
  "",
  "## Next Move",
  "1. Rebuild the outbound.",
  "",
  "## Relevant Files",
  "- packages/framework/runtime/src/compaction.ts: the contract.",
].join("\n");

test("provider steps compact proactively before dispatching an oversized request", async () => {
  const requests: ProviderStreamRequest[] = [];
  const { runner, ledger, events } = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield content(CONFORMING_SUMMARY);
          return;
        }
        expect(
          request.messages.some(
            (message) =>
              message.role === "system" &&
              message.content.includes(CONFORMING_SUMMARY),
          ),
        ).toBe(true);
        expect(
          request.messages.some(
            (message) => message.role === "user" && message.content === "hello",
          ),
        ).toBe(true);
        yield content("done");
      },
    },
    {
      runtimeContextConfig: withBudgetDefaults({
        max: 100,
        thresholdPercent: 50,
        reserved: 10,
      }),
      preservedRecentMessages: 0,
    },
  );
  // The compacted span has to be genuinely larger than any conforming summary,
  // or the shrink check correctly refuses the compaction and there is nothing
  // left for this test to observe.
  ledger.add({
    id: "old-1",
    role: "assistant",
    content: "x".repeat(40_000),
    tokens: 10_000,
  });
  ledger.add({
    id: "old-2",
    role: "user",
    content: "older follow-up",
    tokens: 10,
  });

  await runner.runTurn(turn);

  expect(requests).toHaveLength(2);
  expect(
    events.some(
      (event) => event.type === "compaction.begin" && event.trigger === "ratio",
    ),
  ).toBe(true);
  const begin = events.find(
    (event): event is Extract<RuntimeEvent, { type: "compaction.begin" }> =>
      event.type === "compaction.begin",
  );
  expect(begin?.beforeTokens).toBeGreaterThanOrEqual(100);
  expect(events.some((event) => event.type === "context.checkpoint")).toBe(
    true,
  );
});

test("provider steps prune old oversized tool results before dispatch", async () => {
  const requests: ProviderStreamRequest[] = [];
  const { runner, ledger, events } = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream(request) {
        requests.push(request);
        yield content("done");
      },
    },
    {
      runtimeContextConfig: withBudgetDefaults({
        max: 200_000,
        thresholdPercent: 85,
        reserved: 8_192,
      }),
    },
  );
  ledger.add({
    id: "call",
    role: "tool_call",
    content: "read_big {}",
    pairID: "p1",
    tokens: 10,
  });
  ledger.add({
    id: "old-big",
    role: "tool_result",
    content: "x".repeat(9_000),
    pairID: "p1",
    tokens: 2_250,
  });
  ledger.add({
    id: "recent",
    role: "assistant",
    content: "recent context",
    tokens: 10,
  });

  await runner.runTurn(turn);

  expect(requests).toHaveLength(1);
  const old = requests[0]?.messages.find((message) =>
    message.content.includes("tool result truncated for context"),
  );
  expect(old).toBeDefined();
  expect(old?.content).toContain("originalChars=9000");
  expect(events.some((event) => event.type === "compaction.begin")).toBe(false);
});

test("provider message estimates exclude binary data URLs", () => {
  const base = estimateProviderMessages([{ role: "user", content: "read it" }]);
  const encoded = "A".repeat(2_000_000);
  const image = estimateProviderMessages([
    {
      role: "user",
      content: "read it",
      images: [
        { mediaType: "image/png", dataURL: `data:image/png;base64,${encoded}` },
      ],
    },
  ]);
  expect(image).toBe(base + 256);
});

test("provider estimates price durable attachment refs by metadata, not bytes", () => {
  const base = estimateProviderMessages([{ role: "user", content: "read it" }]);
  const ref = {
    id: "att_1",
    path: ".natalia/attachments/att_1-image.png",
    filename: "image.png",
    mediaType: "image/png" as const,
    byteLength: 5_000_000,
    sha256: "a".repeat(64),
  };
  const estimate = estimateProviderMessages([
    { role: "user", content: "read it", images: [ref] },
  ]);
  expect(estimate).toBe(base + estimateTokens(JSON.stringify(ref)));
  expect(estimate).toBeLessThan(base + 256);
});

test("a turn keeps the context budget snapshotted with its active model", async () => {
  const runtimeContextConfig = withBudgetDefaults({
    max: 100_000,
    thresholdPercent: 50,
    reserved: 1_000,
  });
  let calls = 0;
  const { runner, events } = makeHarness(
    {
      provider: "scripted",
      model: "model-at-turn-start",
      async *stream() {
        calls += 1;
        if (calls === 1) {
          runtimeContextConfig.max = 10;
          yield toolCall([
            { id: "call_1", name: "read_file", arguments: "{}" },
          ]);
          return;
        }
        yield content("done");
      },
    },
    { runtimeContextConfig },
  );

  await runner.runTurn(turn);

  expect(calls).toBe(2);
  expect(events.some((event) => event.type === "compaction.begin")).toBe(false);
});

test("live user messages inject as ordinary tagged user turns", async () => {
  let live = [
    { source: "user" as const, text: "[user] focus on the docs task first" },
  ];
  const seen: string[] = [];
  const { runner } = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream(request) {
        seen.push(
          request.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content)
            .join("\n"),
        );
        yield content("acknowledged");
      },
    },
    {
      takeLiveUserMessages: () => {
        const next = live;
        live = [];
        return next;
      },
    },
  );
  await runner.runTurn(turn);
  expect(seen[0]).toContain("hello");
  expect(seen[0]).toContain("[user] focus on the docs task first");
});

test("a next-step that arrives mid-turn keeps the loop alive and lands in the ledger", async () => {
  const requests: Array<Array<{ role: string; content: string }>> = [];
  let arrived = false;
  let injected = false;
  const { runner, ledger } = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream(request) {
        requests.push(
          request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        );
        // Simulate a user submitting `next-step` while the model is answering
        // the first step.
        arrived = true;
        yield content(
          requests.length === 1 ? "first answer" : "after injection",
        );
      },
    },
    {
      takeStepInputs: (step) => {
        // Nothing was queued before step 0; the input appears at the next step.
        if (step === 0 || injected) return [];
        injected = true;
        return [{ id: "in_1", text: "also do X" }];
      },
      hasPendingStepInputs: () => arrived && !injected,
    },
  );

  await runner.runTurn(turn);

  expect(requests.length).toBe(2);
  const secondUserText = requests[1]!
    .filter((message) => message.role === "user")
    .map((message) => message.content);
  expect(secondUserText).toContain("also do X");
  expect(
    ledger
      .snapshot()
      .entries.some(
        (entry) => entry.id === "in_1:user" && entry.content === "also do X",
      ),
  ).toBe(true);
});

test("pending Navi chat renders as a required direct reply without becoming user intent", async () => {
  let systemPrompt = "";
  let userMessages: string[] = [];
  const { runner } = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream(request) {
        const system = request.messages.find(
          (message) => message.role === "system",
        );
        if (system && typeof system.content === "string")
          systemPrompt = system.content;
        userMessages = request.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content);
        yield content("replying to Navi");
      },
    },
    {
      naviIntro: true,
      naviChats: [
        {
          id: "collab:chat:pending",
          threadID: "collab:chat:thread",
          from: "live_chat",
          to: "main_agent",
          text: "Did you account for the empty case?",
          round: 2,
          expectsReply: true,
          status: "pending",
        },
      ],
    },
  );

  await runner.runTurn(turn);
  // ADR D1/D2: collaboration is dynamic context, never system prompt content.
  expect(systemPrompt).not.toContain("<navi_chat>");
  const runtimeContext = userMessages.join("\n");
  expect(runtimeContext).toContain('<runtime_context source="collab"');
  expect(runtimeContext).toContain("<navi_chat>");
  expect(runtimeContext).toContain("messageID: collab:chat:pending");
  expect(runtimeContext).toContain("round 2 · REPLY_REQUIRED");
  expect(runtimeContext).toContain("[Navi → you, untrusted data]");
  expect(runtimeContext).toContain("must receive one direct collab_chat reply");
  expect(runtimeContext).toContain("Every reply continues the thread");
  expect(runtimeContext).toContain("Never report that Navi has not replied");
  expect(runtimeContext).not.toContain("<pending_user_intents>");
});

test("an active plan renders as a NextPlanHandoff in the runtime context, not the system", async () => {
  let systemPrompt = "";
  let userMessages: string[] = [];
  const { runner } = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream(request) {
        const system = request.messages.find(
          (message) => message.role === "system",
        );
        if (system && typeof system.content === "string")
          systemPrompt = system.content;
        userMessages = request.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content);
        yield content("working on the plan");
      },
    },
    {
      activePlan: {
        planID: "plan:1",
        version: 5,
        title: "Switch to Bun-native HTTP",
        objective: "replace the fetch wrapper",
        steps: [
          {
            id: "s1",
            title: "introduce the server",
            verification: "typecheck",
          },
        ],
        constraints: ["keep loopback default"],
        verification: ["typecheck"],
        riskNotes: ["port conflicts"],
      },
    },
  );
  await runner.runTurn(turn);
  expect(systemPrompt).not.toContain("<next_plan_handoff>");
  const runtimeContext = userMessages.join("\n");
  expect(runtimeContext).toContain(
    '<runtime_context source="plan" authority="user" trust="untrusted"',
  );
  expect(runtimeContext).toContain("<next_plan_handoff>");
  expect(runtimeContext).toContain("plan:1 v5: Switch to Bun-native HTTP");
  expect(runtimeContext).toContain("replace the fetch wrapper");
  expect(runtimeContext).toContain("s1: introduce the server");
  expect(runtimeContext).toContain("keep loopback default");
  expect(runtimeContext).toContain("port conflicts");
  expect(runtimeContext).toContain("</next_plan_handoff>");
});

test("the static system prompt is byte-identical across workspaces and permission modes (ADR D1)", async () => {
  const collect = async (options?: {
    workspaceRoot?: string;
    permissionMode?: "ask" | "auto" | "read_only";
  }) => {
    let system = "";
    const { runner } = makeHarness(
      {
        provider: "scripted",
        model: "m1",
        async *stream(request) {
          const systemMessage = request.messages.find(
            (message) => message.role === "system",
          );
          if (systemMessage && typeof systemMessage.content === "string")
            system = systemMessage.content;
          yield content("ok");
        },
      },
      {
        workspaceRoot: options?.workspaceRoot ?? "/tmp/ws-a",
        permissionMode: options?.permissionMode ?? "auto",
        naviIntro: true,
        activePlan: {
          planID: "plan:1",
          version: 2,
          title: "t",
          objective: "o",
          steps: [],
          constraints: [],
          verification: [],
          riskNotes: [],
        },
      },
    );
    await runner.runTurn(turn);
    return system;
  };
  const first = await collect();
  const second = await collect({
    workspaceRoot: "/tmp/ws-b",
    permissionMode: "ask",
  });
  expect(first.length).toBeGreaterThan(0);
  expect(second).toBe(first);
  // Dynamic facts must not leak into the static system.
  for (const dynamic of [
    "Working directory",
    "Workspace root folder",
    "Permission mode",
    "<navi_chat>",
    "<next_plan_handoff>",
  ])
    expect(first).not.toContain(dynamic);
  // The authority model is a static global convention (ADR D9).
  expect(first).toContain("<authority_model>");
  expect(first).toContain("Fail-closed gates");
  expect(first).toContain("highest revision is the current state");
});

test("environment details move to the runtime context and precede the user request (ADR D2/D6)", async () => {
  const shapes: Array<Array<{ role: string; content: string }>> = [];
  const { runner } = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream(request) {
        shapes.push(
          request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        );
        yield content("ok");
      },
    },
    { permissionMode: "ask" },
  );
  await runner.runTurn(turn);
  const messages = shapes[0]!;
  const system = messages.find((message) => message.role === "system");
  expect(system).toBeDefined();
  expect(system!.content).not.toContain("Working directory");
  const contextIndex = messages.findIndex(
    (message) =>
      message.role === "user" &&
      message.content.includes('<runtime_context source="environment"'),
  );
  expect(contextIndex).toBeGreaterThan(0);
  const requestIndex = messages.findIndex(
    (message) => message.role === "user" && message.content === "hello",
  );
  expect(requestIndex).toBeGreaterThan(contextIndex);
  expect(messages[contextIndex]!.content).toContain("Permission mode: ask");
});

test("constitution/AGENTS documents inject with explicit per-section enforcement (EI §3.8 P-1.c)", async () => {
  // A deny-annotated section and a prose section both reach the provider
  // context; the structured <constitution_rules> list states each section's
  // enforcement so the model knows which rules are hard vs warn-level prose.
  const shapes: string[] = [];
  const { runner } = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream(request) {
        shapes.push(request.messages.map((m) => m.content).join("\n"));
        yield content("ok");
      },
    },
    {
      permissionMode: "ask",
      projectDocuments: {
        hash: "constitution:abc",
        documents: [
          {
            source: "constitution",
            path: ".natalia/constitution.md",
            content: "# Rules",
            hash: "abc",
            rules: [
              {
                id: "constitution:never-force-push:1",
                source: "constitution",
                section: "Never force-push",
                statement: "Force-pushing rewrites shared history.",
                enforcement: "deny",
                annotated: true,
                appliesTo: { commandPattern: "git push --force" },
              },
              {
                id: "constitution:small-prs:2",
                source: "constitution",
                section: "Small PRs",
                statement: "Prefer small pull requests.",
                enforcement: "warn",
                annotated: false,
              },
            ],
          },
        ],
      },
    },
  );
  await runner.runTurn(turn);
  const injected = shapes[0]!;
  expect(injected).toContain("<constitution_rules>");
  expect(injected).toContain("[deny] Force-pushing rewrites shared history.");
  expect(injected).toContain("[warn] Prefer small pull requests.");
  expect(injected).toContain(
    'appliesTo: {"commandPattern":"git push --force"}',
  );
  // The raw content still rides along for grounding.
  expect(injected).toContain("# Rules");
  // The block stays in the appended runtime context, never the static system.
  const systemMsg = injected
    .split("\n")
    .find((line) => line === "SYSTEM_PLACEHOLDER");
  expect(systemMsg).toBeUndefined();
});

test("a mid-turn step input appends a fresh runtime context instead of mutating the system (ADR D3/D6)", async () => {
  const requests: Array<Array<{ role: string; content: string }>> = [];
  let arrived = false;
  let injected = false;
  const naviChats: Array<{
    id: string;
    threadID: string;
    from: "live_chat" | "main_agent";
    to: "live_chat" | "main_agent";
    text: string;
    round: number;
    expectsReply: boolean;
    status: string;
  }> = [];
  const { runner, ledger } = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream(request) {
        requests.push(
          request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        );
        arrived = true;
        // A collaboration reply arrives while the turn is in flight.
        naviChats.push({
          id: "collab:chat:late",
          threadID: "collab:chat:thread",
          from: "live_chat",
          to: "main_agent",
          text: "late reply",
          round: 3,
          expectsReply: false,
          status: "sent",
        });
        yield content(requests.length === 1 ? "first" : "after injection");
      },
    },
    {
      naviIntro: true,
      naviChats,
      takeStepInputs: (step) => {
        if (step === 0 || injected) return [];
        injected = true;
        return [{ id: "in_1", text: "also do X" }];
      },
      hasPendingStepInputs: () => arrived && !injected,
    },
  );
  await runner.runTurn(turn);
  expect(requests.length).toBe(2);
  // The system message is never mutated mid-turn.
  expect(requests[1]![0]!.content).toBe(requests[0]![0]!.content);
  // The second request carries a fresh runtime context with a higher revision.
  const contexts = requests[1]!
    .filter(
      (message) =>
        message.role === "user" &&
        message.content.includes('<runtime_context source="collab"'),
    )
    .map((message) => message.content);
  expect(contexts.length).toBeGreaterThanOrEqual(2);
  const revisions = contexts.map((content) =>
    Number(/revision="(\d+)"/u.exec(content)?.[1] ?? "0"),
  );
  expect(Math.max(...revisions)).toBeGreaterThan(Math.min(...revisions));
  expect(contexts.join("\n")).toContain("collab:chat:late");
  expect(
    requests[1]!.some(
      (message) => message.role === "user" && message.content === "also do X",
    ),
  ).toBe(true);
  expect(
    ledger
      .snapshot()
      .entries.some(
        (entry) => entry.id === "in_1:user" && entry.content === "also do X",
      ),
  ).toBe(true);
});

test("an already-announced turn is not re-announced", async () => {
  const announced = new Set<string>(["t1"]);
  const { runner, events } = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream() {
        yield content("done");
      },
    },
    {
      isTurnAnnounced: (id) => announced.has(id),
      markTurnAnnounced: (id) => announced.add(id),
    },
  );
  await runner.runTurn(turn);
  expect(events.some((event) => event.type === "turn.submitted")).toBe(false);
});

test("duplicate provider tool_call_ids are remapped before execution", async () => {
  let streamCalls = 0;
  const provider: StreamingProvider = {
    provider: "scripted",
    model: "m1",
    async *stream() {
      streamCalls += 1;
      if (streamCalls === 1) {
        yield toolCall([
          { id: "call_dup", name: "read_file", arguments: "{}" },
          { id: "call_dup", name: "glob", arguments: "{}" },
        ]);
        return;
      }
      yield content("done");
    },
  };
  const { runner, events, executedCalls } = makeHarness(provider, {
    maxSteps: 4,
  });

  await runner.runTurn(turn);

  expect(executedCalls.map(({ call }) => call.id)).toEqual([
    "call_dup",
    "call_dup#1",
  ]);
  expect(
    events.some(
      (event) =>
        event.type === "diagnostic" &&
        event.message.includes("duplicate tool_call_id"),
    ),
  ).toBe(true);
});

test("provider usage commits the last step instead of summing every step", async () => {
  let streamCalls = 0;
  const { runner, ledger } = makeHarness({
    provider: "scripted",
    model: "m1",
    async *stream() {
      streamCalls += 1;
      if (streamCalls === 1) {
        yield toolCall([
          {
            id: "call_1",
            name: "read_file",
            arguments: '{"path":"a.txt"}',
          },
        ]);
        yield usage(100, 5);
        return;
      }
      yield content("done");
      yield usage(120, 7);
    },
  });

  await runner.runTurn(turn);
  expect(streamCalls).toBe(2);
  // The prompt size of the second request describes the live context. Summing
  // both requests' prompt tokens (220) makes the ledger believe the window is
  // far larger than it is and forces a bogus compaction.
  expect(ledger.snapshot().checkpoint).toMatchObject({
    inputTokens: 120,
    outputTokens: 7,
  });
});

test("main-path request metering counts advertised tools and exposes the three buckets", async () => {
  const registry = new ToolRegistry();
  registry.set("big_tool", {
    name: "big_tool",
    requiresApproval: false,
    description: "d".repeat(4000),
    parameters: {
      type: "object",
      properties: {
        payload: { type: "string", description: "p".repeat(4000) },
      },
    },
    execute: async () => "ok",
  });
  const meter = new TokenMeter();
  const { runner, events } = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream() {
        yield content("done");
        yield usage(120, 7);
      },
    },
    { tools: registry, tokenMeter: meter },
  );
  await runner.runTurn(turn);

  const snapshot = events.find(
    (event): event is Extract<RuntimeEvent, { type: "context.snapshot" }> =>
      event.type === "context.snapshot",
  );
  expect(snapshot).toBeDefined();
  // The advertised tool schema is part of the request header and must be
  // measured as its own bucket, not folded into the message surface.
  expect(snapshot!.toolsTokens).toBeGreaterThan(0);
  expect(snapshot!.systemTokens).toBeGreaterThan(0);
  expect(snapshot!.messageTokens).toBeGreaterThanOrEqual(0);

  const status = events.find(
    (event): event is Extract<RuntimeEvent, { type: "context.status" }> =>
      event.type === "context.status" && event.toolsTokens !== undefined,
  );
  expect(status).toBeDefined();
  expect(status!.headerTokens).toBe(
    (status!.systemTokens ?? 0) + (status!.toolsTokens ?? 0),
  );
  expect(status!.requestTokens).toBe(
    (status!.headerTokens ?? 0) + (status!.surfaceTokens ?? 0),
  );
});

test("the environment block states the session's current confinement mode", async () => {
  // The agent layer (sandbox study §6b①): the model knows its CURRENT
  // confinement state — the tool schema advertises the escalation targets,
  // this says where the agent IS.
  const shapes: Array<Array<{ role: string; content: string }>> = [];
  const { runner } = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream(request) {
        shapes.push(
          request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        );
        yield content("ok");
      },
    },
    { permissionMode: "ask", confinementMode: "workspace-write" },
  );
  await runner.runTurn(turn);
  const environment = shapes[0]!.find((message) =>
    message.content.includes('<runtime_context source="environment"'),
  );
  expect(environment).toBeDefined();
  expect(environment!.content).toContain("Confinement mode: workspace-write");
  expect(environment!.content).toContain("targets: danger-full-access");
  // The statement rides the dynamic layer, never the static system.
  const system = shapes[0]!.find((message) => message.role === "system");
  expect(system!.content).not.toContain("Confinement mode");
});

test("turn telemetry rides the injected log, and degrades to silence without it", async () => {
  // T3: the [natalia-turn] records left the console for the operation log —
  // leveled, rotated, correlated by the ambient scope. The kit stays bare:
  // no log means no records and no throw.
  const records: Array<{
    level: string;
    component: string;
    message: string;
    fields: Record<string, unknown>;
  }> = [];
  const capture =
    (level: string) =>
    (
      component: string,
      message: string,
      fields?: Record<string, unknown>,
    ): void => {
      records.push({ level, component, message, fields: fields ?? {} });
    };
  const log = {
    info: capture("info"),
    error: capture("error"),
    debug: capture("debug"),
  };
  const withLog = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream() {
        yield content("ok");
      },
    },
    { permissionMode: "auto", log },
  );
  await withLog.runner.runTurn(turn);
  const start = records.find((record) => record.component === "[natalia-turn]");
  expect(start).toBeDefined();
  expect(start!.message).toBe("start");
  expect(start!.fields).toMatchObject({ model: "m1", internal: false });
  const finished = records.filter(
    (record) => record.component === "[natalia-turn]",
  );
  expect(finished.map((record) => record.message)).toContain("finished");
  // Without the channel (a bare context): nothing recorded, nothing thrown.
  records.length = 0;
  const bare = makeHarness(
    {
      provider: "scripted",
      model: "m1",
      async *stream() {
        yield content("ok");
      },
    },
    { permissionMode: "auto" },
  );
  await bare.runner.runTurn(turn);
  expect(records).toEqual([]);
});

test("the provider prefix is stable across turns whose dynamic state differs (the prefix cache's condition)", async () => {
  // The prefix-cache assembly's invariant: the STATIC system prompt is
  // the first message and byte-identical across turns; every dynamic
  // difference (plan, documents, confinement) arrives AFTER it as an
  // appended <runtime_context> user message, never inside the static
  // block. A provider's prefix cache keys off those leading bytes —
  // one differing byte in the static block and every turn re-bills the
  // whole persona.
  const shapes: Array<Array<{ role: string; content: string }>> = [];
  const record = {
    provider: "scripted",
    model: "m1",
    async *stream(request: ProviderStreamRequest) {
      shapes.push(
        request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      );
      yield content("ok");
    },
  };
  await makeHarness(record, { permissionMode: "ask" }).runner.runTurn({
    ...turn,
  });
  await makeHarness(record, {
    permissionMode: "auto",
    activePlan: {
      planID: "plan:1",
      version: 1,
      title: "a plan the other turn never had",
      objective: "the objective only this turn carries",
      steps: [
        {
          id: "s1",
          title: "a step",
          detail: "the detail",
          verification: "verify",
        },
      ],
      constraints: ["a constraint"],
      verification: ["a verification"],
      riskNotes: ["a risk"],
    },
    confinementMode: "danger-full-access",
  }).runner.runTurn({ ...turn });

  console.log(
    "FREI shapes:",
    shapes.length,
    JSON.stringify(shapes[1] ?? null)?.slice(0, 80),
  );
  const plain = shapes[0]!;
  const rich = shapes[1]!;
  // The static system prompt is the first message, byte-identical.
  expect(plain[0]!.role).toBe("system");
  expect(rich[0]!.content).toBe(plain[0]!.content);
  // And the dynamic state lives only in the appended context blocks: the
  // plan's objective and the confinement are NOT in the static block but
  // ARE in the later context message.
  expect(rich[0]!.content).not.toContain(
    "the objective only this turn carries",
  );
  expect(rich[0]!.content).not.toContain("dangerous");
  const richContext = rich.find(
    (message) =>
      message.role === "user" && message.content.includes("<runtime_context"),
  );
  expect(richContext).toBeDefined();
  expect(richContext!.content).toContain(
    "the objective only this turn carries",
  );
});
