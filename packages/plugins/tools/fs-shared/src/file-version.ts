/**
 * The file version stamp: how a write learns that the file it is about to
 * change is not the file the model read.
 *
 * The reference harness's `fs-local` carries an opaque version token on every
 * read and refuses a write whose `expected.version` no longer matches. Without
 * it, `edit_file` reads the file, computes the replacement, and writes — and
 * anything that changed the file in between is silently overwritten. That is
 * not hypothetical: it is the failure this repository's own agent hit three
 * times in one session (`file changed since it was read`), each time losing
 * uncommitted work.
 *
 * The token is `dev:ino:size:mtimeNs:ctimeNs` — the reference's exact
 * composition. `dev`+`ino` name the file (a rename onto the same path is a
 * different inode), `size` catches a same-inode rewrite, and the two
 * nanosecond timestamps catch a write that restored the size. It is opaque to
 * callers: nothing may parse it, and nothing may construct one.
 */

import { stat } from "node:fs/promises";

/** An opaque file version token. Never parsed, never constructed by hand. */
export type FileVersion = string;

/**
 * The version of the file at `path`, or `undefined` when it does not exist.
 *
 * `undefined` is a real answer and not an error: a write that expects a
 * version and finds none is writing to a file that vanished, which is the
 * same class of surprise as one that changed.
 */
export async function fileVersion(
  path: string,
): Promise<FileVersion | undefined> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

/**
 * Whether the file at `path` is still at `expected`.
 *
 * A missing file is never at any version: the caller expected something and
 * there is nothing, which is the stale case rather than a fresh one.
 */
export async function fileAtVersion(
  path: string,
  expected: FileVersion,
): Promise<boolean> {
  return (await fileVersion(path)) === expected;
}

/** The refusal a stale write carries, in the words a reader needs. */
export function staleVersionMessage(displayPath: string): string {
  return (
    `cannot edit "${displayPath}": file changed since it was read — ` +
    `re-read the file, then retry`
  );
}
