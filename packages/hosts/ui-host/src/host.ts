import type { RuntimeClient, RuntimeEvent } from "@anthelia/contracts";
import * as viewStore from "@natalia/view-store";
import {
  createPendingController,
  type PendingPresenter,
} from "@natalia/ui-model";
import { createUiEventBus } from "./events";
import { createSilentLogger } from "./logger";
import { createMemoryPreferenceStore } from "./preferences";
import type {
  Logger,
  PreferenceStore,
  UiPlugin,
  UiPluginContext,
  UiPluginLifecycle,
  UiProjection,
  UiTransport,
} from "./protocol";
import { createMemoryTransport } from "./transport";

export type UiPluginHostOptions<TContext = unknown> = {
  root: HTMLElement;
  runtime: RuntimeClient;
  transport?: UiTransport;
  preferences?: PreferenceStore;
  logger?: Logger;
  t?: (text: string) => string;
  extra?: TContext;
  replay?: "all" | "none";
  /**
   * The lazy activation seam (interface spec §2.3's second stage): when a
   * panel mount arrives for a plugin whose UI bundle is not loaded, the
   * host asks this to activate it BEFORE failing. The web loader wires it
   * to the per-plugin bundle load; a host without it keeps the old
   * behaviour (a mount of an unloaded plugin is an error).
   */
  ensurePluginLoaded?: (pluginID: string) => Promise<void>;
};

export type LoadedUiPlugin = {
  plugin: UiPlugin;
  panels: NonNullable<UiPlugin["panels"]>;
  commands: NonNullable<UiPlugin["commands"]>;
};

export type UiPluginHost = {
  load(plugin: UiPlugin): Promise<LoadedUiPlugin>;
  unload(id: string): Promise<void>;
  loaded(): LoadedUiPlugin[];
  listPanels(): Array<{
    pluginId: string;
    panel: import("./protocol").UiPanelDefinition;
  }>;
  /**
   * Arms the catalog's declared panels WITHOUT loading any bundle (the
   * first stage of §2.3's lazy loading): the shell lists panels from the
   * catalog, and the mount activates. Re-arming replaces the armed set.
   */
  armPanelsFromCatalog(): Promise<number>;
  mountPanel(
    pluginId: string,
    panelId: string,
    container: HTMLElement,
  ): Promise<void>;
  subscribePanels(listener: () => void): () => void;
  projection: UiProjection;
  executeCommand(name: string, args?: unknown): Promise<unknown>;
  close(): Promise<void>;
};

type MountedPlugin = {
  record: LoadedUiPlugin;
  lifecycle?: UiPluginLifecycle;
};

type MountedPanel = {
  lifecycle?: UiPluginLifecycle;
  dispose?: () => void;
};

export async function createUiPluginHost<TContext = unknown>(
  options: UiPluginHostOptions<TContext>,
): Promise<UiPluginHost> {
  const logger = options.logger ?? createSilentLogger();
  const preferences = options.preferences ?? createMemoryPreferenceStore();
  const transport = options.transport ?? createMemoryTransport();
  const t = options.t ?? ((text: string) => text);
  const events = createUiEventBus();
  const sessionStates = new Map<string, viewStore.AppState>();
  let activeKey: string | undefined;
  let state = viewStore.initialState();
  const projectionListeners = new Set<(next: viewStore.AppState) => void>();
  const mounted = new Map<string, MountedPlugin>();
  const mountedPanels = new Map<string, MountedPanel>();
  /** Catalog-declared panels awaiting activation (spec §2.3 stage 1). */
  const armedPanels = new Map<
    string,
    { pluginId: string; panel: import("./protocol").UiPanelDefinition }
  >();
  const presenters = new Map<
    string,
    { pluginId: string; presenter: PendingPresenter }
  >();
  const panelListeners = new Set<() => void>();
  const pendingController = createPendingController(() => {
    for (const listener of panelListeners) listener();
  });
  let started = false;
  let closed = false;

  /**
   * Session keys are `${workspaceID ?? "default"}:${sessionID}`. Before the
   * workspace registry is known a session's hydrated history can land on the
   * `default:` key. A later event carrying the concrete workspace id used to
   * create a second, empty shell key that then won `activateSession` and wiped
   * the visible transcript. Treat `default:` as the workspace-unknown home for
   * that session.
   */
  function conversationContentScore(
    candidate: viewStore.AppState | undefined,
  ): number {
    if (!candidate) return 0;
    return (
      candidate.messages.length +
      Object.keys(candidate.streams).length +
      Object.keys(candidate.tools).length
    );
  }

  function hasConversationContent(
    candidate: viewStore.AppState | undefined,
  ): boolean {
    return conversationContentScore(candidate) > 0;
  }

  function workspaceUnknownKey(sessionID: string): string | undefined {
    const key = `default:${sessionID}`;
    return hasConversationContent(sessionStates.get(key)) ? key : undefined;
  }

  const projection: UiProjection = {
    getState: () => state,
    subscribe(listener) {
      projectionListeners.add(listener);
      return () => {
        projectionListeners.delete(listener);
      };
    },
    hydrateMessages(messages, direction = "older", options) {
      const evicted = viewStore.hydrateProjectedMessages(
        state,
        messages,
        direction,
        options,
      );
      for (const listener of projectionListeners) listener(state);
      return evicted;
    },
    hydrateNaviMessages(messages, options) {
      const evicted = viewStore.hydrateNaviMessages(state, messages, options);
      for (const listener of projectionListeners) listener(state);
      return evicted;
    },
    hydrateNiaMessages(messages, options) {
      const evicted = viewStore.hydrateNiaMessages(state, messages, options);
      for (const listener of projectionListeners) listener(state);
      return evicted;
    },
    hydrateRuntimeNotices(notices) {
      const changed = viewStore.hydrateRuntimeNotices(state, notices);
      if (changed) for (const listener of projectionListeners) listener(state);
      return changed;
    },
    beginNaviHydration() {
      viewStore.beginNaviHydration(state);
    },
    beginNiaHydration() {
      viewStore.beginNiaHydration(state);
    },
    hydrateSubagents(subagents) {
      const changed = viewStore.hydrateSubagents(state, subagents);
      for (const listener of projectionListeners) listener(state);
      return changed;
    },
    hydrateSubagentHistory(history, options) {
      const changed = viewStore.hydrateSubagentHistory(state, history, options);
      for (const listener of projectionListeners) listener(state);
      return changed;
    },
    activateSession(sessionID, workspaceID) {
      const preferredKey = `${workspaceID ?? "default"}:${sessionID}`;
      const preferredState = sessionStates.get(preferredKey);
      const defaultKey = `default:${sessionID}`;
      const defaultState = sessionStates.get(defaultKey);
      const siblingKeys = [...sessionStates.keys()].filter(
        (key) => key !== preferredKey && key.endsWith(`:${sessionID}`),
      );
      let selectedKey = sessionStates.has(preferredKey)
        ? preferredKey
        : (siblingKeys[0] ?? preferredKey);
      // A concrete-workspace key created by a late event is usually a shell.
      // When the workspace-unknown `default:` key holds this session's history,
      // prefer whichever side actually has more conversation content.
      if (defaultKey !== preferredKey && hasConversationContent(defaultState)) {
        if (
          !hasConversationContent(preferredState) ||
          conversationContentScore(defaultState) >=
            conversationContentScore(preferredState)
        ) {
          selectedKey = defaultKey;
        }
      } else if (
        selectedKey === preferredKey &&
        !hasConversationContent(preferredState)
      ) {
        const hydrated = siblingKeys.find((key) =>
          hasConversationContent(sessionStates.get(key)),
        );
        if (hydrated) selectedKey = hydrated;
      }
      activeKey = selectedKey;
      state = sessionStates.get(activeKey) ?? viewStore.initialState();
      state.sessionID ??= sessionID as never;
      sessionStates.set(activeKey, state);
      for (const listener of projectionListeners) listener(state);
    },
  };

  const fanout = (event: RuntimeEvent) => {
    const sessionID = event.sessionID;
    const workspaceID = (event as { workspaceID?: string }).workspaceID;
    const activeSessionID = activeKey
      ? activeKey.slice(activeKey.lastIndexOf(":") + 1)
      : undefined;
    let key: string | undefined =
      sessionID && activeSessionID && sessionID === activeSessionID
        ? activeKey
        : sessionID
          ? `${workspaceID ?? "default"}:${sessionID}`
          : activeKey;
    // Do not fork a second state key for a session whose history already lives
    // on the workspace-unknown `default:` key.
    if (
      key &&
      sessionID &&
      workspaceID &&
      workspaceID !== "default" &&
      !sessionStates.has(key)
    ) {
      key = workspaceUnknownKey(sessionID) ?? key;
    }
    if (!key) {
      viewStore.applyEvent(state, event);
      for (const listener of projectionListeners) listener(state);
      events.emit(event);
      return;
    }
    const target = sessionStates.get(key) ?? viewStore.initialState();
    if (sessionID) target.sessionID ??= sessionID;
    sessionStates.set(key, target);
    viewStore.applyEvent(target, event);
    const shouldRender =
      key === activeKey ||
      (sessionID &&
        !activeKey &&
        (!state.sessionID || state.sessionID === sessionID));
    if (shouldRender) {
      if (!activeKey) activeKey = key;
      state = target;
      for (const listener of projectionListeners) listener(state);
    }
    events.emit(event);
  };

  function ctxFor(plugin: UiPlugin): UiPluginContext<TContext> {
    return {
      root: options.root,
      runtime: options.runtime,
      viewStore,
      projection,
      events: {
        emit: events.emit,
        subscribe(listener, filter) {
          return events.subscribe(listener, filter ?? plugin.events);
        },
      },
      preferences,
      resources: {
        async read(input) {
          if (!options.runtime.resourceRead)
            throw new Error("runtime does not provide resourceRead");
          return await options.runtime.resourceRead({
            resource: input.resource,
            ...(input.params ? { params: input.params } : {}),
            reader: plugin.id,
          });
        },
      },
      transport,
      logger,
      t,
      pending: {
        registerPresenter(presenter) {
          const existing = presenters.get(presenter.kind);
          if (
            existing &&
            existing.pluginId === plugin.id &&
            existing.presenter === presenter
          )
            // Re-registering the same presenter is a no-op; notifying here
            // would make a remounting panel fight the panel revision.
            return () => {};
          if (existing && existing.pluginId !== plugin.id)
            throw new Error(
              `pending presenter for kind "${presenter.kind}" is already owned by ${existing.pluginId}`,
            );
          presenters.set(presenter.kind, {
            pluginId: plugin.id,
            presenter,
          });
          for (const listener of panelListeners) listener();
          return () => {
            const current = presenters.get(presenter.kind);
            if (
              current?.pluginId === plugin.id &&
              current.presenter === presenter
            ) {
              presenters.delete(presenter.kind);
              for (const listener of panelListeners) listener();
            }
          };
        },
        presenters() {
          const view = new Map<string, PendingPresenter>();
          for (const [kind, entry] of presenters)
            view.set(kind, entry.presenter);
          return view;
        },
        controller: pendingController,
      },
      extra: options.extra,
      host: {
        listPanels: () => listPanelRows(),
        armPanelsFromCatalog: () => armCatalogPanels(),
        mountPanel: async (pluginId, panelId, container) => {
          await ensureLoaded(pluginId);
          const entry = mounted.get(pluginId);
          if (!entry) throw new Error(`ui plugin not loaded: ${pluginId}`);
          const panel = entry.record.panels.find((item) => item.id === panelId);
          if (!panel)
            throw new Error(`ui panel not found: ${pluginId}:${panelId}`);
          if (!panel.mount)
            throw new Error(`ui panel has no mount: ${pluginId}:${panelId}`);
          const key = `${pluginId}:${panelId}`;
          const existing = mountedPanels.get(key);
          existing?.dispose?.();
          existing?.lifecycle?.dispose?.();
          const dispose = (await panel.mount(
            ctxFor(entry.record.plugin),
            container,
          )) as (() => void) | undefined;
          mountedPanels.set(key, {
            ...(dispose ? { dispose } : {}),
          });
        },
        subscribePanels(listener) {
          panelListeners.add(listener);
          return () => {
            panelListeners.delete(listener);
          };
        },
        loaded() {
          return [...mounted.values()].map((entry) => ({
            pluginId: entry.record.plugin.id,
            name: entry.record.plugin.name,
            version: entry.record.plugin.version,
            ...(entry.record.plugin.shellLayout
              ? { shellLayout: entry.record.plugin.shellLayout }
              : {}),
          }));
        },
        unload: async (pluginId) => {
          await unloadPlugin(pluginId);
        },
        load: async (plugin) => {
          await loadPlugin(plugin);
        },
      },
    };
  }

  const startRuntime = () => {
    if (started) return;
    started = true;
    options.runtime.start(fanout, { replay: options.replay ?? "all" });
  };

  async function loadPlugin(plugin: UiPlugin) {
    if (closed) throw new Error("ui plugin host is closed");
    if (mounted.has(plugin.id))
      throw new Error(`ui plugin already loaded: ${plugin.id}`);
    const ctx = ctxFor(plugin);
    const lifecycle = await plugin.mount(ctx);
    const record: LoadedUiPlugin = {
      plugin,
      panels: plugin.panels ?? [],
      commands: plugin.commands ?? [],
    };
    mounted.set(plugin.id, {
      record,
      ...(lifecycle ? { lifecycle } : {}),
    });
    for (const listener of panelListeners) listener();
    startRuntime();
    logger.info(`loaded ${plugin.id}@${plugin.version}`);
    return record;
  }

  /**
   * The panel rows the shell lists: mounted plugins' panels UNION the
   * armed catalog's (declared, not yet loaded) — the lazy listing.
   */
  function listPanelRows(): Array<{
    pluginId: string;
    panel: import("./protocol").UiPanelDefinition;
  }> {
    const rows = [...mounted.values()].flatMap((entry) =>
      entry.record.panels.map((panel) => ({
        pluginId: entry.record.plugin.id,
        panel,
      })),
    );
    const mountedKeys = new Set(
      rows.map((row) => `${row.pluginId}:${row.panel.id}`),
    );
    for (const [key, armed] of armedPanels) {
      if (mountedKeys.has(key)) continue;
      // An armed catalog row is metadata (the manifest's panel), and the
      // rail lists only panels it can mount — a metadata row would vanish
      // from it (exactly the bug this mount fixes). So the armed row
      // carries a REAL mount: load the bundle through the activation seam,
      // then delegate to the loaded panel's own mount. Listing a panel and
      // mounting it are separate acts; this makes the listed one mountable
      // without changing any consumer's filter.
      rows.push({
        pluginId: armed.pluginId,
        panel: {
          ...armed.panel,
          // The declared mount type is sync (a lifecycle), but a
          // load-then-delegate mount is async by nature — and every
          // caller awaits it (the host's own mountPanel does). The cast
          // states that contract instead of lying with a sync wrapper
          // that drops the ordering.
          mount: (async (
            ctx: import("./protocol").UiPluginContext,
            container: HTMLElement,
          ) => {
            await ensureLoaded(armed.pluginId);
            const entry = mounted.get(armed.pluginId);
            const panel = entry?.record.panels.find(
              (item) => item.id === armed.panel.id,
            );
            if (!panel?.mount)
              throw new Error(
                `ui panel has no mount: ${armed.pluginId}:${armed.panel.id}`,
              );
            return await panel.mount(ctx, container);
          }) as unknown as typeof armed.panel.mount,
        },
      });
    }
    return rows;
  }

  /** Arms the catalog's declared panels without loading any bundle. */
  async function armCatalogPanels(): Promise<number> {
    const catalog = (await options.runtime.pluginCatalog?.()) ?? [];
    armedPanels.clear();
    for (const entry of catalog) {
      if (!entry.enabled || !entry.installed) continue;
      for (const panel of entry.ui?.panels ?? [])
        armedPanels.set(`${entry.id}:${panel.id}`, {
          pluginId: entry.id,
          panel,
        });
    }
    for (const listener of panelListeners) listener();
    return armedPanels.size;
  }

  /** The activation event's answer: the seam loads, or nothing does. */
  async function ensureLoaded(pluginId: string): Promise<void> {
    if (mounted.get(pluginId) || !options.ensurePluginLoaded) return;
    await options.ensurePluginLoaded(pluginId);
  }

  return {
    projection,
    async load(plugin) {
      return await loadPlugin(plugin);
    },
    async unload(id) {
      await unloadPlugin(id);
    },
    loaded() {
      return [...mounted.values()].map((entry) => entry.record);
    },
    listPanels() {
      return listPanelRows();
    },
    armPanelsFromCatalog() {
      return armCatalogPanels();
    },
    async mountPanel(
      pluginId: string,
      panelId: string,
      container: HTMLElement,
    ): Promise<void> {
      // The mount is the activation event (spec §2.3 stage 2): load the
      // plugin through the seam, then proceed. Without the seam the loud
      // failure below stands — a silent no-op would hide the gap.
      await ensureLoaded(pluginId);
      const entry = mounted.get(pluginId);
      if (!entry) throw new Error(`ui plugin not loaded: ${pluginId}`);
      const panel = entry.record.panels.find((item) => item.id === panelId);
      if (!panel) throw new Error(`ui panel not found: ${pluginId}:${panelId}`);
      if (!panel.mount)
        throw new Error(`ui panel has no mount: ${pluginId}:${panelId}`);
      const key = `${pluginId}:${panelId}`;
      const existing = mountedPanels.get(key);
      existing?.dispose?.();
      existing?.lifecycle?.dispose?.();
      // The container is the host's element, and the shell re-mounts into the
      // SAME one on every activation. Disposing a panel unwires its listeners
      // and timers; it does not remove the DOM it appended, so without this a
      // re-mount stacks a second root inside the slot. The slot is a flex
      // column, so the panes then split the sidebar's height between them —
      // the field report was a terminal occupying exactly half of a 1193px
      // sidebar, the other half going to a stale copy that painted nothing.
      container.replaceChildren();
      const dispose = (await panel.mount(
        ctxFor(entry.record.plugin),
        container,
      )) as (() => void) | undefined;
      mountedPanels.set(key, {
        ...(dispose ? { dispose } : {}),
      });
      return;
    },
    subscribePanels(listener: () => void) {
      panelListeners.add(listener);
      return () => {
        panelListeners.delete(listener);
      };
    },
    async executeCommand(name, args) {
      for (const entry of mounted.values()) {
        const command = entry.record.commands.find((item) => item.id === name);
        if (command) return await command.run(args);
      }
      return executeRuntimeCommand(options.runtime, name, args);
    },
    async close() {
      if (closed) return;
      closed = true;
      const ids = [...mounted.keys()];
      const errors: unknown[] = [];
      for (const id of ids) {
        try {
          await unloadPlugin(id);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, "ui plugin host cleanup failed");
    },
  };

  async function unloadPlugin(id: string) {
    const entry = mounted.get(id);
    if (!entry) return;
    mounted.delete(id);
    // The panels this plugin mounted are keyed `${pluginId}:${panelId}`, and
    // nothing else removes them: `mountPanel` only disposes the previous panel
    // for the *same* key. Leaving them behind leaves the DOM, timers and
    // listeners a disposing plugin was supposed to release, and a later install
    // mounts a second copy beside the first.
    for (const [key, panel] of [...mountedPanels])
      if (key.startsWith(`${id}:`)) {
        mountedPanels.delete(key);
        panel.dispose?.();
        await panel.lifecycle?.dispose();
      }
    for (const [kind, owned] of [...presenters])
      if (owned.pluginId === id) presenters.delete(kind);
    for (const listener of panelListeners) listener();
    try {
      await entry.lifecycle?.dispose();
    } finally {
      await entry.record.plugin.unmount?.();
    }
    logger.info(`unloaded ${id}`);
  }
}

async function executeRuntimeCommand(
  runtime: RuntimeClient,
  name: string,
  args?: unknown,
): Promise<unknown> {
  if (name === "runtime.submit") return runtime.submit(String(args ?? ""));
  if (name === "runtime.chatSubmit") {
    if (!runtime.naviChat?.submit)
      throw new Error("runtime command execution unavailable");
    const text =
      typeof args === "object" && args && "text" in args
        ? String((args as { text: unknown }).text)
        : String(args ?? "");
    return runtime.naviChat.submit({ text });
  }
  if (name === "runtime.cancel") {
    runtime.cancel(typeof args === "string" ? args : undefined);
    return;
  }
  throw new Error(`command unavailable: ${name}`);
}
