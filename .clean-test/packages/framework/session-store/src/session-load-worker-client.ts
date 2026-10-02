import type {
  RuntimeEvent,
  RuntimeMessagePage,
  SessionID,
} from "@anthelia/contracts";
import type {
  SessionLoadWorkerRequest,
  SessionLoadWorkerResponse,
} from "./session-load.worker";

let nextID = 1;
const pending = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }
>();

const workers: Worker[] = [];
let nextWorker = 0;

function poolWorker(): Worker {
  const size = Math.max(
    2,
    Math.min(4, Number(process.env.NATALIA_SESSION_LOAD_WORKERS ?? 2)),
  );
  while (workers.length < size) {
    const instance = new Worker(
      new URL("./session-load.worker.ts", import.meta.url),
      { type: "module" },
    );
    instance.addEventListener(
      "message",
      (event: MessageEvent<SessionLoadWorkerResponse>) => {
        const response = event.data;
        const entry = pending.get(response.id);
        if (!entry) return;
        pending.delete(response.id);
        if (response.ok) {
          if ("events" in response)
            entry.resolve({
              events: response.events,
              lastSeq: response.lastSeq,
              hasMore: response.hasMore,
            });
          else if ("page" in response) entry.resolve(response.page);
          else entry.resolve(undefined);
        } else entry.reject(new Error(response.error));
      },
    );
    instance.addEventListener("error", () => {
      for (const { reject } of pending.values())
        reject(new Error("session-load worker failed"));
      pending.clear();
    });
    // Idle workers must not pin the process; the host owns liveness.
    (instance as Worker & { unref?: () => void }).unref?.();
    workers.push(instance);
  }
  return workers[nextWorker++ % workers.length]!;
}

type SessionLoadWorkerTask =
  | {
      op: "events";
      dbPath: string;
      sessionID: string;
      afterSeq?: number;
      limit?: number;
    }
  | {
      op: "messagePage";
      dbPath: string;
      sessionID: SessionID;
      options: { limit?: number; order?: "asc" | "desc"; cursor?: string };
    }
  | { op: "ensureMessageIndex"; dbPath: string; sessionID: SessionID };

async function run<T>(request: SessionLoadWorkerTask): Promise<T> {
  const id = nextID++;
  const instance = poolWorker();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
    });
    instance.postMessage({ ...request, id } as SessionLoadWorkerRequest);
  });
}

export async function loadSessionEventsInWorker(
  dbPath: string,
  sessionID: string,
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  let afterSeq = 0;
  while (true) {
    const page = await loadSessionEventPageInWorker(
      dbPath,
      sessionID,
      afterSeq,
      500,
    );
    events.push(...page.events);
    if (!page.hasMore) return events;
    afterSeq = page.lastSeq;
  }
}

export type SessionEventPage = {
  events: RuntimeEvent[];
  lastSeq: number;
  hasMore: boolean;
};

export function loadSessionEventPageInWorker(
  dbPath: string,
  sessionID: string,
  afterSeq: number,
  limit: number,
): Promise<SessionEventPage> {
  return run<SessionEventPage>({
    op: "events",
    dbPath,
    sessionID,
    afterSeq,
    limit,
  });
}

export function loadMessagePageInWorker(
  dbPath: string,
  sessionID: SessionID,
  options: { limit?: number; order?: "asc" | "desc"; cursor?: string },
): Promise<RuntimeMessagePage> {
  return run<RuntimeMessagePage>({
    op: "messagePage",
    dbPath,
    sessionID,
    options,
  });
}

export function ensureMessageIndexInWorker(
  dbPath: string,
  sessionID: SessionID,
): Promise<void> {
  return run<void>({ op: "ensureMessageIndex", dbPath, sessionID });
}
