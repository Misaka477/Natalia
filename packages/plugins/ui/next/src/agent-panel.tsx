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
import { TurnNavigator } from "./components/TurnNavigator";
import { readVisibleTurnMessageID } from "./controllers/scroll-memory";

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
  const [selectedID, setSelectedID] = createSignal<string | undefined>(
    undefined,
  );
  const [inspectorTab, setInspectorTab] = createSignal<"transcript" | "pr">(
    "transcript",
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

  const [teamPRs, setTeamPRs] = createSignal<RuntimeTeamPR[]>([]);
  const [teamConcurrency, setTeamConcurrency] = createSignal<
    number | undefined
  >(undefined);
  const [terminals, setTerminals] = createSignal<
    RuntimeNativeTerminalSession[]
  >([]);

  async function refreshData() {
    try {
      const prs =
        (await props.runtime?.teamPRList?.(props.state.sessionID)) ?? [];
      setTeamPRs(prs);
    } catch {
      setTeamPRs([]);
    }
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

  // Auto-select the first subagent or PR sandbox when none is selected.
  createEffect(() => {
    if (selectedID()) return;
    const firstAgent = subagents()[0];
    if (firstAgent) {
      setSelectedID(firstAgent.id);
      return;
    }
    const firstPR = teamPRs()[0];
    if (firstPR?.sandboxID) {
      setSelectedID(firstPR.sandboxID);
      setInspectorTab("pr");
    }
  });

  const runningSubagents = createMemo(() =>
    subagents().filter((agent) => agent.status === "running"),
  );
  const completedSubagents = createMemo(() =>
    subagents().filter((agent) => agent.status === "completed"),
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

  const prByAgentID = createMemo(() => {
    const map = new Map<string, RuntimeTeamPR>();
    for (const pr of teamPRs()) {
      if (pr.sandboxID) map.set(pr.sandboxID, pr);
      map.set(pr.id, pr);
    }
    return map;
  });

  // PRs whose sandboxID does not appear in active subagents
  const orphanPRs = createMemo(() => {
    const ids = new Set(subagents().map((a) => a.id));
    return teamPRs().filter((pr) => !ids.has(pr.sandboxID) && !ids.has(pr.id));
  });

  const selectedSubagent = createMemo(() =>
    subagents().find((item) => item.id === selectedID()),
  );
  const selectedPR = createMemo(() => {
    const id = selectedID();
    if (!id) return undefined;
    return prByAgentID().get(id);
  });

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
                tool.argumentsRaw,
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
  const [subActiveMessageID, setSubActiveMessageID] = createSignal<
    string | undefined
  >(undefined);
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

  function agentStatusLabel(status: string) {
    return status === "running"
      ? t("agent.statusRunning")
      : status === "completed"
        ? t("agent.statusCompleted")
        : status === "failed"
          ? t("agent.statusFailed")
          : status;
  }

  function renderAgentCard(agent: SubagentView, isChild = false) {
    const pr = () => prByAgentID().get(agent.id);
    const title = () => pr()?.task || agent.task || agent.id;
    return (
      <button
        type="button"
        class={`${styles.rosterCard} ${isChild ? styles.treeChild : ""}`}
        data-active={selectedID() === agent.id}
        data-status={agent.status}
        onClick={() => {
          setSelectedID(agent.id);
          setInspectorTab("transcript");
        }}
      >
        <div class={styles.rosterCardTop}>
          <span class={styles.statusDot} data-status={agent.status} />
          <span class={styles.rosterTitle}>{title()}</span>
          <span class={styles.statusBadge} data-status={agent.status}>
            {agentStatusLabel(agent.status)}
          </span>
        </div>
        <div class={styles.rosterMeta}>
          <span class={styles.rosterId}>{agent.id}</span>
          <Show when={agent.phase}>
            <span>· {agent.phase}</span>
          </Show>
          <Show when={pr()}>
            {(matchedPR) => (
              <span
                class={styles.prPill}
                data-ok={
                  matchedPR().buildEvidence
                    ? matchedPR().buildEvidence!.ok
                    : undefined
                }
              >
                PR · {matchedPR().status}
                <Show when={matchedPR().buildEvidence}>
                  {matchedPR().buildEvidence!.ok ? " ✓" : " ✗"}
                </Show>
              </span>
            )}
          </Show>
        </div>
      </button>
    );
  }

  return (
    <div class="review-pane">
      {/* Unified Squad Summary Bar */}
      <div class={styles.summaryBar}>
        <div class={styles.summaryStats}>
          <span class={styles.statChip} data-tone="running">
            <span class={styles.statusDot} data-status="running" />
            {t("agent.runningSubagents")}: {runningSubagents().length}
          </span>
          <span class={styles.statChip}>
            {t("agent.statusCompleted")}: {completedSubagents().length}
          </span>
          <Show when={teamPRs().length > 0}>
            <span class={styles.statChip} data-tone="accent">
              Team PR: {teamPRs().length}
            </span>
          </Show>
          <Show when={teamConcurrency() !== undefined}>
            <span class={styles.statChip}>
              {t("agent.concurrencyLimit")}: {teamConcurrency()}
            </span>
          </Show>
        </div>
        <button
          type="button"
          class={styles.actionBtn}
          onClick={() => void refreshData()}
        >
          {t("agent.refresh")}
        </button>
      </div>

      <Show
        when={subagents().length > 0 || teamPRs().length > 0}
        fallback={
          <PanelState
            state="empty"
            title={t("agent.emptyTitle")}
            description={t("agent.emptyHint")}
          />
        }
      >
        <div class={styles.deckBody}>
          {/* Left column: Agent & Sandbox Task Roster */}
          <div class={styles.roster}>
            <Show when={subagentTree().roots.length > 0}>
              <div class={styles.rosterSection}>{t("agent.subagent")}</div>
              <For each={subagentTree().roots}>
                {(agent) => (
                  <div>
                    {renderAgentCard(agent, false)}
                    <For each={subagentTree().children.get(agent.id) ?? []}>
                      {(child) => renderAgentCard(child, true)}
                    </For>
                  </div>
                )}
              </For>
            </Show>

            <Show when={orphanPRs().length > 0}>
              <div class={styles.rosterSection}>{t("agent.taskQueue")}</div>
              <For each={orphanPRs()}>
                {(pr) => {
                  const key = pr.sandboxID || pr.id;
                  return (
                    <button
                      type="button"
                      class={styles.rosterCard}
                      data-active={selectedID() === key}
                      data-status={pr.status}
                      onClick={() => {
                        setSelectedID(key);
                        setInspectorTab("pr");
                      }}
                    >
                      <div class={styles.rosterCardTop}>
                        <span
                          class={styles.statusDot}
                          data-status={pr.status}
                        />
                        <span class={styles.rosterTitle}>
                          {pr.task || pr.id}
                        </span>
                        <span
                          class={styles.prPill}
                          data-ok={
                            pr.buildEvidence ? pr.buildEvidence.ok : undefined
                          }
                        >
                          PR · {pr.status}
                        </span>
                      </div>
                      <div class={styles.rosterMeta}>
                        <span class={styles.rosterId}>{pr.sandboxID}</span>
                      </div>
                    </button>
                  );
                }}
              </For>
            </Show>
          </div>

          {/* Right column: Selected Agent & Sandbox PR Inspector */}
          <div class={styles.inspector}>
            <div class={styles.inspectorHeader}>
              <div class={styles.inspectorTitleWrap}>
                <span class={styles.inspectorTitle}>
                  {selectedPR()?.task ||
                    selectedSubagent()?.task ||
                    selectedSubagent()?.id ||
                    selectedID() ||
                    t("agent.selectOne")}
                </span>
                <Show when={selectedSubagent()}>
                  <span class={styles.inspectorSub}>
                    {selectedSubagent()?.id} · {selectedSubagent()?.status} ·{" "}
                    {selectedSubagent()?.phase ?? "idle"}
                    {selectedSubagent()?.parentAgentID
                      ? t("agent.parent", {
                          id: selectedSubagent()?.parentAgentID,
                        })
                      : ""}
                  </span>
                </Show>
              </div>

              <div class={styles.inspectorActions}>
                <Show when={selectedID()}>
                  <ContextMeter
                    usage={
                      props.state.subagentStates[selectedID() ?? ""]?.context
                    }
                    compact
                  />
                </Show>
                <Show when={selectedTerminals().length}>
                  <button
                    type="button"
                    class={styles.actionBtn}
                    onClick={() =>
                      props.onOpenTerminal?.(selectedTerminals()[0]!.id)
                    }
                  >
                    {t("agent.openTerminal")} (
                    {selectedTerminals()
                      .map((term) => term.id)
                      .join(", ")}
                    )
                  </button>
                </Show>
                <Show when={selectedPR()}>
                  <div class={styles.inspectorModeSwitch}>
                    <button
                      type="button"
                      class={styles.modeBtn}
                      data-active={inspectorTab() === "transcript"}
                      onClick={() => setInspectorTab("transcript")}
                    >
                      {t("agent.subagent")}
                    </button>
                    <button
                      type="button"
                      class={styles.modeBtn}
                      data-active={inspectorTab() === "pr"}
                      onClick={() => setInspectorTab("pr")}
                    >
                      PR / Sandbox
                    </button>
                  </div>
                </Show>
              </div>
            </div>

            <div class={`review-diff-content neu-pane ${nia.flatPane}`}>
              <Show
                when={selectedID()}
                fallback={
                  <div class="review-empty">
                    <div class="review-empty-title">
                      {t("agent.selectToView")}
                    </div>
                  </div>
                }
              >
                <Show
                  when={inspectorTab() === "pr" && selectedPR()}
                  fallback={
                    <>
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
                        onScroll={(event) => {
                          const visibleID = readVisibleTurnMessageID(
                            event.currentTarget as HTMLElement | undefined,
                          );
                          if (visibleID) setSubActiveMessageID(visibleID);
                        }}
                        onNearTop={() => void loadOlderSubagentHistory()}
                        hasOlder={subagentPaging().hasOlder}
                        historyLoading={!subagentPaging().initialized}
                        olderHistoryLoading={subagentPaging().loadingOlder}
                      />
                      <TurnNavigator
                        messages={renderedSubagentMessages}
                        getApi={() => subTranscriptApi}
                        activeMessageID={subActiveMessageID}
                        includeSystemTurns={true}
                        hasOlder={subagentPaging().hasOlder}
                        onLoadOlder={() => void loadOlderSubagentHistory()}
                        t={props.t}
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
                    </>
                  }
                >
                  {(pr) => (
                    <div class={styles.prInspector}>
                      <div class={styles.queueCard}>
                        <div class={styles.queueTitle}>
                          {pr().task || pr().id}
                        </div>
                        <div class={styles.queueMeta}>
                          <span>
                            {t("agent.prStatus", { status: pr().status })}
                          </span>
                          <span>
                            {t("agent.prSubagent", { id: pr().sandboxID })}
                          </span>
                          <span>
                            phase:{" "}
                            {subagents().find(
                              (item) => item.id === pr().sandboxID,
                            )?.phase ?? t("agent.phaseUnknown")}
                          </span>
                        </div>
                        <Show when={pr().result}>
                          <div class={styles.queueResult}>{pr().result}</div>
                        </Show>
                        <Show when={pr().buildEvidence}>
                          <div
                            class={
                              pr().buildEvidence!.ok
                                ? styles.buildOk
                                : styles.cardError
                            }
                          >
                            Build{" "}
                            {pr().buildEvidence!.ok ? "passed ✓" : "failed ✗"} ·
                            exit {pr().buildEvidence?.exitCode}
                            <Show when={pr().buildEvidence?.output}>
                              <pre class={styles.buildOutput}>
                                {pr().buildEvidence?.output}
                              </pre>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    </div>
                  )}
                </Show>
              </Show>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
