import type { SyntaxPart } from "./syntax";
import type {
  SyntaxWorkerRequest,
  SyntaxWorkerResponse,
} from "./syntax-worker";
import { createWebWorkerPool, defaultWorkerPoolSize } from "./worker-pool";

let nextID = 1;
const pending = new Map<
  number,
  {
    resolve: (parts: SyntaxPart[]) => void;
    reject: (error: Error) => void;
  }
>();

const pool = createWebWorkerPool(() => {
  const instance = new Worker(new URL("./syntax-worker.ts", import.meta.url), {
    type: "module",
  });
  instance.addEventListener(
    "message",
    (event: MessageEvent<SyntaxWorkerResponse>) => {
      const response = event.data;
      const entry = pending.get(response.id);
      if (!entry) return;
      pending.delete(response.id);
      if (response.ok) entry.resolve(response.parts);
      else entry.reject(new Error(response.error));
    },
  );
  instance.addEventListener("error", () => {
    for (const { reject } of pending.values())
      reject(new Error("syntax worker failed"));
    pending.clear();
  });
  return instance;
}, defaultWorkerPoolSize());

export function highlightInWorker(
  text: string,
  language?: string,
): Promise<SyntaxPart[]> {
  const id = nextID++;
  const instance = pool.worker();
  return new Promise<SyntaxPart[]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const request: SyntaxWorkerRequest = { id, text, language };
    instance.postMessage(request);
  });
}

export function highlightInWorkerBatch(
  lines: Array<{ text: string; language?: string }>,
): Promise<SyntaxPart[][]> {
  return Promise.all(
    lines.map(({ text, language }) => highlightInWorker(text, language)),
  );
}
