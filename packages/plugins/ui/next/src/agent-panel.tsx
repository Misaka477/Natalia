import { PanelState } from "./components/PanelState";
import styles from "./styles/agent-panel.module.css";
import nia from "./styles/nia-panel.module.css";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type {
  RuntimeClient,
  RuntimeNativeTerminalSession,
  RuntimeSubagentView,
  RuntimeTeamPR,
} from "@anthelia/contracts";
import { type AppState, type SubagentView } from "@natalia/view-store";
import {
  ContextMeter,
  PagedTranscriptController,
  Transcript,
  toolCallRow,
  type PagedTranscriptState,
  type TranscriptHandle,
} from "@natalia/ui-kit";
import type { Message } from "./types";
import { stableRows, type RowSignature } from "./stable-rows";
import { SessionUsageBar } from "./components/SessionUsageBar";

function subagentToolCallsFromText(
  text: string,
): NonNullable<Message["toolCalls"]> | undefined {
  const trimmed = text.trim();
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(\{[\s\S]*\})$/u);
  if (!match) return undefined;
  try {
    JSON.parse(match[2]!);
  } catch {
    return undefined;
  }
  return [
    {
      name: match[1]!,
      output: match[2]!,
      status: "completed",
      summary: match[1]!,
    },
  ];
}

export function AgentPanel(props: {
  t: (key: string, params?: Record<string, unknown>) => string;
  state: AppState;
  runtime?: RuntimeClient;
  sessionID?: string;
  onOpenTerminal?: (terminalID: string) => void;
  onHydrateSubagentHistory?: (
    history: RuntimeSubagentView[],
    options?: {
      direction?: "older" | "newer";
      replace?: boolean;
      subagentID?: string;
    },
  ) => void;
}) {
  const t = props.t;
  const [subTab, setSubTab] = createSignal<"subagent" | "team">("subagent");
  const [selectedID, setSelectedID] = createSignal<string | undefined>(
    undefined,
  );
  const subagentPager = new PagedTranscriptController<RuntimeSubagentView>({
    pageSize: 100,
    onPage: (page, direction) => {
      const subagentID = selectedID();
      if (!subagentID) return;
      props.onHydrateSubagentHistory?.(page.data, {
        subagentID,
        ...(direction === "initial" ? { replace: true } : { direction }),
      });
    },
  });
  const [subagentPaging, setSubagentPaging] =
    createSignal<PagedTranscriptState>(subagentPager.snapshot());
  onCleanup(
    subagentPager.subscribe(() => setSubagentPaging(subagentPager.snapshot())),
  );
  onCleanup(() => subagentPager.dispose());

  function subagentPageSource(input: { cursor?: string; limit: number }) {
    const subagentID = selectedID();
    if (!subagentID) return Promise.resolve({ data: [], cursor: {} });
    if (props.runtime?.subagentHistoryPage)
      return props.runtime.subagentHistoryPage({
        subagentID,
        sessionID: props.sessionID,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
    return Promise.resolve(
      props.runtime?.subagentHistory?.(props.sessionID),
    ).then((rows) => ({
      data: (rows ?? []).filter((row) => row.id === subagentID),
      cursor: {},
    }));
  }

  async function loadOlderSubagentHistory() {
    await subagentPager.loadOlder();
  }

  createEffect(() => {
    const subagentID = selectedID();
    if (!subagentID) {
      subagentPager.reset();
      return;
    }
    subagentPager.setSource(subagentPageSource);
    void subagentPager.loadInitial();
  });

  const [teamAvailable, setTeamAvailable] = createSignal(false);
  const [teamPRs, setTeamPRs] = createSignal<RuntimeTeamPR[]>([]);
  const [teamConcurrency, setTeamConcurrency] = createSignal<
    number | undefined
  >(undefined);
  const [terminals, setTerminals] = createSignal<
    RuntimeNativeTerminalSession[]
  >([]);
  const teamStatusTally = createMemo(() => {
    const tally: Record<string, number> = {
      completed: 0,
      failed: 0,
      stopped: 0,
    };
    for (const pr of teamPRs()) {
      const status = pr.status || "pending";
      tally[status] = (tally[status] ?? 0) + 1;
    }
    return tally;
  });

  async function refreshData() {
    let teamSeen = false;
    try {
      const prs =
        (await props.runtime?.teamPRList?.(props.state.sessionID)) ?? [];
      setTeamPRs(prs);
      teamSeen = true;
    } catch {
      setTeamPRs([]);
    }
    try {
      const plugins = (await props.runtime?.plugins?.()) ?? [];
      if (
        plugins.some(
          (plugin) =>
            plugin.id?.includes("team") || plugin.name?.includes("Team"),
        )
      )
        teamSeen = true;
    } catch {
      // plugin list may be unavailable; teamPRList already tried
    }
    setTeamAvailable(teamSeen);
    try {
      const list =
        (await props.runtime?.nativeTerminalList?.(props.state.sessionID)) ??
        [];
      setTerminals(list);
    } catch {
      setTerminals([]);
    }
    try {
      const config = await props.runtime?.configGet?.();
      setTeamConcurrency(config?.team?.maxConcurrent);
    } catch {
      setTeamConcurrency(undefined);
    }
  }

  onMount(() => {
    void refreshData();
  });

  const subagents = createMemo(() =>
    Object.values(props.state.subagentStream.active).sort((a, b) => {
      const at = a.lastActivityAt ?? 0;
      const bt = b.lastActivityAt ?? 0;
      return bt - at;
    }),
  );

  const runningSubagents = createMemo(() =>
    subagents().filter((agent) => agent.status === "running"),
  );

  const subagentTree = createMemo(() => {
    const roots: SubagentView[] = [];
    const children = new Map<string, SubagentView[]>();
    for (const agent of subagents()) {
      const parent = agent.parentAgentID;
      if (!parent || !subagents().some((item) => item.id === parent)) {
        roots.push(agent);
      } else {
        const list = children.get(parent) ?? [];
        list.push(agent);
        children.set(parent, list);
      }
    }
    return { roots, children };
  });

  const selectedSubagent = createMemo(() =>
    subagents().find((item) => item.id === selectedID()),
  );

  const [subagentElapsedMs, setSubagentElapsedMs] = createSignal(0);
  const subagentElapsedTimer = setInterval(() => {
    const selected = selectedSubagent();
    if (selected?.status === "running" && selected.startedAt)
      setSubagentElapsedMs(Date.now() - selected.startedAt);
    else setSubagentElapsedMs(0);
  }, 1000);
  onCleanup(() => clearInterval(subagentElapsedTimer));

  function formatSubagentDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 1) return `${seconds}s`;
    return `${minutes}m ${seconds}s`;
  }

  const selectedTerminals = createMemo(() =>
    terminals().filter((terminal) => terminal.agentID === selectedID()),
  );

  const subagentMessageCache = new Map<
    string,
    { signature: RowSignature; value: Message }
  >();

  const subagentMessages = createMemo<Message[]>(() => {
    const id = selectedID();
    if (!id) return [];
    const child = props.state.subagentStream.states[id];
    if (child?.messages?.length) {
      return stableRows(
        subagentMessageCache,
        child.messages.map((msg, index) => {
          const rowID = `sub-${id}-${index}`;
          const tool = msg.tool;
          if (tool) {
            const status = (tool.status as Message["status"]) ?? "completed";
            return {
              id: rowID,
              signature: [
                id,
                tool.name,
                tool.result,
                tool.summary,
                status,
                // The arguments stream in fragments; a row cached mid-stream
                // would pin a ToolCall without parsed arguments forever.
                tool.argumentsRaw,
                // The card and its structured facts are what the row RENDERS
                // (R0), and the legacy metadata blob is the replay fallback
                // the decode reads: every field the derivation depends on
                // belongs in the row's identity.
                tool.card,
                tool.meta,
                tool.metadata,
              ],
              create: () =>
                ({
                  id: rowID,
                  role: "assistant",
                  content: "",
                  status,
                  toolCalls: [toolCallRow(tool)],
                }) satisfies Message,
            };
          }
          const role =
            msg.role === "user"
              ? "user"
              : msg.role === "system"
                ? "system"
                : "assistant";
          const content = msg.text + (msg.pendingText || "");
          const status = msg.status as Message["status"];
          const streaming = Boolean(
            (msg.pendingText ?? "").length > 0 && msg.role !== "user",
          );
          return {
            id: rowID,
            signature: [
              id,
              role,
              msg.role,
              msg.text,
              msg.pendingText ?? "",
              msg.reasoningVisible,
              status,
              streaming,
            ],
            create: () =>
              ({
                id: rowID,
                role,
                thinking:
                  msg.role === "thinking" && msg.reasoningVisible !== false,
                content,
                status,
                streaming,
              }) satisfies Message,
          };
        }),
      );
    }
    const history = props.state.subagentStream.history[id] ?? [];
    return stableRows(
      subagentMessageCache,
      history.map((event, index) => {
        const rowID = `${event.id}:${event.event}:${index}`;
        const text =
          event.text || event.activityDetail || event.task || event.event;
        const status =
          event.status === "running"
            ? "running"
            : event.status === "failed"
              ? "error"
              : event.status === "completed"
                ? "done"
                : undefined;
        const timestamp = event.lastActivityAt
          ? new Date(event.lastActivityAt).toLocaleTimeString()
          : undefined;
        return {
          id: rowID,
          signature: [id, rowID, text, status, event.event, timestamp],
          // Parse the tool-call shape only when the row is actually rebuilt.
          create: () => {
            const toolCalls = subagentToolCallsFromText(text);
            if (toolCalls)
              return {
                id: rowID,
                role: "assistant",
                content: "",
                toolCalls,
                status: "done",
                timestamp,
              } satisfies Message;
            return {
              id: rowID,
              role: event.event === "log" ? "assistant" : "system",
              content: text,
              timestamp,
              status,
            } satisfies Message;
          },
        };
      }),
    );
  });

  let subTranscriptApi: TranscriptHandle | undefined;
  const [subShowJumpToBottom, setSubShowJumpToBottom] = createSignal(false);
  const renderedSubagentMessages = createMemo<Message[]>(() =>
    subagentMessages(),
  );

  createEffect(() => {
    const id = selectedID();
    if (!id) return;
    setSubShowJumpToBottom(false);
    requestAnimationFrame(() => {
      subTranscriptApi?.scrollToBottom();
    });
  });

  function agentStatusLabel(agent: SubagentView) {
    return agent.status === "running"
      ? t("agent.statusRunning")
      : agent.status === "completed"
        ? t("agent.statusCompleted")
        : agent.status === "failed"
          ? t("agent.statusFailed")
          : agent.status;
  }

  return (
    <div class="review-pane">
      <div class="review-subtabs">
        <button
          type="button"
          class="review-subtab"
          data-active={subTab() === "subagent"}
          onClick={() => setSubTab("subagent")}
        >
          {t("agent.subagent")}
        </button>
        <Show when={teamAvailable()}>
          <button
            type="button"
            class="review-subtab"
            data-active={subTab() === "team"}
            onClick={() => setSubTab("team")}
          >
            Team
          </button>
        </Show>
      </div>

      <Show when={subTab() === "subagent"}>
        <div class="review-header">
          <div class="review-title">
            <span>{t("agent.subagent")}</span>
          </div>
          <div class="review-meta">
            <ContextMeter
              usage={props.state.subagentStates[selectedID() ?? ""]?.context}
              compact
            />
            <span class="review-count">{subagents().length} agents</span>
          </div>
        </div>
        <Show
          when={subagents().length}
          fallback={
            <PanelState
              state="empty"
              title={t("agent.emptyTitle")}
              description={t("agent.emptyHint")}
            />
          }
        >
          <div class="review-body">
            <div class="review-files" style="width: 220px">
              <div class="review-files-heading">Agents</div>
              <For each={subagentTree().roots}>
                {(agent) => (
                  <div>
                    <button
                      type="button"
                      class="review-file-row"
                      data-active={selectedID() === agent.id}
                      onClick={() => setSelectedID(agent.id)}
                    >
                      <span class="review-file-status">
                        {agentStatusLabel(agent)}
                      </span>
                      <span class="review-file-name">{agent.id}</span>
                    </button>
                    <For each={subagentTree().children.get(agent.id) ?? []}>
                      {(child) => (
                        <div class={styles.treeChild}>
                          <button
                            type="button"
                            class="review-file-row"
                            data-active={selectedID() === child.id}
                            onClick={() => setSelectedID(child.id)}
                          >
                            <span class="review-file-status">
                              {agentStatusLabel(child)}
                            </span>
                            <span class="review-file-name">└ {child.id}</span>
                          </button>
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </For>
              <Show when={!subagents().length}>
                <div class="review-empty">
                  <div class="review-empty-title">{t("agent.emptyTitle")}</div>
                </div>
              </Show>
            </div>
            <div
              class="review-resizer"
              role="separator"
              aria-orientation="vertical"
            />
            <div class="review-diff">
              <div class="review-diff-header">
                <span class="review-diff-path">
                  {selectedSubagent()?.id ?? t("agent.selectOne")}
                </span>
                <Show when={selectedSubagent()}>
                  <span class="review-meta">
                    {selectedSubagent()?.status} ·{" "}
                    {selectedSubagent()?.phase ?? "idle"}
                    {selectedSubagent()?.parentAgentID
                      ? t("agent.parent", {
                          id: selectedSubagent()?.parentAgentID,
                        })
                      : ""}
                    <Show when={selectedTerminals().length}>
                      {" · "}
                      {t("agent.terminal")}
                      {selectedTerminals()
                        .map((terminal) => terminal.id)
                        .join(", ")}
                      <button
                        type="button"
                        class="terminal-toolbar-btn"
                        onClick={() =>
                          props.onOpenTerminal?.(selectedTerminals()[0]!.id)
                        }
                      >
                        {t("agent.openTerminal")}
                      </button>
                    </Show>
                  </span>
                </Show>
              </div>
              <div class={`review-diff-content neu-pane ${nia.flatPane}`}>
                <Show
                  when={selectedSubagent()}
                  fallback={
                    <div class="review-empty">
                      <div class="review-empty-title">
                        {t("agent.selectToView")}
                      </div>
                    </div>
                  }
                >
                  <Transcript
                    messages={renderedSubagentMessages()}
                    emptyTitle={t("agent.emptyMsgTitle")}
                    emptyHint={t("agent.emptyMsgHint")}
                    assistantName={selectedSubagent()?.id ?? "Subagent"}
                    assistantInitial="A"
                    apiRef={(api) => {
                      subTranscriptApi = api;
                    }}
                    onFollowChange={(following) =>
                      setSubShowJumpToBottom(!following)
                    }
                    onNearTop={() => void loadOlderSubagentHistory()}
                    hasOlder={subagentPaging().hasOlder}
                    historyLoading={!subagentPaging().initialized}
                    olderHistoryLoading={subagentPaging().loadingOlder}
                  />
                  <SessionUsageBar
                    t={props.t}
                    usage={
                      props.state.subagentStates[selectedID() ?? ""]
                        ?.sessionUsage
                    }
                  />
                  <Show when={selectedSubagent()?.status === "running"}>
                    <div class="neu-activity-bar" data-running={true}>
                      <span class="neu-activity-pulse" />
                      <span class="neu-activity-label">
                        {selectedSubagent()?.status} ·{" "}
                        {formatSubagentDuration(subagentElapsedMs())}
                      </span>
                    </div>
                  </Show>
                  <Show when={subShowJumpToBottom()}>
                    <button
                      type="button"
                      class="neu-jump-bottom"
                      onClick={() => subTranscriptApi?.scrollToBottom()}
                      title={t("agent.jumpToBottom")}
                    >
                      ↓
                    </button>
                  </Show>
                </Show>
              </div>
            </div>
          </div>
        </Show>
      </Show>

      <Show when={subTab() === "team"}>
        <div class="review-header">
          <div class="review-title">
            <span>{t("agent.teamOverview")}</span>
            <button
              type="button"
              class="terminal-toolbar-btn"
              onClick={() => void refreshData()}
            >
              {t("agent.refresh")}
            </button>
          </div>
          <div class="review-meta">
            <span class="review-count">{teamPRs().length} PR</span>
          </div>
        </div>
        <div class="review-section-label">{t("agent.concurrencyLimit")}</div>
        <div class="review-entity-control">
          <div class={styles.select}>
            {teamConcurrency() ?? t("agent.unset")}
          </div>
        </div>
        <div class="review-section-label">{t("agent.runningSubagents")}</div>
        <div class="review-entity-control">
          <div class={styles.select}>{runningSubagents().length}</div>
        </div>
        <div class="review-section-label">{t("agent.statusTally")}</div>
        <div class="review-entity-control">
          <div class={styles.select}>
            {t("agent.completedFailed", {
              completed: teamStatusTally().completed ?? 0,
              failed: teamStatusTally().failed ?? 0,
              stopped: teamStatusTally().stopped ?? 0,
            })}
          </div>
        </div>
        <Show when={teamPRs().length}>
          <div class="review-section-label">{t("agent.taskQueue")}</div>
          <div class="review-entity-list">
            <For each={teamPRs()}>
              {(pr) => (
                <div class={styles.queueCard}>
                  <div class={styles.queueTitle}>{pr.task || pr.id}</div>
                  <div class={styles.queueMeta}>
                    <span>{t("agent.prStatus", { status: pr.status })}</span>
                    <span>{t("agent.prSubagent", { id: pr.sandboxID })}</span>
                    <span>
                      phase:{" "}
                      {subagents().find((item) => item.id === pr.sandboxID)
                        ?.phase ?? t("agent.phaseUnknown")}
                    </span>
                  </div>
                  <Show when={pr.result}>
                    <div class={styles.queueResult}>{pr.result}</div>
                  </Show>
                  <Show when={pr.buildEvidence && !pr.buildEvidence.ok}>
                    <div class={styles.cardError}>
                      build exit {pr.buildEvidence?.exitCode}
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={!teamPRs().length}>
          <PanelState state="empty" title={t("agent.noTeamTasks")} />
        </Show>
      </Show>
    </div>
  );
}
