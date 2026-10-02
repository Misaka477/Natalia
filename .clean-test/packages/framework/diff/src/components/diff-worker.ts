import {
  diffWasmStructured,
  type StructuredDiffResult,
} from "@anthelia/diff-wasm";

export type DiffWorkerRequest = {
  id: number;
  oldText: string;
  newText: string;
  stream?: boolean;
};

export type DiffWorkerResponse =
  | { id: number; ok: true; result: StructuredDiffResult }
  | {
      id: number;
      ok: true;
      stream: true;
      kind: "start";
      additions: number;
      deletions: number;
    }
  | {
      id: number;
      ok: true;
      stream: true;
      kind: "hunk";
      hunk: StructuredDiffResult["hunks"][number];
    }
  | { id: number; ok: true; stream: true; kind: "done" }
  | { id: number; ok: false; error: string };

self.onmessage = (event: MessageEvent<DiffWorkerRequest>) => {
  const { id, oldText, newText, stream } = event.data;
  void diffWasmStructured(oldText, newText)
    .then((result) => {
      if (stream) {
        const start: DiffWorkerResponse = {
          id,
          ok: true,
          stream: true,
          kind: "start",
          additions: result.additions,
          deletions: result.deletions,
        };
        (self as unknown as Worker).postMessage(start);
        for (const hunk of result.hunks) {
          const message: DiffWorkerResponse = {
            id,
            ok: true,
            stream: true,
            kind: "hunk",
            hunk,
          };
          (self as unknown as Worker).postMessage(message);
        }
        const done: DiffWorkerResponse = {
          id,
          ok: true,
          stream: true,
          kind: "done",
        };
        (self as unknown as Worker).postMessage(done);
        return;
      }
      const response: DiffWorkerResponse = { id, ok: true, result };
      (self as unknown as Worker).postMessage(response);
    })
    .catch((error: unknown) => {
      const response: DiffWorkerResponse = {
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      (self as unknown as Worker).postMessage(response);
    });
};

export {};
