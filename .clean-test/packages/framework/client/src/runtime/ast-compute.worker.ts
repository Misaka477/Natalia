import {
  diffWasmAst,
  indexWasmAst,
  type AstDiffResult,
  type AstIndexResult,
} from "@anthelia/diff-wasm/ast";

export type AstComputeRequest =
  | {
      id: number;
      op: "diff";
      oldText: string;
      newText: string;
      language: string;
    }
  | {
      id: number;
      op: "index";
      source: string;
      language: string;
    };

export type AstComputeResponse =
  | { id: number; ok: true; result: AstDiffResult | AstIndexResult }
  | { id: number; ok: false; error: string };

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<AstComputeRequest>) => void) | null;
  postMessage: (message: AstComputeResponse) => void;
};

worker.onmessage = (event: MessageEvent<AstComputeRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      const result =
        request.op === "diff"
          ? await diffWasmAst(
              request.oldText,
              request.newText,
              request.language,
            )
          : await indexWasmAst(request.source, request.language);
      const response: AstComputeResponse = { id: request.id, ok: true, result };
      worker.postMessage(response);
    } catch (error) {
      const response: AstComputeResponse = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      worker.postMessage(response);
    }
  })();
};

export {};
