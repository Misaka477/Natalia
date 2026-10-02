import type { Plugin, PluginManifest } from "@anthelia/plugin";
import {
  SETTLEMENT_SERVICE,
  type SettlementService,
} from "@natalia/collaboration";
import {
  terminalController,
  type TerminalController,
  type TerminalControllerInput,
} from "@anthelia/runtime-services";
import { createTerminalController } from "./terminal-controller";
import { createPtyTerminalController } from "./pty-terminal-controller";
import { terminalTools, terminalToolFamily } from "./terminal-tools";
import type { NativeTerminalRegistry } from "./native-terminal";

export const TERMINAL_PLUGIN_ID = "natalia-tool-terminal";

export const TERMINAL_PLUGIN_MANIFEST: PluginManifest = {
  apiVersion: 2,
  id: TERMINAL_PLUGIN_ID,
  version: "1.0.0",
  name: "Terminal Tools",
  description: "Native terminal panes and interactive programs.",
  entry: "index.js",
  scope: "session",
  provides: [terminalController.id],
  requires: [],
  optionalRequires: [],
  conflicts: [],
  dependencies: [],
  hooks: {},
  integrationPoints: ["tools", "services"],
  ui: {
    entry: "ui/plugin.js",
    // The built-path convention this manifest already follows for `entry`
    // (the module self-declares the names the release build produces), and
    // the reason the release manifest can carry it too: the install-time
    // manifest comparison holds the module and the file to one declaration.
    css: "ui/plugin.css",
    panels: [
      {
        id: "terminal",
        title: "终端",
        region: "side",
      },
    ],
  },
};

/**
 * The one true terminal plugin. It owns the native host implementation, the
 * terminal resource controller and the terminal tools/aliases: on setup it
 * constructs the controller, provides the `terminalController` token and
 * registers the tool surface; on unload it disposes the controller so every
 * pane stops and the host is torn down.
 */
export function createTerminalPlugin(input: TerminalControllerInput): Plugin {
  let controller: TerminalController | undefined;
  // On Windows the host controller (and its mux/broker) outlives the pty
  // controller's own life only in teardown order: the pty panes stop first,
  // then the host tears down.
  let host: TerminalController | undefined;
  return {
    manifest: TERMINAL_PLUGIN_MANIFEST,
    async setup(api) {
      // The controller input crosses the runtime-services boundary with the
      // host registry typed as `unknown`; the plugin owns the concrete type.
      // The settlement bridge, resolved by name like the process plugin's
      // (the sandbox cannot reach ports; the runtime publishes it). A
      // missing service degrades to a controller that reports no notices.
      const settlement =
        api.services.get<SettlementService>(SETTLEMENT_SERVICE);
      if (input.backend === "wezterm" || input.external) {
        controller = createTerminalController({
          ...input,
          external: input.external as NativeTerminalRegistry | undefined,
        });
      } else if (process.platform === "win32") {
        // Windows's PTY backend has no in-process PTY: node-pty's native
        // modules cannot load under bun, and the Python bridge needs the
        // POSIX pty module (plus a python3 on PATH). A pane in the WezTerm
        // mux is a real PTY the panel can render, so the host controller is
        // built alongside the pty controller and its registry is lent to the
        // pty spawn (the pane starts windowless — see spawnWithWezTermPty).
        // The backend default stays "pty" everywhere; only the SPAWN differs.
        const weztermHost = createTerminalController({
          ...input,
          external: undefined,
        });
        // The registry is built by the host's own init (mux, broker); await
        // it so the pty spawn sees a live registry rather than falling back.
        await weztermHost.init();
        host = weztermHost;
        controller = createPtyTerminalController({
          ...input,
          settlement,
          nativeTerminal: () => weztermHost.nativeRegistry(),
        });
      } else {
        controller = createPtyTerminalController({ ...input, settlement });
      }
      api.services.provide(terminalController.id, controller);
      for (const tool of terminalTools()) api.tools.register(tool);
      for (const [alias, target] of Object.entries(
        terminalToolFamily().aliases ?? {},
      ))
        api.tools.registerAlias(alias, target);
    },
    async dispose() {
      await controller?.close();
      controller = undefined;
      await host?.close();
      host = undefined;
    },
  };
}
