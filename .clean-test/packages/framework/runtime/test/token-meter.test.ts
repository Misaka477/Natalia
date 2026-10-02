import { expect, test } from "bun:test";
import {
  TOKEN_METER_BLOCK_OVERHEAD,
  TOKEN_METER_IMAGE_PIXELS_PER_TOKEN,
  TOKEN_METER_IMAGE_UNKNOWN_TOKENS,
  TOKEN_METER_ROLE_OVERHEAD,
  TokenMeter,
  estimateMeterMessage,
  estimateTokenText,
  requestHeaderKey,
} from "../src/token-meter";

test("token meter estimates messages with a stable fixed heuristic", () => {
  const meter = new TokenMeter();
  expect(estimateMeterMessage({ role: "user", content: "hello world" })).toBe(
    4 + 3,
  );
  expect(
    meter.estimateRequest({
      system: "system",
      tools: [{ name: "shell" }],
      messages: [{ role: "user", content: "hello" }],
    }),
  ).toBeGreaterThan(0);
});

test("provider usage is reused only when the canonical header still matches", () => {
  const meter = new TokenMeter();
  const messages = [{ role: "user" as const, content: "hello" }];
  meter.observeSurface("main", messages);
  meter.recordUsage(
    "main",
    { inputTokens: 10_000, outputTokens: 200 },
    {
      headerKey: JSON.stringify({ system: "sys", tools: [] }),
      surfaceTokens: meter.estimateMessages(messages),
    },
  );

  const matching = meter.measureRequest("main", {
    system: "sys",
    tools: [],
    messages,
    contextWindow: 100_000,
  });
  expect(matching.source).toBe("provider_usage");
  expect(matching.totalTokens).toBe(10_200);

  const changedHeader = meter.measureRequest("main", {
    system: "different system",
    tools: [],
    messages,
    contextWindow: 100_000,
  });
  expect(changedHeader.source).toBe("estimate");
  expect(changedHeader.totalTokens).toBeLessThan(10_200);
  expect(changedHeader.totalTokens).toBeGreaterThan(0);
});

test("projected tokens carry the provider sample across surface growth", () => {
  const meter = new TokenMeter();
  const base = [{ role: "user" as const, content: "a".repeat(400) }];
  meter.observeSurface("navi", base);
  meter.recordUsage(
    "navi",
    { inputTokens: 500, outputTokens: 50 },
    { headerKey: "header", surfaceTokens: meter.estimateMessages(base) },
  );

  meter.observeSurface("navi", [
    ...base,
    { role: "assistant" as const, content: "b".repeat(4_000) },
  ]);
  const projected = meter.project("navi");
  expect(projected.pressureTokens).toBe(500);
  expect(projected.projectedTokens).toBeGreaterThan(1_000);
  expect(projected.contextWindow).toBeUndefined();
  meter.setContextWindow("navi", 8_000);
  expect(meter.project("navi").contextWindow).toBe(8_000);
});

test("a smaller provider sample never hides a larger current request", () => {
  const meter = new TokenMeter();
  const messages = [{ role: "user" as const, content: "x".repeat(4_000) }];
  meter.observeSurface("main", messages);
  meter.recordUsage(
    "main",
    { inputTokens: 10, outputTokens: 1 },
    { headerKey: "same", surfaceTokens: meter.estimateMessages(messages) },
  );
  const measured = meter.measureRequest("main", {
    system: "",
    tools: [],
    messages,
  });
  expect(measured.source).toBe("estimate");
  expect(measured.totalTokens).toBeGreaterThanOrEqual(measured.messageTokens);
});

test("three-bucket measurement keeps system, tools and messages additive", () => {
  const meter = new TokenMeter();
  const messages = [
    { role: "user" as const, content: "a".repeat(400) },
    { role: "assistant" as const, content: "b".repeat(400) },
  ];
  const withTools = meter.measureRequest("main", {
    system: "s".repeat(200),
    tools: [{ name: "shell", parameters: { type: "object" } }],
    messages,
  });
  expect(withTools.systemTokens).toBe(estimateTokenText("s".repeat(200)));
  expect(withTools.toolsTokens).toBeGreaterThan(0);
  expect(withTools.messageTokens).toBeGreaterThan(0);
  expect(withTools.headerTokens).toBe(
    withTools.systemTokens + withTools.toolsTokens,
  );
  expect(withTools.totalTokens).toBe(
    withTools.headerTokens + withTools.messageTokens,
  );
  // The system prompt is never also counted inside the message surface.
  expect(withTools.messageTokens).toBe(meter.estimateMessages(messages));
});

test("recordUsage and measureRequest share one header key per envelope", () => {
  const meter = new TokenMeter();
  const messages = [{ role: "user" as const, content: "hello" }];
  const tools = [{ name: "shell", parameters: { type: "object" } }];
  meter.recordUsage(
    "main",
    { inputTokens: 10_000, outputTokens: 200 },
    {
      headerKey: requestHeaderKey({ system: "sys", tools }),
      surfaceTokens: meter.estimateMessages(messages),
    },
  );
  // Same system + tools header reuses the provider anchor.
  const reused = meter.measureRequest("main", {
    system: "sys",
    tools,
    messages,
    contextWindow: 100_000,
  });
  expect(reused.source).toBe("provider_usage");
  expect(reused.totalTokens).toBe(10_200);
  expect(reused.toolsTokens).toBeGreaterThan(0);
  // A different tool set invalidates the anchor even with the same system.
  const changedTools = meter.measureRequest("main", {
    system: "sys",
    tools: [{ name: "other", parameters: { type: "object" } }],
    messages,
    contextWindow: 100_000,
  });
  expect(changedTools.source).toBe("estimate");
});

test("estimateVisualInput prices an image by its dimensions, not its bytes", () => {
  // 1568x882 is the post-scaling maximum for the default long-edge limit, and
  // is worth ~1.8k tokens. A meter that read only `content` would price this
  // message at its text alone.
  const withImage = estimateMeterMessage({
    role: "user",
    content: "看看这张截图",
    images: [{ width: 1568, height: 882 }],
  });
  const textOnly = estimateMeterMessage({
    role: "user",
    content: "看看这张截图",
  });

  expect(withImage).toBeGreaterThan(textOnly + 1000);
  expect(withImage - textOnly).toBe(
    Math.ceil((1568 * 882) / TOKEN_METER_IMAGE_PIXELS_PER_TOKEN) +
      TOKEN_METER_BLOCK_OVERHEAD,
  );
});

test("estimateVisualInput never under-counts a large image", () => {
  // A 40 MP image — the admission pixel ceiling — must not collapse to a small
  // number. Under-counting is what stops compaction from firing at all.
  const huge = estimateMeterMessage({
    role: "user",
    content: "",
    images: [{ width: 8000, height: 5000 }],
  });

  expect(huge).toBeGreaterThan(50_000);
});

test("estimateVisualInput prices an image with unknown dimensions conservatively", () => {
  const unknown = estimateMeterMessage({
    role: "user",
    content: "",
    images: [{}],
  });
  const known = estimateMeterMessage({
    role: "user",
    content: "",
    images: [{ width: 1568, height: 882 }],
  });

  expect(unknown).toBeGreaterThan(known);
  expect(unknown - known).toBe(
    TOKEN_METER_IMAGE_UNKNOWN_TOKENS -
      Math.ceil((1568 * 882) / TOKEN_METER_IMAGE_PIXELS_PER_TOKEN),
  );
});

test("estimateVisualInput prices videos the same way as images", () => {
  const video = estimateMeterMessage({
    role: "user",
    content: "",
    videos: [{ width: 1920, height: 1080 }],
  });
  const image = estimateMeterMessage({
    role: "user",
    content: "",
    images: [{ width: 1920, height: 1080 }],
  });

  expect(video).toBe(image);
});

test("a message with no attachments is priced exactly as before", () => {
  expect(estimateMeterMessage({ role: "user", content: "plain text" })).toBe(
    TOKEN_METER_ROLE_OVERHEAD + estimateTokenText("plain text"),
  );
});

test("measureRequest counts attachment pressure that content alone would miss", () => {
  const meter = new TokenMeter();
  const messages = [
    { role: "user", content: "第一张", images: [{ width: 1568, height: 882 }] },
    { role: "assistant", content: "看到了" },
    { role: "user", content: "第二张", images: [{ width: 1568, height: 882 }] },
  ];
  const textOnly = [
    { role: "user", content: "第一张" },
    { role: "assistant", content: "看到了" },
    { role: "user", content: "第二张" },
  ];

  const withImages = meter.measureRequest("with", {
    messages: messages as never,
    contextWindow: 200_000,
  });
  const withoutImages = meter.measureRequest("without", {
    messages: textOnly as never,
    contextWindow: 200_000,
  });

  // Two screenshots must move the request total by thousands of tokens, or the
  // compaction trigger below never fires for an image-heavy session.
  expect(withImages.messageTokens).toBeGreaterThan(
    withoutImages.messageTokens + 3000,
  );
});

test("recordUsage keeps the cache read instead of dropping it at the boundary", () => {
  // The token meter's usage view once spelled these fields `cacheReadTokens` /
  // `cacheWriteTokens` while every other layer used `cacheReadInputTokens` /
  // `cacheCreationInputTokens`. TypeScript allowed the mismatch — the required
  // fields agree and these are optional — so the cache read silently vanished
  // and the meter under-counted every cached request, on Anthropic as much as
  // on OpenAI. This pins the two vocabularies together.
  const meter = new TokenMeter();
  meter.recordUsage(
    "anthropic",
    {
      inputTokens: 12_000,
      outputTokens: 4,
      cacheReadInputTokens: 11_000,
      cacheCreationInputTokens: 20_000,
    },
    { headerKey: "h" },
  );

  expect(meter.project("anthropic").pressureTokens).toBe(
    12_000 + 11_000 + 20_000,
  );
});

test("recordUsage prices an OpenAI sample, which reports a read but no write", () => {
  const meter = new TokenMeter();
  meter.recordUsage(
    "openai",
    { inputTokens: 900, outputTokens: 2, cacheReadInputTokens: 800 },
    { headerKey: "h" },
  );

  expect(meter.project("openai").pressureTokens).toBe(900 + 800);
});

test("measureRequest prefers the provider sample once the cache read is counted", () => {
  // A cached request's true total includes the read, so the sample must beat
  // the heuristic estimate before it is trusted as the compaction anchor.
  const meter = new TokenMeter();
  const envelope = {
    messages: [{ role: "user", content: "short" }],
    system: "s",
    tools: undefined,
    contextWindow: 200_000,
  };
  // The sample is only reused while the header it priced is still current, so
  // record it against the same key measureRequest will derive.
  meter.recordUsage(
    "cached",
    { inputTokens: 2_000, outputTokens: 10, cacheReadInputTokens: 100_000 },
    { headerKey: requestHeaderKey(envelope) },
  );

  const measured = meter.measureRequest("cached", envelope);

  expect(measured.source).toBe("provider_usage");
  expect(measured.totalTokens).toBe(2_000 + 10 + 100_000);
});
