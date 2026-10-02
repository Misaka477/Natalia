import { expect, test } from "bun:test";
import {
  ProviderConcurrencyLimiter,
  withProviderConcurrency,
} from "../src/provider-concurrency";

test("a provider without a configured cap is unlimited", async () => {
  const limiter = new ProviderConcurrencyLimiter({});
  expect(limiter.capFor("openai")).toBe(Infinity);
  // Unlimited providers do not track or queue: every acquire succeeds at once.
  const release = await limiter.acquire("openai");
  await limiter.acquire("openai");
  await limiter.acquire("openai");
  release();
});

test("the cap queues excess requests and releases them in order", async () => {
  const limiter = new ProviderConcurrencyLimiter({ deepseek: 2 });
  const order: string[] = [];
  // Two slots fill immediately; the third queues.
  const a = await limiter.acquire("deepseek");
  const b = await limiter.acquire("deepseek");
  let thirdStarted = false;
  const third = limiter.acquire("deepseek").then((release) => {
    thirdStarted = true;
    return release;
  });
  expect(thirdStarted).toBe(false);
  a();
  const thirdRelease = await third;
  expect(thirdStarted).toBe(true);
  expect(limiter.activeCount("deepseek")).toBe(2);
  b();
  thirdRelease();
  expect(limiter.activeCount("deepseek")).toBe(0);
});

test("per-provider caps are independent", async () => {
  const limiter = new ProviderConcurrencyLimiter({ deepseek: 1, openai: 3 });
  await limiter.acquire("deepseek");
  // deepseek is full but openai still has 3 slots.
  await limiter.acquire("openai");
  await limiter.acquire("openai");
  await limiter.acquire("openai");
  expect(limiter.activeCount("deepseek")).toBe(1);
  expect(limiter.activeCount("openai")).toBe(3);
});

test("withProviderConcurrency holds the slot for the whole stream", async () => {
  const limiter = new ProviderConcurrencyLimiter({ test: 1 });
  async function* stream() {
    yield 1;
    yield 2;
  }
  const out: number[] = [];
  for await (const value of withProviderConcurrency(limiter, "test", stream))
    out.push(value);
  expect(out).toEqual([1, 2]);
  // The slot was released after the stream ended.
  expect(limiter.activeCount("test")).toBe(0);
});

test("a cancelled queued request never acquires a provider slot", async () => {
  const limiter = new ProviderConcurrencyLimiter({ test: 1 });
  const release = await limiter.acquire("test");
  const controller = new AbortController();
  const queued = limiter.acquire("test", controller.signal);
  controller.abort();
  await expect(queued).rejects.toMatchObject({ name: "AbortError" });
  release();
  expect(limiter.activeCount("test")).toBe(0);
});
