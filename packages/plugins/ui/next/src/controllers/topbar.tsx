/** Topbar controller: the shell's header — brand, the view/search/settings
 * buttons, the view and more dropdowns, and the plugin panel mount slot.
 *
 * The markup moved verbatim from the shell; every value it reads arrives
 * through destructured props.
 */

import { For, Show } from "solid-js";

export interface TopbarProps {
  viewOpen: () => boolean;
  setViewOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  setSearchOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  setSettingsOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  moreOpen: () => boolean;
  setMoreOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  topbarPanel: () => any;
  topbarPanelRef: (element: HTMLDivElement) => void;
  setTopbarPanel: (value: any) => void;
  leftVisible: () => boolean;
  setLeftVisible: (value: boolean | ((prev: boolean) => boolean)) => void;
  rightVisible: () => boolean;
  setRightVisible: (value: boolean | ((prev: boolean) => boolean)) => void;
  layoutMode: () => "wide" | "compact" | "tiny";
  naviOpen: () => boolean;
  setNaviOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  setStatusOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  setHelpOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  setStashOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  setSandboxOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  setPluginManagerOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  groupedTopbarPanels: () => [string, any[]][];
  mountTopbarPanel: (panel: any) => void;
}

/** The shell header. */
export function Topbar(props: TopbarProps) {
  const {
    viewOpen,
    setViewOpen,
    setSearchOpen,
    setSettingsOpen,
    moreOpen,
    setMoreOpen,
    topbarPanel,
    topbarPanelRef,
    setTopbarPanel,
    leftVisible,
    setLeftVisible,
    rightVisible,
    setRightVisible,
    layoutMode,
    naviOpen,
    setNaviOpen,
    setStatusOpen,
    setHelpOpen,
    setStashOpen,
    setSandboxOpen,
    setPluginManagerOpen,
    groupedTopbarPanels,
    mountTopbarPanel,
  } = props;
  return (
    <header class="neu-topbar">
      <div class="neu-topbar-left">
        {/* The app's own mark, not a letter. `/brand.png` is the shell's
              stable copy — generated from `assets/source/natalia-icon.svg` by
              `scripts/build-app-icons.ts` into `apps/web/public/`, which Vite
              copies verbatim. Root-relative because this UI ships as a plugin
              bundle served by the runtime from a different origin, so neither
              a hashed asset name nor a bundle-relative path would resolve. */}
        <img class="neu-topbar-logo" src="/brand.png" alt="Natalia" />
        <div class="neu-topbar-meta">
          <span class="neu-topbar-title">Natalia</span>
          <span class="neu-topbar-sub">
            The world is not beautiful; therefore it is.
          </span>
        </div>
      </div>
      <div class="neu-topbar-right">
        <button
          type="button"
          class="neu-topbar-btn"
          data-active={viewOpen()}
          onClick={() => setViewOpen((value) => !value)}
        >
          视图
        </button>
        <button
          type="button"
          class="neu-topbar-btn"
          onClick={() => setSearchOpen(true)}
        >
          搜索
        </button>
        <button
          type="button"
          class="neu-topbar-btn neu-topbar-btn-primary"
          onClick={() => setSettingsOpen(true)}
        >
          设置
        </button>
        <button
          type="button"
          class="neu-topbar-btn"
          data-active={moreOpen()}
          onClick={() => setMoreOpen((value) => !value)}
        >
          更多
        </button>
      </div>
      <Show when={topbarPanel()}>
        <div class="neu-topbar-panel-dropdown">
          <div class="neu-topbar-panel-content" ref={topbarPanelRef} />
          <button
            type="button"
            class="neu-topbar-panel-close"
            onClick={() => setTopbarPanel(null)}
          >
            关闭
          </button>
        </div>
      </Show>
      <Show when={viewOpen()}>
        <div class="neu-topbar-view-dropdown">
          <button
            type="button"
            class="neu-topbar-more-item"
            data-active={leftVisible()}
            onClick={() => {
              setLeftVisible((value) => !value);
              setViewOpen(false);
            }}
          >
            左栏
          </button>
          <button
            type="button"
            class="neu-topbar-more-item"
            data-active={rightVisible()}
            onClick={() => {
              setRightVisible((value) => !value);
              setViewOpen(false);
            }}
          >
            右栏
          </button>
          <Show when={layoutMode() === "tiny"}>
            <button
              type="button"
              class="neu-topbar-more-item"
              data-active={naviOpen()}
              onClick={() => {
                setNaviOpen((value) => !value);
                setViewOpen(false);
              }}
            >
              Navi
            </button>
          </Show>
        </div>
      </Show>
      <Show when={moreOpen()}>
        <div class="neu-topbar-more-dropdown">
          <button
            type="button"
            class="neu-topbar-more-item"
            onClick={() => {
              setStatusOpen(true);
              setMoreOpen(false);
            }}
          >
            状态
          </button>
          <button
            type="button"
            class="neu-topbar-more-item"
            onClick={() => {
              setHelpOpen(true);
              setMoreOpen(false);
            }}
          >
            帮助
          </button>
          <button
            type="button"
            class="neu-topbar-more-item"
            onClick={() => {
              setStashOpen(true);
              setMoreOpen(false);
            }}
          >
            暂存
          </button>
          <button
            type="button"
            class="neu-topbar-more-item"
            onClick={() => {
              setSandboxOpen(true);
              setMoreOpen(false);
            }}
          >
            沙箱
          </button>
          <button
            type="button"
            class="neu-topbar-more-item"
            onClick={() => {
              setPluginManagerOpen(true);
              setMoreOpen(false);
            }}
          >
            插件
          </button>
          <div class="neu-topbar-more-separator" />
          <For each={groupedTopbarPanels()}>
            {([group, panels]) => (
              <div class="neu-topbar-more-group">
                <span class="neu-topbar-group-label">{group}</span>
                <For each={panels}>
                  {(panel) => (
                    <button
                      type="button"
                      class="neu-topbar-more-item"
                      onClick={() => {
                        mountTopbarPanel(panel);
                        setMoreOpen(false);
                      }}
                    >
                      {panel.panel.title}
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>
    </header>
  );
}
