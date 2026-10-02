import { expect, test } from "bun:test";
import {
  AnthropicProvider,
  contextEntriesToProviderMessages,
  GeminiProvider,
  normalizeRawToolCallProtocol,
  OpenAICompatibleProvider,
  providerFromKind,
  providerForModel,
  readWithIdleTimeout,
  requireNativeToolCallProtocol,
  uniqueProviderToolCallIds,
} from "../src/provider";
import type {
  ProviderStreamChunk,
  ProviderStreamRequest,
} from "../src/provider";
import { defaultConfigV3 } from "@anthelia/config";
import { ContextWindowResolver } from "../src/modelmeta";

test("raw XML-like tool protocol becomes structured calls while preserving prose", async () => {
  async function* source() {
    yield { type: "content" as const, text: "Before <tool_" };
    yield {
      type: "content" as const,
      text: "call><function=agent_attach><parameter=agentId>a6</parameter><parameter=options>{&quot;mode&quot;:&quot;fast&quot;}</parameter></function></tool_call> after",
    };
    yield { type: "done" as const };
  }
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of normalizeRawToolCallProtocol(source()))
    chunks.push(chunk);
  expect(chunks).toEqual([
    { type: "content", text: "Before " },
    { type: "content", text: " after" },
    {
      type: "tool_call",
      calls: [
        {
          id: "raw_xml_tool_0",
          name: "agent_attach",
          arguments: '{"agentId":"a6","options":{"mode":"fast"}}',
        },
      ],
    },
    { type: "done" },
  ]);
});

test("simple args XML-like tool protocol becomes a structured call", async () => {
  async function* source() {
    yield { type: "content" as const, text: "Before <edit_file><ar" };
    yield {
      type: "content" as const,
      text: "gs>{&quot;path&quot;:&quot;note.txt&quot;,&quot;content&quot;:&quot;updated&quot;}</args></edit_file> after",
    };
    yield { type: "done" as const };
  }
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of normalizeRawToolCallProtocol(source()))
    chunks.push(chunk);
  expect(chunks).toEqual([
    { type: "content", text: "Before " },
    { type: "content", text: " after" },
    {
      type: "tool_call",
      calls: [
        {
          id: "raw_xml_tool_0",
          name: "edit_file",
          arguments: '{"path":"note.txt","content":"updated"}',
        },
      ],
    },
    { type: "done" },
  ]);
});

test("raw XML normalization preserves the provider finish reason", async () => {
  async function* source() {
    yield { type: "content" as const, text: "partial" };
    yield { type: "done" as const, finishReason: "length" as const };
  }
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of normalizeRawToolCallProtocol(source()))
    chunks.push(chunk);
  expect(chunks).toEqual([
    { type: "content", text: "partial" },
    { type: "done", finishReason: "length" },
  ]);
});

test("raw XML-like tool protocol leaves malformed or incomplete blocks untouched", async () => {
  async function* source() {
    yield {
      type: "content" as const,
      text: "<tool_call><function=read_file><parameter=path>a.txt</function></tool_call>",
    };
    yield {
      type: "content" as const,
      text: " and <tool_call><function=glob><parameter=pattern>*.ts</parameter>",
    };
  }
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of normalizeRawToolCallProtocol(source()))
    chunks.push(chunk);
  expect(chunks.filter((chunk) => chunk.type === "tool_call")).toEqual([]);
  expect(
    chunks
      .filter(
        (
          chunk,
        ): chunk is Extract<(typeof chunks)[number], { type: "content" }> =>
          chunk.type === "content",
      )
      .map((chunk) => chunk.text)
      .join(""),
  ).toBe(
    "<tool_call><function=read_file><parameter=path>a.txt</function></tool_call> and <tool_call><function=glob><parameter=pattern>*.ts</parameter>",
  );
});

test("raw XML-like calls duplicate native calls only once", async () => {
  async function* source() {
    yield {
      type: "content" as const,
      text: '<tool_call><function=glob><parameter=pattern>"*.ts"</parameter></function></tool_call>',
    };
    yield {
      type: "tool_call" as const,
      calls: [
        { id: "native_1", name: "glob", arguments: '{"pattern":"*.ts"}' },
      ],
    };
  }
  const chunks = [];
  for await (const chunk of normalizeRawToolCallProtocol(source()))
    chunks.push(chunk);
  expect(chunks).toEqual([
    {
      type: "tool_call",
      calls: [
        { id: "native_1", name: "glob", arguments: '{"pattern":"*.ts"}' },
      ],
    },
  ]);
});

test("native calls with identical arguments retain distinct call IDs", async () => {
  async function* source() {
    yield {
      type: "tool_call" as const,
      calls: [
        { id: "native_1", name: "glob", arguments: '{"pattern":"*.ts"}' },
        { id: "native_2", name: "glob", arguments: '{"pattern":"*.ts"}' },
      ],
    };
  }
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of normalizeRawToolCallProtocol(source()))
    chunks.push(chunk);
  expect(chunks).toEqual([
    {
      type: "tool_call",
      calls: [
        { id: "native_1", name: "glob", arguments: '{"pattern":"*.ts"}' },
        { id: "native_2", name: "glob", arguments: '{"pattern":"*.ts"}' },
      ],
    },
  ]);
});

test("raw and native tool calls retain their source order", async () => {
  async function* source() {
    yield {
      type: "content" as const,
      text: '<tool_call><function=read_file><parameter=path>"a.ts"</parameter></function></tool_call>',
    };
    yield {
      type: "tool_call" as const,
      calls: [
        { id: "native_1", name: "glob", arguments: '{"pattern":"*.ts"}' },
      ],
    };
  }
  const chunks = [];
  for await (const chunk of normalizeRawToolCallProtocol(source()))
    chunks.push(chunk);
  expect(chunks).toEqual([
    {
      type: "tool_call",
      calls: [
        {
          id: "raw_xml_tool_0",
          name: "read_file",
          arguments: '{"path":"a.ts"}',
        },
        { id: "native_1", name: "glob", arguments: '{"pattern":"*.ts"}' },
      ],
    },
  ]);
});

test("a partial raw marker is flushed before a native event", async () => {
  async function* source() {
    yield { type: "content" as const, text: "Before <tool_" };
    yield { type: "thinking" as const, text: "checking" };
  }
  const chunks = [];
  for await (const chunk of normalizeRawToolCallProtocol(source()))
    chunks.push(chunk);
  expect(chunks).toEqual([
    { type: "content", text: "Before " },
    { type: "content", text: "<tool_" },
    { type: "thinking", text: "checking" },
  ]);
});

test("native protocol guard reports textual calls without executing them", async () => {
  async function* source() {
    yield { type: "content" as const, text: "Inspecting. <tool_" };
    yield {
      type: "content" as const,
      text: "call><function=read_file><parameter=path>a.txt</parameter></function></tool_call>",
    };
    yield { type: "done" as const, finishReason: "stop" as const };
  }
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of requireNativeToolCallProtocol(source()))
    chunks.push(chunk);
  expect(chunks).toEqual([
    { type: "content", text: "Inspecting. " },
    {
      type: "tool_protocol_violation",
      text: "<tool_call><function=read_file><parameter=path>a.txt</parameter></function></tool_call>",
    },
    { type: "done", finishReason: "stop" },
  ]);
  expect(chunks.some((chunk) => chunk.type === "tool_call")).toBe(false);
});

test("native protocol guard rejects bare function markup split across chunks", async () => {
  async function* source() {
    yield { type: "content" as const, text: "Inspecting. <func" };
    yield {
      type: "content" as const,
      text: "tion=run_shell><parameter=command>git status</parameter></function>",
    };
    yield { type: "done" as const, finishReason: "stop" as const };
  }
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of requireNativeToolCallProtocol(source()))
    chunks.push(chunk);
  expect(chunks).toEqual([
    { type: "content", text: "Inspecting. " },
    {
      type: "tool_protocol_violation",
      text: "<function=run_shell><parameter=command>git status</parameter></function>",
    },
    { type: "done", finishReason: "stop" },
  ]);
  expect(chunks.some((chunk) => chunk.type === "tool_call")).toBe(false);
});

test("native protocol guard preserves structured provider calls", async () => {
  async function* source() {
    yield {
      type: "tool_call" as const,
      calls: [
        { id: "native_1", name: "read_file", arguments: '{"path":"a.txt"}' },
      ],
    };
    yield { type: "done" as const, finishReason: "tool_calls" as const };
  }
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of requireNativeToolCallProtocol(source()))
    chunks.push(chunk);
  expect(chunks).toEqual([
    {
      type: "tool_call",
      calls: [
        { id: "native_1", name: "read_file", arguments: '{"path":"a.txt"}' },
      ],
    },
    { type: "done", finishReason: "tool_calls" },
  ]);
});

test("OpenAI-compatible provider accepts both base and complete chat endpoint URLs", async () => {
  const requested: string[] = [];
  const fetchImpl = Object.assign(
    async (input: URL | RequestInfo) => {
      requested.push(String(input));
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  for (const baseURL of [
    "https://gateway.example/v1",
    "https://gateway.example/v1/chat/completions",
  ]) {
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      model: "test-model",
      baseURL,
      fetch: fetchImpl,
    });
    for await (const _chunk of provider.stream({ messages: [] })) {
      // Drain the stream to force the request.
    }
  }
  expect(requested).toEqual([
    "https://gateway.example/v1/chat/completions",
    "https://gateway.example/v1/chat/completions",
  ]);
});

test("provider adapters map tool choice and omit tools when disabled", async () => {
  const tools = [
    {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: {} },
    },
  ];
  const bodies: Record<string, Array<Record<string, unknown>>> = {
    openai: [],
    anthropic: [],
    gemini: [],
  };
  const fetchFor = (name: keyof typeof bodies, response: string) =>
    Object.assign(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        bodies[name].push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return new Response(response, {
          headers: { "content-type": "text/event-stream" },
        });
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch;
  const providers = [
    new OpenAICompatibleProvider({
      apiKey: "key",
      model: "model",
      fetch: fetchFor("openai", "data: [DONE]\n\n"),
    }),
    new AnthropicProvider({
      apiKey: "key",
      model: "model",
      maxTokens: 1024,
      fetch: fetchFor("anthropic", "event: message_stop\ndata: {}\n\n"),
    }),
    new GeminiProvider({
      apiKey: "key",
      model: "model",
      fetch: fetchFor("gemini", "data: {}\n\n"),
    }),
  ];
  for (const provider of providers)
    for (const toolChoice of ["auto", "required", "none"] as const)
      for await (const _chunk of provider.stream({
        messages: [],
        tools,
        toolChoice,
      })) {
        // Drain each stream to force its request.
      }

  expect(bodies.openai.map((body) => body.tool_choice)).toEqual([
    "auto",
    "required",
    "none",
  ]);
  expect(bodies.openai[2]).not.toHaveProperty("tools");
  expect(bodies.anthropic.map((body) => body.tool_choice)).toEqual([
    { type: "auto" },
    { type: "any" },
    undefined,
  ]);
  expect(bodies.anthropic[2]).not.toHaveProperty("tools");
  expect(bodies.gemini.map((body) => body.toolConfig)).toEqual([
    { functionCallingConfig: { mode: "AUTO" } },
    { functionCallingConfig: { mode: "ANY" } },
    undefined,
  ]);
  expect(bodies.gemini[2]).not.toHaveProperty("tools");
});

test("configured provider resolution preserves the adapter provider identity", () => {
  const config = defaultConfigV3();
  config.providers.internal_gateway = {
    name: "Internal Gateway",
    driver: "anthropic-compatible",
    enabled: true,
    connection: { apiKey: "test-key" },
    requestDefaults: { stream: true, headers: {}, options: {} },
  };
  config.catalog.providers.internal_gateway = {
    models: {
      "review-model": {
        name: "review-model",
        status: "stable",
        source: "manual",
        capabilities: {
          toolCall: false,
          reasoning: false,
          thinking: false,
          imageInput: false,
          videoInput: false,
        },
        limits: { contextWindow: "auto", maxOutputTokens: null },
      },
    },
  };
  config.modelOverrides["internal_gateway/review-model"] = {
    enabled: true,
    name: "Review",
    requestDefaults: { temperature: null, topP: null },
    requestOptions: {},
    headers: {},
  };
  config.defaultModel = { provider: "internal_gateway", model: "review-model" };
  const provider = providerForModel(config, config.defaultModel);
  expect(provider).toBeInstanceOf(AnthropicProvider);
  expect(provider).toMatchObject({
    provider: "anthropic-compatible",
    model: "review-model",
  });
});

test("providerForModel applies the DeepSeek interleaved reasoning default", async () => {
  const config = defaultConfigV3();
  config.providers.deepseek_gateway = {
    name: "DeepSeek Gateway",
    driver: "openai-compatible",
    enabled: true,
    connection: { apiKey: "test-key" },
    requestDefaults: { stream: true, headers: {}, options: {} },
  };
  config.catalog.providers.deepseek_gateway = {
    models: {
      "deepseek-chat": {
        name: "deepseek-chat",
        status: "stable",
        source: "manual",
        capabilities: {
          toolCall: true,
          reasoning: true,
          thinking: true,
          imageInput: false,
          videoInput: false,
        },
        limits: { contextWindow: "auto", maxOutputTokens: null },
      },
    },
  };
  config.modelOverrides["deepseek_gateway/deepseek-chat"] = {
    enabled: true,
    name: "DeepSeek Chat",
    requestDefaults: { temperature: null, topP: null },
    requestOptions: {},
    headers: {},
  };
  let body: Record<string, unknown> | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  try {
    const provider = providerForModel(config, "deepseek_gateway/deepseek-chat");
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    for await (const _chunk of provider!.stream({
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read_file", arguments: "{}" }],
        },
        {
          role: "tool",
          content: "ok",
          toolCallID: "call_1",
          toolName: "read_file",
        },
      ],
    })) {
      // Drain.
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect((body?.messages as Array<Record<string, unknown>>)[0]).toMatchObject({
    role: "assistant",
    reasoning_content: "",
  });
});

test("providerForModel honors an explicit interleaved reasoning field", async () => {
  const config = defaultConfigV3();
  config.providers.interleaved_gateway = {
    name: "Interleaved Gateway",
    driver: "openai-compatible",
    enabled: true,
    connection: { apiKey: "test-key" },
    requestDefaults: { stream: true, headers: {}, options: {} },
  };
  config.catalog.providers.interleaved_gateway = {
    models: {
      "gateway-thinker": {
        name: "gateway-thinker",
        status: "stable",
        source: "manual",
        capabilities: {
          toolCall: true,
          reasoning: true,
          thinking: true,
          imageInput: false,
          videoInput: false,
          interleaved: { field: "reasoning" },
        },
        limits: { contextWindow: "auto", maxOutputTokens: null },
      },
    },
  };
  config.modelOverrides["interleaved_gateway/gateway-thinker"] = {
    enabled: true,
    name: "Gateway Thinker",
    requestDefaults: { temperature: null, topP: null },
    requestOptions: {},
    headers: {},
  };
  let body: Record<string, unknown> | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  try {
    const provider = providerForModel(
      config,
      "interleaved_gateway/gateway-thinker",
    );
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    for await (const _chunk of provider!.stream({
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read_file", arguments: "{}" }],
        },
        {
          role: "tool",
          content: "ok",
          toolCallID: "call_1",
          toolName: "read_file",
        },
      ],
    })) {
      // Drain.
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect((body?.messages as Array<Record<string, unknown>>)[0]).toMatchObject({
    role: "assistant",
    reasoning: "",
  });
  expect(
    (body?.messages as Array<Record<string, unknown>>)[0],
  ).not.toHaveProperty("reasoning_content");
});

test("Anthropic-compatible provider names use the Messages API adapter", async () => {
  const requested: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = Object.assign(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/models"))
        return Response.json({
          data: [
            {
              id: "claude-compatible-model",
              max_input_tokens: 200000,
              max_tokens: 32000,
            },
          ],
        });
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("event: message_stop\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  for (const baseURL of [
    "https://gateway.example/v1",
    "https://gateway.example/v1/messages",
  ]) {
    const provider = providerFromKind({
      provider: "anthropic-compatible",
      apiKey: "test-key",
      model: "claude-compatible-model",
      baseURL,
      fetch: fetchImpl,
    });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    for await (const _chunk of provider.stream({ messages: [] })) {
      // Drain the stream to force the request.
    }
  }
  expect(requested).toEqual([
    "https://gateway.example/v1/models",
    "https://gateway.example/v1/messages",
    "https://gateway.example/v1/models",
    "https://gateway.example/v1/messages",
  ]);
  expect(bodies.map((body) => body.max_tokens)).toEqual([32000, 32000]);
});

test("OpenAI-compatible provider preserves content and usage from the same SSE frame", async () => {
  const fetchImpl = Object.assign(
    async () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"content":"hello","reasoning_content":"think"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    model: "test-model",
    fetch: fetchImpl,
  });
  const chunks = [];
  for await (const chunk of provider.stream({ messages: [] }))
    chunks.push(chunk);
  expect(chunks).toEqual(
    expect.arrayContaining([
      { type: "usage", inputTokens: 3, outputTokens: 2 },
      { type: "thinking", text: "think", field: "reasoning_content" },
      { type: "content", text: "hello" },
    ]),
  );
});

test("OpenAI-compatible keeps reasoning_content when it shares a delta with tool_calls", async () => {
  const sse =
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            reasoning_content: "final thought",
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "read_file", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })}\n\n` + "data: [DONE]\n\n";
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of new OpenAICompatibleProvider({
    apiKey: "key",
    model: "deepseek-thinking",
    fetch: Object.assign(
      async () =>
        new Response(sse, {
          headers: { "content-type": "text/event-stream" },
        }),
      { preconnect: fetch.preconnect },
    ) as typeof fetch,
  }).stream({ messages: [{ role: "user", content: "go" }] })) {
    chunks.push(chunk);
  }
  expect(chunks).toEqual([
    {
      type: "thinking",
      text: "final thought",
      field: "reasoning_content",
    },
    {
      type: "tool_call",
      calls: [
        {
          id: "call_1",
          name: "read_file",
          arguments: "{}",
        },
      ],
    },
    { type: "done", finishReason: "tool_calls" },
  ]);
});

test("OpenAI-compatible provider maps legacy function and recipient streaming calls", async () => {
  const fetchImpl = Object.assign(
    async () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"recipient":"functions.run_shell","content":"{\\"command\\":\\"pwd"}}]}',
          "",
          'data: {"choices":[{"delta":{"content":"\\"}"},"finish_reason":"tool_calls"}]}',
          "",
          'data: {"choices":[{"delta":{"function_call":{"name":"glob","arguments":"{\\"pattern\\":\\"*.ts\\"}"}},"finish_reason":"function_call"}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    model: "test-model",
    fetch: fetchImpl,
  });
  const chunks = [];
  for await (const chunk of provider.stream({ messages: [] }))
    chunks.push(chunk);
  expect(chunks).toEqual(
    expect.arrayContaining([
      {
        type: "tool_call",
        calls: [
          {
            id: "tool_0",
            name: "run_shell",
            arguments: '{"command":"pwd"}',
          },
        ],
      },
      {
        type: "tool_call",
        calls: [
          { id: "tool_0", name: "glob", arguments: '{"pattern":"*.ts"}' },
        ],
      },
    ]),
  );
});

test("OpenAI-compatible provider accepts gateway tool-call name aliases", async () => {
  const fetchImpl = Object.assign(
    async () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_top_name","name":"glob","function":{"arguments":"{\\"pattern\\":\\"*.ts\\"}"}}]}}]}',
          "",
          'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_recipient","recipient":"functions.run_shell","function":{"arguments":"{\\"command\\":\\"pwd\\"}"}}]},"finish_reason":"tool_calls"}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    model: "test-model",
    fetch: fetchImpl,
  });
  const chunks = [];
  for await (const chunk of provider.stream({ messages: [] }))
    chunks.push(chunk);
  expect(chunks).toEqual(
    expect.arrayContaining([
      {
        type: "tool_call",
        calls: [
          {
            id: "call_top_name",
            name: "glob",
            arguments: '{"pattern":"*.ts"}',
          },
          {
            id: "call_recipient",
            name: "run_shell",
            arguments: '{"command":"pwd"}',
          },
        ],
      },
    ]),
  );
});

test("OpenAI-compatible provider waits for a later function name fragment", async () => {
  const fetchImpl = Object.assign(
    async () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"README"}}]}}]}',
          "",
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read_file","arguments":".md\\"}"}}]},"finish_reason":"tool_calls"}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    model: "test-model",
    fetch: fetchImpl,
  });
  const chunks = [];
  for await (const chunk of provider.stream({ messages: [] }))
    chunks.push(chunk);
  expect(chunks).toEqual([
    {
      type: "tool_call",
      calls: [
        {
          id: "tool_0",
          name: "read_file",
          arguments: '{"path":"README.md"}',
        },
      ],
    },
    { type: "done", finishReason: "tool_calls" },
  ]);
});

test("OpenAI-compatible provider normalizes alternate gateway function fields", async () => {
  const fetchImpl = Object.assign(
    async () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_function","function":"functions.read_file","input":"{\\"path\\":\\"README.md\\"}"},{"index":1,"id":"call_alias","tool_name":"tools.glob","arguments":"{\\"pattern\\":\\"*.ts\\"}"}]},"finish_reason":"tool_calls"}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    model: "test-model",
    fetch: fetchImpl,
  });
  const chunks = [];
  for await (const chunk of provider.stream({ messages: [] }))
    chunks.push(chunk);
  expect(chunks).toEqual(
    expect.arrayContaining([
      {
        type: "tool_call",
        calls: [
          {
            id: "call_function",
            name: "read_file",
            arguments: '{"path":"README.md"}',
          },
          {
            id: "call_alias",
            name: "glob",
            arguments: '{"pattern":"*.ts"}',
          },
        ],
      },
    ]),
  );
});

test("OpenAI-compatible provider sends active profile request parameters safely", async () => {
  let headers: Headers | undefined;
  let body: Record<string, unknown> | undefined;
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    model: "test-model",
    authHeader: "x-provider-key",
    customHeaders: { "x-request-source": "natalia" },
    temperature: 0.2,
    maxTokens: 4096,
    topP: 0.9,
    reasoningEffort: "high",
    thinkingEnabled: true,
    fetch: fetchImpl,
  });
  for await (const _chunk of provider.stream({ messages: [] })) {
    // Drain the stream to force the request.
  }
  expect(headers?.get("x-provider-key")).toBe("Bearer test-key");
  expect(headers?.get("x-request-source")).toBe("natalia");
  expect(body).toMatchObject({
    temperature: 0.2,
    max_tokens: 4096,
    top_p: 0.9,
    reasoning_effort: "high",
    thinking_enabled: true,
  });
});

test("OpenAI-compatible provider omits unsupported reasoning and thinking request options", async () => {
  let body: Record<string, unknown> | undefined;
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    model: "test-model",
    reasoningEffort: undefined,
    thinkingEnabled: undefined,
    fetch: fetchImpl,
  });
  for await (const _chunk of provider.stream({ messages: [] })) {
    // Drain the stream.
  }
  expect(body).not.toHaveProperty("reasoning_effort");
  expect(body).not.toHaveProperty("thinking_enabled");
});

test("providers lower image parts to their native request formats", async () => {
  const request = {
    messages: [
      {
        role: "user" as const,
        content: "inspect",
        images: [
          {
            mediaType: "image/png" as const,
            dataURL: "data:image/png;base64,cG5n",
          },
        ],
      },
    ],
  };
  const bodies: Record<string, Record<string, unknown>> = {};
  const fetchFor = (name: string) =>
    Object.assign(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        bodies[name] = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        return new Response("data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch;
  for await (const _chunk of new AnthropicProvider({
    apiKey: "key",
    model: "model",
    fetch: fetchFor("anthropic"),
  }).stream(request)) {
    // Drain.
  }
  for await (const _chunk of new GeminiProvider({
    apiKey: "key",
    model: "model",
    fetch: fetchFor("gemini"),
  }).stream(request)) {
    // Drain.
  }
  const anthropic = bodies.anthropic.messages as Array<{
    content: Array<{ type?: string; source?: { data?: string } }>;
  }>;
  const gemini = bodies.gemini.contents as Array<{
    parts: Array<{ inlineData?: { mimeType?: string; data?: string } }>;
  }>;
  expect(
    anthropic[0]?.content.find((part) => part.type === "image"),
  ).toMatchObject({
    source: { type: "base64", media_type: "image/png", data: "cG5n" },
  });
  expect(gemini[0]?.parts.find((part) => part.inlineData)).toMatchObject({
    inlineData: { mimeType: "image/png", data: "cG5n" },
  });
});

test("provider adapters materialize durable attachment refs through the resolver", async () => {
  let resolved = 0;
  const request: ProviderStreamRequest = {
    messages: [
      {
        role: "user",
        content: "inspect",
        images: [
          {
            id: "att_1",
            path: ".natalia/attachments/att_1-image.png",
            filename: "image.png",
            mediaType: "image/png",
            byteLength: 8,
            sha256: "image-hash",
          },
        ],
      },
    ],
    resolveAttachment: async (attachment) => {
      resolved += 1;
      expect(attachment.id).toBe("att_1");
      return "data:image/png;base64,cG5n";
    },
  };
  let body: Record<string, unknown> | undefined;
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  for await (const _chunk of new AnthropicProvider({
    apiKey: "key",
    model: "model",
    fetch: fetchImpl,
  }).stream(request)) {
    // Drain.
  }
  expect(resolved).toBe(1);
  const messages = body?.messages as Array<{
    content: Array<{ type?: string; source?: { data?: string } }>;
  }>;
  expect(
    messages[0]?.content.find((part) => part.type === "image"),
  ).toMatchObject({
    source: { type: "base64", media_type: "image/png", data: "cG5n" },
  });
});

test("OpenAI-compatible forwards assistant reasoning_content on tool-call follow-up", async () => {
  let body: Record<string, unknown> | undefined;
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new OpenAICompatibleProvider({
    apiKey: "key",
    model: "deepseek-thinking",
    fetch: fetchImpl,
  });
  for await (const _chunk of provider.stream({
    messages: [
      {
        role: "assistant",
        content: "",
        reasoningContent: "I should call the tool first.",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: "{}" }],
      },
      {
        role: "tool",
        content: "ok",
        toolCallID: "call_1",
        toolName: "read_file",
      },
    ],
  })) {
    // Drain.
  }
  expect((body?.messages as Array<Record<string, unknown>>)[0]).toMatchObject({
    role: "assistant",
    reasoning_content: "I should call the tool first.",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: "{}" },
      },
    ],
  });
});

test("OpenAI-compatible keeps the provider reasoning field on assistant replay", async () => {
  let body: Record<string, unknown> | undefined;
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new OpenAICompatibleProvider({
    apiKey: "key",
    model: "gateway-thinking",
    fetch: fetchImpl,
  });
  for await (const _chunk of provider.stream({
    messages: [
      {
        role: "assistant",
        content: "",
        reasoningContent: "plan",
        reasoningField: "reasoning",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: "{}" }],
      },
      {
        role: "tool",
        content: "ok",
        toolCallID: "call_1",
        toolName: "read_file",
      },
    ],
  })) {
    // Drain.
  }
  expect((body?.messages as Array<Record<string, unknown>>)[0]).toMatchObject({
    role: "assistant",
    reasoning: "plan",
  });
  expect(
    (body?.messages as Array<Record<string, unknown>>)[0],
  ).not.toHaveProperty("reasoning_content");
});

test("OpenAI-compatible interleaved replay sends an empty reasoning field", async () => {
  let body: Record<string, unknown> | undefined;
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new OpenAICompatibleProvider({
    apiKey: "key",
    model: "deepseek-chat",
    interleavedReasoningField: "reasoning_content",
    fetch: fetchImpl,
  });
  for await (const _chunk of provider.stream({
    messages: [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: "{}" }],
      },
      {
        role: "tool",
        content: "ok",
        toolCallID: "call_1",
        toolName: "read_file",
      },
    ],
  })) {
    // Drain.
  }
  expect((body?.messages as Array<Record<string, unknown>>)[0]).toMatchObject({
    role: "assistant",
    reasoning_content: "",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: "{}" },
      },
    ],
  });
});

test("OpenAI-compatible preserves encrypted reasoning_details across tool calls", async () => {
  const reasoningDetail = {
    type: "reasoning.encrypted",
    id: "call_1",
    data: "encrypted-signature",
  };
  let body: Record<string, unknown> | undefined;
  let calls = 0;
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      calls += 1;
      if (calls === 1)
        return new Response(
          [
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [reasoningDetail] } }] })}`,
            "",
            `data: ${JSON.stringify({
              choices: [
                {
                  finish_reason: "tool_calls",
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        type: "function",
                        function: {
                          name: "read_file",
                          arguments: "{}",
                        },
                      },
                    ],
                  },
                },
              ],
            })}`,
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new OpenAICompatibleProvider({
    apiKey: "key",
    model: "gemini-test",
    fetch: fetchImpl,
  });
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of provider.stream({ messages: [] }))
    chunks.push(chunk);
  const toolCall = chunks.find(
    (chunk): chunk is Extract<ProviderStreamChunk, { type: "tool_call" }> =>
      chunk.type === "tool_call",
  )?.calls[0];
  expect(toolCall?.thoughtSignature).toBe(JSON.stringify(reasoningDetail));
  if (!toolCall) throw new Error("expected a streamed tool call");
  for await (const _chunk of provider.stream({
    messages: [
      { role: "assistant", content: "", toolCalls: [toolCall] },
      {
        role: "tool",
        content: "ok",
        toolCallID: "call_1",
        toolName: "read_file",
      },
    ],
  })) {
    // Drain.
  }
  expect((body?.messages as Array<Record<string, unknown>>)[0]).toMatchObject({
    role: "assistant",
    reasoning_details: [reasoningDetail],
  });
});

test("OpenAI-compatible accumulates OpenRouter reasoning_details for replay", async () => {
  let body: Record<string, unknown> | undefined;
  let calls = 0;
  const firstDetail = {
    type: "reasoning.text",
    text: "think",
    index: 0,
  };
  const secondDetail = {
    type: "reasoning.text",
    text: "ing",
    signature: "sig",
    format: "anthropic-claude-v1",
    index: 0,
  };
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      calls += 1;
      if (calls === 1)
        return new Response(
          [
            `data: ${JSON.stringify({
              choices: [{ delta: { reasoning_details: [firstDetail] } }],
            })}`,
            "",
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    reasoning_details: [secondDetail],
                    content: "answer",
                  },
                  finish_reason: "stop",
                },
              ],
            })}`,
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new OpenAICompatibleProvider({
    apiKey: "key",
    model: "openrouter-test",
    interleavedReasoningField: "reasoning_content",
    fetch: fetchImpl,
  });
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of provider.stream({ messages: [] }))
    chunks.push(chunk);
  const done = chunks.find(
    (chunk): chunk is Extract<ProviderStreamChunk, { type: "done" }> =>
      chunk.type === "done",
  );
  expect(done?.providerMetadata).toEqual({
    openrouter: {
      reasoning_details: [
        {
          type: "reasoning.text",
          text: "thinking",
          signature: "sig",
          format: "anthropic-claude-v1",
          index: 0,
        },
      ],
    },
  });
  for await (const _chunk of provider.stream({
    messages: [
      {
        role: "assistant",
        content: "answer",
        providerMetadata: done?.providerMetadata,
      },
    ],
  })) {
    // Drain.
  }
  const assistant = (body?.messages as Array<Record<string, unknown>>)[0];
  expect(assistant).toMatchObject({
    role: "assistant",
    reasoning_details: [
      {
        type: "reasoning.text",
        text: "thinking",
        signature: "sig",
        format: "anthropic-claude-v1",
        index: 0,
      },
    ],
  });
  expect(assistant).not.toHaveProperty("reasoning_content");
});

test("OpenAI-compatible preserves reasoning_opaque for replay", async () => {
  let body: Record<string, unknown> | undefined;
  let calls = 0;
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      calls += 1;
      if (calls === 1)
        return new Response(
          [
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    reasoning_text: "think",
                    reasoning_opaque: "opaque-signature",
                  },
                },
              ],
            })}`,
            "",
            `data: ${JSON.stringify({
              choices: [
                {
                  finish_reason: "tool_calls",
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        type: "function",
                        function: { name: "read_file", arguments: "{}" },
                      },
                    ],
                  },
                },
              ],
            })}`,
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new OpenAICompatibleProvider({
    apiKey: "key",
    model: "copilot-test",
    fetch: fetchImpl,
  });
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of provider.stream({ messages: [] }))
    chunks.push(chunk);
  expect(chunks).toContainEqual({
    type: "thinking",
    text: "think",
    field: "reasoning_text",
  });
  expect(chunks).toContainEqual({
    type: "thinking",
    text: "",
    field: "reasoning_text",
    signature: "opaque-signature",
  });
  const toolCall = chunks.find(
    (chunk): chunk is Extract<ProviderStreamChunk, { type: "tool_call" }> =>
      chunk.type === "tool_call",
  )?.calls[0];
  if (!toolCall) throw new Error("expected a streamed tool call");
  for await (const _chunk of provider.stream({
    messages: [
      {
        role: "assistant",
        content: "",
        reasoningContent: "think",
        reasoningField: "reasoning_text",
        reasoningSignature: "opaque-signature",
        toolCalls: [toolCall],
      },
      {
        role: "tool",
        content: "ok",
        toolCallID: "call_1",
        toolName: "read_file",
      },
    ],
  })) {
    // Drain.
  }
  expect((body?.messages as Array<Record<string, unknown>>)[0]).toMatchObject({
    role: "assistant",
    reasoning_text: "think",
    reasoning_opaque: "opaque-signature",
  });
});

test("Anthropic forwards signed thinking blocks on assistant tool-call replay", async () => {
  let body: Record<string, unknown> | undefined;
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  for await (const _chunk of new AnthropicProvider({
    apiKey: "key",
    model: "claude-thinking",
    fetch: fetchImpl,
  }).stream({
    messages: [
      {
        role: "assistant",
        content: "",
        reasoningContent: "inspect the workspace",
        reasoningSignature: "signed-thinking",
        toolCalls: [{ id: "toolu_1", name: "read_file", arguments: "{}" }],
      },
      {
        role: "tool",
        content: "ok",
        toolCallID: "toolu_1",
        toolName: "read_file",
      },
    ],
  })) {
    // Drain.
  }
  expect((body?.messages as Array<{ content: unknown }>)[0]?.content).toEqual([
    {
      type: "thinking",
      thinking: "inspect the workspace",
      signature: "signed-thinking",
    },
    {
      type: "tool_use",
      id: "toolu_1",
      name: "read_file",
      input: {},
    },
  ]);
});

test("Gemini forwards thought signatures on assistant tool-call replay", async () => {
  let body: Record<string, unknown> | undefined;
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  for await (const _chunk of new GeminiProvider({
    apiKey: "key",
    model: "gemini-3-pro",
    fetch: fetchImpl,
  }).stream({
    messages: [
      {
        role: "assistant",
        content: "",
        reasoningContent: "internal thought",
        reasoningSignature: "thought-sig",
        toolCalls: [
          {
            id: "call_1",
            name: "read_file",
            arguments: "{}",
            thoughtSignature: "call-sig",
          },
        ],
      },
      {
        role: "tool",
        content: "ok",
        toolCallID: "call_1",
        toolName: "read_file",
      },
    ],
  })) {
    // Drain.
  }
  const contents = body?.contents as Array<{
    parts: Array<Record<string, unknown>>;
  }>;
  expect(contents[0]?.parts).toEqual([
    {
      thought: true,
      text: "internal thought",
      thoughtSignature: "thought-sig",
    },
    {
      functionCall: { name: "read_file", args: {} },
      thoughtSignature: "call-sig",
    },
  ]);
});

test("Gemini preserves a text part thoughtSignature across replay", async () => {
  let body: Record<string, unknown> | undefined;
  let calls = 0;
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      calls += 1;
      if (calls === 1)
        return new Response(
          [
            `data: ${JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: "visible", thoughtSignature: "text-sig" }],
                  },
                },
              ],
            })}`,
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new GeminiProvider({
    apiKey: "key",
    model: "gemini-3-pro",
    fetch: fetchImpl,
  });
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of provider.stream({ messages: [] }))
    chunks.push(chunk);
  expect(chunks).toContainEqual({
    type: "content",
    text: "visible",
    textSignature: "text-sig",
  });
  for await (const _chunk of provider.stream({
    messages: [
      {
        role: "assistant",
        content: "visible",
        textSignature: "text-sig",
      },
    ],
  })) {
    // Drain.
  }
  const contents = body?.contents as Array<{
    parts: Array<Record<string, unknown>>;
  }>;
  expect(contents[0]?.parts).toEqual([
    { text: "visible", thoughtSignature: "text-sig" },
  ]);
});

test("Gemini preserves multiple thought signatures in order", async () => {
  let body: Record<string, unknown> | undefined;
  let calls = 0;
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      calls += 1;
      if (calls === 1)
        return new Response(
          [
            `data: ${JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        thought: true,
                        text: "plan A",
                        thoughtSignature: "sig-A",
                      },
                      {
                        thought: true,
                        text: "plan B",
                        thoughtSignature: "sig-B",
                      },
                      {
                        functionCall: { name: "read_file", args: {} },
                        thoughtSignature: "call-sig",
                      },
                    ],
                  },
                },
              ],
            })}`,
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new GeminiProvider({
    apiKey: "key",
    model: "gemini-3-pro",
    fetch: fetchImpl,
  });
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of provider.stream({ messages: [] }))
    chunks.push(chunk);
  expect(chunks).toContainEqual({
    type: "thinking",
    text: "plan A",
    signature: "sig-A",
    blockIndex: 0,
  });
  expect(chunks).toContainEqual({
    type: "thinking",
    text: "plan B",
    signature: "sig-B",
    blockIndex: 1,
  });
  for await (const _chunk of provider.stream({
    messages: [
      {
        role: "assistant",
        content: "",
        reasoningBlocks: [
          { text: "plan A", signature: "sig-A" },
          { text: "plan B", signature: "sig-B" },
        ],
        toolCalls: [
          {
            id: "call_1",
            name: "read_file",
            arguments: "{}",
            thoughtSignature: "call-sig",
          },
        ],
      },
      {
        role: "tool",
        content: "ok",
        toolCallID: "call_1",
        toolName: "read_file",
      },
    ],
  })) {
    // Drain.
  }
  const contents = body?.contents as Array<{
    parts: Array<Record<string, unknown>>;
  }>;
  expect(contents[0]?.parts).toEqual([
    { thought: true, text: "plan A", thoughtSignature: "sig-A" },
    { thought: true, text: "plan B", thoughtSignature: "sig-B" },
    {
      functionCall: { name: "read_file", args: {} },
      thoughtSignature: "call-sig",
    },
  ]);
});

test("Gemini replays content parts in provider order", async () => {
  let body: Record<string, unknown> | undefined;
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  for await (const _chunk of new GeminiProvider({
    apiKey: "key",
    model: "gemini-3-pro",
    fetch: fetchImpl,
  }).stream({
    messages: [
      {
        role: "assistant",
        content: "fallback text",
        textSignature: "text-sig",
        contentParts: [
          { type: "thinking", text: "plan A", signature: "sig-A" },
          { type: "text", text: "visible", textSignature: "text-sig" },
          {
            type: "tool_call",
            id: "call_1",
            name: "read_file",
            arguments: "{}",
            thoughtSignature: "call-sig",
          },
        ],
        toolCalls: [
          {
            id: "call_1",
            name: "read_file",
            arguments: "{}",
            thoughtSignature: "call-sig",
          },
        ],
      },
      {
        role: "tool",
        content: "ok",
        toolCallID: "call_1",
        toolName: "read_file",
      },
    ],
  })) {
    // Drain.
  }
  const contents = body?.contents as Array<{
    parts: Array<Record<string, unknown>>;
  }>;
  expect(contents[0]?.parts).toEqual([
    { thought: true, text: "plan A", thoughtSignature: "sig-A" },
    { text: "visible", thoughtSignature: "text-sig" },
    {
      functionCall: { name: "read_file", args: {} },
      thoughtSignature: "call-sig",
    },
  ]);
});

test("Anthropic parser exposes signature deltas for replay", async () => {
  const sse = [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "plan" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig" },
    },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of new AnthropicProvider({
    apiKey: "key",
    model: "claude-thinking",
    fetch: Object.assign(
      async () =>
        new Response(sse, {
          headers: { "content-type": "text/event-stream" },
        }),
      { preconnect: fetch.preconnect },
    ) as typeof fetch,
  }).stream({ messages: [{ role: "user", content: "go" }] })) {
    chunks.push(chunk);
  }
  expect(chunks).toEqual([
    { type: "thinking", text: "plan", blockIndex: 0 },
    { type: "thinking", text: "", signature: "sig", blockIndex: 0 },
    { type: "done", finishReason: "stop" },
  ]);
});

test("Anthropic parser keeps multiple thinking blocks distinct", async () => {
  const sse = [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "plan A" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig-A" },
    },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "thinking", thinking: "plan B" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "signature_delta", signature: "sig-B" },
    },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of new AnthropicProvider({
    apiKey: "key",
    model: "claude-thinking",
    fetch: Object.assign(
      async () =>
        new Response(sse, {
          headers: { "content-type": "text/event-stream" },
        }),
      { preconnect: fetch.preconnect },
    ) as typeof fetch,
  }).stream({ messages: [{ role: "user", content: "go" }] })) {
    chunks.push(chunk);
  }
  expect(chunks).toEqual([
    { type: "thinking", text: "plan A", blockIndex: 0 },
    { type: "thinking", text: "", signature: "sig-A", blockIndex: 0 },
    { type: "thinking", text: "plan B", blockIndex: 1 },
    { type: "thinking", text: "", signature: "sig-B", blockIndex: 1 },
    { type: "done", finishReason: "stop" },
  ]);
});

test("Anthropic replays multiple signed thinking blocks in order", async () => {
  let body: Record<string, unknown> | undefined;
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  for await (const _chunk of new AnthropicProvider({
    apiKey: "key",
    model: "claude-thinking",
    fetch: fetchImpl,
  }).stream({
    messages: [
      {
        role: "assistant",
        content: "",
        reasoningBlocks: [
          { text: "plan A", signature: "sig-A" },
          { text: "plan B", signature: "sig-B" },
          { signature: "redacted-data", redacted: true },
        ],
        toolCalls: [{ id: "toolu_1", name: "read_file", arguments: "{}" }],
      },
      {
        role: "tool",
        content: "ok",
        toolCallID: "toolu_1",
        toolName: "read_file",
      },
    ],
  })) {
    // Drain.
  }
  expect((body?.messages as Array<{ content: unknown }>)[0]?.content).toEqual([
    { type: "thinking", thinking: "plan A", signature: "sig-A" },
    { type: "thinking", thinking: "plan B", signature: "sig-B" },
    { type: "redacted_thinking", data: "redacted-data" },
    {
      type: "tool_use",
      id: "toolu_1",
      name: "read_file",
      input: {},
    },
  ]);
});

test("Anthropic replays content parts in provider order", async () => {
  let body: Record<string, unknown> | undefined;
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  for await (const _chunk of new AnthropicProvider({
    apiKey: "key",
    model: "claude-thinking",
    fetch: fetchImpl,
  }).stream({
    messages: [
      {
        role: "assistant",
        content: "fallback text",
        contentParts: [
          { type: "thinking", text: "plan", signature: "sig-A" },
          { type: "text", text: "visible" },
          {
            type: "tool_call",
            id: "toolu_1",
            name: "read_file",
            arguments: "{}",
            thoughtSignature: "call-sig",
          },
        ],
        toolCalls: [
          {
            id: "toolu_1",
            name: "read_file",
            arguments: "{}",
            thoughtSignature: "call-sig",
          },
        ],
      },
      {
        role: "tool",
        content: "ok",
        toolCallID: "toolu_1",
        toolName: "read_file",
      },
    ],
  })) {
    // Drain.
  }
  expect((body?.messages as Array<{ content: unknown }>)[0]?.content).toEqual([
    { type: "thinking", thinking: "plan", signature: "sig-A" },
    { type: "text", text: "visible" },
    { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
  ]);
});

test("Gemini parser exposes thought signatures on thinking and tool-call parts", async () => {
  const sse = [
    {
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: "plan", thoughtSignature: "thought-sig" },
              {
                functionCall: { name: "read_file", args: {} },
                thoughtSignature: "call-sig",
              },
            ],
          },
        },
      ],
    },
    { candidates: [{ finishReason: "STOP" }] },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of new GeminiProvider({
    apiKey: "key",
    model: "gemini-3-pro",
    fetch: Object.assign(
      async () =>
        new Response(sse, {
          headers: { "content-type": "text/event-stream" },
        }),
      { preconnect: fetch.preconnect },
    ) as typeof fetch,
  }).stream({ messages: [{ role: "user", content: "go" }] })) {
    chunks.push(chunk);
  }
  expect(chunks).toEqual([
    {
      type: "thinking",
      text: "plan",
      signature: "thought-sig",
      blockIndex: 0,
    },
    {
      type: "tool_call",
      calls: [
        {
          id: "gemini_0",
          name: "read_file",
          arguments: "{}",
          thoughtSignature: "call-sig",
        },
      ],
    },
    { type: "done", finishReason: "stop" },
  ]);
});

test("Gemini lowers videos while Anthropic and OpenAI-compatible declare no video support", async () => {
  const request = {
    messages: [
      {
        role: "user" as const,
        content: "watch",
        videos: [
          {
            mediaType: "video/mp4" as const,
            dataURL: "data:video/mp4;base64,bXA0",
          },
        ],
      },
    ],
  };
  let geminiBody: Record<string, unknown> | undefined;
  const fetchFor = (name: string) =>
    Object.assign(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        if (name === "gemini")
          geminiBody = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
        return new Response("data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch;
  expect(
    new OpenAICompatibleProvider({ apiKey: "key", model: "model" }).videoInput,
  ).toBe(false);
  expect(
    new AnthropicProvider({
      apiKey: "key",
      model: "model",
      fetch: fetchFor("anthropic"),
    }).videoInput,
  ).toBe(false);
  for await (const _chunk of new GeminiProvider({
    apiKey: "key",
    model: "model",
    fetch: fetchFor("gemini"),
  }).stream(request)) {
    // Drain.
  }
  const gemini = (geminiBody as { contents?: Array<{ parts?: unknown[] }> })
    ?.contents;
  const parts = (gemini?.[0]?.parts ?? []) as Array<{
    inlineData?: { mimeType?: string; data?: string };
  }>;
  expect(parts.find((part) => part.inlineData)).toMatchObject({
    inlineData: { mimeType: "video/mp4", data: "bXA0" },
  });
});

test("Gemini function responses retain the original function name", async () => {
  let body: Record<string, unknown> | undefined;
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new GeminiProvider({
    apiKey: "key",
    model: "model",
    fetch: fetchImpl,
  });
  for await (const _chunk of provider.stream({
    messages: [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "workspace_read", arguments: "{}" }],
      },
      {
        role: "tool",
        toolCallID: "call_1",
        toolName: "workspace_read",
        content: "result",
      },
    ],
  })) {
    // Drain.
  }
  const contents = body?.contents as Array<{
    parts: Array<{ functionResponse?: { name?: string } }>;
  }>;
  expect(contents[1]?.parts[0]?.functionResponse?.name).toBe("workspace_read");
});

test("provider stream idle timeout cancels a stalled SSE reader with typed timeout", async () => {
  let cancelled = false;
  const reader = {
    read: async () => await new Promise<never>(() => undefined),
    cancel: async () => {
      cancelled = true;
    },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  await expect(readWithIdleTimeout(reader, 5)).rejects.toMatchObject({
    kind: "timeout",
    message: expect.stringContaining("stream idle timeout"),
  });
  expect(cancelled).toBe(true);
});

test("OpenAI-compatible catalog discovery keeps credentials out of URLs and feeds context resolution", async () => {
  let requested = "";
  let authorization = "";
  const fetchImpl = Object.assign(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      requested = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({
        data: [{ id: "catalog-model", context_window: 123456 }],
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new OpenAICompatibleProvider({
    apiKey: "catalog-secret",
    model: "catalog-model",
    baseURL: "https://gateway.example/v1",
    fetch: fetchImpl,
  });
  expect(await provider.listModels()).toEqual([
    { id: "catalog-model", contextWindow: 123456, inputTokenLimit: undefined },
  ]);
  expect(requested).toBe("https://gateway.example/v1/models");
  expect(requested).not.toContain("catalog-secret");
  expect(authorization).toBe("Bearer catalog-secret");
  expect(
    (
      await new ContextWindowResolver().resolve({
        provider: provider.provider,
        model: provider.model,
        providerAdapter: provider,
      })
    ).tokens,
  ).toBe(123456);
});

test("durable tool result context preserves its tool_call_id for the next turn", () => {
  const messages = contextEntriesToProviderMessages([
    {
      id: "call_1",
      role: "tool_call",
      content: 'read_file {"path":"hello.txt"}',
      pairID: "provider_call_1",
    },
    {
      id: "result_1",
      role: "tool_result",
      content: "hello",
      pairID: "provider_call_1",
    },
  ]);
  expect(messages).toEqual([
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "provider_call_1",
          name: "read_file",
          arguments: '{"path":"hello.txt"}',
        },
      ],
    },
    { role: "tool", toolCallID: "provider_call_1", content: "hello" },
  ]);
});

test("durable context restores reasoning and tool thought signatures", () => {
  const messages = contextEntriesToProviderMessages([
    {
      id: "call_1",
      role: "tool_call",
      content: 'read_file {"path":"hello.txt"}',
      pairID: "provider_call_1",
      reasoningContent: "need to inspect",
      reasoningField: "reasoning_content",
      thoughtSignature: "tool-sig",
    },
    {
      id: "result_1",
      role: "tool_result",
      content: "hello",
      pairID: "provider_call_1",
    },
  ]);
  expect(messages[0]).toMatchObject({
    role: "assistant",
    reasoningContent: "need to inspect",
    reasoningField: "reasoning_content",
    toolCalls: [
      {
        id: "provider_call_1",
        name: "read_file",
        arguments: '{"path":"hello.txt"}',
        thoughtSignature: "tool-sig",
      },
    ],
  });
});

test("durable parallel tool calls are grouped before all tool results", () => {
  const messages = contextEntriesToProviderMessages([
    {
      id: "call_1",
      role: "tool_call",
      content: 'read_file {"path":"a.txt"}',
      pairID: "provider_call_1",
    },
    {
      id: "call_2",
      role: "tool_call",
      content: 'read_file {"path":"b.txt"}',
      pairID: "provider_call_2",
    },
    {
      id: "result_1",
      role: "tool_result",
      content: "a",
      pairID: "provider_call_1",
    },
    {
      id: "result_2",
      role: "tool_result",
      content: "b",
      pairID: "provider_call_2",
    },
  ]);

  expect(messages).toEqual([
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "provider_call_1",
          name: "read_file",
          arguments: '{"path":"a.txt"}',
        },
        {
          id: "provider_call_2",
          name: "read_file",
          arguments: '{"path":"b.txt"}',
        },
      ],
    },
    { role: "tool", toolCallID: "provider_call_1", content: "a" },
    { role: "tool", toolCallID: "provider_call_2", content: "b" },
  ]);
});

test("durable assistant text stays on the tool-call message", () => {
  expect(
    contextEntriesToProviderMessages([
      { id: "assistant", role: "assistant", content: "I will inspect it." },
      {
        id: "call",
        role: "tool_call",
        content: 'read_file {"path":"a.txt"}',
        pairID: "provider_call",
      },
      {
        id: "result",
        role: "tool_result",
        content: "a",
        pairID: "provider_call",
      },
    ]),
  ).toEqual([
    {
      role: "assistant",
      content: "I will inspect it.",
      toolCalls: [
        {
          id: "provider_call",
          name: "read_file",
          arguments: '{"path":"a.txt"}',
        },
      ],
    },
    { role: "tool", toolCallID: "provider_call", content: "a" },
  ]);
});

test("durable context omits interrupted tool calls without results", () => {
  expect(
    contextEntriesToProviderMessages([
      {
        id: "call_orphan",
        role: "tool_call",
        content: 'read_file {"path":"missing.txt"}',
        pairID: "provider_call_orphan",
      },
      { id: "user", role: "user", content: "continue" },
    ]),
  ).toEqual([{ role: "user", content: "continue" }]);
});

test("Anthropic provider streams text usage and tool calls", async () => {
  let body: Record<string, unknown> | undefined;
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        [
          'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tool_1","name":"read_file"}}',
          "",
          'data: {"type":"input_json_delta","delta":{"partial_json":"{\\\"path\\\":\\\"a.txt\\\"}"}}',
          "",
          'data: {"type":"content_block_delta","delta":{"text":"hello"}}',
          "",
          'data: {"type":"message_delta","usage":{"input_tokens":5,"output_tokens":7}}',
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    model: "claude-test",
    fetch: fetchImpl,
    // The tool breakpoint is a declared extension; this test opts in.
    capabilities: { supportsCacheControlOnTools: true },
  });
  const chunks = [];
  for await (const chunk of provider.stream({
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "read_file", description: "read", parameters: {} }],
  }))
    chunks.push(chunk);
  // ADR E: only the LAST tool schema carries a cache breakpoint.
  const anthropicTools = body?.["tools"] as Array<{
    name: string;
    cache_control?: unknown;
  }>;
  expect(anthropicTools).toHaveLength(1);
  // A single tool is the last tool, so it carries the prefix breakpoint.
  expect(anthropicTools[0]!.cache_control).toEqual({ type: "ephemeral" });
  expect(chunks).toEqual(
    expect.arrayContaining([
      { type: "content", text: "hello" },
      { type: "usage", inputTokens: 5, outputTokens: 7 },
      {
        type: "tool_call",
        calls: [
          { id: "tool_1", name: "read_file", arguments: '{"path":"a.txt"}' },
        ],
      },
    ]),
  );
});

test("Anthropic provider streams thinking variants without polluting tool JSON at fragmented CRLF EOF", async () => {
  const encoder = new TextEncoder();
  const events = [
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"plan"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" more","partial_json":"{\\"ignored\\":true}"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"reasoning_content":" compat"}}',
    'data: {"choices":[{"delta":{"reasoning_content":" gateway","content":" choice text"}}]}',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_1","name":"read_file"}}',
    'data: {"type":"content_block_start","index":2,"content_block":{"type":"text"}}',
    'data: {"type":"content_block_delta","index":2,"delta":{"text":"hello"}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":5,"output_tokens":7}}',
    'data: {"type":"input_json_delta","index":1,"delta":{"partial_json":"{\\"path\\":\\"a.txt\\"}"}}',
  ].join("\r\n\r\n");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < events.length; index += 17)
        controller.enqueue(encoder.encode(events.slice(index, index + 17)));
      controller.close();
    },
  });
  const fetchImpl = Object.assign(
    async () =>
      new Response(body, {
        headers: { "content-type": "text/event-stream" },
      }),
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    model: "claude-test",
    maxTokens: 4096,
    fetch: fetchImpl,
  });
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of provider.stream({ messages: [] }))
    chunks.push(chunk);
  expect(chunks).toEqual([
    { type: "thinking", text: "plan", blockIndex: 0 },
    { type: "thinking", text: " more", blockIndex: 0 },
    { type: "thinking", text: " compat", blockIndex: 0 },
    { type: "thinking", text: " gateway", blockIndex: 0 },
    { type: "content", text: " choice text" },
    { type: "content", text: "hello" },
    { type: "usage", inputTokens: 5, outputTokens: 7 },
    {
      type: "tool_call",
      calls: [
        { id: "tool_1", name: "read_file", arguments: '{"path":"a.txt"}' },
      ],
    },
    { type: "done", finishReason: "tool_calls" },
  ]);
});

test("Anthropic thinking request is opt-in, validates its default budget, and honors an explicit budget", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  for (const options of [
    { thinkingEnabled: false },
    { thinkingEnabled: true },
    { thinkingEnabled: true, thinkingBudgetTokens: 2048 },
  ]) {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-test",
      maxTokens: 4096,
      temperature: 0.2,
      fetch: fetchImpl,
      ...options,
    });
    for await (const _chunk of provider.stream({ messages: [] })) {
      // Drain the stream to record the request.
    }
  }
  expect(bodies[0]).not.toHaveProperty("thinking");
  expect(bodies[0]?.temperature).toBe(0.2);
  expect(bodies[1]?.thinking).toEqual({
    type: "enabled",
    budget_tokens: 1024,
  });
  expect(bodies[2]?.thinking).toEqual({
    type: "enabled",
    budget_tokens: 2048,
  });
  expect(bodies[1]).not.toHaveProperty("temperature");
  expect(bodies[2]).not.toHaveProperty("temperature");
});

test("Anthropic thinking rejects invalid budgets before fetch", async () => {
  let fetchCalls = 0;
  const fetchImpl = Object.assign(
    async () => {
      fetchCalls += 1;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  for (const options of [
    { maxTokens: 1024 },
    { maxTokens: 4096, thinkingBudgetTokens: 1023 },
    { maxTokens: 4096, thinkingBudgetTokens: 4096 },
  ]) {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-test",
      thinkingEnabled: true,
      fetch: fetchImpl,
      ...options,
    });
    await expect(
      (async () => {
        for await (const _chunk of provider.stream({ messages: [] })) {
          // Drain the stream to force request validation.
        }
      })(),
    ).rejects.toThrow("Anthropic thinking requires an integer budget_tokens");
  }
  expect(fetchCalls).toBe(0);
});

test("Anthropic reasoning effort maps to thinking budgets and clamps to max_tokens", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  for (const reasoningEffort of ["minimal", "low", "medium", "high", "xhigh"]) {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-test",
      maxTokens: 32768,
      thinkingEnabled: true,
      reasoningEffort,
      fetch: fetchImpl,
    });
    for await (const _chunk of provider.stream({ messages: [] })) {
      // Drain the stream to record the request.
    }
  }
  const budgets = bodies.map(
    (body) => (body.thinking as { budget_tokens: number }).budget_tokens,
  );
  expect(budgets).toEqual([1024, 2048, 4096, 8192, 16384]);

  const clampedProvider = new AnthropicProvider({
    apiKey: "test-key",
    model: "claude-test",
    maxTokens: 5000,
    thinkingEnabled: true,
    reasoningEffort: "high",
    fetch: fetchImpl,
  });
  for await (const _chunk of clampedProvider.stream({ messages: [] })) {
    // Drain the stream to record the request.
  }
  expect(bodies.at(-1)?.thinking).toEqual({
    type: "enabled",
    budget_tokens: 4999,
  });
});

test("Anthropic explicit thinking budget overrides reasoning effort", async () => {
  let body: Record<string, unknown> | undefined;
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    model: "claude-test",
    maxTokens: 32768,
    thinkingEnabled: true,
    reasoningEffort: "xhigh",
    thinkingBudgetTokens: 2048,
    fetch: fetchImpl,
  });
  for await (const _chunk of provider.stream({ messages: [] })) {
    // Drain the stream to record the request.
  }
  expect(body?.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  expect(body).not.toHaveProperty("reasoning_effort");
});

test("providerForModel forwards Anthropic thinking settings", async () => {
  const config = defaultConfigV3();
  config.providers.internal_gateway = {
    name: "Internal Gateway",
    driver: "anthropic-compatible",
    enabled: true,
    connection: { apiKey: "test-key" },
    requestDefaults: {
      stream: true,
      headers: {},
      options: { reasoningEffort: "high", thinkingBudgetTokens: 2048 },
    },
  };
  config.catalog.providers.internal_gateway = {
    models: {
      "thinking-model": {
        name: "thinking-model",
        status: "stable",
        source: "manual",
        capabilities: {
          toolCall: false,
          reasoning: true,
          thinking: true,
          imageInput: false,
          videoInput: false,
        },
        limits: { contextWindow: "auto", maxOutputTokens: 4096 },
      },
    },
  };
  config.modelOverrides["internal_gateway/thinking-model"] = {
    enabled: true,
    name: "Thinking",
    requestDefaults: { temperature: null, topP: null, thinkingEnabled: true },
    requestOptions: {},
    headers: {},
  };
  let body: Record<string, unknown> | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  try {
    const provider = providerForModel(
      config,
      "internal_gateway/thinking-model",
    );
    expect(provider).toBeInstanceOf(AnthropicProvider);
    for await (const _chunk of provider!.stream({ messages: [] })) {
      // Drain the stream to record the resolved request defaults.
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(body?.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
});

test("Gemini provider maps SSE content function calls and usage without placing its key in the URL", async () => {
  let requested: string | undefined;
  let headers: Headers | undefined;
  const fetchImpl = Object.assign(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      requested = String(input);
      headers = new Headers(init?.headers);
      return new Response(
        [
          'data: {"candidates":[{"content":{"parts":[{"text":"hi"},{"functionCall":{"name":"glob","args":{"pattern":"**/*.ts"}}}]}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3}}',
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new GeminiProvider({
    apiKey: "test-key",
    model: "gemini-test",
    fetch: fetchImpl,
  });
  const chunks = [];
  for await (const chunk of provider.stream({
    messages: [{ role: "user", content: "hi" }],
  }))
    chunks.push(chunk);
  expect(requested).toBe(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
  );
  expect(headers?.get("x-goog-api-key")).toBe("test-key");
  expect(chunks).toEqual(
    expect.arrayContaining([
      { type: "content", text: "hi" },
      {
        type: "tool_call",
        calls: [
          { id: "gemini_0", name: "glob", arguments: '{"pattern":"**/*.ts"}' },
        ],
      },
      { type: "usage", inputTokens: 2, outputTokens: 3 },
    ]),
  );
});

test("uniqueProviderToolCallIds remaps duplicates without stealing reserved ids", () => {
  const normalized = uniqueProviderToolCallIds([
    { id: "call_1", name: "read_file", arguments: "{}" },
    { id: "call_1", name: "glob", arguments: "{}" },
    { id: "call_1#1", name: "grep", arguments: "{}" },
  ]);
  expect(normalized.duplicates).toEqual(["call_1"]);
  expect(normalized.calls.map((call) => call.id)).toEqual([
    "call_1",
    "call_1#2",
    "call_1#1",
  ]);
  expect(normalized.calls.map((call) => call.name)).toEqual([
    "read_file",
    "glob",
    "grep",
  ]);

  const crossStep = uniqueProviderToolCallIds(
    [{ id: "call_1", name: "read_file", arguments: "{}" }],
    ["call_1"],
  );
  expect(crossStep.duplicates).toEqual(["call_1"]);
  expect(crossStep.calls[0]?.id).toBe("call_1#1");
});

test("contextEntriesToProviderMessages collapses duplicate ledger call pairs", () => {
  const messages = contextEntriesToProviderMessages([
    {
      id: "call_a",
      role: "tool_call",
      content: 'read_file {"path":"a"}',
      pairID: "call_x",
    },
    {
      id: "result_a",
      role: "tool_result",
      content: "a",
      pairID: "call_x",
    },
    {
      id: "call_b",
      role: "tool_call",
      content: 'read_file {"path":"a"}',
      pairID: "call_x",
    },
    {
      id: "result_b",
      role: "tool_result",
      content: "a again",
      pairID: "call_x",
    },
  ]);

  expect(messages.flatMap((message) => message.toolCalls ?? [])).toHaveLength(
    1,
  );
  expect(messages.filter((message) => message.role === "tool")).toHaveLength(1);
  expect(messages.flatMap((message) => message.toolCalls ?? [])[0]?.id).toBe(
    "call_x",
  );
});

test("Anthropic requests emit cache_control breakpoints on the stable prefix (ADR E)", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const provider = new AnthropicProvider({
    apiKey: "key",
    model: "model",
    maxTokens: 1024,
    // The tool breakpoint is a declared extension, so this test opts in. The
    // system-block breakpoint needs no declaration: it is native to the format.
    capabilities: { supportsCacheControlOnTools: true },
    fetch: Object.assign(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response("event: message_stop\ndata: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch,
  });
  for await (const _chunk of provider.stream({
    messages: [
      { role: "system", content: "static persona" },
      { role: "user", content: "hello" },
    ],
    tools: [
      {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "run_shell",
        description: "run",
        parameters: { type: "object", properties: {} },
      },
    ],
  })) {
    // Drain to force the request.
  }
  const body = bodies[0]!;
  // The system prompt is a cacheable text block.
  const system = body.system as Array<{
    type: string;
    text: string;
    cache_control?: { type: string };
  }>;
  expect(system).toHaveLength(1);
  expect(system[0]!.text).toBe("static persona");
  expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
  // Only the LAST tool schema carries a breakpoint (the prefix ends there).
  const tools = body.tools as Array<{ name: string; cache_control?: unknown }>;
  expect(tools).toHaveLength(2);
  expect(tools[0]!.cache_control).toBeUndefined();
  expect(tools[1]!.cache_control).toEqual({ type: "ephemeral" });
});

test("Anthropic usage chunks carry the cache metrics (ADR E)", async () => {
  const provider = new AnthropicProvider({
    apiKey: "key",
    model: "model",
    maxTokens: 1024,
    fetch: Object.assign(
      async () =>
        new Response(
          "event: message_start\n" +
            'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":0,"cache_creation_input_tokens":80,"cache_read_input_tokens":20}}}\n\n' +
            "event: message_stop\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      { preconnect: fetch.preconnect },
    ) as typeof fetch,
  });
  const usages: Array<Record<string, unknown>> = [];
  for await (const chunk of provider.stream({
    messages: [{ role: "user", content: "hi" }],
  }))
    if (chunk.type === "usage")
      usages.push(chunk as unknown as Record<string, unknown>);
  expect(usages).toHaveLength(1);
  expect(usages[0]).toMatchObject({
    inputTokens: 100,
    cacheCreationInputTokens: 80,
    cacheReadInputTokens: 20,
  });
});

/** Drive the OpenAI-compatible adapter over one SSE body and collect its chunks. */
async function collectOpenAIChunks(
  sse: string,
): Promise<import("../src/provider").ProviderStreamChunk[]> {
  const fetchImpl = Object.assign(
    async () =>
      new Response(sse, {
        headers: { "content-type": "text/event-stream" },
      }),
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    model: "test-model",
    fetch: fetchImpl,
  });
  const chunks: import("../src/provider").ProviderStreamChunk[] = [];
  for await (const chunk of provider.stream({ messages: [] }))
    chunks.push(chunk);
  return chunks;
}

test("OpenAI-compatible reports prefix-cache reads from prompt_tokens_details", async () => {
  // Without this the whole OpenAI family shows a permanent 0% hit rate however
  // stable the prefix is, because the read was the only cache signal it emits.
  const chunks = await collectOpenAIChunks(
    [
      'data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":12000,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":11000}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
  );

  const usage = chunks.find((chunk) => chunk.type === "usage");
  expect(usage).toEqual({
    type: "usage",
    inputTokens: 12000,
    outputTokens: 4,
    cacheReadInputTokens: 11000,
  });
  // OpenAI bills no cache write, so that field must stay absent rather than 0 —
  // a 0 would claim the endpoint reported a write it never measured.
  expect(usage).not.toHaveProperty("cacheCreationInputTokens");
});

test("OpenAI-compatible omits the cache read when the endpoint reports none", async () => {
  const chunks = await collectOpenAIChunks(
    [
      'data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":8,"completion_tokens":2}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
  );

  expect(chunks.find((chunk) => chunk.type === "usage")).toEqual({
    type: "usage",
    inputTokens: 8,
    outputTokens: 2,
  });
});

test("OpenAI-compatible treats an explicit zero cached_tokens as a reported read", async () => {
  // A cold cache is a real measurement, not a missing one: reporting it lets the
  // hit-rate metric show 0% honestly instead of hiding the request.
  const chunks = await collectOpenAIChunks(
    [
      'data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":900,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":0}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
  );

  expect(chunks.find((chunk) => chunk.type === "usage")).toEqual({
    type: "usage",
    inputTokens: 900,
    outputTokens: 2,
    cacheReadInputTokens: 0,
  });
});

test("OpenAI-compatible reads cache usage on the buffered path too", async () => {
  // Both the streaming and buffered parsers share one mapping, so a session
  // cannot report a hit rate that depends on which path served the request.
  const chunks = await collectOpenAIChunks(
    [
      'data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":5000,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":5000}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
  );

  const usage = chunks.find((chunk) => chunk.type === "usage");
  expect(usage).toMatchObject({ cacheReadInputTokens: 5000 });
});

/** Drive the Anthropic adapter and capture the request body and headers. */
async function runAnthropic(input: {
  messages?: Parameters<AnthropicProvider["stream"]>[0]["messages"];
  tools?: Parameters<AnthropicProvider["stream"]>[0]["tools"];
  capabilities?: ConstructorParameters<
    typeof AnthropicProvider
  >[0]["capabilities"];
  sessionID?: string;
  cacheRetention?: ConstructorParameters<
    typeof AnthropicProvider
  >[0]["cacheRetention"];
}): Promise<{
  body: Record<string, unknown>;
  headers: Record<string, string>;
}> {
  let sent: Record<string, unknown> = {};
  let headers: Record<string, string> = {};
  const fetchImpl = Object.assign(
    async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      return new Response("", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    model: "claude-test",
    fetch: fetchImpl,
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    ...(input.sessionID ? { sessionID: input.sessionID } : {}),
    ...(input.cacheRetention ? { cacheRetention: input.cacheRetention } : {}),
  });
  for await (const _chunk of provider.stream({
    messages: input.messages ?? [{ role: "user", content: "hi" }],
    ...(input.tools ? { tools: input.tools } : {}),
  }));
  return { body: sent, headers };
}

const ONE_TOOL = [
  { name: "read_file", description: "read", parameters: { type: "object" } },
];

test("Anthropic omits tool cache_control until the endpoint declares it", async () => {
  // Tool caching is an extension the Messages spec added after tool caching
  // shipped, so a conforming endpoint is not obliged to accept it.
  const undeclared = await runAnthropic({ tools: ONE_TOOL });
  expect(
    (undeclared.body.tools as Array<Record<string, unknown>>)[0],
  ).not.toHaveProperty("cache_control");

  const declared = await runAnthropic({
    tools: ONE_TOOL,
    capabilities: { supportsCacheControlOnTools: true },
  });
  expect(
    (declared.body.tools as Array<Record<string, unknown>>)[0].cache_control,
  ).toEqual({ type: "ephemeral" });
});

test("Anthropic always marks the system block, which is native to the format", async () => {
  // Not gated: `cache_control` on the system block is part of the Messages
  // spec, the way `stream: true` is.
  const { body } = await runAnthropic({
    messages: [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ],
  });

  const system = (body.system as Array<Record<string, unknown>>)[0];
  expect(system.cache_control).toEqual({ type: "ephemeral" });
});

test("Anthropic sends no session affinity header until the endpoint declares it", async () => {
  const undeclared = await runAnthropic({ sessionID: "ses_abc" });
  expect(undeclared.headers).not.toHaveProperty("x-session-affinity");
  expect(undeclared.headers).not.toHaveProperty("x-session-id");

  const declared = await runAnthropic({
    sessionID: "ses_abc",
    capabilities: { sendSessionAffinityHeaders: true },
  });
  expect(declared.headers["x-session-affinity"]).toBe("ses_abc");

  const openrouter = await runAnthropic({
    sessionID: "ses_abc",
    capabilities: {
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openrouter",
    },
  });
  expect(openrouter.headers["x-session-id"]).toBe("ses_abc");
  expect(openrouter.headers).not.toHaveProperty("x-session-affinity");
});

test("Anthropic sends no affinity header without a session id", async () => {
  // The capability alone is not enough: there is nothing to put in the header.
  const { headers } = await runAnthropic({
    capabilities: { sendSessionAffinityHeaders: true },
  });

  expect(headers).not.toHaveProperty("x-session-affinity");
});

test("Anthropic sends ttl 1h only when retention and the capability agree", async () => {
  const undeclared = await runAnthropic({
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ],
    cacheRetention: "long",
  });
  // Long asked for, long not declared: degrades rather than sending a ttl the
  // deployment would reject.
  expect(
    (undeclared.body.system as Array<Record<string, unknown>>)[0].cache_control,
  ).toEqual({ type: "ephemeral" });

  const declared = await runAnthropic({
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ],
    cacheRetention: "long",
    capabilities: { supportsLongCacheRetention: true },
  });
  expect(
    (declared.body.system as Array<Record<string, unknown>>)[0].cache_control,
  ).toEqual({ type: "ephemeral", ttl: "1h" });
});

test("Anthropic retention none omits the cache marker everywhere", async () => {
  const { body } = await runAnthropic({
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ],
    tools: [
      { name: "read_file", description: "r", parameters: { type: "object" } },
    ],
    cacheRetention: "none",
    capabilities: { supportsCacheControlOnTools: true },
  });

  expect((body.system as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
    "cache_control",
  );
  expect((body.tools as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
    "cache_control",
  );
});

test("Anthropic marks the last conversation message so the whole prefix is cached", async () => {
  // Anthropic writes a cache entry only at a breakpoint, so without one on the
  // conversation the entire history is re-billed every turn however stable it
  // is. This is the largest single cache win on this family.
  const { body } = await runAnthropic({
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ],
  });

  const messages = body.messages as Array<{
    role: string;
    content: Array<{ type: string; text?: string; cache_control?: unknown }>;
  }>;
  expect(messages).toHaveLength(3);
  // Only the last message carries the conversation breakpoint.
  expect(messages[0]!.content[0]).not.toHaveProperty("cache_control");
  expect(messages[1]!.content[0]).not.toHaveProperty("cache_control");
  expect(messages[2]!.content[0]!.cache_control).toEqual({ type: "ephemeral" });
});

test("Anthropic marks a trailing tool result, which is a user-role block", async () => {
  // A tool turn ends in a tool_result block, so the breakpoint has to be able to
  // land there or a tool-heavy turn caches nothing.
  const { body } = await runAnthropic({
    messages: [
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }],
      },
      {
        role: "tool",
        content: "file body",
        toolCallID: "c1",
        toolName: "read_file",
      },
    ],
  });

  const messages = body.messages as Array<{
    role: string;
    content: Array<{ type: string; cache_control?: unknown }>;
  }>;
  const last = messages[messages.length - 1]!;
  expect(last.role).toBe("user");
  expect(last.content[0]!.type).toBe("tool_result");
  expect(last.content[0]!.cache_control).toEqual({ type: "ephemeral" });
});

test("Anthropic conversation breakpoint honours retention and its capability", async () => {
  const none = await runAnthropic({ cacheRetention: "none" });
  expect(
    (
      none.body.messages as Array<{ content: Array<Record<string, unknown>> }>
    )[0]!.content[0],
  ).not.toHaveProperty("cache_control");

  const longUndeclared = await runAnthropic({ cacheRetention: "long" });
  expect(
    (
      longUndeclared.body.messages as Array<{
        content: Array<Record<string, unknown>>;
      }>
    )[0]!.content[0]!.cache_control,
  ).toEqual({ type: "ephemeral" });

  const longDeclared = await runAnthropic({
    cacheRetention: "long",
    capabilities: { supportsLongCacheRetention: true },
  });
  expect(
    (
      longDeclared.body.messages as Array<{
        content: Array<Record<string, unknown>>;
      }>
    )[0]!.content[0]!.cache_control,
  ).toEqual({ type: "ephemeral", ttl: "1h" });
});

test("Anthropic converts a bare-string last message rather than skipping it", async () => {
  // A message with no parts converts to a bare string; it still has to carry the
  // marker or the conversation caches nothing.
  const { body } = await runAnthropic({
    messages: [{ role: "user", content: "" }],
  });

  const messages = body.messages as Array<{
    content: Array<{ type: string; cache_control?: unknown }> | string;
  }>;
  expect(Array.isArray(messages[0]!.content)).toBe(true);
  expect(
    (messages[0]!.content as Array<Record<string, unknown>>)[0]!.cache_control,
  ).toEqual({ type: "ephemeral" });
});

test("Anthropic cached prefix grows monotonically across turns", async () => {
  // The property the whole cache line exists for: what turn N+1 sends must be a
  // strict extension of what turn N sent, so the prefix cached at turn N is
  // reused rather than re-billed. This is why the volatile runtime-context block
  // costs nothing — it is re-inserted at the same relative position every turn,
  // so it always lands in the fresh tail and never inside the reusable prefix.
  const requests: Array<Array<Record<string, unknown>>> = [];
  const fetchImpl = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<Record<string, unknown>>;
      };
      requests.push(body.messages);
      return new Response("event: message_stop\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const provider = new AnthropicProvider({
    apiKey: "k",
    model: "m",
    maxTokens: 64,
    fetch: fetchImpl,
  });

  // Three turns, each appending an assistant reply and a fresh user request.
  const turns = [
    [{ role: "user" as const, content: "one" }],
    [
      { role: "user" as const, content: "one" },
      { role: "assistant" as const, content: "reply one" },
      { role: "user" as const, content: "two" },
    ],
    [
      { role: "user" as const, content: "one" },
      { role: "assistant" as const, content: "reply one" },
      { role: "user" as const, content: "two" },
      { role: "assistant" as const, content: "reply two" },
      { role: "user" as const, content: "three" },
    ],
  ];
  for (const messages of turns)
    for await (const _chunk of provider.stream({ messages })) {
      // Drain to force the request.
    }

  expect(requests).toHaveLength(3);
  // The breakpoint marker is stripped before comparing: it moves to whichever
  // message is last in each request, so the annotated bytes differ between turns
  // by construction. What must be stable is the content, because that is what
  // the cache keys on — Anthropic's own recommendation is to mark the last
  // block, and that pattern only works across turns if the annotation is
  // per-request metadata rather than part of the cached prompt.
  const key = (m: Record<string, unknown>) => {
    const copy: Record<string, unknown> = { ...m };
    if (Array.isArray(copy.content))
      copy.content = (copy.content as Array<Record<string, unknown>>).map(
        (block) => {
          const { cache_control: _ignored, ...rest } = block;
          return rest;
        },
      );
    return JSON.stringify(copy);
  };
  // Turn N's messages are a prefix of turn N+1's: nothing already sent changes.
  for (let index = 1; index < requests.length; index += 1) {
    const previous = requests[index - 1]!.map(key);
    const current = requests[index]!.map(key);
    expect(current.length).toBeGreaterThan(previous.length);
    expect(current.slice(0, previous.length)).toEqual(previous);
  }
  // And the breakpoint is on the final message each time, so the cached prefix
  // is exactly the stable part rather than stopping at the header.
  const marked = (messages: Array<Record<string, unknown>>) =>
    messages.filter((message) =>
      Array.isArray(message.content)
        ? (message.content as Array<Record<string, unknown>>).some(
            (block) => block.cache_control !== undefined,
          )
        : false,
    ).length;
  expect(marked(requests[2]!)).toBe(1);
  expect(marked(requests[2]!)).toBeLessThan(requests[2]!.length);
});

test("a tool result whose pairing id is missing cannot leave a dangling tool call", () => {
  // The OpenAI-compatible gateway rejects a `role: "tool"` message that no
  // assistant `toolCalls` entry precedes, and a `toolCalls` entry whose result
  // never arrives. A durable entry can lose its pairID (an older journal, a
  // partial write), so the rebuild must drop BOTH halves of the pair rather
  // than emit either alone.
  const messages = contextEntriesToProviderMessages([
    {
      id: "call_1",
      role: "tool_call",
      content: 'read_file {"path":"hello.txt"}',
      pairID: "call_1",
    },
    {
      id: "result_1",
      role: "tool_result",
      content: "hello",
      pairID: undefined,
    },
    {
      id: "result_2",
      role: "tool_result",
      content: "no pair key at all",
    },
  ]);
  // The unpaired call and the unpaired results both vanish: the turn rebuilds
  // as plain text, which the gateway accepts.
  expect(messages).toEqual([]);
});

test("a tool call repeated in the durable log is emitted once", () => {
  // A provider can echo the same call id twice (a resumed step, a replayed
  // page). Two assistant entries carrying the same id, or two results for one
  // call, are both rejected.
  const messages = contextEntriesToProviderMessages([
    {
      id: "call_1",
      role: "tool_call",
      content: 'read_file {"path":"a.txt"}',
      pairID: "dup",
    },
    {
      id: "call_2",
      role: "tool_call",
      content: 'read_file {"path":"a.txt"}',
      pairID: "dup",
    },
    { id: "r1", role: "tool_result", content: "a", pairID: "dup" },
    { id: "r2", role: "tool_result", content: "a again", pairID: "dup" },
  ]);
  const calls = messages.flatMap((message) => message.toolCalls ?? []);
  expect(calls.map((call) => call.id)).toEqual(["dup"]);
  const results = messages.filter((message) => message.role === "tool");
  expect(results).toHaveLength(1);
});
