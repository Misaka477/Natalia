/**
 * Minimal round-robin Worker thread pool for the Node/Bun runtime process.
 *
 * CPU-heavy framework work (AST parsing, structured diff parsing, object-store
 * maintenance, etc.) can be dispatched to these workers so the runtime's main
 * event loop stays responsive for urgent RPC traffic.
 */
export type RuntimeWorkerPool<TWorker extends Worker = Worker> = {
  worker(): TWorker;
  all(): TWorker[];
  size(): number;
  /** Whether a worker came up at all. False means the caller must not wait. */
  healthy(): boolean;
  /** Why no worker came up, when none did. */
  failure(): string | undefined;
};

export function createRuntimeWorkerPool<TWorker extends Worker = Worker>(
  factory: () => TWorker,
  size: number,
): RuntimeWorkerPool<TWorker> {
  const workers: TWorker[] = [];
  let next = 0;
  // Whether a worker came up, and why not when none did.
  //
  // In a PACKAGED build the worker module is not a file on disk — the bundler
  // inlines it and the `new URL("./…worker.ts", import.meta.url)` every pool
  // factory uses resolves into the runtime's own embedded paths. The
  // constructor then fails without settling anything, so every task posted
  // waits forever. Measured: a packaged Windows copy whose
  // `session-project` and `secondary` pools both failed this way, with
  // `config.get` unanswered and the window spinning on its loading surface.
  //
  // The first failure is sticky on purpose. A pool that retries the factory
  // on every task re-raises the same failure for every caller, and each one
  // pays the deadline again; a caller that asks `healthy()` first goes
  // straight to its synchronous fallback.
  let broken: string | undefined;

  function ensureWorkers(): void {
    if (broken !== undefined) return;
    while (workers.length < size) {
      let worker: TWorker;
      try {
        worker = factory();
      } catch (error) {
        broken = error instanceof Error ? error.message : String(error);
        return;
      }
      // An idle worker must not keep the runtime process alive: the server/
      // host handle owns liveness, and graceful shutdown closes those. Without
      // this the process hangs after dispose until the shutdown watchdog.
      (worker as Worker & { unref?: () => void }).unref?.();
      workers.push(worker);
    }
  }

  return {
    worker() {
      if (!workers.length) ensureWorkers();
      if (workers.length === 0)
        throw new Error(broken ?? "no worker available");
      return workers[next++ % workers.length]!;
    },
    all() {
      if (!workers.length) ensureWorkers();
      return workers;
    },
    size() {
      return workers.length || size;
    },
    healthy() {
      if (!workers.length) ensureWorkers();
      return workers.length > 0;
    },
    failure() {
      return broken;
    },
  };
}

export function defaultRuntimeWorkerPoolSize(): number {
  const cpus =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0;
  const cpuCount = cpus || 2;
  return Math.max(2, Math.min(4, cpuCount));
}
