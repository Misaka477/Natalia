import type { AppState } from "@natalia/view-store";
import type {
  CloneStateWorkerRequest,
  CloneStateWorkerResponse,
} from "./clone-state.worker";

let nextID = 1;
const pending = new Map<
  number,
  { resolve: (state: AppState) => void; reject: (error: Error) => void }
>();

const workers: Worker[] = [];
let nextWorker = 0;

function poolWorker(): Worker {
  const hardwareConcurrency =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0;
  const size = Math.max(2, Math.min(4, hardwareConcurrency || 2));
  while (workers.length < size) {
    const instance = new Worker(
      new URL("./clone-state.worker.ts", import.meta.url),
      { type: "module" },
    );
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
      for (const { reject } of pending.values())
        reject(new Error("clone-state worker failed"));
      pending.clear();
    });
    // Idle workers must not pin the process; the host owns liveness.
    (instance as Worker & { unref?: () => void }).unref?.();
    workers.push(instance);
  }
  return workers[nextWorker++ % workers.length]!;
}

export function cloneStateInWorker(state: AppState): Promise<AppState> {
  const id = nextID++;
  const instance = poolWorker();
  return new Promise<AppState>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const request: CloneStateWorkerRequest = { id, state };
    instance.postMessage(request);
  });
}
