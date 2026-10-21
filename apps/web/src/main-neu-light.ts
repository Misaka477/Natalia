import { perfLog } from "./perf-log";
import { createNataliaNeuLightPlugin } from "@natalia/plugin-web-ui";
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
const startupStart = performance.now();
(
  globalThis as unknown as { __nataliaStartupStart?: number }
).__nataliaStartupStart ??= startupStart;
perfLog(`[perf] renderer boot start +0.0ms`);

// Observability: log every main-thread long task during startup and runtime.
// This is the primary signal for the "silent gap" / interaction jank issue.
if (typeof PerformanceObserver !== "undefined") {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= 50) {
          perfLog(
            `[perf] longtask ${entry.duration.toFixed(1)}ms start +${entry.startTime.toFixed(1)}ms`,
          );
        }
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    // longtask API not available; startup/perf logs still work.
  }
}

// Heartbeat logs reveal main-thread stalls: if heartbeats stop but the app is
// still booting, the main thread is likely blocked in synchronous work.
if (typeof setInterval !== "undefined") {
  const heartbeat = setInterval(() => {
    const global = globalThis as unknown as {
      __nataliaStartupComplete?: boolean;
    };
    if (global.__nataliaStartupComplete) {
      clearInterval(heartbeat);
      return;
    }
    perfLog(
      `[perf] heartbeat +${(performance.now() - startupStart).toFixed(0)}ms`,
    );
  }, 1000);
}

// The runtime's address, and the token that authorizes against it.
//
// The same three sources `main-neu.ts` reads, in the same order: an explicit
// build-time URL, then the endpoint the server injected into the document, then
// a default. The default is 8790 because that is where `start-app` puts the
// runtime — measured: a live `natalia.exe` launch listens on 8790 (runtime) and
// 8791 (web shell), and `serve-web` injects `{"url":"http://127.0.0.1:8790"}`
// into the HTML it serves.
//
// This file used to hardcode 8790 with no token, which was right about the port
// and wrong about the token; a later change moved the default to 8787, which is
// the DAEMON's port and nothing else's — so a page that missed the injection
// asked a port with no listener behind it.
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
perfLog(
  `[startup] runtime client +${(performance.now() - startupStart).toFixed(1)}ms`,
);

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
perfLog(
  `[startup] ui host +${(performance.now() - startupStart).toFixed(1)}ms`,
);

// Optional UI panel plugins are loaded first so the main UI can see them.
for (const entry of UI_PLUGIN_REGISTRY) {
  await host.load(entry.create());
}

// Arm the catalog's declared panels; each bundle loads on its first mount
// (the unified path for official and third-party feature UI, lazily).
await host.armPanelsFromCatalog();
perfLog(
  `[startup] plugin ui bundles +${(performance.now() - startupStart).toFixed(1)}ms`,
);

// Load the Neumorphism light UI plugin
await host.load(createNataliaNeuLightPlugin());
perfLog(
  `[startup] main ui loaded +${(performance.now() - startupStart).toFixed(1)}ms`,
);
