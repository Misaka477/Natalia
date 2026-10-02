import { expect, test } from "bun:test";
import { startRendererMemoryTrace } from "../src/memory-trace";

test("renderer memory trace is a no-op without the injected flag", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(
      args
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" "),
    );
  };
  try {
    delete (globalThis as { __NATALIA_MEMORY_TRACE?: unknown })
      .__NATALIA_MEMORY_TRACE;
    startRendererMemoryTrace();
    expect(warnings).toHaveLength(0);
  } finally {
    console.warn = original;
  }
});

test("renderer memory trace samples performance.memory when enabled", () => {
  const warnings: string[] = [];
  const original = console.warn;
  const originalMemory = (performance as { memory?: unknown }).memory;
  console.warn = (...args: unknown[]) => {
    warnings.push(
      args
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" "),
    );
  };
  (performance as { memory?: unknown }).memory = {
    usedJSHeapSize: 10 * 1048576,
    totalJSHeapSize: 20 * 1048576,
    jsHeapSizeLimit: 100 * 1048576,
  };
  (globalThis as { __NATALIA_MEMORY_TRACE?: unknown }).__NATALIA_MEMORY_TRACE =
    1;
  try {
    const stop = startRendererMemoryTrace();
    expect(
      warnings.some((entry) => entry.includes("[mem-trace][renderer]")),
    ).toBe(true);
    expect(warnings.some((entry) => entry.includes("usedJSHeapMB"))).toBe(true);
    stop();
  } finally {
    console.warn = original;
    if (originalMemory === undefined)
      delete (performance as { memory?: unknown }).memory;
    else (performance as { memory?: unknown }).memory = originalMemory;
    delete (globalThis as { __NATALIA_MEMORY_TRACE?: unknown })
      .__NATALIA_MEMORY_TRACE;
  }
});
