import { highlightLine, type SyntaxPart } from "./syntax";

export type SyntaxWorkerRequest = {
  id: number;
  text: string;
  language?: string;
};

export type SyntaxWorkerResponse =
  | { id: number; ok: true; parts: SyntaxPart[] }
  | { id: number; ok: false; error: string };

const worker = self as unknown as {
  onmessage: (event: MessageEvent<SyntaxWorkerRequest>) => void;
  postMessage: (response: SyntaxWorkerResponse) => void;
};

worker.onmessage = (event: MessageEvent<SyntaxWorkerRequest>) => {
  const { id, text, language } = event.data;
  try {
    const parts = highlightLine(text, language);
    worker.postMessage({ id, ok: true, parts });
  } catch (error) {
    worker.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export {};
