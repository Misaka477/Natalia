/**
 * The process's ONE ObjectStore per root.
 *
 * Every runtime site that touches a workspace's objects used to construct
 * its own `new ObjectStore(root)` — one SQLite handle (and, when the pack
 * daemon is in use, one pipe) per call, none of them ever released. POSIX
 * unlinks tolerate open files, so nothing noticed; Windows answers EBUSY
 * to every delete of a root the process has touched, and a long-lived
 * runtime accumulates one handle per operation per workspace.
 *
 * Sharing by root fixes both: the handle count stops growing with the
 * operation count, and there is exactly one owner-shaped question —
 * "is anyone still using this root?" — answered by
 * {@link releaseSharedObjectStoresUnder} when a workspace's runtime is
 * disposed. A root used again after its release simply opens a new store
 * on the next call, so a release is never a correctness event, only a
 * handle-count one.
 *
 * The key is the resolved root: the callers spell it through
 * resolveWorkspaceObjectsRoot, and two spellings of one directory must
 * not become two handles.
 */
import { resolve, sep } from "node:path";
import { ObjectStore } from "./object-store";

const shared = new Map<string, ObjectStore>();

/** The shared store for a root, opening it on first use. */
export function sharedObjectStore(root: string): ObjectStore {
  const key = resolve(root);
  const existing = shared.get(key);
  if (existing) return existing;
  const store = new ObjectStore(key);
  shared.set(key, store);
  return store;
}

/**
 * Releases the shared store for exactly this root, if one was opened.
 *
 * Idempotent, and silent when the root was never shared. The store is
 * dropped from the registry BEFORE it is disposed, so a caller that
 * races a release cannot be handed a disposed store: the next
 * sharedObjectStore call opens a fresh one.
 */
export function releaseSharedObjectStore(root: string): void {
  const key = resolve(root);
  const store = shared.get(key);
  if (!store) return;
  shared.delete(key);
  store.dispose();
}

/**
 * Releases every shared store whose root sits inside `root` — a
 * workspace's objects library AND the per-workspace areas beneath it
 * (the baselines' own object root, the vault's).
 *
 * This is the shape a workspace teardown needs: the registry holds
 * several roots per workspace and a caller should not have to enumerate
 * them. A store for the root itself is included.
 */
export function releaseSharedObjectStoresUnder(root: string): void {
  const base = resolve(root);
  const prefix = base.endsWith(sep) ? base : base + sep;
  for (const [key, store] of [...shared]) {
    if (key !== base && !key.startsWith(prefix)) continue;
    shared.delete(key);
    store.dispose();
  }
}

/** Releases every shared store: process shutdown, and tests that need a clean slate. */
export function releaseAllSharedObjectStores(): void {
  for (const [key, store] of [...shared]) {
    shared.delete(key);
    store.dispose();
  }
}
