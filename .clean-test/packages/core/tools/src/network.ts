import type { ToolExecutionContext } from "./types";

/**
 * Enforce the runtime's network policy for a URL.
 *
 * This is shared by the web and browser tool families: both can touch the
 * network, so both must apply the same allowed-scheme/denied-host rules.
 */
export function assertNetworkURL(input: string, context: ToolExecutionContext) {
  const url = new URL(input);
  const allowedSchemes = context.settings?.allowedSchemes ?? ["https", "http"];
  if (!allowedSchemes.includes(url.protocol.slice(0, -1)))
    throw new Error(`network scheme is not allowed: ${url.protocol}`);
  const host = url.hostname.toLowerCase();
  // IPv6 literals arrive bracketed ([::1], [fd00::1]); the loopback and
  // private-range checks below work on the bare address.
  const bareHost =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const allowed = context.settings?.allowedHosts ?? [];
  const allowedGroups = context.settings?.allowedHostGroups ?? [allowed];
  const denied = context.settings?.deniedHosts ?? [];
  if (denied.some((pattern) => hostMatches(host, pattern)))
    throw new Error(`network host denied: ${host}`);
  if (
    allowedGroups.some(
      (group) =>
        group.length && !group.some((pattern) => hostMatches(host, pattern)),
    )
  )
    throw new Error(`network host is not allowed: ${host}`);
  const localhost =
    host === "localhost" ||
    bareHost === "::1" || // IPv6 loopback
    host.startsWith("127."); // IPv4 loopback
  if (localhost && context.settings?.allowLocalhost === false)
    throw new Error(`localhost network access is not allowed: ${host}`);
  const privateAddress =
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(host) || // IPv4 private
    /^f[cd][0-9a-f]{2}:/iu.test(bareHost) || // IPv6 unique-local fc00::/7
    /^fe[89ab][0-9a-f]:/iu.test(bareHost); // IPv6 link-local fe80::/10
  if (privateAddress && context.settings?.allowPrivate === false)
    throw new Error(`private network access is not allowed: ${host}`);
}

function hostMatches(host: string, pattern: string) {
  const normalized = pattern.toLowerCase();
  return normalized.startsWith("*.")
    ? host.endsWith(normalized.slice(1))
    : host === normalized;
}
