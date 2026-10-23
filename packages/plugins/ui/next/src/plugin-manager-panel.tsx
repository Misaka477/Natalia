import styles from "./styles/plugin-manager-panel.module.css";
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
  t: (key: string, params?: Record<string, unknown>) => string;
  open: boolean;
  onClose: () => void;
  ctx: UiPluginContext;
}) {
  const t = props.t;
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
            class={styles.confirmBox}
            onClick={(event) => event.stopPropagation()}
          >
            <div class="neu-confirm-title">{t("pluginMgr.confirmTitle")}</div>
            <div class={styles.confirmText}>
              {t("pluginMgr.confirmBody", { name: confirmUninstall()!.name })}
            </div>
            <div class="neu-confirm-actions">
              <button
                type="button"
                class={styles.btn}
                onClick={() => setConfirmUninstall(null)}
              >
                {t("pluginMgr.cancel")}
              </button>
              <button
                type="button"
                class={`${styles.btn} ${styles.confirmDanger}`}
                onClick={() => void uninstallRuntime(confirmUninstall()!.id)}
              >
                {t("pluginMgr.confirm")}
              </button>
            </div>
          </div>
        </div>
      </Show>
      <div class="neu-settings-backdrop" onClick={props.onClose}>
        <div class={styles.window} onClick={(event) => event.stopPropagation()}>
          <div class="neu-settings-header">
            <span class="neu-settings-title">{t("pluginMgr.title")}</span>
            <button
              type="button"
              class="neu-settings-close"
              onClick={props.onClose}
              aria-label={t("pluginMgr.closeAria")}
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
          <div class={styles.body}>
            <Show when={error()}>
              <div class={styles.error}>{error()}</div>
            </Show>
            <div class={styles.install}>
              <input
                class={styles.input}
                placeholder="npm package spec, e.g. @natalia/plugin-xxx"
                value={installSpec()}
                onInput={(event) => setInstallSpec(event.currentTarget.value)}
              />
              <button
                type="button"
                class={styles.btn}
                onClick={() => void installRuntime()}
              >
                {t("pluginMgr.install")}
              </button>
            </div>
            <div class={styles.sectionTitle}>{t("pluginMgr.uiPlugins")}</div>
            <Show
              when={uiRegistry().length || uiPlugins().length}
              fallback={
                <div class={styles.empty}>{t("pluginMgr.noUiPlugins")}</div>
              }
            >
              <For each={uiRegistry()}>
                {(entry) => {
                  const loaded = uiPlugins().some(
                    (plugin) => plugin.pluginId === entry.id,
                  );
                  return (
                    <div class={styles.row}>
                      <div class={styles.main}>
                        <span class={styles.name}>{entry.name}</span>
                        <span class={styles.meta}>
                          {entry.id} · {entry.version}
                        </span>
                      </div>
                      <label class={styles.switch}>
                        <input
                          type="checkbox"
                          checked={loaded}
                          onChange={(event) => {
                            if (event.currentTarget.checked)
                              void enableUi(entry);
                            else void disableUi(entry.id);
                          }}
                        />
                        <span class={styles.switchTrack}>
                          <span class={styles.switchThumb} />
                        </span>
                      </label>
                    </div>
                  );
                }}
              </For>
            </Show>
            <div class={styles.sectionTitle}>
              {t("pluginMgr.runtimePlugins")}
            </div>
            <Show
              when={runtimeCatalog().length}
              fallback={
                <div class={styles.empty}>
                  {t("pluginMgr.noRuntimePlugins")}
                </div>
              }
            >
              <For each={runtimeCatalog()}>
                {(plugin) => (
                  <div class={styles.row}>
                    <div class={styles.main}>
                      <span class={styles.name}>{plugin.name}</span>
                      <span class={styles.meta}>
                        {plugin.id}
                        {plugin.version ? ` · ${plugin.version}` : ""}
                      </span>
                    </div>
                    <button
                      type="button"
                      class={styles.btn}
                      onClick={() => requestUninstall(plugin.id, plugin.name)}
                    >
                      {t("pluginMgr.uninstall")}
                    </button>
                    <label class={styles.switch}>
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
                      <span class={styles.switchTrack}>
                        <span class={styles.switchThumb} />
                      </span>
                    </label>
                    <button
                      type="button"
                      class={styles.btn}
                      onClick={() => void reloadRuntime(plugin.id)}
                    >
                      {t("pluginMgr.reload")}
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
