/**
 * Lifecycle for the browser bridge that backs the browser_* tools.
 *
 * The bridge server is a process-level singleton: the first tool call starts
 * it, extension websocket connections update the connected flag, and plugin
 * unload stops it through close().
 */
import type { BrowserBridgeServer } from "./server";
import { createBrowserBridgeServer } from "./server";

export type BrowserBridgeLifecycle = {
  /** Start the local bridge server on first use. No-op when already started. */
  ensureStarted(): Promise<void>;
  /** Whether the Natalia Browser Bridge extension is currently connected. */
  isConnected(): boolean;
  /** Stop the bridge server and clear connection state. */
  close(): Promise<void>;
  /** Update connection state (used by the bridge server callbacks). */
  setConnected(connected: boolean): void;
  /** Local bridge server base URL, if this lifecycle owns a running server. */
  getBaseUrl(): string | undefined;
};

type LifecycleState = {
  server?: BrowserBridgeServer;
  connected: boolean;
};

function createLifecycle(): BrowserBridgeLifecycle {
  let state: LifecycleState = { connected: false };
  let startPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  function setConnected(connected: boolean) {
    state.connected = connected;
  }

  async function ensureStarted(): Promise<void> {
    if (state.server) return;
    // An explicitly configured external bridge is not owned by this process;
    // tools use it directly and no local server is started here.
    if (process.env.NATALIA_BROWSER_BRIDGE_URL) return;
    if (startPromise) return startPromise;

    startPromise = (async () => {
      const bridge = createBrowserBridgeServer({
        onConnection(kind) {
          setConnected(kind === "extension");
        },
      });
      state.server = bridge;
    })().finally(() => {
      startPromise = undefined;
    });
    await startPromise;
  }

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      // Wait for an in-flight start to settle so the newly created server is
      // closed too, even when dispose races the first tool call.
      await startPromise?.catch(() => {});
      const bridge = state.server;
      state.server = undefined;
      setConnected(false);
      await bridge?.close();
    })();
    try {
      await closePromise;
    } finally {
      closePromise = undefined;
    }
  }

  return {
    async ensureStarted() {
      await ensureStarted();
    },
    isConnected() {
      return state.connected;
    },
    async close() {
      await close();
    },
    setConnected,
    getBaseUrl() {
      return state.server?.url;
    },
  };
}

let singleton: BrowserBridgeLifecycle | undefined;

export function getBrowserBridgeLifecycle(): BrowserBridgeLifecycle {
  singleton ??= createLifecycle();
  return singleton;
}
