/**
 * Dependency roots, linked into every candidate.
 *
 * A candidate is a checkout of the workspace's tracked tree: the snapshot
 * backend materializes the base index, the worktree backend runs
 * `git worktree add`. Either way the directories a build tool needs but
 * version control excludes — `node_modules/` above all — are simply not
 * there, and the promotion gate's command (`npm run typecheck`) dies with
 * "module not found" before it has tested anything. That failure is what
 * made a sandboxed build look like a broken toolchain, round after round.
 *
 * The remedy is a LINK, not a copy: a workspace's `node_modules` is
 * gigabytes, and copying it per candidate would make `create` slower than
 * the work it isolates. The link is created once, at candidate creation,
 * and is deliberately invisible to every content surface:
 *
 *   - capture/diff/merge never see it, because a symlink is neither a file
 *     nor a directory for the snapshot walk, so the candidate's index has no
 *     entry for it and a promotion can never write a link into the host;
 *   - the worktree backend's force-add (`git add -f` for paths
 *     `.nataliaignore` allows but `.gitignore` hides) must exclude it
 *     explicitly, or the candidate branch would carry a `node_modules`
 *     symlink into the host's history — {@link isDependencyLinkPath} is that
 *     exclusion;
 *   - confinement (the executor's kernel floor) makes the link readable and
 *     NOT writable: landlock's write allow-list holds the candidate root,
 *     so a command inside the candidate reads the host's dependencies and
 *     cannot modify them.
 *
 * What the link is NOT: user content. It is plumbing the sandbox installs,
 * so no surface reports it as a pending change — the three surfaces (diff,
 * delete's pending list, the manifest) agree by all being silent about it.
 */
import { lstat, mkdir, symlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * The roots a candidate links from its host, after the declaration is
 * checked. A root that escapes the workspace is refused here rather than at
 * link time: a declaration naming `../../..` would otherwise link the whole
 * filesystem into every candidate.
 */
export function dependencyRootsFor(
  hostRoot: string,
  declared: readonly string[] | undefined,
): string[] {
  const roots: string[] = [];
  for (const raw of declared ?? []) {
    // The same spelling a caller would write in .nataliaignore: a leading
    // `./` is noise, and normalizing it here is what lets the dedup below
    // see `node_modules` and `./node_modules` as one root.
    const value = raw.trim().replace(/^\.\//u, "");
    if (!value) continue;
    if (isAbsolute(value))
      throw new Error(
        `sandbox dependency root must be host-relative: ${value}`,
      );
    const rel = relative(resolve(hostRoot), resolve(hostRoot, value));
    if (!rel || rel.startsWith("..") || rel === "..")
      throw new Error(
        `sandbox dependency root escapes the workspace: ${value}`,
      );
    if (!roots.includes(value)) roots.push(value);
  }
  return roots;
}

/** Whether a candidate-relative path is one of the declared dependency links. */
export function isDependencyLinkPath(
  path: string,
  roots: readonly string[],
): boolean {
  const normalized = path.split("\\").join("/").replace(/^\.\//u, "");
  return roots.some((root) => {
    const value = root.split("\\").join("/").replace(/^\.\//u, "");
    return normalized === value || normalized.startsWith(`${value}/`);
  });
}

/**
 * Links every declared root that exists in the host into the candidate.
 *
 * A root the host does not have is skipped silently: an absent
 * `node_modules` means the workspace installs nothing, and inventing an
 * empty directory would make the next `npm run` fail differently rather
 * than not at all. A path the candidate already holds (a project that
 * tracks its dependencies, say) is never replaced.
 */
export async function linkDependencyRoots(input: {
  hostRoot: string;
  candidateRoot: string;
  roots: readonly string[];
}): Promise<string[]> {
  const linked: string[] = [];
  for (const root of input.roots) {
    const source = resolve(input.hostRoot, root);
    const target = resolve(input.candidateRoot, root);
    let info;
    try {
      info = await lstat(source);
    } catch {
      continue; // the host has no such root
    }
    if (!info.isDirectory()) continue;
    let existing;
    try {
      existing = await lstat(target);
    } catch {
      existing = undefined;
    }
    if (existing) continue; // the candidate already holds this path
    await mkdir(resolve(input.candidateRoot, root, ".."), { recursive: true });
    await symlink(source, target, "dir");
    linked.push(root);
  }
  return linked;
}
