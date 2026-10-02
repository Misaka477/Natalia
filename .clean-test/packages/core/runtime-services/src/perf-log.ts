/**
 * Performance/log helper.
 *
 * Ordinary startup/rendering timing logs are only emitted when
 * NATALIA_PERF_VERBOSE=1. Error/failure logs should stay unconditional and
 * should not be routed through this helper.
 */
export function perfLog(...args: unknown[]): void {
  if (process.env.NATALIA_PERF_VERBOSE === "1") {
    console.warn(...args);
  }
}
