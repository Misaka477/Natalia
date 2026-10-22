/** Topbar controller: the shell's header — brand, the view/search/settings
 * buttons, the view and more dropdowns, and the plugin panel mount slot.
 *
 * The markup moved verbatim from the shell; every value it reads arrives
 * through destructured props.
 */

import { For, Show } from "solid-js";
import type { LocaleRuntime } from "../locale/runtime";
import type { SlotsRegistry } from "../slots/registry";
import { SlotMount } from "../slots/mount";

export interface TopbarProps {
  t: (key: string, params?: Record<string, unknown>) => string;
  locale: LocaleRuntime;
  slots: SlotsRegistry;
  /** What the turn is doing now; undefined when idle. */
  runningLabel: () => string | undefined;
  /** The current session's name, for the session segment. */
  sessionLabel: () => string;
  /** Reveals the session list (the segment's one action). */
  onOpenSessions: () => void;
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
    t,
    locale,
    slots,
    runningLabel,
    sessionLabel,
    onOpenSessions,
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
        {/* A plugin entry, before the shell's brand block. */}
        <SlotMount slots={slots} name="topbar.start" t={t} />
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
        {/* The status segment: what the turn is doing now, always visible
            rather than only where the transcript happens to be scrolled. */}
        <Show when={runningLabel()}>
          {(label) => <span class="neu-topbar-status">{label()}</span>}
        </Show>
        {/* The session segment: which session this is, one click from the
            list. The tree is the switch surface; this is its door. */}
        <button
          type="button"
          class="neu-topbar-session"
          onClick={onOpenSessions}
          title={sessionLabel()}
        >
          {sessionLabel()}
        </button>
      </div>
      <div class="neu-topbar-right">
        {/* The rail toggles are direct buttons in the actions segment — the
          four-segment topbar keeps every action one click from the bar
          instead of behind a dropdown. */}
        <button
          type="button"
          class="neu-topbar-btn"
          data-active={leftVisible()}
          onClick={() => setLeftVisible((value) => !value)}
        >
          {t("topbar.left")}
        </button>
        <button
          type="button"
          class="neu-topbar-btn"
          data-active={rightVisible()}
          onClick={() => setRightVisible((value) => !value)}
        >
          {t("topbar.right")}
        </button>
        <Show when={layoutMode() === "tiny"}>
          <button
            type="button"
            class="neu-topbar-btn"
            data-active={naviOpen()}
            onClick={() => setNaviOpen((value) => !value)}
          >
            {t("topbar.navi")}
          </button>
        </Show>
        <button
          type="button"
          class="neu-topbar-btn"
          onClick={() => setSearchOpen(true)}
        >
          {t("topbar.search")}
        </button>
        <button
          type="button"
          class="neu-topbar-btn neu-topbar-btn-primary"
          onClick={() => setSettingsOpen(true)}
        >
          {t("topbar.settings")}
        </button>
        <button
          type="button"
          class="neu-topbar-btn"
          data-active={moreOpen()}
          onClick={() => setMoreOpen((value) => !value)}
        >
          {t("topbar.more")}
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
            {t("topbar.close")}
          </button>
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
            {t("common.status")}
          </button>
          <button
            type="button"
            class="neu-topbar-more-item"
            onClick={() => {
              setHelpOpen(true);
              setMoreOpen(false);
            }}
          >
            {t("common.help")}
          </button>
          <button
            type="button"
            class="neu-topbar-more-item"
            onClick={() => {
              setStashOpen(true);
              setMoreOpen(false);
            }}
          >
            {t("common.stash")}
          </button>
          <button
            type="button"
            class="neu-topbar-more-item"
            onClick={() => {
              setSandboxOpen(true);
              setMoreOpen(false);
            }}
          >
            {t("common.sandbox")}
          </button>
          <button
            type="button"
            class="neu-topbar-more-item"
            onClick={() => {
              setPluginManagerOpen(true);
              setMoreOpen(false);
            }}
          >
            {t("common.plugins")}
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
