import type {
  DiffParseWorkerRequest,
  DiffParseWorkerResponse,
} from "./diff-parse.worker";

let nextID = 1;
const pending = new Map<
  number,
  {
    resolve: (
      result: DiffParseWorkerResponse extends { ok: true; result: infer R }
        ? R
        : never,
    ) => void;
    reject: (error: Error) => void;
  }
>();

const workers: Worker[] = [];
let nextWorker = 0;

function poolWorker(): Worker {
  const size = Math.max(
    2,
    Math.min(4, Number(process.env.NATALIA_DIFF_PARSE_WORKERS ?? 2)),
  );
  while (workers.length < size) {
    const instance = new Worker(
      new URL("./diff-parse.worker.ts", import.meta.url),
      { type: "module" },
    );
    instance.addEventListener(
      "message",
      (event: MessageEvent<DiffParseWorkerResponse>) => {
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
        reject(new Error("diff-parse worker failed"));
      pending.clear();
    });
    // Idle workers must not pin the process; the host owns liveness.
    (instance as Worker & { unref?: () => void }).unref?.();
    workers.push(instance);
  }
  return workers[nextWorker++ % workers.length]!;
}

export function parsePatchInWorker(patch: string) {
  const id = nextID++;
  const instance = poolWorker();
  return new Promise<{
    counts: { additions: number; deletions: number };
    structured: ReturnType<
      typeof import("../structured-parse").patchToStructured
    >;
  }>((resolve, reject) => {
    pending.set(id, { resolve: (value) => resolve(value as never), reject });
    const request: DiffParseWorkerRequest = { id, op: "patch", patch };
    instance.postMessage(request);
  });
}

export function diffChangesInWorker(rawDiff: string) {
  const id = nextID++;
  const instance = poolWorker();
  return new Promise<
    ReturnType<typeof import("../structured-parse").diffToChanges>
  >((resolve, reject) => {
    pending.set(id, { resolve: (value) => resolve(value as never), reject });
    const request: DiffParseWorkerRequest = { id, op: "diffChanges", rawDiff };
    instance.postMessage(request);
  });
}
