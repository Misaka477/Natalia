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
};

export function createRuntimeWorkerPool<TWorker extends Worker = Worker>(
  factory: () => TWorker,
  size: number,
): RuntimeWorkerPool<TWorker> {
  const workers: TWorker[] = [];
  let next = 0;

  function ensureWorkers(): void {
    while (workers.length < size) {
      const worker = factory();
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
      return workers[next++ % workers.length]!;
    },
    all() {
      if (!workers.length) ensureWorkers();
      return workers;
    },
    size() {
      return workers.length || size;
    },
  };
}

export function defaultRuntimeWorkerPoolSize(): number {
  const cpus =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0;
  const cpuCount = cpus || 2;
  return Math.max(2, Math.min(4, cpuCount));
}
