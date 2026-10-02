/**
 * Minimal round-robin Web Worker pool.
 *
 * The pool owns a small set of long-lived workers so CPU-heavy UI tasks can
 * run in parallel without creating a new Worker per request. Workers are
 * created lazily on first use to avoid adding startup cost before they are
 * actually needed.
 */
export type WebWorkerPool<TWorker extends Worker = Worker> = {
  worker(): TWorker;
  all(): TWorker[];
  size(): number;
};

export function createWebWorkerPool<TWorker extends Worker = Worker>(
  factory: () => TWorker,
  size: number,
): WebWorkerPool<TWorker> {
  const workers: TWorker[] = [];
  let next = 0;

  function ensureWorkers(): void {
    while (workers.length < size) {
      const worker = factory();
      // In the browser `unref` is absent; in the Bun runtime an idle worker
      // must not keep the process alive past a graceful shutdown.
      (worker as Worker & { unref?: () => void }).unref?.();
      workers.push(worker);
    }
  }

  return {
    worker() {
      if (!workers.length) ensureWorkers();
      const worker = workers[next++ % workers.length]!;
      return worker;
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

export function defaultWorkerPoolSize(): number {
  if (typeof navigator !== "undefined" && navigator.hardwareConcurrency) {
    return Math.max(2, Math.min(4, navigator.hardwareConcurrency));
  }
  return 2;
}
