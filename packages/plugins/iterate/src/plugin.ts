import type { Plugin, PluginAPI, PluginManifest } from "@anthelia/plugin";
import { iterateTools } from "./tools";

export const ITERATE_PLUGIN_ID = "natalia-tool-iterate";

export const ITERATE_PLUGIN_MANIFEST: PluginManifest = {
  apiVersion: 2,
  id: ITERATE_PLUGIN_ID,
  version: "1.0.0",
  name: "Iterate Tools",
  description:
    "Self-iteration: copy the product's read-only source to a workspace the model chooses and continue the session's work there, and land a built copy as a new generation.",
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

export function createIteratePlugin(): Plugin {
  const disposers: Array<() => void> = [];
  return {
    manifest: ITERATE_PLUGIN_MANIFEST,
    setup(api: PluginAPI) {
      for (const tool of iterateTools) disposers.push(api.tools.register(tool));
    },
    async dispose() {
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}

export default createIteratePlugin;
