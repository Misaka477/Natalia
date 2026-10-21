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

// The runtime's address, and the token that authorizes against it.
//
// The port is NOT 8790 by default: the daemon binds 8787 (measured —
// `netstat` on a live `natalia daemon` shows 127.0.0.1:8787 LISTENING), and a
// hardcoded 8790 made every RPC fail to connect, which is why the settings
// panel's 浏览 button did nothing: the request never reached the runtime that
// would have opened the dialog.
//
// The token is required: the daemon answers `401 unauthorized` without it
// (measured — a bare POST to /rpc returns exactly that). The shell serves the
// page from the daemon itself, so the token is injected into the document
// rather than read from an environment variable a browser cannot see.
const env = (import.meta as { env?: Record<string, string> }).env ?? {};
const runtimeURL =
  env.VITE_NATALIA_RUNTIME_URL ||
  (globalThis as { __NATALIA_RUNTIME__?: { url?: string; token?: string } })
    .__NATALIA_RUNTIME__?.url ||
  "http://127.0.0.1:8787";
const runtimeToken = (
  globalThis as { __NATALIA_RUNTIME__?: { token?: string } }
).__NATALIA_RUNTIME__?.token;

const runtime = createWebRuntimeClient({
  url: runtimeURL,
  ...(runtimeToken ? { token: runtimeToken } : {}),
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
