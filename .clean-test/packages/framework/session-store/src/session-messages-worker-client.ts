import type { RuntimeMessagePage } from "@anthelia/contracts";
import type {
  SessionMessagesWorkerRequest,
  SessionMessagesWorkerResponse,
} from "./session-messages.worker";

let nextID = 1;
const pending = new Map<
  number,
  {
    resolve: (page: RuntimeMessagePage) => void;
    reject: (error: Error) => void;
  }
>();

const workers: Worker[] = [];
let nextWorker = 0;

function poolWorker(): Worker {
  const size = Math.max(
    2,
    Math.min(4, Number(process.env.NATALIA_SESSION_MESSAGES_WORKERS ?? 2)),
  );
  while (workers.length < size) {
    const instance = new Worker(
      new URL("./session-messages.worker.ts", import.meta.url),
      { type: "module" },
    );
    instance.addEventListener(
      "message",
      (event: MessageEvent<SessionMessagesWorkerResponse>) => {
        const response = event.data;
        const entry = pending.get(response.id);
        if (!entry) return;
        pending.delete(response.id);
        if (response.ok) entry.resolve(response.page);
        else entry.reject(new Error(response.error));
      },
    );
    instance.addEventListener("error", () => {
      for (const { reject } of pending.values())
        reject(new Error("session-messages worker failed"));
      pending.clear();
    });
    // Idle workers must not pin the process; the host owns liveness.
    (instance as Worker & { unref?: () => void }).unref?.();
    workers.push(instance);
  }
  return workers[nextWorker++ % workers.length]!;
}

export function projectSessionMessagesInWorker(
  session: import("@anthelia/session").SessionRecord,
  options: { limit?: number; order?: "asc" | "desc"; cursor?: string },
): Promise<RuntimeMessagePage> {
  const id = nextID++;
  const instance = poolWorker();
  return new Promise<RuntimeMessagePage>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const request: SessionMessagesWorkerRequest = { id, session, options };
    instance.postMessage(request);
  });
}
