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
  /** Whether a worker is available. False means the caller must not wait. */
  healthy(): boolean;
  /** Why no worker is available, when none is. */
  failure(): string | undefined;
};

export function createRuntimeWorkerPool<TWorker extends Worker = Worker>(
  factory: () => TWorker,
  size: number,
): RuntimeWorkerPool<TWorker> {
  const workers: TWorker[] = [];
  let next = 0;
  /**
   * Why the factory refused to produce a worker.
   *
   * Sticky on purpose. A factory that cannot produce one will not start
   * producing one on the next task, and retrying it per task re-raises the same
   * failure for every caller — each of whom pays its own deadline for it.
   */
  let refused: string | undefined;
  /**
   * The last worker failure that was NOT a refusal by the factory: a worker
   * that was constructed and then died.
   */
  let lastFailure: string | undefined;

  function reason(): string {
    return refused ?? lastFailure ?? "no worker available";
  }

  /**
   * Removes a worker whose own `error` event fired.
   *
   * The retirement exists because of how a dead worker actually presents
   * itself. Bun reports a worker whose bootstrap died — a module it could not
   * resolve, a syntax error, an uncaught throw — as an ASYNCHRONOUS `error`
   * event, never as a constructor throw. `factory()` therefore SUCCEEDS for a
   * worker that is already gone, and only the pool can notice. Measured on a
   * packaged Windows runtime: the compiled binary could not resolve the worker
   * module (`BuildMessage: ModuleNotFound resolving "B:\~BUN\root\…"`), every
   * pool was filled with dead workers, and `config.get` and `model.catalog`
   * each paid their full 15s deadline before falling back.
   *
   * A dead worker is retired rather than condemning the pool: the next
   * `worker()` call creates a replacement lazily, so one crash costs one
   * construction — not the whole pool, and not a permanent switch to the
   * caller's synchronous fallback.
   */
  function retire(dead: TWorker, message: string): void {
    const at = workers.indexOf(dead);
    if (at >= 0) workers.splice(at, 1);
    lastFailure = message;
  }

  function ensureWorkers(): void {
    if (refused !== undefined) return;
    while (workers.length < size) {
      let worker: TWorker;
      try {
        worker = factory();
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
        return;
      }
      worker.addEventListener("error", (event: ErrorEvent) => {
        const message = (event as ErrorEvent | undefined)?.message;
        retire(
          worker,
          message ? `a worker failed: ${message}` : "a worker failed",
        );
      });
      // An idle worker must not keep the runtime process alive: the server/
      // host handle owns liveness, and graceful shutdown closes those. Without
      // this the process hangs after dispose until the shutdown watchdog.
      (worker as Worker & { unref?: () => void }).unref?.();
      workers.push(worker);
    }
  }

  return {
    worker() {
      if (refused !== undefined) throw new Error(reason());
      if (!workers.length) ensureWorkers();
      if (!workers.length) throw new Error(reason());
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
      if (refused !== undefined) return false;
      if (!workers.length) ensureWorkers();
      return workers.length > 0;
    },
    failure() {
      return refused ?? lastFailure;
    },
  };
}

export function defaultRuntimeWorkerPoolSize(): number {
  const cpus =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0;
  const cpuCount = cpus || 2;
  return Math.max(2, Math.min(4, cpuCount));
}
