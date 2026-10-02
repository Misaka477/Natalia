import { cloneState, type AppState } from "@natalia/view-store";

export type CloneStateWorkerRequest = {
  id: number;
  state: AppState;
};

export type CloneStateWorkerResponse =
  | { id: number; ok: true; state: AppState }
  | { id: number; ok: false; error: string };

self.onmessage = (event: MessageEvent<CloneStateWorkerRequest>) => {
  try {
    const cloned = cloneState(event.data.state);
    const response: CloneStateWorkerResponse = {
      id: event.data.id,
      ok: true,
      state: cloned,
    };
    self.postMessage(response);
  } catch (error) {
    const response: CloneStateWorkerResponse = {
      id: event.data.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

export {};
