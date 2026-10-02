import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
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
    const href = options?.cacheBust
      ? `${entryPath}?reload=${Date.now()}`
      : pathToFileURL(entryPath).href;
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
      if (filename?.toString() !== entryPath.split("/").pop()) return;
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
