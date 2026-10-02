import { parentPort } from "node:worker_threads";
import {
  patchToStructured,
  countPatch,
  diffToChanges,
} from "../structured-parse";

export type DiffParseWorkerRequest =
  | { id: number; op: "patch"; patch: string }
  | { id: number; op: "diffChanges"; rawDiff: string };

export type DiffParseWorkerResponse =
  | {
      id: number;
      ok: true;
      result:
        | {
            counts: { additions: number; deletions: number };
            structured: ReturnType<typeof patchToStructured>;
          }
        | ReturnType<typeof diffToChanges>;
    }
  | { id: number; ok: false; error: string };

const port = parentPort;
if (!port) throw new Error("diff-parse worker requires parentPort");

port.on("message", (request: DiffParseWorkerRequest) => {
  try {
    const result =
      request.op === "patch"
        ? {
            counts: countPatch(request.patch),
            structured: patchToStructured(request.patch),
          }
        : diffToChanges(request.rawDiff);
    const response: DiffParseWorkerResponse = {
      id: request.id,
      ok: true,
      result,
    };
    port.postMessage(response);
  } catch (error) {
    const response: DiffParseWorkerResponse = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    port.postMessage(response);
  }
});

export {};
