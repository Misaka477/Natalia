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
// Three sources, in order: an explicit build-time URL, then the endpoint the
// server injected into the document, then a default. The default is 8790
// because that is where `start-app` puts the runtime — measured: a live
// `natalia.exe` launch listens on 8790 (runtime) and 8791 (web shell), and
// `serve-web` injects `{"url":"http://127.0.0.1:8790"}` into the HTML it
// serves. 8787 is the DAEMON's port and nothing else's.
//
// The token is required when the host has one: the daemon answers
// `401 unauthorized` without it (measured — a bare POST to /rpc returns exactly
// that). The shell serves the page from the runtime itself, so the token is
// injected into the document rather than read from an environment variable a
// browser cannot see.
const env = (import.meta as { env?: Record<string, string> }).env ?? {};
const runtimeURL =
  env.VITE_NATALIA_RUNTIME_URL ||
  (globalThis as { __NATALIA_RUNTIME__?: { url?: string; token?: string } })
    .__NATALIA_RUNTIME__?.url ||
  "http://127.0.0.1:8790";
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
