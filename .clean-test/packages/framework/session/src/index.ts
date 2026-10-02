/**
 * The session package's node entry: the whole surface — the node-free
 * facts plus the two stores (file-backed and sqlite-backed). Browser
 * consumers get ./browser instead (the vite alias), which is facts
 * without the node imports; this entry stays the one true whole.
 */
export * from "./facts";

// The stores call the pure builders: `export *` re-exports them but does
// not bring the names into this module's scope.
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import {
  appendSessionEvent,
  createSessionRecord,
  type SessionMetadata,
  type SessionRecord,
} from "./facts";
import { normalizeInbox } from "./inbox";
import {
  mkdir,
  readFile,
  readdir,
  rename as fsRename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

export class JsonSessionStore {
  readonly dir: string;
  private writeQueue = Promise.resolve();

  constructor(dir = ".natalia/sessions") {
    this.dir = resolve(dir);
  }

  async load(id: SessionID) {
    try {
      const session = JSON.parse(
        await readFile(this.path(id), "utf8"),
      ) as SessionRecord;
      normalizeInbox(session);
      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(session: SessionRecord) {
    const snapshot = structuredClone(session);
    const write = () => this.writeSnapshot(snapshot);
    const queued = this.writeQueue.then(write, write);
    this.writeQueue = queued.catch(() => undefined);
    return await queued;
  }

  async loadOrCreate(id: SessionID, title: string) {
    const existing = await this.load(id);
    if (existing) return existing;
    const session = createSessionRecord(id, title);
    await this.save(session);
    return session;
  }

  async list() {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      const sessions: SessionRecord[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try {
          const session = JSON.parse(
            await readFile(join(this.dir, entry.name), "utf8"),
          ) as SessionRecord;
          if (session.id && session.title && Array.isArray(session.events))
            sessions.push(session);
        } catch {
          // Ignore corrupt records; the active session remains usable.
        }
      }
      // Pinned first, then by lastAccessedAt descending, then by createdAt descending
      return sessions.sort((left, right) => {
        const lp = left.metadata?.pinned ? 1 : 0;
        const rp = right.metadata?.pinned ? 1 : 0;
        if (lp !== rp) return rp - lp;
        const la = left.metadata?.lastAccessedAt ?? "";
        const ra = right.metadata?.lastAccessedAt ?? "";
        if (la !== ra) return ra.localeCompare(la);
        return right.createdAt.localeCompare(left.createdAt);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async rename(id: SessionID, title: string) {
    const session = await this.load(id);
    if (!session) throw new Error(`session not found: ${id}`);
    const trimmed = title.trim();
    if (!trimmed) throw new Error("session title cannot be empty");
    session.title = trimmed;
    session.metadata = { ...session.metadata, titleSource: "manual" };
    await this.save(session);
    return session;
  }

  async delete(id: SessionID) {
    await rm(this.path(id), { force: true });
  }

  async updateMetadata(id: SessionID, partial: Partial<SessionMetadata>) {
    const session = await this.load(id);
    if (!session) throw new Error(`session not found: ${id}`);
    session.metadata = { ...session.metadata, ...partial };
    await this.save(session);
    return session;
  }

  async setAutoTitle(
    id: SessionID,
    title: string,
    source: "generated" | "fallback",
  ) {
    let result: SessionRecord | undefined;
    const write = async () => {
      const session = await this.load(id);
      if (!session) throw new Error(`session not found: ${id}`);
      if (session.metadata?.titleSource === "manual") {
        result = session;
        return;
      }
      session.title = title;
      session.metadata = { ...session.metadata, titleSource: source };
      result = session;
      await this.writeSnapshot(session);
    };
    const queued = this.writeQueue.then(write, write);
    this.writeQueue = queued.catch(() => undefined);
    await queued;
    return result!;
  }

  private async writeSnapshot(snapshot: SessionRecord) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const temporary = `${this.path(snapshot.id)}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
      mode: 0o600,
    });
    await renameSessionFile(temporary, this.path(snapshot.id));
  }

  async duplicate(id: SessionID, newID?: SessionID, newTitle?: string) {
    const session = await this.load(id);
    if (!session) throw new Error(`session not found: ${id}`);
    const targetID =
      newID ??
      (`ses_${crypto.randomUUID().replace(/-/gu, "").slice(0, 16)}` as SessionID);
    const copy: SessionRecord = {
      ...structuredClone(session),
      id: targetID,
      title: newTitle ?? `${session.title} (copy)`,
      metadata: {
        ...session.metadata,
        lastAccessedAt: new Date().toISOString(),
      },
    };
    await this.save(copy);
    return copy;
  }

  async fork(
    id: SessionID,
    turnID: string,
    newID?: SessionID,
    newTitle?: string,
  ) {
    const session = await this.load(id);
    if (!session) throw new Error(`session not found: ${id}`);
    const boundary = session.events.findIndex(
      (event) => event.type === "turn.submitted" && event.id === turnID,
    );
    if (boundary < 0) throw new Error(`turn not found: ${turnID}`);
    const targetID =
      newID ??
      (`ses_${crypto.randomUUID().replace(/-/gu, "").slice(0, 16)}` as SessionID);
    const includedTurns = new Set(
      session.events
        .slice(0, boundary)
        .flatMap((event) =>
          event.type === "turn.submitted" ? [event.id] : [],
        ),
    );
    const fork: SessionRecord = {
      ...structuredClone(session),
      id: targetID,
      title: newTitle ?? `${session.title} (fork)`,
      events: structuredClone(session.events.slice(0, boundary)),
      inbox: session.inbox
        ?.filter((input) => includedTurns.has(input.id))
        .map((input) => ({ ...structuredClone(input), sessionID: targetID })),
      metadata: {
        ...session.metadata,
        lastAccessedAt: new Date().toISOString(),
      },
    };
    await this.save(fork);
    return fork;
  }

  private path(id: SessionID) {
    return join(this.dir, `${id}.json`);
  }
}

/**
 * Atomically replaces the session file. POSIX rename is atomic and this returns
 * on the first attempt. Windows rejects the rename while another client holds
 * the target open for reading (its handle lacks FILE_SHARE_DELETE), so the
 * overwrite is retried with a short backoff, and a direct overwrite is used as
 * a last resort once the lock clears. Writers are already serialized by the
 * per-store queue, so the fallback cannot interleave two updates.
 */
async function renameSessionFile(source: string, target: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsRename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code !== "EPERM" &&
        code !== "EBUSY" &&
        code !== "EACCES" &&
        code !== "EEXIST"
      )
        throw error;
      if (attempt >= 4) {
        await writeFile(target, await readFile(source, "utf8"), {
          mode: 0o600,
        });
        await rm(source, { force: true }).catch(() => undefined);
        return;
      }
      await Bun.sleep(25 * (attempt + 1));
    }
  }
}

export { SqliteSessionStore } from "./sqlite-store";
export type {
  SessionRow,
  StoredContextEpoch,
  StoredSessionEvent,
} from "./sqlite-store";
