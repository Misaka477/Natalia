/**
 * The browse directory picker: one-level listing and child creation, for a
 * client no OS dialog can reach.
 *
 * The native picker opens a dialog on the host's display, which is the right
 * answer for a browser on the same machine and the wrong one for a remote
 * client — there is no display to put it on. This backend serves the
 * primitives an in-app browser drives one level at a time instead, so the
 * same settings row works from anywhere.
 *
 * The shape follows the reference harness's `directory-picker-browse`, read in
 * full before writing: a fully-qualified fence on every wire path, a streamed
 * name-sorted window bounded by `maxEntries`, and a closed error vocabulary.
 */

import { homedir } from "node:os";
import { mkdir, opendir, stat } from "node:fs/promises";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import type { DirectoryEntry, DirectoryListing } from "@anthelia/contracts";

// The wire types live on the contract side of the dependency edge: the host
// depends on the contracts, never the reverse. Re-exported so a caller of this
// module gets one import rather than two.
export type { DirectoryEntry, DirectoryListing };

/** The closed failure vocabulary of the browse primitives. */
export type DirectoryPickerErrorCode =
  | "directory-unreadable"
  | "directory-exists"
  | "directory-create-failed";

/** A typed failure so consumers map business codes without string matching. */
export class DirectoryPickerError extends Error {
  constructor(
    readonly code: DirectoryPickerErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "DirectoryPickerError";
  }
}

/**
 * The complete-result bound of one listing level.
 *
 * The default follows GitHub's web UI, which truncates directory listings at
 * 1,000 entries. A level with more children than this reports `truncated`
 * rather than materializing all of them.
 */
export const DEFAULT_MAX_ENTRIES = 1000;

/**
 * True when the path names one fixed filesystem location regardless of process
 * state: POSIX-absolute on POSIX; on Windows only drive-qualified (`C:\…`) or
 * complete UNC (`\\server\share…`) forms.
 *
 * Rooted drive-less forms (`\foo`, `/foo`) and incomplete UNC prefixes (`\\`,
 * `\\server`) pass `isAbsolute` yet still resolve against the process's current
 * drive, so a wire value carrying one would name a different directory on a
 * different host. The fence is what makes a path from the wire mean one thing.
 */
export function fullyQualified(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32"
    ? win32.isAbsolute(path) &&
        /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/u.test(path)
    : posix.isAbsolute(path);
}

/**
 * Ancestor chain from the filesystem root to `target` inclusive — the
 * breadcrumb rows of a listing, every one a jump target.
 */
function ancestryCrumbs(target: string): DirectoryEntry[] {
  const crumbs: DirectoryEntry[] = [];
  let current = target;
  for (;;) {
    const parent = dirname(current);
    // basename of a root is '' — label the root crumb by its full path.
    crumbs.unshift({
      name: parent === current ? current : basename(current),
      path: current,
      hidden: false,
    });
    if (parent === current) return crumbs;
    current = parent;
  }
}

/** One streamed listing candidate: the dirent facts a row needs. */
interface ListingCandidate {
  name: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/**
 * Insert a streamed candidate into the name-sorted bounded window, evicting the
 * name-largest candidate when the window exceeds `keep`.
 *
 * Memory over an arbitrarily large level therefore stays O(keep) regardless of
 * how many children the directory holds.
 * @returns true when an eviction happened (the level has candidates beyond the window).
 */
export function boundedInsert(
  window: ListingCandidate[],
  candidate: ListingCandidate,
  keep: number,
): boolean {
  // Full window, name at or beyond the tail: one comparison rejects, so an
  // oversized level costs O(1) per candidate past the head.
  if (
    window.length === keep &&
    candidate.name.localeCompare(window[window.length - 1]!.name) >= 0
  )
    return true;
  // Binary insertion keeps a retained candidate at O(log keep) comparisons.
  let lo = 0;
  let hi = window.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candidate.name.localeCompare(window[mid]!.name) < 0) hi = mid;
    else lo = mid + 1;
  }
  window.splice(lo, 0, candidate);
  if (window.length <= keep) return false;
  window.pop();
  return true;
}

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One listing row for a dirent, following symlinks to directories; null for
 * non-directories and broken or cyclic links (skipped silently — the browser
 * shows what can be entered, and a broken link cannot).
 */
async function directoryRow(
  parent: string,
  name: string,
  isDirectory: boolean,
  isSymbolicLink: boolean,
): Promise<DirectoryEntry | null> {
  const path = join(parent, name);
  let enterable = isDirectory;
  if (!enterable && isSymbolicLink) {
    try {
      enterable = (await stat(path)).isDirectory();
    } catch {
      // Broken or cyclic symlink: stat is the probe, failure means "not enterable".
      return null;
    }
  }
  if (!enterable) return null;
  // POSIX hidden convention; Windows' hidden attribute is not exposed by
  // dirents. The client owns whether hidden rows show.
  return { name, path, hidden: name.startsWith(".") };
}

/** The options one listing takes. */
export interface ListDirectoryOptions {
  /** The complete-result bound; defaults to {@link DEFAULT_MAX_ENTRIES}. */
  maxEntries?: number;
}

/**
 * List one directory level plus its ancestry.
 *
 * @param path - absolute directory to list; absent lists the home directory.
 * @returns the level's listing with ancestry.
 * @throws {DirectoryPickerError} `directory-unreadable` when the target is not
 *   fully qualified or cannot be listed.
 */
export async function listDirectoryLevel(
  path?: string,
  options: ListDirectoryOptions = {},
): Promise<DirectoryListing> {
  const home = homedir();
  // The contract takes fully qualified paths only; resolve() would silently
  // rebase a relative or empty wire value under the host process cwd (or, for
  // rooted drive-less Windows forms, its current drive).
  if (path !== undefined && !fullyQualified(path))
    throw new DirectoryPickerError(
      "directory-unreadable",
      path,
      `cannot list "${path}": not a fully qualified path`,
    );
  const target = resolve(path ?? home);
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  // Stream the level (opendir, one dirent at a time) into a name-sorted window
  // of maxEntries + 1 candidates: memory stays bounded no matter how many
  // children the directory holds, the window keeps the name-sorted head, and
  // the +1 slot lets an in-window extra row prove the cut. A window candidate
  // that turns out non-enterable (broken symlink) is not backfilled from
  // beyond the window — an eviction already marks the level truncated, which
  // stays the honest answer.
  const keep = maxEntries + 1;
  const window: ListingCandidate[] = [];
  let evicted = false;
  try {
    const level = await opendir(target);
    try {
      for (;;) {
        const dirent = await level.read();
        if (dirent === null) break;
        // Only rows a browser could enter contend for the window; dirent says
        // "directory" outright, a symlink needs the later stat probe.
        if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
        const candidate = {
          name: dirent.name,
          isDirectory: dirent.isDirectory(),
          isSymbolicLink: dirent.isSymbolicLink(),
        };
        if (boundedInsert(window, candidate, keep)) evicted = true;
      }
    } finally {
      // Manual read() never auto-closes; close on every exit.
      await level.close();
    }
  } catch (error: unknown) {
    throw new DirectoryPickerError(
      "directory-unreadable",
      target,
      `cannot list ${target}: ${messageOf(error)}`,
    );
  }
  const entries: DirectoryEntry[] = [];
  let truncated = evicted;
  for (const candidate of window) {
    const row = await directoryRow(
      target,
      candidate.name,
      candidate.isDirectory,
      candidate.isSymbolicLink,
    );
    if (row === null) continue;
    if (entries.length === maxEntries) {
      truncated = true;
      break;
    }
    entries.push(row);
  }
  return {
    path: target,
    home,
    crumbs: ancestryCrumbs(target),
    entries,
    truncated,
  };
}

/**
 * Create one child directory under an existing parent.
 *
 * @param path - absolute existing parent directory.
 * @param name - single non-blank path segment (no separators, not `.`/`..`).
 * @returns the created directory's absolute path.
 * @throws {DirectoryPickerError} `directory-exists` for an existing child,
 *   `directory-create-failed` for a parent that is not fully qualified or any
 *   other failure.
 */
export async function createChildDirectory(
  path: string,
  name: string,
): Promise<string> {
  // Same fully-qualified fence as the listing: never rebase a parent under the
  // cwd or the current drive.
  if (!fullyQualified(path))
    throw new DirectoryPickerError(
      "directory-create-failed",
      path,
      `cannot create under "${path}": not a fully qualified parent path`,
    );
  const parent = resolve(path);
  if (
    name.trim() === "" ||
    name === "." ||
    name === ".." ||
    /[/\\]/u.test(name)
  )
    throw new DirectoryPickerError(
      "directory-create-failed",
      join(parent, name),
      `"${name}" is not a single path segment`,
    );
  const target = join(parent, name);
  try {
    // Non-recursive: the parent is the directory the browser is showing, so a
    // missing parent is a real failure, not a level to invent.
    await mkdir(target);
    return target;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    )
      throw new DirectoryPickerError(
        "directory-exists",
        target,
        `${target} already exists`,
      );
    throw new DirectoryPickerError(
      "directory-create-failed",
      target,
      `cannot create ${target}: ${messageOf(error)}`,
    );
  }
}
