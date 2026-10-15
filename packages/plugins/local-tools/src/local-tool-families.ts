import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolFamily } from "@anthelia/tools";

export const TOOL_FAMILY_MANIFEST = "natalia.tool.json";

export type LocalToolFamilyManifest = {
  entry: string;
};

export type LocalToolFamilyOptions = {
  onError?: (id: string, error: unknown) => void;
  trust?: {
    workspaceRoot: string;
    verify: (
      key: string,
      entryPath: string,
    ) => Promise<{ verified: boolean; expected?: string; actual?: string }>;
  };
};

export async function discoverLocalToolFamilies(root: string) {
  const dir = resolve(root);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const isDirectory = (entry: {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }) => entry.isDirectory() || entry.isSymbolicLink();
  const directories = [
    dir,
    ...entries.filter(isDirectory).map((entry) => join(dir, entry.name)),
  ];
  for (const entry of entries.filter(
    (entry) => isDirectory(entry) && entry.name === "node_modules",
  )) {
    const installed = await readdir(join(dir, entry.name), {
      withFileTypes: true,
    }).catch(() => []);
    for (const packageEntry of installed.filter(isDirectory)) {
      const packageDir = join(dir, entry.name, packageEntry.name);
      directories.push(packageDir);
      if (packageEntry.name.startsWith("@")) {
        const scoped = await readdir(packageDir, { withFileTypes: true }).catch(
          () => [],
        );
        for (const scopedEntry of scoped.filter(isDirectory))
          directories.push(join(packageDir, scopedEntry.name));
      }
    }
  }
  const discovered: Array<{ manifest: LocalToolFamilyManifest; path: string }> =
    [];
  for (const directory of directories) {
    const path = join(directory, TOOL_FAMILY_MANIFEST);
    try {
      discovered.push({
        manifest: JSON.parse(
          await readFile(path, "utf8"),
        ) as LocalToolFamilyManifest,
        path,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return discovered;
}

export async function loadLocalToolFamilies(input: {
  roots: string[];
  onError?: (id: string, error: unknown) => void;
  trust?: LocalToolFamilyOptions["trust"];
}): Promise<ToolFamily[]> {
  const families: ToolFamily[] = [];
  for (const root of input.roots) {
    const discovered = await discoverLocalToolFamilies(root);
    for (const { manifest, path } of discovered) {
      const imported = await importLocalToolFamily(manifest, path, input);
      if (!imported) continue;
      families.push(imported.family);
    }
  }
  return families;
}

export async function reloadLocalToolFamily(input: {
  roots: string[];
  familyID: string;
  onError?: (id: string, error: unknown) => void;
  trust?: LocalToolFamilyOptions["trust"];
}): Promise<ToolFamily> {
  for (const root of input.roots) {
    const discovered = await discoverLocalToolFamilies(root);
    for (const { manifest, path } of discovered) {
      const imported = await importLocalToolFamily(manifest, path, input, {
        cacheBust: true,
      });
      if (imported?.family.id !== input.familyID) continue;
      return imported.family;
    }
  }
  throw new Error(`tool family not found: ${input.familyID}`);
}

/**
 * The module specifier for a family entry, and the reload query that goes
 * with it.
 *
 * The two runtimes disagree about where the cache key lives, and the
 * disagreement is measured, not assumed:
 *
 * - Bun keys a `file:` URL's module cache by the URL WITHOUT its query, so
 *   `file:///...index.ts?reload=1` silently returns the module already in
 *   memory. A bare path with the query appended is a distinct key there and
 *   does re-evaluate.
 * - Node is the mirror image: a bare absolute path is not a legal module
 *   specifier on Windows (`ERR_UNSUPPORTED_ESM_URL_SCHEME`), while a file URL
 *   with a query is both legal and a distinct key.
 *
 * So the spelling follows the runtime — a runtime check, never a baked-in
 * choice (AGENTS.md §4). Both branches re-evaluate the changed bytes; neither
 * regresses the other. Without a cacheBust token the file URL is correct on
 * both, and is what the plain load path uses.
 */
export function toolFamilySpecifier(entryPath: string, cacheBust?: number) {
  if (!cacheBust) return pathToFileURL(entryPath).href;
  return typeof Bun !== "undefined"
    ? `${entryPath}?reload=${cacheBust}`
    : `${pathToFileURL(entryPath).href}?reload=${cacheBust}`;
}

async function importLocalToolFamily(
  manifest: LocalToolFamilyManifest,
  path: string,
  input: LocalToolFamilyOptions,
  options?: { cacheBust?: boolean },
): Promise<{ family: ToolFamily; entryPath: string } | undefined> {
  const entryPath = resolve(path, "..", manifest.entry);
  try {
    if (input.trust) {
      const verified = await input.trust.verify(keyForPath(path), entryPath);
      if (verified.expected && !verified.verified) {
        input.onError?.(
          path,
          new Error("package changed since install (fingerprint mismatch)"),
        );
        return undefined;
      }
    }
    const href = toolFamilySpecifier(
      entryPath,
      options?.cacheBust ? Date.now() : undefined,
    );
    const module = (await import(href)) as { default?: unknown };
    const exported = module.default;
    const family =
      typeof exported === "function"
        ? (exported as () => ToolFamily)()
        : (exported as ToolFamily | undefined);
    if (!family || typeof family.id !== "string") {
      input.onError?.(
        path,
        new Error(`tool family entry has no default export: ${entryPath}`),
      );
      return undefined;
    }
    return { family, entryPath };
  } catch (error) {
    input.onError?.(path, error);
    return undefined;
  }
}

function keyForPath(manifestPath: string) {
  return resolve(manifestPath, "..");
}

export async function watchLocalToolFamilies(input: {
  roots: string[];
  onError?: (id: string, error: unknown) => void;
  trust?: LocalToolFamilyOptions["trust"];
  onChange: (familyID: string, entryPath: string) => void;
  debounceMs?: number;
}): Promise<() => Promise<void>> {
  const debounceMs = input.debounceMs ?? 150;
  const { watch } = await import("node:fs");
  const entries: Array<{ familyID: string; dir: string; entryPath: string }> =
    [];
  for (const root of input.roots) {
    const discovered = await discoverLocalToolFamilies(root);
    for (const { manifest, path } of discovered) {
      const imported = await importLocalToolFamily(manifest, path, input);
      if (!imported) continue;
      entries.push({
        familyID: imported.family.id,
        dir: resolve(path, ".."),
        entryPath: imported.entryPath,
      });
    }
  }
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watchers = entries.map(({ familyID, dir, entryPath }) =>
    watch(dir, (_event, filename) => {
      // basename(), not a "/" split: the entry path carries the HOST
      // separator, and splitting a Windows path on "/" yields the whole
      // path — which the event's filename (a bare name) never equals, so
      // the change was silently dropped there and the family never
      // reloaded.
      if (filename?.toString() !== basename(entryPath)) return;
      const existing = timers.get(familyID);
      if (existing) clearTimeout(existing);
      timers.set(
        familyID,
        setTimeout(() => {
          timers.delete(familyID);
          input.onChange(familyID, entryPath);
        }, debounceMs),
      );
    }),
  );
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const watcher of watchers) watcher.close();
  };
}
