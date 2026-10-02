import type {
  MaintenanceWorkerRequest,
  MaintenanceWorkerResponse,
} from "./maintenance.worker";

let nextID = 1;
const pending = new Map<
  number,
  {
    resolve: (
      result: MaintenanceWorkerResponse extends { result: infer R } ? R : never,
    ) => void;
    reject: (error: Error) => void;
  }
>();

const workers: Worker[] = [];
let nextWorker = 0;

function poolWorker(): Worker {
  const hardwareConcurrency =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0;
  const cpus = hardwareConcurrency || 2;
  const size = Math.max(2, Math.min(4, cpus));
  while (workers.length < size) {
    const instance = new Worker(
      new URL("./maintenance.worker.ts", import.meta.url),
      { type: "module" },
    );
    instance.addEventListener(
      "message",
      (event: MessageEvent<MaintenanceWorkerResponse>) => {
        const response = event.data;
        const entry = pending.get(response.id);
        if (!entry) return;
        pending.delete(response.id);
        if (response.ok) entry.resolve(response.result as never);
        else entry.reject(new Error(response.error));
      },
    );
    instance.addEventListener("error", () => {
      for (const { reject } of pending.values())
        reject(new Error("object-store worker failed"));
      pending.clear();
    });
    // Idle workers must not pin the process; the host owns liveness.
    (instance as Worker & { unref?: () => void }).unref?.();
    workers.push(instance);
  }
  return workers[nextWorker++ % workers.length]!;
}

export function runObjectStoreMaintenance<T>(
  request: Omit<MaintenanceWorkerRequest, "id">,
): Promise<T> {
  const id = nextID++;
  const instance = poolWorker();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (result) => resolve(result as T),
      reject,
    });
    instance.postMessage({ ...request, id } as MaintenanceWorkerRequest);
  });
}
