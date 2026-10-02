import { readFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { listInstalledPlugins, packageDirectory } from "@natalia/installer";

/**
 * Resolves a plugin's renderer-side UI bundle from the local plugin store.
 *
 * The transport stays install-location agnostic; this closure is provided by
 * the CLI and owns the plugin-store path and enabled/installed checks. Official
 * and third-party plugins go through exactly the same path.
 */
export function createPluginUiResolver(pluginStoreRoot: string) {
  // CLI startup asks for several UI bundles back-to-back. Coalesce concurrent
  // catalog reads so one burst does not repeat the install lookup for every
  // plugin bundle; the promise is intentionally not kept after settling so
  // later plugin install/enable changes are still observed.
  let rowsPromise: ReturnType<typeof listInstalledPlugins> | undefined;

  async function installedRows() {
    if (!rowsPromise) {
      rowsPromise = listInstalledPlugins({
        pluginStoreRoot,
        workspaceRoot: process.cwd(),
      }).finally(() => {
        rowsPromise = undefined;
      });
    }
    return await rowsPromise;
  }

  return async (pluginId: string, asset: "js" | "css" = "js") => {
    const rows = await installedRows();
    const row = rows.find(
      (candidate) => candidate.id === pluginId && candidate.enabled,
    );
    if (!row?.packageName || !row.ui?.entry) return undefined;
    const packageDir = resolve(
      packageDirectory(resolve(pluginStoreRoot), row.packageName),
    );
    const entry =
      asset === "css"
        ? resolve(
            packageDir,
            dirname(row.ui.entry),
            `${basename(row.ui.entry, extname(row.ui.entry))}.css`,
          )
        : resolve(packageDir, row.ui.entry);
    const rel = relative(packageDir, entry);
    if (
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      rel.startsWith(`${sep}`) ||
      /^[a-zA-Z]:/u.test(rel)
    )
      return undefined;
    try {
      const body = await readFile(entry);
      return { body: new Uint8Array(body) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
}
