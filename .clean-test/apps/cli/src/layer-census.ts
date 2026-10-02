import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { realExecutableDirs } from "./official-plugins";

/**
 * The layer census (master plan P4: "doctor 报告层名"): which package
 * prefixes a build actually contains — the boundary made VISIBLE rather
 * than documented.
 *
 * Two honest sources, one shape (the standalone layout was verified
 * against the D2 release: the engine compiles INTO the bundle, so its
 * node_modules scopes cannot testify after the fact — the census must
 * be EMITTED AT BUILD time):
 *
 *  - manifest: `manifest.json` beside the installed binary carries the
 *    build-time workspace census (written by build-standalone);
 *  - node_modules: a source checkout computes it live from its workspace
 *    links (the same scopes under either context).
 *
 * A build that has neither reports empty layers with no roots — absent
 * evidence stays absent; nothing is guessed.
 */

export type LayerCensus = {
  /** Where the names came from: the build manifest, live scopes, or none. */
  source: "manifest" | "node_modules" | "none";
  /** Roots that actually contributed (manifest path or scope roots). */
  roots: string[];
  /** Package names per prefix, sorted. */
  anthelia: string[];
  natalia: string[];
  /**
   * The build's identity, when a manifest carried it (DoD #4: an incident
   * bundle must say which build produced it — the version is baked into
   * the same manifest the layers come from, so dropping it was losing the
   * one fact the analyst most needs). A source checkout has no build
   * version; absent stays absent rather than guessing.
   */
  version?: string;
  target?: string;
};

/** Build-time census over a source checkout's workspaces (used by the release build). */
export async function censusFromWorkspace(root: string): Promise<{
  anthelia: string[];
  natalia: string[];
}> {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as {
    workspaces?: string[];
  };
  const dirs = new Set<string>();
  for (const pattern of manifest.workspaces ?? []) {
    // The repo's globs are one-level-with-*/two-level-with-*/* shapes; a
    // bounded walk matches both without pulling in node_modules.
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === "node_modules") continue;
        const full = join(dir, entry.name);
        if (await fileExists(join(full, "package.json"))) dirs.add(full);
        if (depth > 0) await walk(full, depth - 1);
      }
    };
    const starCount = (pattern.match(/\*/gu) ?? []).length;
    await walk(join(root, pattern.split("/")[0] ?? "."), starCount);
    const tail = pattern.split("/").slice(1).join("/");
    if (tail.includes("/"))
      await walk(join(root, pattern.split("/").slice(0, -1).join("/")), 1);
  }
  const anthelia: string[] = [];
  const natalia: string[] = [];
  for (const dir of dirs) {
    try {
      const name = (
        JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
          name?: string;
        }
      ).name;
      if (name?.startsWith("@anthelia/")) anthelia.push(name);
      else if (name?.startsWith("@natalia/")) natalia.push(name);
    } catch {
      /* unreadable manifest: not counted */
    }
  }
  return { anthelia: anthelia.sort(), natalia: natalia.sort() };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function scopeNames(
  root: string,
  scope: "@anthelia" | "@natalia",
): Promise<string[]> {
  try {
    const entries = await readdir(join(root, "node_modules", scope), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => `${scope}/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
}

export async function layerCensus(
  candidateRoots: readonly string[] = [
    // The installed context first: manifest.json sits BESIDE the real
    // executable (versions/<v>/) — inside a standalone bundle
    // process.execPath points into the read-only VFS, so the shared
    // real-executable chain is the only honest locator.
    ...realExecutableDirs({
      argv0: process.argv0,
      execPath: process.execPath,
    }),
    resolve(dirname(process.execPath), ".."),
    process.cwd(),
  ],
): Promise<LayerCensus> {
  // 1. The build manifest (installed context): names baked at release time.
  for (const raw of candidateRoots) {
    const manifestPath = join(resolve(raw), "manifest.json");
    if (!(await fileExists(manifestPath))) continue;
    try {
      const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as {
        layers?: { anthelia?: string[]; natalia?: string[] };
        version?: string;
        target?: string;
      };
      if (parsed.layers)
        return {
          source: "manifest",
          roots: [manifestPath],
          anthelia: [...(parsed.layers.anthelia ?? [])].sort(),
          natalia: [...(parsed.layers.natalia ?? [])].sort(),
          ...(parsed.version ? { version: parsed.version } : {}),
          ...(parsed.target ? { target: parsed.target } : {}),
        };
    } catch {
      /* fall through to the live scope census */
    }
  }
  // 2. Live scopes (source checkout).
  const roots: string[] = [];
  const anthelia = new Set<string>();
  const natalia = new Set<string>();
  for (const raw of candidateRoots) {
    const root = resolve(raw);
    const a = await scopeNames(root, "@anthelia");
    const n = await scopeNames(root, "@natalia");
    if (!a.length && !n.length) continue;
    roots.push(root);
    for (const name of a) anthelia.add(name);
    for (const name of n) natalia.add(name);
  }
  if (roots.length)
    return {
      source: "node_modules",
      roots,
      anthelia: [...anthelia].sort(),
      natalia: [...natalia].sort(),
    };
  return { source: "none", roots: [], anthelia: [], natalia: [] };
}
