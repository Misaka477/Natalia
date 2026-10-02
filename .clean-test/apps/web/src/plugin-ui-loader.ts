import { perfLog } from "./perf-log";
import type { PluginCatalogEntry, RuntimeClient } from "@anthelia/contracts";
import type { UiPlugin, UiPluginHost } from "@natalia/ui-host";

type UiPluginFactory = () => UiPlugin;
type UiModule = {
  createUiPlugin?: UiPluginFactory;
  default?: UiPluginFactory;
  [key: string]: unknown;
};

function resolveUiPluginFactory(mod: UiModule): UiPluginFactory | undefined {
  if (typeof mod.createUiPlugin === "function") return mod.createUiPlugin;
  if (typeof mod.default === "function") return mod.default;
  for (const [name, value] of Object.entries(mod)) {
    if (name === "default" || name === "createUiPlugin") continue;
    if (typeof value !== "function") continue;
    // Official and scaffolded UI panel plugins historically export
    // create<Name>Plugin / create<Name>UiPlugin rather than createUiPlugin.
    if (/^create[A-Za-z0-9_]*(?:Ui)?Plugin$/u.test(name)) {
      return value as UiPluginFactory;
    }
  }
  return undefined;
}

/** Maps loaded UI plugin ids back to the runtime plugin they came from. */
const uiSourceByPluginId = new Map<string, string>();

/** Maximum number of UI bundles fetched and evaluated concurrently. */
const MAX_CONCURRENT_PLUGIN_UI_LOADS = 4;

async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const current = nextIndex++;
        await mapper(items[current]!);
      }
    },
  );
  await Promise.all(workers);
}

function enabledUiPlugins(
  catalog: readonly PluginCatalogEntry[],
): PluginCatalogEntry[] {
  return catalog.filter(
    (plugin) => plugin.enabled && plugin.installed && plugin.ui?.entry,
  );
}

/**
 * Loads every enabled/installed plugin's renderer-side UI bundle through the
 * same path used for official and third-party plugins.
 *
 * The runtime serves a single deterministic URL per plugin:
 *
 *   GET /plugins/<pluginId>/ui.js
 *
 * This loader deliberately does not know which plugins are "official"; it only
 * follows the plugin catalog.
 */
export async function loadPluginUiBundles(
  host: UiPluginHost,
  runtime: RuntimeClient,
  runtimeURL: string,
  token?: string,
): Promise<void> {
  const catalogStart = performance.now();
  const catalog = (await runtime.pluginCatalog?.()) ?? [];
  perfLog(
    `[perf] plugin-ui catalog ${catalog.length} plugins +${(performance.now() - catalogStart).toFixed(1)}ms`,
  );
  const plugins = enabledUiPlugins(catalog);
  await forEachWithConcurrency(
    plugins,
    MAX_CONCURRENT_PLUGIN_UI_LOADS,
    (plugin) => loadOnePluginUi(host, runtimeURL, plugin, token),
  );
}

/**
 * The lazy activation's second stage (spec §2.3): load ONE plugin's UI
 * bundle on demand — the host's mountPanel calls this through its
 * ensurePluginLoaded seam when a panel of a not-yet-loaded plugin is
 * requested. Idempotent by the same loaded-set the reconcile path uses,
 * so a second request for the same plugin is a no-op.
 */
export async function activatePluginUi(
  host: UiPluginHost,
  runtime: RuntimeClient,
  runtimeURL: string,
  token: string | undefined,
  pluginID: string,
): Promise<boolean> {
  const loaded = new Set(uiSourceByPluginId.values());
  if (loaded.has(pluginID)) return false;
  const catalog = (await runtime.pluginCatalog?.()) ?? [];
  const entry = catalog.find((plugin) => plugin.id === pluginID);
  if (!entry) return false;
  await loadOnePluginUi(host, runtimeURL, entry, token);
  return true;
}

/**
 * Reconciles the UI host with the current plugin catalog:
 *
 * - loads UI for newly enabled plugins
 * - unloads UI for disabled/removed plugins
 *
 * Runtime plugins, whether they carry UI or not, remain fully managed by the
 * plugin manager through pluginInstall/Uninstall/SetEnabled; this function only
 * keeps the renderer-side panels in sync with that catalog.
 */
export async function syncPluginUiBundles(
  host: UiPluginHost,
  runtime: RuntimeClient,
  runtimeURL: string,
  token?: string,
): Promise<void> {
  const catalog = (await runtime.pluginCatalog?.()) ?? [];
  const enabled = new Set(
    catalog
      .filter(
        (plugin) => plugin.enabled && plugin.installed && plugin.ui?.entry,
      )
      .map((plugin) => plugin.id),
  );

  for (const [uiPluginId, runtimePluginId] of [...uiSourceByPluginId]) {
    if (enabled.has(runtimePluginId)) continue;
    try {
      await host.unload(uiPluginId);
    } catch (error) {
      console.warn(
        `[plugin-ui] failed to unload ${uiPluginId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    uiSourceByPluginId.delete(uiPluginId);
  }

  const loadedRuntimePluginIds = new Set(uiSourceByPluginId.values());
  const pluginsToLoad = enabledUiPlugins(catalog).filter(
    (plugin) => !loadedRuntimePluginIds.has(plugin.id),
  );
  await forEachWithConcurrency(
    pluginsToLoad,
    MAX_CONCURRENT_PLUGIN_UI_LOADS,
    (plugin) => loadOnePluginUi(host, runtimeURL, plugin, token),
  );
}

async function loadOnePluginUi(
  host: UiPluginHost,
  runtimeURL: string,
  plugin: PluginCatalogEntry,
  token?: string,
): Promise<void> {
  if (!plugin.ui?.entry) return;
  try {
    const moduleUrl = new URL(
      `/plugins/${encodeURIComponent(plugin.id)}/ui.js`,
      runtimeURL,
    ).href;
    const bundleStart = performance.now();
    perfLog(`[perf] plugin-ui bundle start ${plugin.id} url=${moduleUrl}`);
    const mod = await importPluginUiModule(moduleUrl, token);
    perfLog(
      `[perf] plugin-ui bundle fetched ${plugin.id} +${(performance.now() - bundleStart).toFixed(1)}ms`,
    );
    const factory = resolveUiPluginFactory(mod);
    if (!factory) {
      console.warn(
        `[plugin-ui] ${plugin.id} does not export createUiPlugin/create*Plugin`,
      );
      return;
    }
    const pluginStart = performance.now();
    const uiPlugin = factory();
    await host.load(uiPlugin);
    uiSourceByPluginId.set(uiPlugin.id, plugin.id);
    // The declaration drives it: the manifest's css field is the contract.
    // (It used to need a hardcoded id special-case, back when the schema
    // stripped the field and only the release manifest carried it.)
    if (plugin.ui?.css) await loadPluginUiCss(runtimeURL, plugin.id, token);
    console.info(
      `[plugin-ui] loaded ${plugin.id}@${plugin.version} +${(performance.now() - pluginStart).toFixed(1)}ms`,
    );
  } catch (error) {
    console.warn(
      `[plugin-ui] failed to load ${plugin.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function loadPluginUiCss(
  runtimeURL: string,
  pluginId: string,
  token?: string,
): Promise<void> {
  try {
    const url = new URL(
      `/plugins/${encodeURIComponent(pluginId)}/ui.css`,
      runtimeURL,
    ).href;
    const headers = token ? { authorization: `Bearer ${token}` } : undefined;
    const response = await fetch(url, { headers });
    if (!response.ok) return; // CSS is optional; missing assets are normal.
    const css = await response.text();
    const existing = document.querySelector<HTMLStyleElement>(
      `style[data-natalia-plugin-ui-css="${pluginId}"]`,
    );
    if (existing) existing.textContent = css;
    else {
      const style = document.createElement("style");
      style.setAttribute("data-natalia-plugin-ui-css", pluginId);
      style.textContent = css;
      document.head.append(style);
    }
  } catch (error) {
    console.warn(
      `[plugin-ui] failed to load css for ${pluginId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function importPluginUiModule(
  url: string,
  token?: string,
): Promise<UiModule> {
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(
      `plugin ui request failed (${response.status} ${response.statusText})`,
    );
  const code = await response.text();
  const blob = new Blob([code], { type: "text/javascript" });
  const blobURL = URL.createObjectURL(blob);
  try {
    return (await import(/* @vite-ignore */ blobURL)) as UiModule;
  } finally {
    URL.revokeObjectURL(blobURL);
  }
}
