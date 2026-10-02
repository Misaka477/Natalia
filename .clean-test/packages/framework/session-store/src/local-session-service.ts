import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAttachmentService } from "@anthelia/attachments";
import type { SessionID } from "@anthelia/contracts";
import {
  resolveWorkspaceJsonSessionsDir,
  resolveWorkspaceJournalDatabasePath,
} from "@anthelia/platform";
import {
  JsonSessionStore,
  SqliteSessionStore,
  createSessionRecord,
  projectedWorkGraphEdges,
  projectedWorkGraphNodes,
} from "@anthelia/session";

export type LocalSessionRow = {
  id: SessionID;
  title: string;
  createdAt: string;
  lastAccessedAt?: string;
  pinned: boolean;
  archived?: boolean;
  events: number;
  pendingInputs: number;
};

export type SessionMetadataBundle = {
  version: 1;
  source: { id: string; createdAt: string };
  title: string;
  pinned: boolean;
  cancelled: boolean;
  resumable: boolean;
};

/** Offline session operations used when no runtime plugin host is running. */
export function createLocalSessionService(
  workspaceRoot = process.cwd(),
  sessionDir?: string,
) {
  const root = resolve(workspaceRoot);
  const json = () =>
    new JsonSessionStore(sessionDir ?? resolveWorkspaceJsonSessionsDir(root));
  const sqlite = () => {
    const path = resolveWorkspaceJournalDatabasePath(root);
    return existsSync(path) ? new SqliteSessionStore(path) : undefined;
  };

  return {
    async list(
      options: { useSqliteStore?: boolean } = {},
    ): Promise<LocalSessionRow[]> {
      const jsonSessions = await json().list();
      const database = options.useSqliteStore === false ? undefined : sqlite();
      const sqliteSessions = database
        ? database.list().map(
            (session) =>
              ({
                id: session.id,
                title: session.title,
                createdAt: session.createdAt,
                lastAccessedAt: session.metadata.lastAccessedAt as
                  | string
                  | undefined,
                pinned: session.pinned,
                archived: Boolean(session.metadata.archived),
                events: database.eventCount(session.id),
                pendingInputs: database.pendingInputCount(session.id),
              }) satisfies LocalSessionRow,
          )
        : [];
      database?.close();
      const sqliteIDs = new Set(sqliteSessions.map((session) => session.id));
      const sessions = jsonSessions
        .filter((session) =>
          // Match runtime migration: once SQLite is populated, missing JSON
          // IDs are treated as deleted rather than resurrected on startup.
          options.useSqliteStore === true && sqliteIDs.size > 0
            ? false
            : !sqliteIDs.has(session.id),
        )
        .map(
          (session) =>
            ({
              id: session.id,
              title: session.title,
              createdAt: session.createdAt,
              lastAccessedAt: session.metadata?.lastAccessedAt,
              pinned: Boolean(session.metadata?.pinned),
              archived: Boolean(session.metadata?.archived),
              events: session.events.length,
              pendingInputs:
                session.inbox?.filter((input) => !input.promotedAt).length ?? 0,
            }) satisfies LocalSessionRow,
        );
      return [...sqliteSessions, ...sessions].sort((left, right) => {
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
        return right.createdAt.localeCompare(left.createdAt);
      });
    },

    async delete(id: string) {
      const store = json();
      if (!(await store.load(id as SessionID)))
        throw new Error(`session not found: ${id}`);
      await store.delete(id as SessionID);
      const attachments = createAttachmentService(root);
      const removed = await attachments.cleanup(
        attachments.referencedForSessions(await store.list()),
      );
      return { id, deleted: true, removedAttachments: removed.length };
    },

    async show(id: string) {
      const database = sqlite();
      const sqliteSession = database?.get(id as SessionID);
      if (database && sqliteSession) {
        const result = {
          id: sqliteSession.id,
          title: sqliteSession.title,
          createdAt: sqliteSession.createdAt,
          pinned: sqliteSession.pinned,
          lastAccessedAt: sqliteSession.metadata.lastAccessedAt as
            | string
            | undefined,
          events: database.eventCount(sqliteSession.id),
          pendingInputs: database.pendingInputCount(sqliteSession.id),
          cancelled: sqliteSession.cancelled,
          resumable: sqliteSession.resumable,
        };
        database.close();
        return result;
      }
      database?.close();
      const session = await json().load(id as SessionID);
      if (!session) throw new Error(`session not found: ${id}`);
      return {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        pinned: Boolean(session.metadata?.pinned),
        lastAccessedAt: session.metadata?.lastAccessedAt,
        events: session.events.length,
        pendingInputs:
          session.inbox?.filter((input) => !input.promotedAt).length ?? 0,
        cancelled: session.cancelled,
        resumable: session.resumable,
      };
    },

    /**
     * All of a session's events, offline (Discovery D5's replay source):
     * WHATEVER STORE THE FILES SHOW wins — the journal database when it
     * exists, the JSON store otherwise. Same store-first rule `show`
     * uses, so counts and scores can never disagree about the source.
     */
    async events(
      id: string,
    ): Promise<import("@anthelia/contracts").RuntimeEvent[]> {
      const database = sqlite();
      if (database) {
        const session = database.get(id as SessionID);
        if (session) {
          try {
            return database.loadEvents(session.id);
          } finally {
            database.close();
          }
        }
        database.close();
      }
      const session = await json().load(id as SessionID);
      if (!session) throw new Error(`session not found: ${id}`);
      return session.events;
    },

    async workGraph(sessionID: string) {
      const database = sqlite();
      const session = database?.loadRecord(sessionID as SessionID);
      database?.close();
      const record = session ?? (await json().load(sessionID as SessionID));
      if (!record) throw new Error(`session not found: ${sessionID}`);
      return {
        sessionID: record.id,
        nodes: projectedWorkGraphNodes(record.events),
        edges: projectedWorkGraphEdges(record.events),
      };
    },

    async rename(id: string, title: string) {
      const session = await json().rename(id as SessionID, title);
      return { id: session.id, title: session.title };
    },

    async setPinned(id: string, pinned: boolean) {
      const session = await json().updateMetadata(id as SessionID, { pinned });
      return { id: session.id, pinned: Boolean(session.metadata?.pinned) };
    },

    async duplicate(
      id: string,
      input: { title?: string; newID?: string } = {},
    ) {
      const session = await json().duplicate(
        id as SessionID,
        input.newID as SessionID | undefined,
        input.title,
      );
      return { id: session.id, title: session.title, duplicatedFrom: id };
    },

    async exportMetadata(id: string): Promise<SessionMetadataBundle> {
      const session = await json().load(id as SessionID);
      if (!session) throw new Error(`session not found: ${id}`);
      return {
        version: 1,
        source: { id: session.id, createdAt: session.createdAt },
        title: session.title,
        pinned: Boolean(session.metadata?.pinned),
        cancelled: session.cancelled,
        resumable: session.resumable,
      };
    },

    async importMetadata(
      bundle: SessionMetadataBundle,
      input: { id?: string; title?: string } = {},
    ) {
      if (bundle.version !== 1 || !bundle.source?.id || !bundle.title)
        throw new Error("invalid session metadata bundle");
      const store = json();
      const id = (input.id ??
        `ses_import_${randomUUID().replace(/-/gu, "").slice(0, 16)}`) as SessionID;
      if (await store.load(id))
        throw new Error(`session already exists: ${id}`);
      const session = createSessionRecord(id, input.title ?? bundle.title);
      session.cancelled = bundle.cancelled;
      session.resumable = bundle.resumable;
      session.metadata = {
        pinned: bundle.pinned,
        importedFrom: bundle.source.id,
      };
      await store.save(session);
      return {
        id: session.id,
        title: session.title,
        importedFrom: bundle.source.id,
      };
    },
  };
}

export type LocalSessionService = ReturnType<typeof createLocalSessionService>;
