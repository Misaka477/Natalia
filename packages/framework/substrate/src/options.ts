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
  /**
   * The distribution the official plugins are installed FROM.
   *
   * Deriving it from the store (`<store>/../plugins`) was the layout when the
   * store was a SIBLING of the distribution; the store now lives in the one
   * home, so that derivation points at `<home>/plugins`, which does not exist,
   * and installing an official plugin from the shell failed with ENOENT on an
   * installed machine. A host that knows where its distribution is says so;
   * the sibling derivation stays as the fallback for a store that really does
   * sit beside one (the dev store does).
   */
  pluginDistributionRoot?: string;
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
  /** Host-owned registry shared with task delivery and other capability consumers. */
  capabilityRegistry?: CapabilityRegistry;
  /** Preferred host-owned capability lifetime; survives runtime config reloads. */
  capabilityHost?: CapabilityHost;
  /**
   * The self-iteration handoff, injected by the host that owns the
   * workspace manager (the CLI's serve command).
   *
   * A runtime is bound to ONE workspace and cannot reach another
   * workspace's runtime, so the handoff — which creates a session in a
   * DIFFERENT tree — has to be handed down from the layer that holds them
   * all. Absent in every other host (tests, workers, the TUI's own
   * clients), where the tool answers that self-iteration is unavailable
   * rather than reaching for something that is not there.
   */
  iterateBranch?: (
    baseline: string | undefined,
    request: import("./iterate-branch").IterateBranchRequest,
  ) => Promise<import("./iterate-branch").IterateBranchResult>;
};
