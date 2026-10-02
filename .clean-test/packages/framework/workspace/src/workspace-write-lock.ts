/**
 * The workspace write lock (D2: "same workspace, writes serialised").
 *
 * Parallel sessions may run turns concurrently; two of them writing the same
 * workspace at once would interleave file edits and corrupt both. The lock is
 * a promise chain — the next writer waits for the previous one to release —
 * so writers serialise in acquisition order while readers and everything else
 * stay parallel.
 *
 * The lock also keeps a lightweight activity snapshot so the runtime can tell
 * which session is currently or about to write which paths. It is observational
 * only; it never changes the serialisation guarantee.
 */
import type { WorkspaceWriteActivity, WorkspaceWriteLock } from "./contracts";

type LockRequest = {
  sessionID?: string;
  paths: string[];
  queuedAt: number;
  acquiredAt: number;
  active: boolean;
  release?: () => void;
};

export function createWorkspaceWriteLock(): WorkspaceWriteLock {
  let chain: Promise<void> = Promise.resolve();
  const requests: LockRequest[] = [];

  /** Acquires the lock; resolves with the release function. */
  function acquire(
    sessionID?: string,
    paths: string[] = [],
  ): Promise<() => void> {
    const request: LockRequest = {
      sessionID,
      paths,
      queuedAt: Date.now(),
      acquiredAt: 0,
      active: false,
    };
    requests.push(request);
    let release!: () => void;
    let released = false;
    const gate = new Promise<void>((resolve) => {
      release = () => {
        if (released) return;
        released = true;
        request.active = false;
        request.acquiredAt = 0;
        const index = requests.indexOf(request);
        if (index >= 0) requests.splice(index, 1);
        resolve();
      };
    });
    request.release = release;
    const previous = chain;
    chain = previous.then(() => gate);
    return previous.then(() => {
      request.active = true;
      request.acquiredAt = Date.now();
      return release;
    });
  }

  function snapshot(): WorkspaceWriteActivity[] {
    return requests.map((request) => ({
      sessionID: request.sessionID,
      paths: request.paths,
      acquiredAt: request.acquiredAt,
      queuedAt: request.queuedAt,
      active: request.active,
    }));
  }

  return { acquire, snapshot };
}
