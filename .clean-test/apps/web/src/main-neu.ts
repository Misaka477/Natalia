import { createNataliaNeuPlugin } from "@natalia/plugin-web-ui";
import { UI_PLUGIN_REGISTRY } from "./ui-plugin-registry";
import {
  createConsoleLogger,
  createUiPluginHost,
  createWebTransport,
} from "@natalia/ui-host";
import { createWebRuntimeClient } from "./runtime-rpc";
import { createLocalPreferenceStore } from "./local-preferences";
import { activatePluginUi, syncPluginUiBundles } from "./plugin-ui-loader";
import { startRendererMemoryTrace } from "./memory-trace";

startRendererMemoryTrace();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root mount point");

const runtimeURL =
  (import.meta as { env?: Record<string, string> }).env
    ?.VITE_NATALIA_RUNTIME_URL || "http://127.0.0.1:8790";

const runtime = createWebRuntimeClient({
  url: runtimeURL,
});

// Annotated: the ensurePluginLoaded seam references the host, so the
// initializer would otherwise infer itself.
const host: Awaited<ReturnType<typeof createUiPluginHost>> =
  await createUiPluginHost({
    root,
    runtime,
    transport: createWebTransport(),
    logger: createConsoleLogger("ui-web-shell"),
    // The lazy activation seam (spec §2.3): a panel mount of a plugin whose
    // bundle is not yet loaded loads THAT plugin's bundle on demand —
    // startup arms the catalog's panels and fetches nothing.
    ensurePluginLoaded: async (pluginID) => {
      await activatePluginUi(host, runtime, runtimeURL, undefined, pluginID);
    },
    extra: {
      uiPluginRegistry: UI_PLUGIN_REGISTRY,
      runtimeURL,

      syncPluginUiBundles: () => syncPluginUiBundles(host, runtime, runtimeURL),
    },
    preferences: createLocalPreferenceStore(),
  });

// Optional UI panel plugins are loaded first so the main UI can see them.
for (const entry of UI_PLUGIN_REGISTRY) {
  await host.load(entry.create());
}

// Arm the catalog's declared panels; each bundle loads on its first mount
// (the unified path for official and third-party feature UI, lazily).
await host.armPanelsFromCatalog();

// Load the Neumorphism dark UI plugin
await host.load(createNataliaNeuPlugin());
