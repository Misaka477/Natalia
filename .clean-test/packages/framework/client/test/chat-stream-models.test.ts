import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";
import { defaultConfigV3 } from "@anthelia/config";
import { ContextLedger, TokenMeter } from "@anthelia/runtime";
import type { ProviderMessage } from "@anthelia/runtime";
import { compactionService } from "@anthelia/compaction";
import { providerModelController } from "@anthelia/provider-model";
import { createTestContext } from "@anthelia/runtime-services";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import type { ProductRuntimeContext } from "@natalia/collab";
import { createNaviChatTurn } from "@natalia/collab";
import { createNiaChatTurn } from "@natalia/collab";
import { createCollaborationWake } from "@natalia/collab";
import type { ProviderChatTurnInput } from "@anthelia/provider-model";

test("Nia normal and Navi expert resolve independent adapters, models and thinking on submit and wake", async () => {
  const config = defaultConfigV3();
  for (const [id, driver, model] of [
    ["qifengstep", "anthropic-compatible", "step-3.7-flash"],
    ["grok", "openai-compatible", "grok-4.6"],
    ["expert", "openai-compatible", "expert-model"],
  ] as const) {
    config.providers[id] = {
      name: id,
      driver,
      enabled: true,
      connection: { apiKey: "test-only", baseURL: `https://${id}.invalid/v1` },
      requestDefaults: { stream: true, headers: {}, options: {} },
    };
    config.catalog.providers[id] = {
      models: {
        [model]: {
          name: model,
          status: "stable",
          source: "manual",
          capabilities: {
            toolCall: true,
            reasoning: true,
            thinking: true,
            imageInput: false,
            videoInput: false,
          },
          limits: { contextWindow: 32768, maxOutputTokens: 16384 },
        },
      },
    };
    config.modelOverrides[`${id}/${model}`] = {
      enabled: true,
      name: model,
      requestDefaults: { temperature: null, topP: null, thinkingEnabled: true },
      requestOptions: {},
      headers: {},
    };
  }
  config.defaultModel = { provider: "qifengstep", model: "step-3.7-flash" };
  const events: RuntimeEvent[] = [];
  const exec = {
    session: { id: "ses_model_streams", events },
    // This harness owns the complete live event array, not a tail.
    fullEventsLoaded: true,
    tokenMeter: new TokenMeter(),
    naviTokenMeter: new TokenMeter(),
    niaTokenMeter: new TokenMeter(),
    naviChatLedger: new ContextLedger(),
    niaChatLedger: new ContextLedger(),
    naviPendingQueue: [],
    niaPendingQueue: [],
    naviChatModelProfile: {
      normal: { modelID: "expert/expert-model", reasoningEffort: "low" },
      expert: {
        modelID: "expert/expert-model",
        variant: "expert-variant",
        reasoningEffort: "xhigh",
      },
    },
    niaChatModelProfile: {
      normal: {
        modelID: "grok/grok-4.6",
        variant: "nia-variant",
        reasoningEffort: "high",
      },
    },
    provider: {
      async *stream() {
        throw new Error("main provider must not serve chat");
      },
    },
  } as unknown as SessionExecutionState;
  let sequence = 0;
  const ctx = {
    // The navi turn reads optional services (the RINA response cache) from
    // the directory; a bare one means "no cache", which is the default.
    state: { serviceDirectory: createTestContext([]) },
    ports: {
      getTsRuntimeConfig: () => config,
      getContextWindowResolver: () => ({
        resolve: async () => ({ contextWindow: 32768, source: "test" }),
      }),
      resolveContextStatusConfig: async () => ({
        max: 32768,
        thresholdPercent: 85,
        reserved: 8_000,
      }),
      modelRefKeyForSelection: () => undefined,
      getChatDefaultProvider: () => undefined,
      providerFromEnvironment: () => undefined,
      publishForSession: (_: unknown, event: RuntimeEvent) => {
        events.push(event);
      },
      nextChatSequence: () => sequence++,
      naviChatPersona: () => "Navi only",
      naviChatLiveContext: () => "",
      niaChatPersona: () => "Nia only",
      niaChatLiveContext: () => "",
      naviChatTools: () => [],
      niaChatTools: () => [],
      effectiveMaxSteps: () => 1,
      redactToolOutput: (text: string) => text,
      getWorkspaceRoot: () => "/tmp/kilo",
    },
  } as unknown as RuntimeContext;
  const navi = createNaviChatTurn(ctx);
  const nia = createNiaChatTurn(ctx);
  const wakeInputs: ProviderChatTurnInput[] = [];
  const wakeController = {
    runTurn: async () => undefined,
    runNaviChatTurn: async (input: ProviderChatTurnInput) => {
      wakeInputs.push(input);
      await navi.runNaviChatTurn(
        { ...input, exec },
        new AbortController().signal,
      );
    },
    runNiaChatTurn: async (input: ProviderChatTurnInput) => {
      wakeInputs.push(input);
      await nia.runNiaChatTurn(
        { ...input, exec },
        new AbortController().signal,
      );
    },
    requestNaviWake: () => undefined,
    requestNiaWake: () => undefined,
    naviBusy: () => false,
    niaBusy: () => false,
    abortNavi: () => false,
    abortNia: () => false,
    dispose: async () => undefined,
  };
  ctx.ports.resolveService = (() =>
    wakeController) as typeof ctx.ports.resolveService;
  ctx.state.serviceDirectory = createTestContext([
    compactionService.mock({
      compactBeforeProviderStep: async () => ({ compacted: false }),
      runWithContextLimitRecovery: async () => ({ recovered: false }),
      prepareContextRequest: async (input: {
        outbound: ProviderMessage[];
      }) => ({
        outbound: input.outbound,
        decision: "none",
        compacted: false,
        pruned: 0,
        used: 0,
      }),
    }),
    providerModelController.mock(wakeController),
  ]);
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(url), body });
      const sse = String(url).endsWith("/messages")
        ? [
            {
              type: "content_block_delta",
              delta: { type: "thinking_delta", thinking: "step thinking" },
            },
            {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "step answer" },
            },
            { type: "message_delta", delta: { stop_reason: "end_turn" } },
          ]
        : [
            { choices: [{ delta: { reasoning_content: "grok thinking" } }] },
            {
              choices: [
                { delta: { content: "grok answer" }, finish_reason: "stop" },
              ],
            },
          ];
      return new Response(
        sse.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      );
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  try {
    await nia.runNiaChatTurn(
      { exec, text: "audit", responseMessageID: "nia-submit" },
      new AbortController().signal,
    );
    expect(requests[0]).toMatchObject({
      url: "https://grok.invalid/v1/chat/completions",
      body: { model: "grok-4.6", reasoning_effort: "high" },
    });
    const wake = createCollaborationWake(ctx as ProductRuntimeContext);
    await wake.wakeNia(exec);
    expect(requests[1]).toMatchObject({
      url: "https://grok.invalid/v1/chat/completions",
      body: { model: "grok-4.6", reasoning_effort: "high" },
    });
    expect(wakeInputs[0]).toMatchObject({
      model: { modelID: "grok/grok-4.6", variant: "nia-variant" },
      reasoningEffort: "high",
    });
    exec.advisorPending = true;
    await wake.wakeNavi(exec);
    expect(requests[2]).toMatchObject({
      url: "https://expert.invalid/v1/chat/completions",
      body: { model: "expert-model", reasoning_effort: "xhigh" },
    });
    expect(wakeInputs[1]).toMatchObject({
      model: { modelID: "expert/expert-model", variant: "expert-variant" },
      reasoningEffort: "xhigh",
    });
    expect(exec.advisorPending).toBe(false);
    exec.niaChatModelProfile = { normal: { reasoningEffort: "high" } };
    await nia.runNiaChatTurn(
      { exec, text: "default", responseMessageID: "nia-default" },
      new AbortController().signal,
    );
    expect(requests[3]).toMatchObject({
      url: "https://qifengstep.invalid/v1/messages",
      body: {
        model: "step-3.7-flash",
        thinking: { type: "enabled", budget_tokens: 8192 },
      },
    });
    expect(
      events.filter((event) => event.type === "nia.chat.thinking.done"),
    ).toHaveLength(3);
    expect(
      events.filter((event) => event.type === "navi.chat.thinking.done"),
    ).toHaveLength(1);
    expect(events.some((event) => event.type === "thinking.delta")).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the navi turn carries no response cache", () => {
  // The cache was removed: its replay synthesized a content-only stream, so a
  // hit on a step whose correct behaviour was a tool call ended the turn with a
  // sentence instead of the work — the whole of this loop's job. A source-level
  // pin, because the behaviour (a second identical request must reach the
  // provider again) is otherwise invisible until a cache reappears.
  const source = readFileSync(
    join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "domains",
      "collab",
      "src",
      "chat-turn-navi.ts",
    ),
    "utf8",
  );
  for (const symbol of [
    "rinaResponseCache",
    "responseCache",
    "cacheKey",
    "cacheHit",
  ])
    expect(source, `${symbol} must not return to the navi turn`).not.toContain(
      symbol,
    );
});
