import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pluginManifestSchema, type PluginManifest } from "./manifest";

export async function discoverPluginManifests(
  root: string,
  options: { nodeModules?: boolean } = {},
) {
  const dir = resolve(root);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const manifests: Array<{ manifest: PluginManifest; path: string }> = [];
  const directories = [
    dir,
    ...entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name)),
  ];
  if (options.nodeModules !== false) {
    const modulesDir = join(dir, "node_modules");
    const modules = await readdir(modulesDir, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of modules) {
      if (!entry.isDirectory()) continue;
      const packagePath = join(modulesDir, entry.name);
      if (!entry.name.startsWith("@")) directories.push(packagePath);
      else
        for (const scoped of await readdir(packagePath, {
          withFileTypes: true,
        }).catch(() => []))
          if (scoped.isDirectory())
            directories.push(join(packagePath, scoped.name));
    }
  }
  for (const directory of directories) {
    const path = join(directory, "natalia.plugin.json");
    try {
      manifests.push({
        manifest: pluginManifestSchema.parse(
          JSON.parse(await readFile(path, "utf8")),
        ),
        path,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return manifests;
}
