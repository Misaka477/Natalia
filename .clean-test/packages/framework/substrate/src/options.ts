import type { CapabilityHost, CapabilityRegistry } from "@anthelia/capability";
import type { EpisodeID, SessionID } from "@anthelia/contracts";
import type {
  TerminalControllerInput,
  ToolHooks,
  ToolPolicy,
} from "@anthelia/runtime-services";
import type { StreamingProvider } from "@anthelia/runtime";
import type { ToolRegistry } from "@anthelia/tools";

export type RealRuntimeClientOptions = {
  sessionID?: SessionID;
  episodeID?: EpisodeID;
  title?: string;
  workspaceRoot?: string;
  /** Natalia instance plugin store. Hosts resolve this once; workspaces never own it. */
  pluginStoreRoot?: string;
  /** Override the user-level config path, primarily for isolated hosts/tests. */
  globalConfigPath?: string;
  sessionDir?: string;
  checkpointDir?: string;
  /** Override the operation-log directory, primarily for isolated hosts/tests. */
  operationLogsDir?: string;
  vaultDir?: string;
  useSqliteStore?: boolean;
  /** Persistent cache for provider context-window resolution. Avoids remote model-metadata probing on every cold start. */
  contextWindowCachePath?: string;
  provider?: StreamingProvider;
  tools?: ToolRegistry;
  permissionProfile?: string;
  permissionMode?: "ask" | "auto" | "read_only";
  toolPolicy?: ToolPolicy;
  hooks?: ToolHooks;
  nativeTerminal?: TerminalControllerInput["external"];
  /** Host-owned registry shared with task delivery and other capability consumers. */
  capabilityRegistry?: CapabilityRegistry;
  /** Preferred host-owned capability lifetime; survives runtime config reloads. */
  capabilityHost?: CapabilityHost;
};
