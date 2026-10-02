import { expect, test } from "bun:test";
import { OpenAIResponsesProvider } from "../src/provider";

/** Drive the adapter and capture both the request body and the emitted chunks. */
async function runResponses(input: {
  sse: string;
  messages?: Parameters<OpenAIResponsesProvider["stream"]>[0]["messages"];
  capabilities?: ConstructorParameters<
    typeof OpenAIResponsesProvider
  >[0]["capabilities"];
  sessionID?: string;
  cacheRetention?: ConstructorParameters<
    typeof OpenAIResponsesProvider
  >[0]["cacheRetention"];
  toolChoice?: "auto" | "required" | "none";
  tools?: Parameters<OpenAIResponsesProvider["stream"]>[0]["tools"];
}): Promise<{
  body: Record<string, unknown>;
  chunks: import("../src/provider").ProviderStreamChunk[];
}> {
  let sent: Record<string, unknown> = {};
  const fetchImpl = Object.assign(
    async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(input.sse, {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    model: "gpt-test",
    fetch: fetchImpl,
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    ...(input.sessionID ? { sessionID: input.sessionID } : {}),
    ...(input.cacheRetention ? { cacheRetention: input.cacheRetention } : {}),
  });
  const chunks: import("../src/provider").ProviderStreamChunk[] = [];
  for await (const chunk of provider.stream({
    messages: input.messages ?? [{ role: "user", content: "hi" }],
    ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
    ...(input.tools ? { tools: input.tools } : {}),
  }))
    chunks.push(chunk);
  return { body: sent, chunks };
}

const SSE = (events: string[]) =>
  events.map((event) => `data: ${event}\n\n`).join("") + "data: [DONE]\n\n";

test("Responses sends input items, not a messages array", async () => {
  const { body } = await runResponses({
    sse: SSE([
      JSON.stringify({ type: "response.output_text.delta", delta: "ok" }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_1",
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      }),
    ]),
    messages: [
      { role: "system", content: "be terse" },
      { role: "user", content: "hello" },
    ],
  });

  expect(body).not.toHaveProperty("messages");
  expect(body.input).toEqual([
    { role: "system", content: [{ type: "input_text", text: "be terse" }] },
    { role: "user", content: [{ type: "input_text", text: "hello" }] },
  ]);
  expect(body.store).toBe(false);
  expect(body.stream).toBe(true);
});

test("Responses lifts tool calls into function_call items keyed by call_id", async () => {
  // The pairing lives in call_id, not in message order, so the call has to
  // leave the assistant message that carried it.
  const { body } = await runResponses({
    sse: SSE([
      JSON.stringify({ type: "response.output_text.delta", delta: "ok" }),
    ]),
    messages: [
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "read_file", arguments: '{"p":"a"}' },
        ],
      },
      {
        role: "tool",
        content: "file body",
        toolCallID: "call_1",
        toolName: "read_file",
      },
    ],
  });

  expect(body.input).toEqual([
    { role: "user", content: [{ type: "input_text", text: "read it" }] },
    {
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: '{"p":"a"}',
    },
    { type: "function_call_output", call_id: "call_1", output: "file body" },
  ]);
});

test("Responses emits content, tool calls and usage from the event stream", async () => {
  const { chunks } = await runResponses({
    sse: SSE([
      JSON.stringify({ type: "response.created", response: { id: "resp_9" } }),
      JSON.stringify({ type: "response.output_text.delta", delta: "hel" }),
      JSON.stringify({ type: "response.output_text.delta", delta: "lo" }),
      JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "call_7",
          name: "grep",
        },
      }),
      JSON.stringify({
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: '{"q":',
      }),
      JSON.stringify({
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: '"x"}',
      }),
      JSON.stringify({
        type: "response.function_call_arguments.done",
        output_index: 0,
        arguments: '{"q":"x"}',
      }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_9",
          usage: {
            input_tokens: 500,
            output_tokens: 12,
            total_tokens: 512,
            input_tokens_details: { cached_tokens: 400 },
          },
        },
      }),
    ]),
  });

  const texts = chunks
    .filter((chunk) => chunk.type === "content")
    .map((chunk) => (chunk as { text: string }).text)
    .join("");
  expect(texts).toBe("hello");
  expect(chunks).toContainEqual({
    type: "tool_call",
    calls: [{ id: "call_7", name: "grep", arguments: '{"q":"x"}' }],
  });
  // `input_tokens` on this family INCLUDES cached tokens, so they are
  // subtracted — unlike Anthropic, whose input_tokens excludes them.
  expect(chunks.find((chunk) => chunk.type === "usage")).toEqual({
    type: "usage",
    inputTokens: 100,
    outputTokens: 12,
    cacheReadInputTokens: 400,
  });
  expect(chunks.find((chunk) => chunk.type === "done")).toMatchObject({
    finishReason: "stop",
  });
});

test("Responses subtracts cache-write tokens too, and reports them separately", async () => {
  const { chunks } = await runResponses({
    sse: SSE([
      JSON.stringify({
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 1000,
            output_tokens: 5,
            input_tokens_details: {
              cached_tokens: 300,
              cache_write_tokens: 200,
            },
          },
        },
      }),
    ]),
  });

  expect(chunks.find((chunk) => chunk.type === "usage")).toEqual({
    type: "usage",
    inputTokens: 500,
    outputTokens: 5,
    cacheReadInputTokens: 300,
    cacheCreationInputTokens: 200,
  });
});

test("Responses sends no cache parameter when the endpoint declared none", async () => {
  // The safe default: an undeclared endpoint gets nothing rather than a guess
  // that would 400 on every request.
  const { body } = await runResponses({ sse: SSE([]) });

  expect(body).not.toHaveProperty("prompt_cache_key");
  expect(body).not.toHaveProperty("prompt_cache_retention");
  expect(body).not.toHaveProperty("prompt_cache_options");
});

test("Responses sends only the retention shape the endpoint accepts", async () => {
  // The two shapes are mutually exclusive; sending the wrong one is a hard 400.
  const legacy = await runResponses({
    sse: SSE([]),
    capabilities: { supportsLongCacheRetention: true },
  });
  expect(legacy.body.prompt_cache_retention).toBe("24h");
  expect(legacy.body).not.toHaveProperty("prompt_cache_options");

  const modern = await runResponses({
    sse: SSE([]),
    capabilities: {
      supportsExplicitPromptCacheMode: true,
      supportsLongCacheRetention: true,
    },
  });
  expect(modern.body.prompt_cache_options).toEqual({
    mode: "explicit",
    ttl: "30m",
  });
  expect(modern.body).not.toHaveProperty("prompt_cache_retention");

  const modernShort = await runResponses({
    sse: SSE([]),
    capabilities: { supportsExplicitPromptCacheMode: true },
  });
  expect(modernShort.body.prompt_cache_options).toEqual({ mode: "explicit" });
  expect(modernShort.body).not.toHaveProperty("prompt_cache_retention");
});

test("Responses sends a session key whenever one is configured", async () => {
  // A session key rides along independently of retention: it is accepted far
  // more widely than either retention parameter.
  const { body } = await runResponses({
    sse: SSE([]),
    capabilities: { supportsPromptCacheKey: true },
    sessionID: "ses_abc",
  });

  expect(body.prompt_cache_key).toBe("ses_abc");
  expect(body).not.toHaveProperty("prompt_cache_retention");
  expect(body).not.toHaveProperty("prompt_cache_options");
});

test("Responses clamps max_output_tokens up to the API minimum", async () => {
  const fetchImpl = Object.assign(
    async (_url: string | URL | Request, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      return new Response(SSE([]), {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  let captured: Record<string, unknown> = {};
  const provider = new OpenAIResponsesProvider({
    apiKey: "k",
    model: "m",
    fetch: fetchImpl,
    maxTokens: 4,
  });
  for await (const _chunk of provider.stream({
    messages: [{ role: "user", content: "hi" }],
  }));

  expect(captured.max_output_tokens).toBe(16);
});

test("Responses maps an incomplete response to a length finish", async () => {
  const { chunks } = await runResponses({
    sse: SSE([
      JSON.stringify({
        type: "response.incomplete",
        response: { usage: { input_tokens: 9, output_tokens: 1 } },
      }),
    ]),
  });

  expect(chunks.find((chunk) => chunk.type === "done")).toMatchObject({
    finishReason: "length",
  });
});

test("Responses retention none suppresses every cache parameter", async () => {
  // `none` means the caller does not want the cache, so even a declared key has
  // nothing to route.
  const { body } = await runResponses({
    sse: SSE([]),
    sessionID: "ses_abc",
    capabilities: {
      supportsPromptCacheKey: true,
      supportsLongCacheRetention: true,
    },
    cacheRetention: "none",
  });

  expect(body).not.toHaveProperty("prompt_cache_key");
  expect(body).not.toHaveProperty("prompt_cache_retention");
  expect(body).not.toHaveProperty("prompt_cache_options");
});

test("the adapter's SSE diagnostics ride the injected log, silent without it (T3)", async () => {
  // The env gate (NATALIA_DEBUG_PROVIDER) is retired: the transport layer
  // stays context-free, the runtime injects the operation-log channel, and
  // the log's level gate decides what lands.
  const records: Array<{
    component: string;
    message: string;
    fields: Record<string, unknown>;
  }> = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    model: "gpt-test",
    log: {
      debug: (component, message, fields) =>
        records.push({ component, message, fields: fields ?? {} }),
    },
    fetch: Object.assign(
      async () =>
        new Response(
          SSE([
            JSON.stringify({ type: "response.output_text.delta", delta: "ok" }),
          ]),
          { headers: { "content-type": "text/event-stream" } },
        ),
      { preconnect: () => {} },
    ) as unknown as typeof fetch,
  });
  for await (const chunk of provider.stream({
    messages: [{ role: "user", content: "hi" }],
  }))
    void chunk;
  expect(records.length).toBeGreaterThan(0);
  expect(records[0]).toMatchObject({
    component: "[provider]",
    message: "responses SSE",
  });
  expect(records[0]!.fields).toMatchObject({
    type: "response.output_text.delta",
  });
  // Without the channel (a bare adapter): silence, and no throw.
  const bare = new OpenAIResponsesProvider({
    apiKey: "test-key",
    model: "gpt-test",
    fetch: Object.assign(
      async () =>
        new Response(
          SSE([
            JSON.stringify({ type: "response.output_text.delta", delta: "ok" }),
          ]),
          {
            headers: { "content-type": "text/event-stream" },
          },
        ),
      { preconnect: () => {} },
    ) as unknown as typeof fetch,
  });
  for await (const chunk of bare.stream({
    messages: [{ role: "user", content: "hi" }],
  }))
    void chunk;
});
