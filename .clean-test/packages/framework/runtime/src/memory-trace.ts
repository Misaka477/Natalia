export function memoryTrace(
  label: string,
  extra?: Record<string, unknown>,
): void {
  if (process.env.NATALIA_MEMORY_TRACE !== "1") return;
  const usage = process.memoryUsage();
  console.warn(`[mem-trace] ${label}`, {
    rssMB: Math.round(usage.rss / 1048576),
    heapMB: Math.round(usage.heapUsed / 1048576),
    externalMB: Math.round(usage.external / 1048576),
    arrayBuffersMB: Math.round(usage.arrayBuffers / 1048576),
    ...extra,
  });
}

let sampler: ReturnType<typeof setInterval> | undefined;

/**
 * Periodic RSS/heap sample under `NATALIA_MEMORY_TRACE=1`, so a soak can tell a
 * one-off spike from a per-session/per-turn leak. Interval is configurable via
 * `NATALIA_MEMORY_TRACE_INTERVAL_MS` (default 15s); the timer is unref'd so it
 * never keeps the process alive.
 */
export function startMemoryTraceSampler(): void {
  if (process.env.NATALIA_MEMORY_TRACE !== "1") return;
  if (sampler) return;
  const configured = Number(process.env.NATALIA_MEMORY_TRACE_INTERVAL_MS ?? "");
  const intervalMs =
    Number.isFinite(configured) && configured >= 1_000 ? configured : 15_000;
  sampler = setInterval(() => memoryTrace("rss.sample"), intervalMs);
  sampler.unref?.();
}

export function stopMemoryTraceSampler(): void {
  if (sampler) clearInterval(sampler);
  sampler = undefined;
}
