import { createSignal, createEffect, For, Show, onCleanup } from "solid-js";
import type {
  RuntimeClient,
  RuntimeEvent,
  RuntimeNativeTerminalSession,
} from "@anthelia/contracts";
import { WebTerminal, type WebTerminalApi } from "./web-terminal";
import "./styles.css";

const MAX_TERMINALS_PER_SESSION = 8;

type TerminalTab = {
  id: string;
  title: string;
  cells: string[];
  layout: "vertical" | "horizontal";
};

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
  const [shellProfile, setShellProfile] = createSignal("bash");
  const [searchQuery, setSearchQuery] = createSignal("");
  const terminalApis = new Map<string, WebTerminalApi>();
  const activeApi = () => terminalApis.get(activeID() ?? "");
  let loadToken = 0;

  function retitle(next: TerminalTab[]) {
    return next.map((tab, index) => ({ ...tab, title: tabTitle(index) }));
  }

  async function loadTabs(sessionID: string) {
    const token = ++loadToken;
    const listed = (await props.runtime?.nativeTerminalList?.(sessionID)) ?? [];
    if (token !== loadToken) return;
    setSessions(listed);
    const running = listed.filter(
      (item) =>
        item.status === "running" &&
        (!item.sessionID || item.sessionID === sessionID),
    );
    if (!running.length) {
      const id = newTerminalID();
      setTabs([{ id, title: tabTitle(0), cells: [id], layout: "horizontal" }]);
      setActiveID(id);
      setLimitError();
      return;
    }
    const next = retitle(
      running.map((item) => ({
        id: item.id,
        title: "",
        cells: [item.id],
        layout: "horizontal" as const,
      })),
    );
    setTabs(next);
    const current = activeID();
    setActiveID(
      current && next.some((tab) => tab.id === current) ? current : next[0]?.id,
    );
    setLimitError();
  }

  createEffect((previous?: string) => {
    const sessionID = props.sessionID;
    const runtimeURL = props.runtimeURL;
    const key = `${sessionID ?? ""}\0${runtimeURL ?? ""}`;
    if (!sessionID || !runtimeURL) {
      setTabs([]);
      setActiveID();
      setLimitError();
      return key;
    }
    if (previous === key) return key;
    void loadTabs(sessionID);
    return key;
  });

  createEffect(() => {
    const events = props.events;
    const sessionID = props.sessionID;
    if (!events || !sessionID) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = events.subscribe((event) => {
      const relevant =
        event.type === "terminal.update" ||
        (event.type === "terminal.action" &&
          (event.action === "started" || event.action === "exit")) ||
        (event.type === "terminal.timeline" &&
          (event.action === "started" || event.action === "exit"));
      if (!relevant) return;
      if (sessionID && event.sessionID && event.sessionID !== sessionID) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (sessionID) void loadTabs(sessionID);
      }, 50);
    });
    onCleanup(() => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    });
  });

  async function refreshSessions() {
    const listed =
      (await props.runtime?.nativeTerminalList?.(props.sessionID)) ?? [];
    setSessions(listed);
  }

  async function claimActiveTerminal() {
    const id = activeID();
    if (!id) return;
    try {
      await props.runtime?.nativeTerminalClaimHumanInput?.(id, props.sessionID);
      await refreshSessions();
    } catch {
      // optional method may not exist; leave current state
    }
  }

  async function releaseActiveTerminal() {
    const id = activeID();
    if (!id) return;
    try {
      await props.runtime?.nativeTerminalReleaseHumanControl?.(
        id,
        props.sessionID,
      );
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
        await props.runtime?.nativeTerminalEndSecureInput?.(
          id,
          props.sessionID,
        );
      else
        await props.runtime?.nativeTerminalBeginSecureInput?.(
          id,
          props.sessionID,
        );
      await refreshSessions();
    } catch {
      // optional method may not exist; leave current state
    }
  }

  async function addTab() {
    if (!props.sessionID) return;
    if (tabs().length >= MAX_TERMINALS_PER_SESSION) {
      setLimitError(`每个会话最多 ${MAX_TERMINALS_PER_SESSION} 个终端`);
      return;
    }
    const id = newTerminalID();
    const next = retitle([
      ...tabs(),
      { id, title: "", cells: [id], layout: "horizontal" },
    ]);
    setTabs(next);
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
          title: tabTitle(0),
          cells: [nextID],
          layout: "horizontal",
        },
      ];
      setTabs(remaining);
      setActiveID(nextID);
    } else {
      setTabs(retitle(remaining));
      if (
        activeID() === id ||
        !remaining.some((tab) => tab.cells.includes(activeID() ?? ""))
      )
        setActiveID(remaining[0]?.cells[0]);
    }
    setLimitError();
    try {
      await props.runtime?.nativeTerminalStop?.(id, props.sessionID);
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
    if (activeID() === cellID) {
      const replaced = next.find((item) => item.id === tab.id)!;
      setActiveID(replaced.cells[0]);
    }
    void props.runtime
      ?.nativeTerminalStop?.(cellID, props.sessionID)
      .catch(() => undefined);
  }

  return (
    <div class="terminal-pane">
      <Show
        when={props.sessionID && props.runtimeURL}
        fallback={
          <div class="terminal-output">
            <div class="terminal-line terminal-line-header">
              选择一个会话以打开交互式终端
            </div>
          </div>
        }
      >
        <div class="terminal-toolbar">
          <select
            class="neu-form-input terminal-profile-select"
            value={shellProfile()}
            onChange={(event) => setShellProfile(event.currentTarget.value)}
          >
            <option value="bash">bash</option>
            <option value="zsh">zsh</option>
            <option value="sh">sh</option>
            <option value="pwsh">pwsh</option>
          </select>
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
            {(tab) => (
              <button
                type="button"
                class="terminal-tab"
                data-active={
                  activeID() === tab.id || tab.cells.includes(activeID() ?? "")
                }
                onClick={() => setActiveID(tab.cells[0])}
              >
                <span class="terminal-tab-label">{tab.title}</span>
                <span
                  class="terminal-tab-close"
                  role="button"
                  aria-label={`关闭 ${tab.title}`}
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
                          sessionID={props.sessionID!}
                          terminalID={cellID}
                          runtimeURL={props.runtimeURL ?? ""}
                          token={props.token}
                          active={props.active && activeID() === cellID}
                          command={shellProfile()}
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
