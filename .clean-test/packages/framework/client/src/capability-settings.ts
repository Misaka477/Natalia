/**
 * The host consumer for the `settings` capability grant.
 *
 * A capability holding the grant contributes settings through the kernel; the
 * runtime merges the effective contributions into the tool settings it hands to
 * every tool. The merge is deliberately one-directional: contributions provide
 * defaults, and an explicitly configured or permission-derived value always
 * wins. A contribution can therefore fill an unset browser or endpoint option,
 * but it can never widen network or security settings the operator configured.
 */
export function mergeContributedToolSettings<T extends Record<string, unknown>>(
  base: T,
  contributions: Array<{ payload: unknown }>,
): T {
  const defaults: Record<string, unknown> = {};
  for (const entry of contributions) {
    if (!entry.payload || typeof entry.payload !== "object") continue;
    Object.assign(defaults, entry.payload);
  }
  // `undefined` means "not configured": a contributed default must be allowed
  // through in that case, so undefined base values are dropped before the base
  // spreads over the defaults.
  const defined = Object.fromEntries(
    Object.entries(base).filter(([, value]) => value !== undefined),
  ) as T;
  return { ...defaults, ...defined } as T;
}
