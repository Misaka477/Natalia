import type { Plugin, PluginAPI, PluginManifest } from "@anthelia/plugin";
import { browserTools } from "./tools";
import { getBrowserBridgeLifecycle } from "./browser-bridge-lifecycle";

export const BROWSER_PLUGIN_ID = "natalia-tool-browser";

export const BROWSER_PLUGIN_MANIFEST: PluginManifest = {
  apiVersion: 2,
  id: BROWSER_PLUGIN_ID,
  version: "1.0.0",
  name: "Browser Tools",
  description:
    "Control the user's existing browser through the Natalia Browser Bridge extension.",
  entry: "index.js",
  scope: "session",
  provides: [],
  requires: [],
  optionalRequires: [],
  conflicts: [],
  dependencies: [],
  hooks: {},
  integrationPoints: ["tools"],
};

export function createBrowserPlugin(): Plugin {
  const disposers: Array<() => void> = [];
  return {
    manifest: BROWSER_PLUGIN_MANIFEST,
    setup(api: PluginAPI) {
      for (const tool of browserTools) disposers.push(api.tools.register(tool));
    },
    async dispose() {
      for (const dispose of disposers.splice(0)) dispose();
      await getBrowserBridgeLifecycle().close();
    },
  };
}

export default createBrowserPlugin;
