import { parentPort } from "node:worker_threads";
import { projectSessionMessages } from "@anthelia/session";
import type { RuntimeMessagePage } from "@anthelia/contracts";

export type SessionMessagesWorkerRequest = {
  id: number;
  session: import("@anthelia/session").SessionRecord;
  options: { limit?: number; order?: "asc" | "desc"; cursor?: string };
};

export type SessionMessagesWorkerResponse =
  | { id: number; ok: true; page: RuntimeMessagePage }
  | { id: number; ok: false; error: string };

const port = parentPort;
if (!port) throw new Error("session-messages worker requires parentPort");

port.on("message", (request: SessionMessagesWorkerRequest) => {
  try {
    const page = projectSessionMessages(request.session, request.options);
    const response: SessionMessagesWorkerResponse = {
      id: request.id,
      ok: true,
      page,
    };
    port.postMessage(response);
  } catch (error) {
    const response: SessionMessagesWorkerResponse = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    port.postMessage(response);
  }
});

export {};
