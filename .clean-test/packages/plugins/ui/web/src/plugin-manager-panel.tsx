import { createSignal, For, Show, onMount } from "solid-js";
import type { PluginStatus } from "@anthelia/contracts";
import type { UiPlugin, UiPluginContext } from "@natalia/ui-host";

type UiPluginView = {
  pluginId: string;
  name: string;
  version: string;
};

type UiRegistryEntry = {
  id: string;
  name: string;
  version: string;
  create: () => UiPlugin;
};

export function PluginManagerPanel(props: {
  open: boolean;
  onClose: () => void;
  ctx: UiPluginContext;
}) {
  const [runtimePlugins, setRuntimePlugins] = createSignal<PluginStatus[]>([]);
  const [runtimeCatalog, setRuntimeCatalog] = createSignal<
    Array<{
      id: string;
      name: string;
      version: string;
      enabled?: boolean;
    }>
  >([]);
  const [uiPlugins, setUiPlugins] = createSignal<UiPluginView[]>([]);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [installSpec, setInstallSpec] = createSignal("");
  const [confirmUninstall, setConfirmUninstall] = createSignal<{
    id: string;
    name: string;
  } | null>(null);
  const uiRegistry = (): UiRegistryEntry[] =>
    (props.ctx.extra as { uiPluginRegistry?: UiRegistryEntry[] } | undefined)
      ?.uiPluginRegistry ?? [];
  const syncPluginUis = () =>
    (
      props.ctx.extra as
        | { syncPluginUiBundles?: () => Promise<void> }
        | undefined
    )?.syncPluginUiBundles?.();
  const [enabledMap, setEnabledMap] = createSignal<Record<string, boolean>>({});

  async function enableUi(entry: UiRegistryEntry) {
    try {
      await props.ctx.host?.load(entry.create());
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function disableUi(pluginId: string) {
    try {
      await props.ctx.host?.unload(pluginId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function refresh() {
    setError(undefined);
    try {
      const runtime = (await props.ctx.runtime.plugins?.()) ?? [];
      const catalog = (await props.ctx.runtime.pluginCatalog?.()) ?? [];
      const ui = props.ctx.host?.loaded() ?? [];
      setRuntimePlugins(runtime);
      setRuntimeCatalog(
        catalog.map((plugin) => ({
          id: plugin.id,
          name: plugin.name ?? plugin.id,
          version: plugin.version,
          enabled: plugin.enabled,
        })),
      );
      setUiPlugins(ui);
      setEnabledMap((prev) => {
        const next = { ...prev };
        for (const plugin of catalog) {
          next[plugin.id] = plugin.enabled;
        }
        return next;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  onMount(() => {
    void refresh();
  });

  async function installRuntime() {
    const spec = installSpec().trim();
    if (!spec) return;
    try {
      await props.ctx.runtime.pluginInstall?.({ spec });
      setInstallSpec("");
      await refresh();
      await syncPluginUis();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function requestUninstall(id: string, name: string) {
    setConfirmUninstall({ id, name });
  }

  async function uninstallRuntime(id: string) {
    try {
      await props.ctx.runtime.pluginUninstall?.({ pluginID: id });
      await refresh();
      await syncPluginUis();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConfirmUninstall(null);
    }
  }

  async function setEnabled(id: string, enabled: boolean) {
    try {
      await props.ctx.runtime.pluginSetEnabled?.({ pluginID: id, enabled });
      await refresh();
      await syncPluginUis();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function unloadRuntime(id: string) {
    try {
      await props.ctx.runtime.pluginUnload?.(id);
      await refresh();
      await syncPluginUis();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function reloadRuntime(id: string) {
    try {
      await props.ctx.runtime.pluginReload?.(id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function unloadUi(pluginId: string) {
    try {
      await props.ctx.host?.unload?.(pluginId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <Show when={props.open}>
      <Show when={confirmUninstall()}>
        <div
          class="neu-confirm-backdrop"
          onClick={() => setConfirmUninstall(null)}
        >
          <div
            class="neu-confirm-box"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="neu-confirm-title">确认卸载</div>
            <div class="neu-confirm-text">
              确定要卸载 <strong>{confirmUninstall()!.name}</strong> 吗？
            </div>
            <div class="neu-confirm-actions">
              <button
                type="button"
                class="neu-plugin-btn"
                onClick={() => setConfirmUninstall(null)}
              >
                取消
              </button>
              <button
                type="button"
                class="neu-plugin-btn neu-confirm-danger"
                onClick={() => void uninstallRuntime(confirmUninstall()!.id)}
              >
                确认卸载
              </button>
            </div>
          </div>
        </div>
      </Show>
      <div class="neu-settings-backdrop" onClick={props.onClose}>
        <div
          class="neu-plugin-window"
          onClick={(event) => event.stopPropagation()}
        >
          <div class="neu-settings-header">
            <span class="neu-settings-title">插件管理</span>
            <button
              type="button"
              class="neu-settings-close"
              onClick={props.onClose}
              aria-label="关闭插件管理"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M3 3l10 10M13 3L3 13"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </div>
          <div class="neu-plugin-body">
            <Show when={error()}>
              <div class="neu-plugin-error">{error()}</div>
            </Show>
            <div class="neu-plugin-install">
              <input
                class="neu-plugin-input"
                placeholder="npm package spec, e.g. @natalia/plugin-xxx"
                value={installSpec()}
                onInput={(event) => setInstallSpec(event.currentTarget.value)}
              />
              <button
                type="button"
                class="neu-plugin-btn"
                onClick={() => void installRuntime()}
              >
                安装
              </button>
            </div>
            <div class="neu-plugin-section-title">UI 插件</div>
            <Show
              when={uiRegistry().length || uiPlugins().length}
              fallback={
                <div class="neu-plugin-empty">没有已加载的 UI 插件</div>
              }
            >
              <For each={uiRegistry()}>
                {(entry) => {
                  const loaded = uiPlugins().some(
                    (plugin) => plugin.pluginId === entry.id,
                  );
                  return (
                    <div class="neu-plugin-row">
                      <div class="neu-plugin-main">
                        <span class="neu-plugin-name">{entry.name}</span>
                        <span class="neu-plugin-meta">
                          {entry.id} · {entry.version}
                        </span>
                      </div>
                      <label class="neu-plugin-switch">
                        <input
                          type="checkbox"
                          checked={loaded}
                          onChange={(event) => {
                            if (event.currentTarget.checked)
                              void enableUi(entry);
                            else void disableUi(entry.id);
                          }}
                        />
                        <span class="neu-plugin-switch-track">
                          <span class="neu-plugin-switch-thumb" />
                        </span>
                      </label>
                    </div>
                  );
                }}
              </For>
            </Show>
            <div class="neu-plugin-section-title">运行时插件</div>
            <Show
              when={runtimeCatalog().length}
              fallback={<div class="neu-plugin-empty">没有运行时插件</div>}
            >
              <For each={runtimeCatalog()}>
                {(plugin) => (
                  <div class="neu-plugin-row">
                    <div class="neu-plugin-main">
                      <span class="neu-plugin-name">{plugin.name}</span>
                      <span class="neu-plugin-meta">
                        {plugin.id}
                        {plugin.version ? ` · ${plugin.version}` : ""}
                      </span>
                    </div>
                    <button
                      type="button"
                      class="neu-plugin-btn"
                      onClick={() => requestUninstall(plugin.id, plugin.name)}
                    >
                      卸载
                    </button>
                    <label class="neu-plugin-switch">
                      <input
                        type="checkbox"
                        checked={enabledMap()[plugin.id] ?? true}
                        onChange={(event) => {
                          const next = event.currentTarget.checked;
                          setEnabledMap((prev) => ({
                            ...prev,
                            [plugin.id]: next,
                          }));
                          void setEnabled(plugin.id, next);
                        }}
                      />
                      <span class="neu-plugin-switch-track">
                        <span class="neu-plugin-switch-thumb" />
                      </span>
                    </label>
                    <button
                      type="button"
                      class="neu-plugin-btn"
                      onClick={() => void reloadRuntime(plugin.id)}
                    >
                      重新加载
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
