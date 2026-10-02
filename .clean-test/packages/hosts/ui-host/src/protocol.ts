import type {
  ChatMessageRow,
  RuntimeClient,
  RuntimeEvent,
  RuntimeProjectedMessage,
  RuntimeSubagentView,
  RuntimeWorkspaceContent,
  UiPanelMeta,
} from "@anthelia/contracts";
import type * as ViewStore from "@natalia/view-store";
import type { AppState } from "@natalia/view-store";
import type {
  PendingController,
  PendingKind,
  PendingPresenter,
} from "@natalia/ui-model";

export type UiPluginLifecycle = {
  dispose(): void | Promise<void>;
};

export type UiPanelDefinition = UiPanelMeta & {
  /**
   * Optional dynamic panel renderer. When present, the host can mount this
   * panel into a container supplied by another (host) UI plugin.
   */
  mount?(
    ctx: UiPluginContext,
    container: HTMLElement,
  ): UiPluginLifecycle | void | (() => void);
  /** Optional capabilities that must exist for this panel to be shown. */
  requiresCapabilities?: string[];
};

export type UiCommandDefinition = {
  id: string;
  title: string;
  description?: string;
  run(args?: unknown): unknown | Promise<unknown>;
};

export type UiEventPattern =
  | "*"
  | "runtime.*"
  | "runtime.turn.*"
  | "runtime.chat.*"
  | "runtime.checkpoint.*"
  | (string & {});

export type UiEventBus = {
  emit(event: RuntimeEvent): void;
  subscribe(
    listener: (event: RuntimeEvent) => void,
    filter?: readonly UiEventPattern[],
  ): () => void;
};

export type PreferenceStore = {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  subscribe(listener: (key: string, value: unknown) => void): () => void;
};

export type Logger = {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
};

export type TerminalOptions = {
  cwd?: string;
  cols?: number;
  rows?: number;
};

export type TerminalHandle = {
  write(data: string | Uint8Array): Promise<void>;
  resize?(cols: number, rows: number): Promise<void>;
  onData(listener: (data: Uint8Array) => void): () => void;
  close(): Promise<void>;
};

export type UiResources = {
  read(input: {
    resource: string;
    params?: Record<string, string>;
  }): Promise<RuntimeWorkspaceContent>;
};

export type UiTransport = {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  openPath?(path: string): Promise<void>;
  readClipboardImage?(): Promise<Uint8Array | undefined>;
  createTerminal?(options: TerminalOptions): Promise<TerminalHandle>;
};

export type UiProjection = {
  getState(): AppState;
  subscribe(listener: (state: AppState) => void): () => void;
  hydrateMessages?(
    messages: RuntimeProjectedMessage[],
    direction?: "older" | "newer",
    options?: { replace?: boolean },
  ): boolean;
  hydrateNaviMessages?(
    messages: ChatMessageRow[],
    options?: import("@natalia/view-store").HydrateAgentMessagesOptions,
  ): boolean;
  hydrateNiaMessages?(
    messages: ChatMessageRow[],
    options?: import("@natalia/view-store").HydrateAgentMessagesOptions,
  ): boolean;
  hydrateRuntimeNotices?(
    notices: import("@anthelia/contracts").RuntimeProjectedNotice[],
  ): boolean;
  beginNaviHydration?(): void;
  beginNiaHydration?(): void;
  hydrateSubagents?(subagents: RuntimeSubagentView[]): boolean;
  hydrateSubagentHistory?(
    history: RuntimeSubagentView[],
    options?: import("@natalia/view-store").HydrateSubagentHistoryOptions,
  ): boolean;
  /** Activates a cached workspace/session projection without discarding others. */
  activateSession?(sessionID: string, workspaceID?: string): void;
};

export type UiPluginContext<TContext = unknown> = {
  root: HTMLElement;
  runtime: RuntimeClient;
  host?: {
    listPanels(): Array<{
      pluginId: string;
      panel: UiPanelDefinition;
    }>;
    /**
     * Arms the catalog's declared panels without loading bundles (spec
     * §2.3 stage 1): the shell lists from the catalog, the mount
     * activates. Returns the armed count.
     */
    armPanelsFromCatalog?(): Promise<number>;
    mountPanel(
      pluginId: string,
      panelId: string,
      container: HTMLElement,
    ): Promise<void>;
    subscribePanels(listener: () => void): () => void;
    loaded(): Array<{
      pluginId: string;
      name: string;
      version: string;
      shellLayout?: unknown;
    }>;
    unload(pluginId: string): Promise<void>;
    load(plugin: UiPlugin): Promise<void>;
  };
  viewStore: typeof ViewStore;
  projection: UiProjection;
  events: UiEventBus;
  preferences: PreferenceStore;
  resources: UiResources;
  transport: UiTransport;
  logger: Logger;
  t: (text: string) => string;
  /** Shared presenter registry so any UI can render a pending request kind. */
  pending: {
    registerPresenter(presenter: PendingPresenter): () => void;
    presenters(): ReadonlyMap<PendingKind, PendingPresenter>;
    /** Shared UI-only selection state; the host owns dialog-stack truth. */
    controller: PendingController;
  };
  extra?: TContext;
};

export type UiPlugin<TContext = unknown> = {
  id: string;
  name: string;
  version: string;
  description?: string;
  mount(
    ctx: UiPluginContext<TContext>,
  ): Promise<UiPluginLifecycle | void> | UiPluginLifecycle | void;
  unmount?(): void | Promise<void>;
  panels?: UiPanelDefinition[];
  commands?: UiCommandDefinition[];
  events?: UiEventPattern[];
  preferences?: Record<string, unknown>;
  /**
   * Optional custom shell layout plugin. When present, the main UI host can
   * delegate the whole shell rendering to this plugin instead of its default
   * layout. The concrete type lives in @natalia/ui-kit; this protocol keeps
   * ui-host free of a Solid/UI-kit dependency.
   */
  shellLayout?: unknown;
};

export function defineUiPlugin<TContext = unknown>(
  plugin: UiPlugin<TContext>,
): UiPlugin<TContext> {
  return plugin;
}
