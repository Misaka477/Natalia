import type { AstDiffResult, AstIndexResult } from "@anthelia/diff-wasm/ast";
import type {
  AstComputeRequest,
  AstComputeResponse,
} from "./ast-compute.worker";

type AstComputeTask =
  | {
      op: "diff";
      oldText: string;
      newText: string;
      language: string;
    }
  | {
      op: "index";
      source: string;
      language: string;
    };
import {
  createRuntimeWorkerPool,
  defaultRuntimeWorkerPoolSize,
  type RuntimeWorkerPool,
} from "@anthelia/substrate";

let nextID = 1;
const pending = new Map<
  number,
  {
    resolve: (result: AstDiffResult | AstIndexResult) => void;
    reject: (error: Error) => void;
  }
>();
let pool: RuntimeWorkerPool<Worker> | undefined;

function ensurePool(): RuntimeWorkerPool<Worker> {
  if (pool) return pool;
  pool = createRuntimeWorkerPool(
    () =>
      new Worker(new URL("./ast-compute.worker.ts", import.meta.url), {
        type: "module",
      }),
    defaultRuntimeWorkerPoolSize(),
  );
  for (const worker of pool.all()) {
    worker.addEventListener(
      "message",
      (event: MessageEvent<AstComputeResponse>) => {
        const response = event.data;
        const entry = pending.get(response.id);
        if (!entry) return;
        pending.delete(response.id);
        if (response.ok) entry.resolve(response.result);
        else entry.reject(new Error(response.error));
      },
    );
    worker.addEventListener("error", () => {
      for (const { reject } of pending.values())
        reject(new Error("AST worker failed"));
      pending.clear();
    });
    // The pool is lazy, but a fresh worker may not have listeners attached
    // until ensurePool has run; attach on first all() above covers all.
  }
  return pool;
}

async function run<T extends AstDiffResult | AstIndexResult>(
  request: AstComputeTask,
): Promise<T> {
  const id = nextID++;
  const instance = ensurePool().worker();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (result) => resolve(result as T),
      reject,
    });
    const fullRequest = { ...request, id } as AstComputeRequest;
    instance.postMessage(fullRequest);
  });
}

export async function astDiffInWorker(
  oldText: string,
  newText: string,
  language: string,
): Promise<AstDiffResult> {
  return run<AstDiffResult>({ op: "diff", oldText, newText, language });
}

export async function astIndexInWorker(
  source: string,
  language: string,
): Promise<AstIndexResult> {
  return run<AstIndexResult>({ op: "index", source, language });
}
