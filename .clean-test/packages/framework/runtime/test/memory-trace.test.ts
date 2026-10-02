import { expect, test } from "bun:test";
import {
  startMemoryTraceSampler,
  stopMemoryTraceSampler,
} from "../src/memory-trace";

test("the RSS sampler is a no-op unless NATALIA_MEMORY_TRACE=1", () => {
  delete process.env.NATALIA_MEMORY_TRACE;
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    startMemoryTraceSampler();
    expect(warnings).toHaveLength(0);
  } finally {
    console.warn = original;
    stopMemoryTraceSampler();
  }
});

test("the RSS sampler logs periodic samples when enabled", async () => {
  process.env.NATALIA_MEMORY_TRACE = "1";
  process.env.NATALIA_MEMORY_TRACE_INTERVAL_MS = "1000";
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    startMemoryTraceSampler();
    await Bun.sleep(1_150);
    stopMemoryTraceSampler();
    expect(
      warnings.some((entry) => entry.includes("[mem-trace] rss.sample")),
    ).toBe(true);
  } finally {
    console.warn = original;
    stopMemoryTraceSampler();
    delete process.env.NATALIA_MEMORY_TRACE;
    delete process.env.NATALIA_MEMORY_TRACE_INTERVAL_MS;
  }
});
