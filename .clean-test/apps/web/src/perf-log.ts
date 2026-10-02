export function perfLog(...args: unknown[]): void {
  const enabled =
    (globalThis as { __NATALIA_PERF_VERBOSE?: number })
      .__NATALIA_PERF_VERBOSE === 1;
  if (enabled) console.warn(...args);
}
