import type { RuntimeStructuredDiffHunk } from "@anthelia/contracts";
import type { StructuredDiffResult } from "@anthelia/diff-wasm";
import type { DiffWorkerRequest, DiffWorkerResponse } from "./diff-worker";
import { createWebWorkerPool, defaultWorkerPoolSize } from "./worker-pool";

let nextID = 1;
const pending = new Map<
  number,
  {
    resolve: (result: StructuredDiffResult) => void;
    reject: (error: Error) => void;
  }
>();
const streaming = new Map<
  number,
  {
    onHunk: (hunk: RuntimeStructuredDiffHunk) => void;
    resolve: (meta: { additions: number; deletions: number }) => void;
    reject: (error: Error) => void;
  }
>();

function handleWorkerMessage(event: MessageEvent<DiffWorkerResponse>) {
  const response = event.data;
  const single = pending.get(response.id);
  if (single) {
    pending.delete(response.id);
    if (response.ok && "result" in response) {
      single.resolve(response.result);
    } else if (response.ok) {
      single.reject(new Error("unexpected stream response"));
    } else {
      single.reject(new Error(response.error));
    }
    return;
  }
  const stream = streaming.get(response.id);
  if (!stream) return;
  if (!response.ok) {
    streaming.delete(response.id);
    stream.reject(new Error(response.error));
    return;
  }
  if (!("stream" in response && response.stream)) return;
  if (response.kind === "start") return;
  if (response.kind === "hunk") {
    stream.onHunk(response.hunk);
    return;
  }
  if (response.kind === "done") {
    streaming.delete(response.id);
    stream.resolve(
      response as unknown as { additions: number; deletions: number },
    );
  }
}

function handleWorkerError() {
  for (const { reject } of pending.values())
    reject(new Error("diff worker failed"));
  pending.clear();
  for (const { reject } of streaming.values())
    reject(new Error("diff worker failed"));
  streaming.clear();
}

const diffPool = createWebWorkerPool<Worker>(
  () =>
    new Worker(new URL("./diff-worker.ts", import.meta.url), {
      type: "module",
    }),
  defaultWorkerPoolSize(),
);

function ensureWorkers(): void {
  for (const worker of diffPool.all()) {
    // Message/error listeners are attached once on first pool creation.
    if (!("__nataliaDiffListener" in worker)) {
      worker.addEventListener("message", handleWorkerMessage);
      worker.addEventListener("error", handleWorkerError);
      (
        worker as Worker & { __nataliaDiffListener?: boolean }
      ).__nataliaDiffListener = true;
    }
  }
}

/**
 * Runs a structured diff (`@anthelia/diff-wasm` + parseDiffBinary) inside a
 * dedicated Web Worker. The main thread only receives the already-parsed
 * `StructuredDiffResult`.
 */
export function computeDiffInWorker(
  oldText: string,
  newText: string,
): Promise<StructuredDiffResult> {
  const id = nextID++;
  ensureWorkers();
  const instance = diffPool.worker();
  return new Promise<StructuredDiffResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const request: DiffWorkerRequest = {
      id,
      oldText,
      newText,
    };
    instance.postMessage(request);
  });
}

/**
 * Streaming variant: hunks are posted one-by-one from the Worker so a large
 * diff can be rendered incrementally without waiting for the full result.
 */
export function computeDiffInWorkerStream(
  oldText: string,
  newText: string,
  onHunk: (hunk: RuntimeStructuredDiffHunk) => void,
): Promise<{ additions: number; deletions: number }> {
  const id = nextID++;
  ensureWorkers();
  const instance = diffPool.worker();
  return new Promise<{ additions: number; deletions: number }>(
    (resolve, reject) => {
      streaming.set(id, { onHunk, resolve, reject });
      const request: DiffWorkerRequest = {
        id,
        oldText,
        newText,
        stream: true,
      };
      instance.postMessage(request);
    },
  );
}
