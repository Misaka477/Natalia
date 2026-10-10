import type { AppState } from "@natalia/view-store";
import type {
  CloneStateWorkerRequest,
  CloneStateWorkerResponse,
} from "./clone-state.worker";

let nextID = 1;
const pending = new Map<
  number,
  {
    /** The worker this request was handed to, so its failure rejects only its own. */
    owner: Worker;
    resolve: (state: AppState) => void;
    reject: (error: Error) => void;
  }
>();

const workers: Worker[] = [];
const dead = new WeakSet<Worker>();
let nextWorker = 0;

/**
 * How long a clone may take before the caller falls back.
 *
 * A worker that has already errored does not error AGAIN for a later
 * `postMessage` — the message is silently dropped and its promise never
 * settles. Without this ceiling the caller awaits forever, `setState` is
 * never called, and the UI freezes on the last projected frame while the
 * model keeps streaming: the "it worked for a while and then nothing
 * renders" report. The synchronous clone on the main thread is the honest
 * fallback the caller already has; this is what lets it reach it.
 */
const CLONE_TIMEOUT_MS = 5_000;

function poolWorker(): Worker {
  const hardwareConcurrency =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0;
  const size = Math.max(2, Math.min(4, hardwareConcurrency || 2));
  while (workers.length < size) {
    const instance = workerFactory();
    instance.addEventListener(
      "message",
      (event: MessageEvent<CloneStateWorkerResponse>) => {
        const response = event.data;
        const entry = pending.get(response.id);
        if (!entry) return;
        pending.delete(response.id);
        if (response.ok) entry.resolve(response.state);
        else entry.reject(new Error(response.error));
      },
    );
    instance.addEventListener("error", () => {
      // Everything this worker was holding is unreachable now, so those
      // callers must hear about it rather than wait for a message that will
      // never come.
      for (const [id, entry] of [...pending]) {
        // Only the requests this worker owned; the map is shared across the
        // pool, and rejecting another worker's live work would be a lie.
        if (entry.owner !== instance) continue;
        pending.delete(id);
        entry.reject(new Error("clone-state worker failed"));
      }
      // And it must never be handed work again: a dead worker accepts
      // `postMessage` silently, so reusing it hangs every later request.
      dead.add(instance);
      instance.terminate();
    });
    // Idle workers must not pin the process; the host owns liveness.
    (instance as Worker & { unref?: () => void }).unref?.();
    workers.push(instance);
  }
  // Rotate over the LIVE workers only.
  for (let attempt = 0; attempt < workers.length; attempt++) {
    const candidate = workers[nextWorker++ % workers.length]!;
    if (!dead.has(candidate)) return candidate;
  }
  // Every pooled worker is dead: start a fresh one rather than hand work to
  // a corpse.
  workers.length = 0;
  return poolWorker();
}

/**
 * The Worker constructor, overridable so a test can hand the pool a worker
 * that never answers. Production never sets this.
 */
let workerFactory: () => Worker = () =>
  new Worker(new URL("./clone-state.worker.ts", import.meta.url), {
    type: "module",
  });

export function setCloneStateWorkerFactory(factory: () => Worker): void {
  workerFactory = factory;
  // A new factory means the pooled instances were built by the old one.
  workers.length = 0;
}

export function cloneStateInWorker(state: AppState): Promise<AppState> {
  const id = nextID++;
  const instance = poolWorker();
  return new Promise<AppState>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      reject(
        new Error(
          `clone-state worker did not answer within ${CLONE_TIMEOUT_MS}ms`,
        ),
      );
    }, CLONE_TIMEOUT_MS);
    const entry = {
      owner: instance,
      resolve: (value: AppState) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error: Error) => {
        clearTimeout(timer);
        reject(error);
      },
    };
    pending.set(id, entry);
    const request: CloneStateWorkerRequest = { id, state };
    instance.postMessage(request);
  });
}
