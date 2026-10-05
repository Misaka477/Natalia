import { getLogger, LoggerLevel, logService } from "@anthelia/logging";

const log = getLogger("memory-trace");

/**
 * A diagnostic that used to gate itself on `NATALIA_MEMORY_TRACE=1` and write
 * through console — one env var per diagnostic, which is exactly the
 * fragmentation the named-level logger replaces. The name is the switch:
 * `NATALIA_LOG=memory-trace=info` (or `debug`) turns it on for this subsystem
 * alone, and the level table decides rather than a bespoke variable.
 */
export function memoryTrace(
  label: string,
  extra?: Record<string, unknown>,
): void {
  const usage = process.memoryUsage();
  log.debug("%s %o", label, {
    rssMB: Math.round(usage.rss / 1048576),
    heapMB: Math.round(usage.heapUsed / 1048576),
    externalMB: Math.round(usage.external / 1048576),
    arrayBuffersMB: Math.round(usage.arrayBuffers / 1048576),
    ...extra,
  });
}

let sampler: ReturnType<typeof setInterval> | undefined;

/**
 * Periodic RSS/heap sample, so a soak can tell a one-off spike from a
 * per-session/per-turn leak. The gate is the level table
 * (`NATALIA_LOG=memory-trace=info`) or `NATALIA_MEMORY_TRACE=1`; the interval
 * is configurable via `NATALIA_MEMORY_TRACE_INTERVAL_MS` (default 15s) and the
 * timer is unref'd so it never keeps the process alive.
 */
export function startMemoryTraceSampler(): void {
  // The gate is the level table, not a bespoke variable: the sampler only
  // earns its timer when memory-trace's threshold admits its records.
  // `NATALIA_MEMORY_TRACE=1` still forces it on for a script that wants the
  // samples without touching the table.
  if (
    process.env.NATALIA_MEMORY_TRACE !== "1" &&
    logService.thresholdFor("memory-trace") < LoggerLevel.info
  )
    return;
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
