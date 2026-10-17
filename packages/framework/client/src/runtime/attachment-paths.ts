/**
 * Workspace containment for the media-preview route.
 *
 * Split out as a pure predicate so the boundary is testable without a runtime:
 * `attachmentDataURL` uses the same rule for the attachment store, and a
 * `/`-separated POSIX path must not be judged by a Windows-style comparison (or
 * the reverse) — the check normalizes separators and, on Windows only, folds
 * case, because NTFS is case-insensitive while ext4 is not.
 */
import { sep } from "node:path";

/**
 * Whether `target` sits outside `root`.
 *
 * @param root - the resolved workspace root (already realpath'd by the caller).
 * @param target - the resolved candidate path.
 * @returns true when the candidate escapes the root, including a sibling whose
 * name merely starts with the root's (`/w/app2` vs `/w/app`).
 */
export function escapesDir(root: string, target: string): boolean {
  const fold = (value: string) =>
    (process.platform === "win32"
      ? value.replaceAll("\\", "/").toLowerCase()
      : value.replaceAll("\\", "/")
    ).replace(/\/+$/u, "");
  const normalizedRoot = fold(root);
  const normalizedTarget = fold(target);
  if (normalizedTarget === normalizedRoot) return false;
  return !normalizedTarget.startsWith(`${normalizedRoot}/`);
}

/** The separator this host uses, re-exported for callers building messages. */
export const hostSeparator = sep;
