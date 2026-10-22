import type { Plugin, PluginAPI, PluginManifest } from "@anthelia/plugin";
import { computerUseTools } from "./tools";

export const COMPUTER_USE_PLUGIN_ID = "natalia-tool-computer-use";

export const COMPUTER_USE_PLUGIN_MANIFEST: PluginManifest = {
  apiVersion: 2,
  id: COMPUTER_USE_PLUGIN_ID,
  version: "1.0.0",
  name: "Computer Use Tools",
  description:
    "Drive the desktop itself: enumerate windows, capture the screen, click, type and send keys, with every action verified against the pixels it changed.",
  entry: "index.js",
  scope: "session",
  provides: [],
  requires: [],
  optionalRequires: [],
  conflicts: [],
  dependencies: [],
  hooks: {},
  integrationPoints: ["tools"],
  skills: { dir: "skills" },
};

export function createComputerUsePlugin(): Plugin {
  const disposers: Array<() => void> = [];
  return {
    manifest: COMPUTER_USE_PLUGIN_MANIFEST,
    setup(api: PluginAPI) {
      // Registration only: the native layer opens on the first tool call,
      // so a platform without it refuses at call time instead of failing
      // the plugin's load and taking the runtime's tool set with it.
      for (const tool of computerUseTools)
        disposers.push(api.tools.register(tool));
    },
    async dispose() {
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}

export default createComputerUsePlugin;
