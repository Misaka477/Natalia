/**
 * The sandbox policy's path law: where a write may land.
 *
 * One home for the containment judgement every write path answers to —
 * the mode's writable roots (the confinement package's `writableRoots`,
 * the same set the kernel-level wrapper grants) and an ownership domain
 * (the fan-out sub-agent's writePaths) are the same QUESTION at two
 * heights, so they share one spelling.
 *
 * The judgement is canonicalize-then-contain, the sandbox study's rule in our
 * own words: a path is REALPATHED before it is compared, because a lexical
 * `allowed/../../../etc/x` waves through every prefix match and the kernel
 * then resolves it outside the root. The re-normalisation resolves the
 * deepest EXISTING ancestor, so a path whose tail does not exist yet — the
 * file the write is about to create — still gets a truthful answer about
 * its directory. A path that resolves outside the root is answered with
 * the path itself, which can never match a relative domain: "not inside"
 * is the only truthful reading.
 */

import { canonicalPath } from "@anthelia/confinement";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * The path's position relative to a root — "" for the root itself, the
 * relative spelling inside it, or the PATH UNCHANGED when it resolves
 * outside. The unchanged-path answer is the load-bearing half: an
 * absolute path can never accidentally match a relative domain, so
 * "outside" is the only reading a caller can make of it.
 */
export function relativeToRoot(path: string, root: string): string {
  const rel = relative(resolve(root), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    return path;
  return rel;
}

/**
 * Whether `path` — judged on where it ACTUALLY lands — sits inside one of
 * the domains (each relative to `root`, a file or a directory prefix).
 */
export function pathWithinDomains(input: {
  path: string;
  root: string;
  domains: readonly string[];
}): boolean {
  const relative = relativeToRoot(
    canonicalPath(input.path),
    canonicalPath(input.root),
  );
  return input.domains.some(
    (domain) =>
      relative === domain ||
      relative.startsWith(domain.endsWith("/") ? domain : `${domain}/`),
  );
}
