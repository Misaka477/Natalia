# Natalia Provider Guide — v1

[中文](#中文) | [English](#english)

<a id="english"></a>

## English

> This guide covers how to write a streaming model provider adapter — the
> piece that lets a Natalia runtime talk to your own model backend, gateway
> or vendor API. It pairs with the runtime API reference
> (`docs/api-reference.md`): providers are host-side, in-process adapters,
> not an RPC surface.

## 1. What a provider is

A provider adapter is an object implementing `StreamingProvider`
(`@anthelia/runtime`):

```ts
export type StreamingProvider = {
  provider: string; // stable identity, e.g. "openai", "my-gateway"
  model: string; // the model id this instance talks to
  imageInput?: boolean; // can lower image attachments (default false)
  videoInput?: boolean; // can lower video attachments
  stream(request: ProviderStreamRequest): AsyncIterable<ProviderStreamChunk>;
};
```

The runtime calls `stream` once per provider step, with the accumulated
messages, the tool catalog and an `AbortSignal`, and consumes an async
iterable of chunks. That is the whole contract: **produce chunks in the right
order, respect the signal, declare your attachment capabilities honestly.**

## 2. The stream protocol

Yield these chunks in this order per request:

| Chunk                                                     | Meaning                                                                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `{ type: "thinking", text }`                              | reasoning text; the runtime hides it when the model forbids it                                                          |
| `{ type: "content", text }`                               | visible text — may be yielded many times, accumulated into one assistant message                                        |
| `{ type: "tool_call", calls: [{ id, name, arguments }] }` | the model wants tools called; after the runtime executes them it calls `stream` again with tool results in the messages |
| `{ type: "usage", inputTokens, outputTokens }`            | token counts, recorded into the journal                                                                                 |
| `{ type: "done" }`                                        | the step is over                                                                                                        |

A step ends with `done`; a step that yields `tool_call` must be followed by
the runtime calling `stream` again with the tool results appended to
`request.messages`. A stream that stops without `done` is treated as a
failure. The runtime enforces an idle timeout on the stream; honor
`request.signal` and stop yielding when it aborts.

## 3. The request

```ts
export type ProviderStreamRequest = {
  messages: ProviderMessage[];
  tools?: ProviderTool[];
  signal?: AbortSignal;
};
```

`ProviderMessage` is the adapter's input shape, independent of any vendor
format:

- `role`: `"system" | "user" | "assistant" | "tool"` — tool results arrive as
  `role: "tool"` messages carrying `toolCallID` / `toolName`.
- `content`: plain text.
- `images`: `{ mediaType, dataURL }` — `image/png`, `image/jpeg`,
  `image/webp`, `image/gif`.
- `videos`: `{ mediaType, dataURL }` — `video/mp4`, `video/webm`.
- `toolCalls`: the assistant's calls, when this message is an assistant turn.

Translate this into your vendor request format; the built-in adapters are the
reference implementations for OpenAI-compatible, Anthropic and Gemini shapes
(`packages/framework/runtime/src/provider.ts`).

## 4. Attachment lowering and the double gate

Attachments are gated twice before they ever reach you: the **selected
model's declared capabilities** (`imageInput`, `videoInput` in the model
catalog) and **your adapter's declarations** must both accept the attachment,
or the turn degrades to a text marker. Declare exactly what you can lower:

- `imageInput: true` — you turn `images` into your native image content block
  (Anthropic `image`/`base64`, Gemini `inlineData`, OpenAI-compatible
  `image_url`).
- `videoInput: true` — you turn `videos` into inline video (Gemini
  `inlineData` is the only built-in today):

```ts
// Gemini lowering, from the built-in adapter:
...(message.videos?.map((video) => ({
  inlineData: { mimeType: video.mediaType, data: dataURLPayload(video.dataURL) },
})) ?? []),
```

`dataURLPayload` strips the `data:<type>;base64,` prefix. There is no
framework size ceiling on attachments — the provider (and ultimately the
model) is the authority on what fits.

## 5. Errors

Throw `providerError(message)` for a stream-level failure, or
`providerErrorFromHttp(response)` when the upstream HTTP call failed — the
runtime turns these into a `turn.finished { stopReason: "error" }` plus a
diagnostic. Do not throw a plain string; the runtime classifies provider
errors so the consumer gets a machine-readable failure, not an unclassified
`internal`.

## 6. Registering your adapter

Two ways:

1. **A new built-in kind** — add a branch in `providerFromKind`
   (`packages/framework/runtime/src/provider.ts`); the config's `providers[].type`
   string is matched case-insensitively by substring (`"anthropic"` /
   `"claude"` → `AnthropicProvider`, `"gemini"` / `"google"` →
   `GeminiProvider`, anything else falls back to the OpenAI-compatible
   adapter). Then `providerForModel(config, modelID)` constructs your
   adapter from the model's `provider` reference.
2. **Injected for a process** — construct your `StreamingProvider` yourself
   and pass it in `createRealRuntimeClient({ provider })`; it overrides the
   config-derived adapter.

Model discovery (`discoverProviderModels`) hits `{baseURL}/v1/models` for
OpenAI-compatible kinds, `/models` with an `x-api-key` for Anthropic and an
`x-goog-api-key` for Gemini — implement a compatible endpoint if you want the
web UI's "add provider" flow to list your models.

## 7. Checklist for a new adapter

- Yields `thinking`/`content` in order, ends with `done`, respects `signal`.
- Returns tool results as `role: "tool"` messages and accepts the follow-up
  `stream` call.
- Declares `imageInput`/`videoInput` exactly as implemented.
- Throws `providerError`/`providerErrorFromHttp`, never a raw string.
- Reports `usage` so the journal records tokens.
- Tests mirror `packages/framework/runtime/test/provider.test.ts`: stream parsing,
  attachment lowering to the native format, error mapping, `videoInput`
  declarations.

<a id="chinese"></a>

## 中文

> 本指南讲如何编写流式模型 provider 适配器——让 Natalia runtime 对接你自己的
> 模型后端、网关或厂商 API 的那块。与运行时 API 参考（`docs/api-reference.md`）
> 配套：provider 是 host 侧、进程内的适配器，不是 RPC 面。

## 1. Provider 是什么

Provider 适配器是实现 `StreamingProvider` 的对象（`@anthelia/runtime`）：

```ts
export type StreamingProvider = {
  provider: string; // 稳定标识，如 "openai"、"my-gateway"
  model: string; // 本实例对话的模型 id
  imageInput?: boolean; // 能否降级图片附件（默认 false）
  videoInput?: boolean; // 能否降级视频附件
  stream(request: ProviderStreamRequest): AsyncIterable<ProviderStreamChunk>;
};
```

runtime 每个 provider 步调用一次 `stream`，传入累积消息、工具目录与
`AbortSignal`，消费一个 async iterable 的块。这就是全部契约：**按正确顺序产出
块、尊重 signal、如实声明附件能力。**

## 2. 流协议

每个请求按此顺序产出块：

| 块                                                        | 含义                                                    |
| --------------------------------------------------------- | ------------------------------------------------------- |
| `{ type: "thinking", text }`                              | 推理文本；模型禁止时 runtime 隐藏它                     |
| `{ type: "content", text }`                               | 可见文本——可产出多次，累积成一条 assistant 消息         |
| `{ type: "tool_call", calls: [{ id, name, arguments }] }` | 模型要调工具；runtime 执行后带工具结果再次调用 `stream` |
| `{ type: "usage", inputTokens, outputTokens }`            | token 计数，记入 journal                                |
| `{ type: "done" }`                                        | 本步结束                                                |

一步以 `done` 结束；产出 `tool_call` 的步之后，runtime 会把工具结果追加到
`request.messages` 再次调用 `stream`。没到 `done` 就停止的流视为失败。runtime
对流有 idle 超时；尊重 `request.signal`，中止时停止产出。

## 3. 请求

```ts
export type ProviderStreamRequest = {
  messages: ProviderMessage[];
  tools?: ProviderTool[];
  signal?: AbortSignal;
};
```

`ProviderMessage` 是与厂商格式无关的适配器输入：

- `role`：`"system" | "user" | "assistant" | "tool"`——工具结果以
  `role: "tool"` 消息到达，携带 `toolCallID` / `toolName`。
- `content`：纯文本。
- `images`：`{ mediaType, dataURL }`——`image/png`、`image/jpeg`、
  `image/webp`、`image/gif`。
- `videos`：`{ mediaType, dataURL }`——`video/mp4`、`video/webm`。
- `toolCalls`：assistant 回合时的工具调用。

把它翻译成你的厂商请求格式；三个内建适配器（OpenAI 兼容、Anthropic、
Gemini 形状，`packages/framework/runtime/src/provider.ts`）是参考实现。

## 4. 附件降级与双层门控

附件在到达你之前被门控两次：**所选模型的声明能力**（模型 catalog 的
`imageInput`、`videoInput`）与**你的适配器声明**必须都接受该附件，
否则会降级为文本标记。只声明你能降级的：

- `imageInput: true` — 你把 `images` 转成原生图片内容块（Anthropic
  `image`/`base64`、Gemini `inlineData`、OpenAI 兼容 `image_url`）。
- `videoInput: true` — 你把 `videos` 转成 inline 视频（今天只有 Gemini
  内建）：

```ts
// 内建适配器的 Gemini 降级：
...(message.videos?.map((video) => ({
  inlineData: { mimeType: video.mediaType, data: dataURLPayload(video.dataURL) },
})) ?? []),
```

`dataURLPayload` 去掉 `data:<type>;base64,` 前缀。框架对附件无大小上限——
provider（最终是模型）才是"装不装得下"的权威。

## 5. 错误

流级失败抛 `providerError(message)`；上游 HTTP 失败用
`providerErrorFromHttp(response)`——runtime 把它们变成
`turn.finished { stopReason: "error" }` + diagnostic。不要抛裸字符串；
runtime 对 provider 错误分类，让消费者拿到机器可读的失败而不是未分类的
`internal`。

## 6. 注册你的适配器

两条路：

1. **新的内建 kind**——在 `providerFromKind`
   （`packages/framework/runtime/src/provider.ts`）加分支；config 的 `providers[].type`
   字符串按子串不区分大小写匹配（`"anthropic"`/`"claude"` →
   `AnthropicProvider`，`"gemini"`/`"google"` → `GeminiProvider`，其他全部
   回退到 OpenAI 兼容适配器）。然后 `providerForModel(config, modelID)`
   按模型的 `provider` 引用构造你的适配器。
2. **进程内注入**——自己构造 `StreamingProvider`，传给
   `createRealRuntimeClient({ provider })`；它覆盖 config 派生的适配器。

模型发现（`discoverProviderModels`）：OpenAI 兼容 kind 打
`{baseURL}/v1/models`，Anthropic 带 `x-api-key`、Gemini 带 `x-goog-api-key`
打 `/models`——想要 Web UI 的"添加 provider"流程列出你的模型，就实现兼容端点。

## 7. 新适配器检查单

- 按序产出 `thinking`/`content`，以 `done` 结束，尊重 `signal`。
- 工具结果以 `role: "tool"` 消息返回，并接受后续 `stream` 调用。
- `imageInput`/`videoInput` 与实现完全一致。
- 抛 `providerError`/`providerErrorFromHttp`，绝不抛裸字符串。
- 报 `usage` 让 journal 记录 token。
- 测试对照 `packages/framework/runtime/test/provider.test.ts`：流解析、附件降级到原生
  格式、错误映射、`videoInput` 声明。
