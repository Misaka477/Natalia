/**
 * The directories a CHECKOUT writes for its own machine, named once.
 *
 * The rule they share: a release that carries one is a release tied to the
 * machine that built it. Each was measured shipping at least once — a 91 MB
 * release carried this checkout's dev plugin store (`natalia.lock`, its
 * node_modules, the initialized marker) into an installer; 19 MiB of test
 * workspaces rode into SHA256SUMS; and `shared-plugin-store/` — the suite's
 * shared official-plugin install, whose lock pins `dist/ts/plugins` by ABSOLUTE
 * checkout path — shipped in every release the build assembled, because the
 * release copies `dist/ts` wholesale and only three names were on the list.
 *
 * The list is written down ONCE because it had grown one consumer at a time:
 * `build-standalone.ts` refused to COPY these names, its own self-check refused
 * to accept them, and `windows-install-plan.ts` refused to INSTALL them — three
 * copies of a list that a fourth state directory could be added to only by
 * remembering all three. Adding a state directory is now one edit, and the
 * release guard, the copier and the installer cannot disagree about it.
 */
export const MACHINE_LOCAL_STATE_DIRS = [
  /** The CLI's plugin store: `natalia.lock` plus installed node_modules. */
  "plugin-store",
  /** Per-workspace PTY stores written by a dev terminal run. */
  "cli-dev-pty-stores",
  /** Workspaces a test run creates (`client-test-workspaces/<name>`). */
  "client-test-workspaces",
  /** The suite's shared official-plugin install (see above). */
  "shared-plugin-store",
] as const;

/**
 * Whether a release-relative path sits inside one of them.
 *
 * Matched on the LEADING segment, because a walk yields
 * `shared-plugin-store\node_modules\@natalia\...` and the offender is the
 * top-level directory. Both separators are accepted: one walker builds POSIX
 * paths and the Windows installer plan builds backslash ones, and a guard that
 * reads only one of them passes the other.
 */
export function isMachineLocalStatePath(relative: string): boolean {
  const head = relative.split(/[\\/]/u)[0] ?? "";
  return (MACHINE_LOCAL_STATE_DIRS as readonly string[]).includes(head);
}
