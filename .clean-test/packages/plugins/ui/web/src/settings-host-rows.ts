/**
 * The settings panel's host-only row logic, as pure functions.
 *
 * The panel itself is a Solid component; the decision it makes — "does this
 * setting row apply to the host this runtime runs on?" — is the part worth
 * testing, and it is the part that got the design wrong once already: the
 * Git Bash path is Windows-only, and hiding it only in the UI would have
 * left the resolver's platform guard as the sole defense. Here the rule is
 * explicit and testable in one place.
 */

/** The settings rows that exist because one host needs them. */
export const HOST_ONLY_SETTING_LABELS: readonly string[] = ["Git Bash 路径"];

/** The status segment's prefix for the runtime's own host name. */
export const HOST_SEGMENT_PREFIX = "host:";

/**
 * The host platform out of the runtime's status segments. `undefined` means
 * the runtime never published one (an old journal, or a host that does not
 * emit it) — and an unknown host is not Windows, so host-only rows stay
 * hidden rather than shown on a guess.
 */
export function hostFromSegments(
  segments: readonly string[] | undefined,
): string | undefined {
  const segment = segments?.find((item) =>
    item.startsWith(HOST_SEGMENT_PREFIX),
  );
  return segment?.slice(HOST_SEGMENT_PREFIX.length) || undefined;
}

/**
 * Whether a setting row applies to the host. Non-host-only rows always do;
 * a host-only row needs the runtime to have SAID it is that host.
 */
export function settingAppliesToHost(
  label: string,
  host: string | undefined,
): boolean {
  if (!HOST_ONLY_SETTING_LABELS.includes(label)) return true;
  return host === "win32";
}

/**
 * The rows of a category as they should render on this host.
 */
export function rowsForHost<T extends { label: string }>(
  items: readonly T[],
  host: string | undefined,
): T[] {
  return items.filter((item) => settingAppliesToHost(item.label, host));
}
