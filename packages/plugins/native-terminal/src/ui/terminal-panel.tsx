import { createSignal, createEffect, For, Show, onCleanup } from "solid-js";
import type {
  RuntimeClient,
  RuntimeEvent,
  RuntimeNativeTerminalSession,
} from "@anthelia/contracts";
import { WebTerminal, type WebTerminalApi } from "./web-terminal";
import { reconcileTabs, sameTabs, type TerminalTab } from "./terminal-tabs";
import { bindTerminalLocale } from "./locales";
import "./styles.css";

const MAX_TERMINALS_PER_SESSION = 8;

type TerminalAttachment = { sessionID: string; runtimeURL: string };

function newTerminalID() {
  return `terminal_${crypto.randomUUID()}`;
}

export function TerminalPane(
  props: {
    runtime?: RuntimeClient;
    sessionID?: string;
    runtimeURL?: string;
    token?: string;
    active?: boolean;
    events?: {
      subscribe(listener: (event: RuntimeEvent) => void): () => void;
    };
    extra?: unknown;
  } = {},
) {
  const t = bindTerminalLocale(props.extra);
  const tabTitle = (index: number) => t("terminal.tabTitle", { n: index + 1 });
  const [tabs, setTabs] = createSignal<TerminalTab[]>([]);
  const [activeID, setActiveID] = createSignal<string>();
  const [limitError, setLimitError] = createSignal<string>();
  const [sessions, setSessions] = createSignal<RuntimeNativeTerminalSession[]>(
    [],
  );
  const [attachment, setAttachment] = createSignal<TerminalAttachment>();
  const sessionID = () => attachment()?.sessionID;
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const terminalApis = new Map<string, WebTerminalApi>();
  const activeApi = () => terminalApis.get(activeID() ?? "");
  let loadToken = 0;
  const [tabsSessionID, setTabsSessionID] = createSignal<string>();

  const activeSession = () => sessions().find((item) => item.id === activeID());
  const activeOwner = () => activeSession()?.inputOwner ?? "model";
  const isSecure = () => Boolean(activeSession()?.secureInput);

  function ensureActive(next: TerminalTab[]) {
    const current = activeID();
    if (current && next.some((tab) => tab.cells.includes(current))) return;
    setActiveID(next[0]?.cells[0]);
  }

  async function loadTabs(forSessionID: string, restoreSaved = false) {
    const token = ++loadToken;
    const listed =
      (await props.runtime?.nativeTerminalList?.(
        forSessionID,
        restoreSaved ? { restoreSaved: true } : undefined,
      )) ?? [];
    if (token !== loadToken) return;
    setSessions(listed);
    const running = listed.filter(
      (item) =>
        item.status === "running" &&
        (!item.sessionID || item.sessionID === forSessionID),
    );
    const sameSession = tabsSessionID() === forSessionID;
    const previous = sameSession ? tabs() : [];
    if (!sameSession) setTabsSessionID(forSessionID);
    const next = reconcileTabs({
      previous,
      running: running.map((item) => item.id),
      known: listed.map((item) => item.id),
      newPaneID: newTerminalID,
    });
    if (!sameTabs(next, previous)) setTabs(next);
    ensureActive(next);
    setLimitError();
  }

  createEffect(() => {
    const nextSessionID = props.sessionID;
    const runtimeURL = props.runtimeURL;
    if (!nextSessionID || !runtimeURL) return;
    const current = attachment();
    if (
      current &&
      current.sessionID === nextSessionID &&
      current.runtimeURL === runtimeURL
    )
      return;
    setAttachment({ sessionID: nextSessionID, runtimeURL });
    void loadTabs(nextSessionID, tabsSessionID() !== nextSessionID);
  });

  createEffect(() => {
    const events = props.events;
    if (!events) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = events.subscribe((event) => {
      const relevant =
        event.type === "terminal.update" ||
        (event.type === "terminal.action" &&
          (event.action === "started" ||
            event.action === "exit" ||
            event.action === "write" ||
            event.action === "detach" ||
            event.action === "secure_input")) ||
        (event.type === "terminal.timeline" &&
          (event.action === "started" || event.action === "exit"));
      if (!relevant) return;
      const current = attachment()?.sessionID;
      if (!current) return;
      if (event.sessionID && event.sessionID !== current) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (attachment()?.sessionID === current) void loadTabs(current);
      }, 50);
    });
    onCleanup(() => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    });
  });

  async function refreshSessions() {
    const current = sessionID();
    if (!current) return;
    const listed = (await props.runtime?.nativeTerminalList?.(current)) ?? [];
    setSessions(listed);
  }

  async function claimActiveTerminal() {
    const id = activeID();
    if (!id) return;
    try {
      await props.runtime?.nativeTerminalClaimHumanInput?.(id, sessionID());
      await refreshSessions();
    } catch {
      // optional method may not exist; leave current state
    }
  }

  async function releaseActiveTerminal() {
    const id = activeID();
    if (!id) return;
    try {
      await props.runtime?.nativeTerminalReleaseHumanControl?.(id, sessionID());
      await refreshSessions();
    } catch {
      // optional method may not exist; leave current state
    }
  }

  async function toggleSecureInput() {
    const id = activeID();
    if (!id) return;
    try {
      const session = sessions().find((item) => item.id === id);
      if (session?.secureInput)
        await props.runtime?.nativeTerminalEndSecureInput?.(id, sessionID());
      else
        await props.runtime?.nativeTerminalBeginSecureInput?.(id, sessionID());
      await refreshSessions();
    } catch {
      // optional method may not exist; leave current state
    }
  }

  async function addTab() {
    if (!sessionID()) return;
    if (tabs().length >= MAX_TERMINALS_PER_SESSION) {
      setLimitError(
        t("terminal.limitError", { max: MAX_TERMINALS_PER_SESSION }),
      );
      return;
    }
    const id = newTerminalID();
    setTabs([...tabs(), { id, cells: [id], layout: "horizontal" }]);
    setActiveID(id);
    setLimitError();
  }

  function splitActiveTab(direction: "vertical" | "horizontal") {
    const tab = tabs().find((item) => item.cells.includes(activeID() ?? ""));
    if (!tab) return;
    const id = newTerminalID();
    const next = tabs().map((item) =>
      item.id === tab.id
        ? {
            ...item,
            cells: [...item.cells, id],
            layout: direction,
          }
        : item,
    );
    setTabs(next);
    setActiveID(id);
    setLimitError();
  }

  async function closeTab(id: string) {
    let remaining = tabs().filter((tab) => tab.id !== id);
    if (!remaining.length) {
      const nextID = newTerminalID();
      remaining = [
        {
          id: nextID,
          cells: [nextID],
          layout: "horizontal",
        },
      ];
      setTabs(remaining);
      setActiveID(nextID);
    } else {
      setTabs(remaining);
      if (activeID() === id) setActiveID(remaining[0]?.cells[0]);
      else ensureActive(remaining);
    }
    setLimitError();
    if (!sessions().some((item) => item.id === id)) return;
    try {
      await props.runtime?.nativeTerminalStop?.(id, sessionID());
    } catch {
      // already exited
    }
  }

  function closeCell(tab: TerminalTab, cellID: string) {
    const remainingCells = tab.cells.filter((item) => item !== cellID);
    const next = tabs().map((item) =>
      item.id === tab.id
        ? {
            ...item,
            cells: remainingCells.length ? remainingCells : [newTerminalID()],
            layout: "horizontal" as const,
          }
        : item,
    );
    setTabs(next);
    ensureActive(next);
    if (!sessions().some((item) => item.id === cellID)) return;
    void props.runtime
      ?.nativeTerminalStop?.(cellID, sessionID())
      .catch(() => undefined);
  }

  return (
    <div class="terminal-pane">
      <Show
        when={attachment()}
        fallback={
          <div class="terminal-output">
            <div class="terminal-line terminal-line-header">
              {t("terminal.selectSession")}
            </div>
          </div>
        }
      >
        {/* Row 1: Unified Tab strip + compact icon actions */}
        <div class="terminal-top-bar">
          <div class="terminal-tabs">
            <For each={tabs()}>
              {(tab, index) => {
                const isTabActive = () =>
                  activeID() === tab.id || tab.cells.includes(activeID() ?? "");
                const tabSession = () =>
                  sessions().find((s) => s.id === tab.cells[0]);
                return (
                  <button
                    type="button"
                    class="terminal-tab"
                    data-active={isTabActive()}
                    onClick={() => setActiveID(tab.cells[0])}
                  >
                    <span
                      class="terminal-tab-dot"
                      data-owner={tabSession()?.inputOwner ?? "model"}
                    />
                    <span class="terminal-tab-label">{tabTitle(index())}</span>
                    <Show when={tab.cells.length > 1}>
                      <span class="terminal-tab-split-count">
                        ×{tab.cells.length}
                      </span>
                    </Show>
                    <span
                      class="terminal-tab-close"
                      role="button"
                      aria-label={t("terminal.closeTab", {
                        title: tabTitle(index()),
                      })}
                      onClick={(event) => {
                        event.stopPropagation();
                        void closeTab(tab.id);
                      }}
                    >
                      ×
                    </span>
                  </button>
                );
              }}
            </For>
            <button
              type="button"
              class="terminal-tab-add"
              title={t("terminal.newTab")}
              disabled={tabs().length >= MAX_TERMINALS_PER_SESSION}
              onClick={() => void addTab()}
            >
              +
            </button>
          </div>

          <div class="terminal-quick-actions">
            <button
              type="button"
              class="terminal-icon-btn"
              data-active={searchOpen()}
              onClick={() => setSearchOpen((v) => !v)}
              title={t("terminal.searchToggle")}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
              >
                <circle cx="6.8" cy="6.8" r="4.8" />
                <path d="M10.4 10.4L14 14" />
              </svg>
            </button>
            <button
              type="button"
              class="terminal-icon-btn"
              onClick={() => splitActiveTab("vertical")}
              title={t("terminal.splitHorizontalTitle")}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
              >
                <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
                <path d="M8 2.5V13.5" />
              </svg>
            </button>
            <button
              type="button"
              class="terminal-icon-btn"
              onClick={() => splitActiveTab("horizontal")}
              title={t("terminal.splitVerticalTitle")}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
              >
                <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
                <path d="M1.5 8H14.5" />
              </svg>
            </button>
            <button
              type="button"
              class="terminal-icon-btn"
              onClick={() => activeApi()?.zoomOut()}
              title={t("terminal.zoomOut")}
            >
              A-
            </button>
            <button
              type="button"
              class="terminal-icon-btn"
              onClick={() => activeApi()?.zoomIn()}
              title={t("terminal.zoomIn")}
            >
              A+
            </button>
            <button
              type="button"
              class="terminal-icon-btn"
              onClick={() => void activeApi()?.copy()}
              title={t("terminal.copy")}
            >
              {t("terminal.copy")}
            </button>
            <button
              type="button"
              class="terminal-icon-btn"
              onClick={() => void activeApi()?.paste()}
              title={t("terminal.paste")}
            >
              {t("terminal.paste")}
            </button>
            <button
              type="button"
              class="terminal-icon-btn"
              onClick={() => activeApi()?.clear()}
              title={t("terminal.clear")}
            >
              {t("terminal.clear")}
            </button>
            <button
              type="button"
              class="terminal-icon-btn"
              onClick={() => activeApi()?.reset()}
              title={t("terminal.refreshTitle")}
            >
              ↻
            </button>
          </div>
        </div>

        {/* Collapsible search bar */}
        <Show when={searchOpen()}>
          <div class="terminal-search-bar">
            <input
              class="terminal-search-input"
              value={searchQuery()}
              placeholder={t("terminal.searchPlaceholder")}
              autofocus
              onInput={(event) => {
                setSearchQuery(event.currentTarget.value);
                activeApi()?.findNext(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  if (event.shiftKey) activeApi()?.findPrevious(searchQuery());
                  else activeApi()?.findNext(searchQuery());
                }
                if (event.key === "Escape") {
                  setSearchQuery("");
                  setSearchOpen(false);
                }
              }}
            />
            <button
              type="button"
              class="terminal-icon-btn"
              onClick={() => activeApi()?.findPrevious(searchQuery())}
              title={t("terminal.prevMatch")}
            >
              ↑
            </button>
            <button
              type="button"
              class="terminal-icon-btn"
              onClick={() => activeApi()?.findNext(searchQuery())}
              title={t("terminal.nextMatch")}
            >
              ↓
            </button>
            <button
              type="button"
              class="terminal-icon-btn"
              onClick={() => {
                setSearchQuery("");
                setSearchOpen(false);
              }}
            >
              ×
            </button>
          </div>
        </Show>

        {/* Row 2: Human-AI Collaboration Status & Control Banner */}
        <div
          class="terminal-collab-bar"
          data-owner={activeOwner()}
          data-secure={isSecure()}
        >
          <div class="terminal-collab-info">
            <span
              class="terminal-owner-badge"
              data-owner={activeOwner()}
              data-secure={isSecure()}
            >
              {activeOwner() === "human"
                ? t("terminal.ownerHuman")
                : t("terminal.ownerModel")}
            </span>
            <span class="terminal-collab-hint">
              {isSecure()
                ? t("terminal.bannerSecure")
                : activeOwner() === "human"
                  ? t("terminal.bannerHuman")
                  : t("terminal.bannerModel")}
            </span>
          </div>
          <div class="terminal-collab-actions">
            <Show when={activeOwner() === "model"}>
              <button
                type="button"
                class="terminal-collab-btn terminal-collab-primary"
                onClick={() => void claimActiveTerminal()}
                title={t("terminal.takeoverTitle")}
              >
                {t("terminal.takeover")}
              </button>
            </Show>
            <Show when={activeOwner() === "human"}>
              <button
                type="button"
                class="terminal-collab-btn"
                data-active={isSecure()}
                onClick={() => void toggleSecureInput()}
                title={
                  isSecure()
                    ? t("terminal.secureEndTitle")
                    : t("terminal.secureStartTitle")
                }
              >
                {isSecure()
                  ? t("terminal.secureEnd")
                  : t("terminal.secureStart")}
              </button>
              <button
                type="button"
                class="terminal-collab-btn terminal-collab-primary"
                disabled={isSecure()}
                onClick={() => void releaseActiveTerminal()}
                title={t("terminal.releaseTitle")}
              >
                {t("terminal.release")}
              </button>
            </Show>
          </div>
        </div>

        <Show when={limitError()}>
          <div class="terminal-limit-error">{limitError()}</div>
        </Show>
        <div class="terminal-xterm-stack">
          <For each={tabs()}>
            {(tab) => (
              <div
                class="terminal-xterm-host"
                data-active={tab.cells.includes(activeID() ?? "")}
                style={{
                  display: tab.cells.includes(activeID() ?? "")
                    ? "flex"
                    : "none",
                }}
              >
                <div
                  class="terminal-split-stack"
                  style={{
                    "flex-direction":
                      tab.layout === "vertical" ? "row" : "column",
                  }}
                >
                  <For each={tab.cells}>
                    {(cellID) => (
                      <div
                        class="terminal-split-cell"
                        data-active={activeID() === cellID}
                        data-multi={tab.cells.length > 1}
                        onClick={() => setActiveID(cellID)}
                      >
                        <Show when={tab.cells.length > 1}>
                          <button
                            type="button"
                            class="terminal-split-close"
                            title={t("terminal.closeSplit")}
                            aria-label={t("terminal.closeSplit")}
                            onClick={(event) => {
                              event.stopPropagation();
                              closeCell(tab, cellID);
                            }}
                          >
                            ×
                          </button>
                        </Show>
                        <WebTerminal
                          sessionID={sessionID()!}
                          terminalID={cellID}
                          runtimeURL={attachment()?.runtimeURL ?? ""}
                          token={props.token}
                          active={props.active && activeID() === cellID}
                          registerApi={(api) => {
                            if (api) terminalApis.set(cellID, api);
                            else terminalApis.delete(cellID);
                          }}
                        />
                      </div>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
