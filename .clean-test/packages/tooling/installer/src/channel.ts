import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * D5 — the update CHANNEL contract: what turns a bare `natalia update`
 * into a working command. A channel is a small JSON descriptor:
 *
 *   { "schema": "natalia.update-channel/1", "latest": "0.1.0",
 *     "source": "0.1.0/" }        // source resolved against the channel
 *
 * The descriptor's LOCATION is the channel: a local path (files on
 * removable media / a mounted release tree — fully usable today) or an
 * http(s) URL (the same shape the plan's curl line and `--from` already
 * speak, fetched with a hard bound so an unreachable channel fails fast
 * and honestly). The default URL is the plan's own contracted domain
 * (§1's `https://natalia.dev/...`): it activates the moment ops serves
 * it — the MECHANISM is proven in-env against local and loopback
 * channels; the serving half is infrastructure outside this repository,
 * named as such rather than pretended.
 */

export const CHANNEL_SCHEMA = "natalia.update-channel/1";
export const DEFAULT_UPDATE_CHANNEL_URL =
  "https://natalia.dev/channels/stable/channel.json";
export const CHANNEL_FETCH_TIMEOUT_MS = 15_000;

export type UpdateChannel = {
  schema: typeof CHANNEL_SCHEMA;
  latest: string;
  source: string;
};

export type ResolvedChannel = { channel: UpdateChannel; source: string };

function parseChannel(text: string, where: string): UpdateChannel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${where}: channel is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const channel = parsed as Partial<UpdateChannel>;
  if (channel.schema !== CHANNEL_SCHEMA)
    throw new Error(
      `${where}: channel schema ${JSON.stringify(channel.schema)} (expected ${CHANNEL_SCHEMA})`,
    );
  if (typeof channel.latest !== "string" || !channel.latest)
    throw new Error(`${where}: channel lacks "latest"`);
  if (typeof channel.source !== "string" || !channel.source)
    throw new Error(`${where}: channel lacks "source"`);
  return {
    schema: CHANNEL_SCHEMA,
    latest: channel.latest,
    source: channel.source,
  };
}

export async function resolveChannel(
  descriptor: string,
): Promise<ResolvedChannel> {
  const isUrl = /^https?:\/\//u.test(descriptor);
  if (!isUrl) {
    const path = resolve(descriptor);
    const text = await readFile(path, "utf8").catch((error: unknown) => {
      throw new Error(
        `channel unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    const channel = parseChannel(text, path);
    // A local source resolves against the descriptor's own directory.
    return { channel, source: resolve(dirname(path), channel.source) };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHANNEL_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(descriptor, { signal: controller.signal });
    if (!response.ok)
      throw new Error(`${descriptor}: channel HTTP ${response.status}`);
    const channel = parseChannel(await response.text(), descriptor);
    return { channel, source: new URL(channel.source, descriptor).toString() };
  } catch (error) {
    if (error instanceof Error && !error.message.startsWith(descriptor))
      throw new Error(`channel unreachable at ${descriptor}: ${error.message}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Minimal, honest version comparison for OUR shapes: numeric
 * major.minor.patch with an optional `-suffix` (0.0.0-m13, 1.2.3).
 * Equal triples without a suffix rank ABOVE their own prerelease (a
 * release beats its -rc, as semver does); suffixes compare
 * lexicographically — which orders m13 < m14. A full semver engine
 * would be a dependency for a two-shape world (不为假想建面).
 *
 * Returns <0 when `candidate` is older, 0 when equal, >0 when newer.
 */
export function compareVersions(candidate: string, current: string): number {
  const parse = (version: string): [number[], string | undefined] => {
    const [triple, ...suffixParts] = version.split("-");
    const numbers = (triple ?? "").split(".").map((part) => Number(part));
    if (numbers.some((number) => !Number.isFinite(number)))
      throw new Error(`unrecognised version: ${version}`);
    return [numbers, suffixParts.length ? suffixParts.join("-") : undefined];
  };
  const [candidateNumbers, candidateSuffix] = parse(candidate);
  const [currentNumbers, currentSuffix] = parse(current);
  const length = Math.max(candidateNumbers.length, currentNumbers.length);
  for (let i = 0; i < length; i += 1) {
    const a = candidateNumbers[i] ?? 0;
    const b = currentNumbers[i] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  if (candidateSuffix === currentSuffix) return 0;
  if (candidateSuffix === undefined) return 1; // a release beats its prerelease
  if (currentSuffix === undefined) return -1;
  return candidateSuffix < currentSuffix ? -1 : 1;
}
