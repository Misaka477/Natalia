/**
 * Renderer (CEF/Chromium) heap sampler.
 *
 * The runtime process' RSS/heap is logged server-side under
 * `NATALIA_MEMORY_TRACE=1`. The web UI runs in a separate Chromium process, so
 * that number says nothing about the renderer; this logs `performance.memory`
 * on the same interval when the flag is injected into the page.
 */
type ChromiumMemory = {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
};

let timer: ReturnType<typeof setInterval> | undefined;

export function startRendererMemoryTrace(): () => void {
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const flag = (globalThis as { __NATALIA_MEMORY_TRACE?: unknown })
    .__NATALIA_MEMORY_TRACE;
  if (flag !== 1 && flag !== "1") return stop;
  if (timer) return stop;
  const memory = (performance as Performance & { memory?: ChromiumMemory })
    .memory;
  if (!memory) {
    console.warn(
      "[mem-trace][renderer] performance.memory unavailable in this renderer",
    );
    return stop;
  }
  const configured = Number(
    (globalThis as { __NATALIA_MEMORY_TRACE_INTERVAL_MS?: unknown })
      .__NATALIA_MEMORY_TRACE_INTERVAL_MS ?? "",
  );
  const intervalMs =
    Number.isFinite(configured) && configured >= 1_000 ? configured : 15_000;
  const mb = (value: number) => Math.round(value / 1048576);
  const sample = () =>
    console.warn("[mem-trace][renderer]", {
      usedJSHeapMB: mb(memory.usedJSHeapSize),
      totalJSHeapMB: mb(memory.totalJSHeapSize),
      limitMB: mb(memory.jsHeapSizeLimit),
    });
  sample();
  timer = setInterval(sample, intervalMs);
  return stop;
}
