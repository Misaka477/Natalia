import { createSignal, createEffect, For, Show, onCleanup } from "solid-js";
import type {
  RuntimeClient,
  RuntimeEvent,
  RuntimeNativeTerminalSession,
} from "@anthelia/contracts";
import { WebTerminal, type WebTerminalApi } from "./web-terminal";
import { reconcileTabs, sameTabs, type TerminalTab } from "./terminal-tabs";
import "./styles.css";

const MAX_TERMINALS_PER_SESSION = 8;

/**
 * The session the panes on screen belong to.
 *
 * A pane is attached to a session, not to whatever the projection says this
 * instant. The projection is briefly empty at several ordinary moments (a UI
 * host reload, a session-list refresh, the app finishing its boot), and the
 * panel used to answer that gap by clearing every tab: the xterm, its socket
 * and its scrollback die with the component, and the reload that follows is
 * what the user sees as "the terminal reloaded". Only a DIFFERENT session moves
 * the panes.
 */
type TerminalAttachment = { sessionID: string; runtimeURL: string };

function newTerminalID() {
  return `terminal_${crypto.randomUUID()}`;
}

function tabTitle(index: number) {
  return `终端 ${index + 1}`;
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
  } = {},
) {
  const [tabs, setTabs] = createSignal<TerminalTab[]>([]);
  const [activeID, setActiveID] = createSignal<string>();
  const [limitError, setLimitError] = createSignal<string>();
  const [sessions, setSessions] = createSignal<RuntimeNativeTerminalSession[]>(
    [],
  );
  const [attachment, setAttachment] = createSignal<TerminalAttachment>();
  const sessionID = () => attachment()?.sessionID;
  // The pane's shell is NOT this panel's decision, and there is deliberately no
  // control for it. A pane is started without naming a shell, and the host
  // picks the one it always has (PowerShell on Windows, bash on Linux, zsh on
  // macOS) through the platform's discovery — one place, platform-aware.
  //
  // The select that used to live here is why: its options were a POSIX-first
  // list (bash, zsh, sh, pwsh, powershell) and its value started empty, so the
  // DOM normalised the empty value to the FIRST option and the panel then sent
  // `command=bash` for every pane — on Windows, where the host had correctly
  // resolved pwsh. A control that both lies about the host and overrides the
  // discovery is worse than no control.
  const [searchQuery, setSearchQuery] = createSignal("");
  const terminalApis = new Map<string, WebTerminalApi>();
  const activeApi = () => terminalApis.get(activeID() ?? "");
  let loadToken = 0;
  // The session the tabs on screen were loaded for. Switching sessions rebuilds
  // them from that session's own pane list; staying on one keeps them.
  const [tabsSessionID, setTabsSessionID] = createSignal<string>();

  function ensureActive(next: TerminalTab[]) {
    const current = activeID();
    if (current && next.some((tab) => tab.cells.includes(current))) return;
    setActiveID(next[0]?.cells[0]);
  }

  /**
   * Reconciles the tabs against the backend's pane list BY PANE ID (the rules
   * live in terminal-tabs.ts), and writes the signal only when the list
   * actually moved: a tab whose panes are all still running is handed on as the
   * SAME object, so the xterm host is neither rebuilt nor reconnected.
   */
  async function loadTabs(forSessionID: string, restoreSaved = false) {
    const token = ++loadToken;
    const listed =
      (await props.runtime?.nativeTerminalList?.(
        forSessionID,
        // The FIRST load of a session is the one that may rebuild what the
        // runtime before this one left behind: `restoreSaved` starts the panes
        // that session had, with their ids and directories, so the tabs come
        // back instead of the panel inventing one empty terminal. Every later
        // load (an event, a reconcile) must never start anything.
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
    // The first load of a session is also the only one that asks the runtime to
    // restore that session's saved panes: a runtime that restarted has none, and
    // a runtime that still has them ignores the request (it is idempotent).
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
          (event.action === "started" || event.action === "exit")) ||
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
      setLimitError(`每个会话最多 ${MAX_TERMINALS_PER_SESSION} 个终端`);
      return;
    }
    const id = newTerminalID();
    setTabs([...tabs(), { id, cells: [id], layout: "horizontal" }]);
    setActiveID(id);
    setLimitError();
  }

  function splitActiveTab(direction: "vertical" | "horizontal") {
    const tab = tabs().find((item) => item.id === activeID());
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
              选择一个会话以打开交互式终端
            </div>
          </div>
        }
      >
        <div class="terminal-toolbar">
          <span
            class="terminal-owner-badge"
            data-owner={
              sessions().find((item) => item.id === activeID())?.inputOwner ??
              "model"
            }
          >
            {sessions().find((item) => item.id === activeID())?.inputOwner ===
            "human"
              ? "人工控制"
              : "模型控制"}
          </span>
          <Show
            when={
              sessions().find((item) => item.id === activeID())?.inputOwner ===
              "model"
            }
          >
            <button
              type="button"
              class="terminal-toolbar-btn"
              onClick={() => void claimActiveTerminal()}
              title="接管终端"
            >
              接管
            </button>
          </Show>
          <Show
            when={
              sessions().find((item) => item.id === activeID())?.inputOwner ===
              "human"
            }
          >
            <button
              type="button"
              class="terminal-toolbar-btn"
              onClick={() => void releaseActiveTerminal()}
              title="交还模型控制"
            >
              交还模型
            </button>
            <button
              type="button"
              class="terminal-toolbar-btn"
              onClick={() => void toggleSecureInput()}
              title={
                sessions().find((item) => item.id === activeID())?.secureInput
                  ? "结束安全输入"
                  : "开始安全输入"
              }
            >
              {sessions().find((item) => item.id === activeID())?.secureInput
                ? "结束安全输入"
                : "安全输入"}
            </button>
          </Show>
          <input
            class="terminal-search-input"
            value={searchQuery()}
            placeholder="搜索终端"
            onInput={(event) => setSearchQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") activeApi()?.findNext(searchQuery());
              if (event.key === "Escape") {
                setSearchQuery("");
                activeApi()?.findNext("");
              }
            }}
          />
          <button
            type="button"
            class="terminal-toolbar-btn"
            onClick={() => activeApi()?.findNext(searchQuery())}
            title="下一个匹配"
          >
            ↓
          </button>
          <button
            type="button"
            class="terminal-toolbar-btn"
            onClick={() => activeApi()?.findPrevious(searchQuery())}
            title="上一个匹配"
          >
            ↑
          </button>
          <button
            type="button"
            class="terminal-toolbar-btn"
            onClick={() => activeApi()?.reset()}
            title="刷新/重连当前终端"
          >
            刷新
          </button>
          <button
            type="button"
            class="terminal-toolbar-btn"
            onClick={() => activeApi()?.clear()}
            title="清空"
          >
            清空
          </button>
          <button
            type="button"
            class="terminal-toolbar-btn"
            onClick={() => void activeApi()?.copy()}
            title="复制"
          >
            复制
          </button>
          <button
            type="button"
            class="terminal-toolbar-btn"
            onClick={() => void activeApi()?.paste()}
            title="粘贴"
          >
            粘贴
          </button>
          <button
            type="button"
            class="terminal-toolbar-btn"
            onClick={() => activeApi()?.zoomOut()}
            title="缩小字体"
          >
            A-
          </button>
          <button
            type="button"
            class="terminal-toolbar-btn"
            onClick={() => activeApi()?.zoomIn()}
            title="放大字体"
          >
            A+
          </button>
          <button
            type="button"
            class="terminal-toolbar-btn"
            onClick={() => splitActiveTab("horizontal")}
            title="纵向分屏"
          >
            分屏↕
          </button>
          <button
            type="button"
            class="terminal-toolbar-btn"
            onClick={() => splitActiveTab("vertical")}
            title="横向分屏"
          >
            分屏↔
          </button>
        </div>
        <div class="terminal-tabs">
          <For each={tabs()}>
            {(tab, index) => (
              <button
                type="button"
                class="terminal-tab"
                data-active={
                  activeID() === tab.id || tab.cells.includes(activeID() ?? "")
                }
                onClick={() => setActiveID(tab.cells[0])}
              >
                <span class="terminal-tab-label">{tabTitle(index())}</span>
                <span
                  class="terminal-tab-close"
                  role="button"
                  aria-label={`关闭 ${tabTitle(index())}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void closeTab(tab.id);
                  }}
                >
                  ×
                </span>
              </button>
            )}
          </For>
          <button
            type="button"
            class="terminal-tab-add"
            title="新建终端"
            disabled={tabs().length >= MAX_TERMINALS_PER_SESSION}
            onClick={() => void addTab()}
          >
            +
          </button>
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
                        onClick={() => setActiveID(cellID)}
                      >
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
