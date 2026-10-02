import { parentPort } from "node:worker_threads";
import { Database } from "bun:sqlite";
import { SqliteSessionStore } from "@anthelia/session";

export type SessionLoadWorkerRequest =
  | {
      id: number;
      op: "events";
      dbPath: string;
      sessionID: string;
      afterSeq?: number;
      limit?: number;
    }
  | {
      id: number;
      op: "messagePage";
      dbPath: string;
      sessionID: string;
      options: { limit?: number; order?: "asc" | "desc"; cursor?: string };
    }
  | {
      id: number;
      op: "ensureMessageIndex";
      dbPath: string;
      sessionID: string;
    };

export type SessionLoadWorkerResponse =
  | {
      id: number;
      ok: true;
      events: import("@anthelia/contracts").RuntimeEvent[];
      lastSeq: number;
      hasMore: boolean;
    }
  | {
      id: number;
      ok: true;
      page: import("@anthelia/contracts").RuntimeMessagePage;
    }
  | { id: number; ok: false; error: string };

const port = parentPort;
if (!port) throw new Error("session-load worker requires parentPort");

const messageStores = new Map<string, SqliteSessionStore>();

function messageStore(dbPath: string) {
  let store = messageStores.get(dbPath);
  if (!store) {
    store = new SqliteSessionStore(dbPath);
    messageStores.set(dbPath, store);
  }
  return store;
}

port.on("message", async (request: SessionLoadWorkerRequest) => {
  try {
    if (request.op === "messagePage") {
      const store = messageStore(request.dbPath);
      const page = store.loadMessagePage(
        request.sessionID as import("@anthelia/contracts").SessionID,
        request.options,
      );
      const response: SessionLoadWorkerResponse = {
        id: request.id,
        ok: true,
        page,
      };
      port.postMessage(response);
      return;
    }
    if (request.op === "ensureMessageIndex") {
      const store = messageStore(request.dbPath);
      store.ensureMessageIndex(
        request.sessionID as import("@anthelia/contracts").SessionID,
      );
      const response: SessionLoadWorkerResponse = {
        id: request.id,
        ok: true,
      } as SessionLoadWorkerResponse;
      port.postMessage(response);
      return;
    }
    let db: Database | undefined;
    try {
      db = new Database(request.dbPath);
      db.exec("PRAGMA query_only=ON");
      const afterSeq = Math.max(0, request.afterSeq ?? 0);
      const limit = Math.max(1, Math.min(2_000, request.limit ?? 500));
      const rows = db
        .query(
          `SELECT seq, event FROM events
           WHERE session_id = ? AND seq > ?
           ORDER BY seq
           LIMIT ?`,
        )
        .all(request.sessionID, afterSeq, limit) as Array<{
        seq: number;
        event: string;
      }>;
      const events = rows.map(
        (row) =>
          JSON.parse(row.event) as import("@anthelia/contracts").RuntimeEvent,
      );
      const response: SessionLoadWorkerResponse = {
        id: request.id,
        ok: true,
        events,
        lastSeq: rows.at(-1)?.seq ?? afterSeq,
        hasMore: rows.length >= limit,
      };
      port.postMessage(response);
    } finally {
      db?.close();
    }
  } catch (error) {
    const response: SessionLoadWorkerResponse = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    port.postMessage(response);
  }
});

export {};
