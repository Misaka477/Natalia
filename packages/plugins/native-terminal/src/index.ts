export {
  NATIVE_INPUT_BROKER_VERSION,
  NativeTerminalRegistry,
  createWezTermHost,
  decodeNativeInputClaim,
  decodeNativeInputDecision,
  encodeNativeInputDecision,
  monospaceFontFallback,
  nativeInputBrokerDecision,
  nativeInputBrokerEndpoint,
  nativeTerminalForkBuildDir,
  nativeTerminalPaneCommand,
  // The pane's full spawn spec — argv AND the environment its shell needs. A pane
  // that takes only the argv is silently unintegrated on zsh, whose rc arrives as
  // ZDOTDIR rather than as a flag. It has to be exported, not merely used inside
  // the package: an installed plugin's consumers reach it only through this
  // boundary, and the first version tested it in-package only, so it worked there
  // and was absent wherever the plugin is loaded from its build output.
  nativeTerminalPaneSpawn,
  nativeTerminalPrebuiltDir,
  platformTriple,
  reclaimStaleMuxRuntimeDirs,
  resolveNataliaWezTermForkExecutable,
  resolveWezTermExecutable,
  startNativeInputBroker,
  writeWezTermNativeDomainConfig,
  type NativeInputBroker,
  type NativeInputClaim,
  type NativeInputDecision,
  type NativeInputKind,
  type NativeTerminalAuditEvent,
  type NativeTerminalHost,
  type NativeTerminalHub,
  type NativeTerminalPane,
  type NativeTerminalSession,
  type NativeTerminalWriteResult,
} from "./native-terminal";
export {
  createTerminalController,
  type TerminalControllerInput,
} from "./terminal-controller";
export {
  createPtyTerminalController,
  type PtyFactory,
  type PtyProcess,
  type PtySpawnOptions,
  type PtyTerminalControllerInput,
} from "./pty-terminal-controller";
export { terminalToolFamily, terminalTools } from "./terminal-tools";
export {
  createTerminalPlugin,
  TERMINAL_PLUGIN_ID,
  TERMINAL_PLUGIN_MANIFEST,
} from "./terminal-plugin";
import type { Plugin, PluginAPI } from "@anthelia/plugin";
import { terminalInput } from "@anthelia/runtime-services";
import type { TerminalControllerInput } from "@anthelia/runtime-services";
import {
  createTerminalPlugin,
  TERMINAL_PLUGIN_MANIFEST,
} from "./terminal-plugin";

export type TerminalRuntimeInput = TerminalControllerInput;

export default function terminalPlugin(): Plugin {
  let instance: Plugin | undefined;
  return {
    manifest: {
      ...TERMINAL_PLUGIN_MANIFEST,
      entry: "index.js",
      requires: [terminalInput.id],
    },
    async setup(api: PluginAPI) {
      const input = api.services.get<TerminalRuntimeInput>(terminalInput.id);
      if (!input)
        throw new Error(`missing runtime service: ${terminalInput.id}`);
      instance = createTerminalPlugin(input);
      await instance.setup(api);
    },
    async dispose() {
      await instance?.dispose?.();
      instance = undefined;
    },
  };
}
