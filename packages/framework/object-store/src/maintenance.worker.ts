import { parentPort } from "node:worker_threads";
import { ObjectStore } from "./object-store";

export type MaintenanceWorkerRequest =
  | {
      id: number;
      op: "compact";
      root: string;
    }
  | {
      id: number;
      op: "collectGarbage";
      root: string;
      reachable: string[];
    };

export type MaintenanceWorkerResponse =
  | {
      id: number;
      ok: true;
      result:
        | Awaited<ReturnType<ObjectStore["compact"]>>
        | Awaited<ReturnType<ObjectStore["collectGarbage"]>>;
    }
  | { id: number; ok: false; error: string };

const port = parentPort;
if (!port)
  throw new Error("object-store maintenance worker requires parentPort");

port.on("message", (request: MaintenanceWorkerRequest) => {
  void (async () => {
    try {
      (
        globalThis as unknown as {
          __NATALIA_OBJECT_STORE_NO_WORKER?: boolean;
        }
      ).__NATALIA_OBJECT_STORE_NO_WORKER = true;
      const store = new ObjectStore(request.root);
      const result =
        request.op === "compact"
          ? await store.compact()
          : await store.collectGarbage(new Set(request.reachable));
      const response: MaintenanceWorkerResponse = {
        id: request.id,
        ok: true,
        result,
      };
      port.postMessage(response);
    } catch (error) {
      const response: MaintenanceWorkerResponse = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      port.postMessage(response);
    }
  })();
});

export {};
