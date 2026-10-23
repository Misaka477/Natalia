/** Transcript controller: the dual agent panes (Natalia + Navi chat).
 *
 * The JSX moved verbatim from the shell; every shell value it reads arrives
 * through the destructured props, so the pane markup needed no rewriting.
 * The transcript handles live in ../transcript-refs so the shell's
 * jump-to-bottom helpers keep working.
 */

import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { Attachment, Message, ToolCall } from "@natalia/ui-kit";
import { ContextMeter, Transcript } from "@natalia/ui-kit";
import styles from "../styles/transcript.module.css";
import { PendingTakeover } from "../components/PendingTakeover";
import { NeuSelect } from "../components/NeuSelect";
import { QueueDock } from "../components/QueueDock";
import { SlotMount } from "../slots/mount";
import { MainInputArea, ChatInputArea } from "./input-area";
import { SessionUsageBar } from "../components/SessionUsageBar";
import type { UiPluginContext } from "@natalia/ui-host";
import type { AppState } from "@natalia/view-store";
import type {
  ChatModelProfile,
  RuntimeSessionSummary,
} from "@anthelia/contracts";
import { humanizeToolResult, pendingToolLink } from "@natalia/ui-model";
import { transcriptRefs } from "../transcript-refs";
import { transcriptScrollMemory } from "../transcript-scroll-memory";
import { PanelState } from "../components/PanelState";
import { anchorIndexFor, readTranscriptAnchor } from "./scroll-memory";
import { goalCommandInstruction } from "../app-neu";
import type { ComposerAttachment } from "../components/Composer";
import type { MessageAction } from "@natalia/ui-kit";
import type { PagedTranscriptState, TranscriptHandle } from "@natalia/ui-kit";
import type { PermissionRungID } from "../permission-rungs";
import type { GoalEditorTarget } from "../app-neu";
export interface MainPanesProps {
  ctx: UiPluginContext;
  t: (key: string, params?: Record<string, unknown>) => string;
  toolCards: any;
  slots: any;
  commands: any;
  state: () => AppState;
  setState: (value: AppState | ((prev: AppState) => AppState)) => void;
  mainDraft: () => string;
  setMainDraft: (value: string | ((prev: string) => string)) => void;
  chatDraft: () => string;
  setChatDraft: (value: string | ((prev: string) => string)) => void;
  mainAttachments: () => ComposerAttachment[];
  setMainAttachments: (
    value:
      | ComposerAttachment[]
      | ((prev: ComposerAttachment[]) => ComposerAttachment[]),
  ) => void;
  chatAttachments: () => ComposerAttachment[];
  setChatAttachments: (
    value:
      | ComposerAttachment[]
      | ((prev: ComposerAttachment[]) => ComposerAttachment[]),
  ) => void;
  selectedSessionID: () => string;
  selectedSession: () => string;
  sessionList: () => RuntimeSessionSummary[];
  layoutMode: () => "wide" | "compact" | "tiny";
  naviOpen: () => boolean;
  setNaviOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  /** Which agent the one main pane shows. */
  focusAgent: () => "natalia" | "navi";
  setFocusAgent: (value: "natalia" | "navi") => void;
  showJumpToBottom: () => boolean;
  setShowJumpToBottom: (value: boolean | ((prev: boolean) => boolean)) => void;
  chatShowJumpToBottom: () => boolean;
  setChatShowJumpToBottom: (
    value: boolean | ((prev: boolean) => boolean),
  ) => void;
  pendingTakeoverMinimized: () => boolean;
  setPendingTakeoverMinimized: (
    value: boolean | ((prev: boolean) => boolean),
  ) => void;
  pendingTakeoverFocus: () => string | undefined;
  setPendingTakeoverFocus: (value: string | undefined) => void;
  pendingRollback: any;
  setPendingRollback: (value: any) => void;
  jumpToBottom: () => void;
  jumpChatToBottom: () => void;
  activityLabel: () => string;
  chatActivityLabel: () => string;
  naviChatActivity: any;
  pendingTakeoverCount: () => number;
  formatDuration: (ms: number) => string;
  turnStartAt: () => number | undefined;
  currentRung: any;
  configRungID: () => PermissionRungID | undefined;
  modelOptions: any;
  permissionOptions: any;
  renderedMainMessages: () => Message[];
  renderedChatMessages: () => Message[];
  loadAttachmentUrl: (attachment: Attachment) => Promise<string>;
  loadOlderHistory: () => Promise<boolean>;
  loadOlderNaviChat: () => Promise<void>;
  loadSecondaryStartupData: () => void;
  refreshTranscript: () => Promise<void>;
  updateChatProfile: (next: ChatModelProfile) => Promise<void>;
  handlePasteAttachments: (
    event: ClipboardEvent,
    current: ComposerAttachment[],
    setAttachments: (value: ComposerAttachment[]) => void,
  ) => void;
  openModelSettings: () => void;
  openGoalEditor: (goal: GoalEditorTarget) => void;
  saveGoalEditor: (goal: GoalEditorTarget) => Promise<void>;
  runGoalControl: (action: "pause" | "resume" | "clear") => Promise<void>;
  forkSessionAtTurn: (turnID: string) => Promise<void>;
  rollbackDraftFromMessage: (message: Message) => void;
  checkpointIDForMessage: (message: Message) => string | undefined;
  redoAppliedRollback: () => Promise<void>;
  cancelPendingRollback: () => void;
  changePermission: (rungID: string) => Promise<void>;
  perfLog: (...args: unknown[]) => void;
  reasoningEffort: any;
  feedbackNotice: any;
  mainPaging: any;
  transcriptHistoryLoading: any;
  transcriptOlderLoading: any;
  resizing: any;
  goalBusy: any;
  goalEditOpen: any;
  goalEditObjective: any;
  setGoalEditObjective: any;
  setGoalEditOpen: any;
  goalEditCap: any;
  setGoalEditCap: any;
  goalNotice: any;
  turnElapsedMs: any;
  modelSelectionSignal: any;
  setModelSelectionSignal: any;
  setReasoningEffortSignal: any;
  startupDataDegraded: any;
  permissionProblem: any;
  rollbackNotice: any;
  setRollbackNotice: any;
  naviPaging: any;
  chatElapsedMs: any;
  chatProfile: any;
}

/** The dual agent panes: Natalia's workspace transcript and the Navi chat. */
export function MainPanes(props: MainPanesProps) {
  const {
    ctx,
    t,
    toolCards,
    slots,
    commands,
    state,
    setState,
    mainDraft,
    setMainDraft,
    chatDraft,
    setChatDraft,
    mainAttachments,
    setMainAttachments,
    chatAttachments,
    setChatAttachments,
    selectedSessionID,
    selectedSession,
    sessionList,
    layoutMode,
    naviOpen,
    setNaviOpen,
    showJumpToBottom,
    setShowJumpToBottom,
    chatShowJumpToBottom,
    setChatShowJumpToBottom,
    pendingTakeoverMinimized,
    setPendingTakeoverMinimized,
    pendingTakeoverFocus,
    setPendingTakeoverFocus,
    pendingRollback,
    setPendingRollback,
    jumpToBottom,
    jumpChatToBottom,
    activityLabel,
    chatActivityLabel,
    naviChatActivity,
    pendingTakeoverCount,
    formatDuration,
    turnStartAt,
    currentRung,
    configRungID,
    modelOptions,
    permissionOptions,
    focusAgent,
    setFocusAgent,
    renderedMainMessages,
    renderedChatMessages,
    loadAttachmentUrl,
    loadOlderHistory,
    loadOlderNaviChat,
    loadSecondaryStartupData,
    refreshTranscript,
    updateChatProfile,
    handlePasteAttachments,
    openModelSettings,
    openGoalEditor,
    saveGoalEditor,
    runGoalControl,
    forkSessionAtTurn,
    rollbackDraftFromMessage,
    checkpointIDForMessage,
    redoAppliedRollback,
    cancelPendingRollback,
    changePermission,
    perfLog,
    feedbackNotice,
    mainPaging,
    transcriptHistoryLoading,
    transcriptOlderLoading,
    resizing,
    goalBusy,
    goalEditOpen,
    goalEditObjective,
    setGoalEditObjective,
    setGoalEditOpen,
    goalEditCap,
    setGoalEditCap,
    goalNotice,
    turnElapsedMs,
    modelSelectionSignal,
    setModelSelectionSignal,
    setReasoningEffortSignal,
    startupDataDegraded,
    permissionProblem,
    rollbackNotice,
    setRollbackNotice,
    naviPaging,
    chatElapsedMs,
    chatProfile,
    reasoningEffort,
  } = props;

  // --- Where the reader was, per session ---
  // Saved on every scroll and restored when a session's history lands, so
  // coming back to a session puts the reader where they left it instead of
  // at the bottom. `pendingRestore` is armed by a session change and spent
  // by the first render that has messages to scroll to.
  let mainFollowing = true;
  let pendingRestore = false;
  let restoredSessionID = "";

  createEffect(() => {
    const sessionID = selectedSessionID();
    if (sessionID && sessionID !== restoredSessionID) {
      pendingRestore = true;
    }
  });

  createEffect(() => {
    const messages = renderedMainMessages();
    if (!pendingRestore || messages.length === 0) return;
    pendingRestore = false;
    const sessionID = selectedSessionID();
    restoredSessionID = sessionID;
    const anchor = transcriptScrollMemory.recall(sessionID);
    if (anchor?.following) {
      transcriptRefs.main?.scrollToBottom();
      return;
    }
    const index = anchorIndexFor(
      anchor,
      messages.map((message: { id: string }) => message.id),
    );
    if (index < 0) {
      // The message the reader was on is gone (the history was rebuilt or
      // the session grew past it): the tail is the honest landing place.
      transcriptRefs.main?.scrollToBottom();
      return;
    }
    transcriptRefs.main?.scrollToIndex(index, { align: "start" });
  });

  function saveMainScrollAnchor(event: Event) {
    const sessionID = selectedSessionID();
    if (!sessionID) return;
    const anchor = readTranscriptAnchor(
      event.currentTarget as HTMLElement | undefined,
      mainFollowing,
    );
    if (anchor) transcriptScrollMemory.remember(sessionID, anchor);
  }

  return (
    <>
      {/* The one main pane. The shell used to render two panes side by
          side, each with its own composer; the architecture wants one
          pane with a switcher in its header, so the agent the reader is
          talking to is a choice inside the pane rather than a split of
          the screen. */}
      <section class="neu-main">
        <div class="neu-pane">
          <div class="neu-pane-header">
            {/* The switcher: which agent this pane is. */}
            <div
              class={styles.agentSwitch}
              role="tablist"
              aria-label={t("transcript.agentSwitchLabel")}
            >
              <button
                type="button"
                role="tab"
                class={styles.agentSwitchBtn}
                aria-selected={focusAgent() === "natalia"}
                data-active={focusAgent() === "natalia"}
                onClick={() => setFocusAgent("natalia")}
              >
                Natalia
              </button>
              <button
                type="button"
                role="tab"
                class={styles.agentSwitchBtn}
                aria-selected={focusAgent() === "navi"}
                data-active={focusAgent() === "navi"}
                onClick={() => setFocusAgent("navi")}
              >
                Navi
              </button>
            </div>
            <span class={styles.headerRight}>
              <Show
                when={focusAgent() === "natalia"}
                fallback={
                  <>
                    <ContextMeter usage={state().navi.context} compact />
                    <span
                      class="neu-pane-status"
                      data-running={Boolean(naviChatActivity())}
                    >
                      {naviChatActivity() ? "running" : "idle"}
                    </span>
                  </>
                }
              >
                <ContextMeter
                  usage={state().natalia.context ?? state().context}
                  compact
                />
                <span
                  class="neu-pane-status"
                  data-running={Boolean(state().natalia.activeTurn)}
                >
                  {state().natalia.activeTurn ? "running" : "idle"}
                </span>
              </Show>
            </span>
          </div>
          <div class="neu-pane-content">
            <Show when={focusAgent() === "natalia"}>
              <div class={styles.mainWrap}>
                <Show
                  when={selectedSessionID() || state().sessionID || "none"}
                  keyed
                >
                  <Show when={feedbackNotice()}>
                    <div class="neu-gov-action-note">{feedbackNotice()}</div>
                  </Show>
                  {/* The startup data failed after every retry. The shell says
                      so once, at the top of the transcript, with the retry that
                      re-runs the fetch — an empty session list or an empty
                      permission menu must not read as "no data exists". */}
                  <Show when={startupDataDegraded()}>
                    <PanelState
                      state="error"
                      title={t("transcript.startupDataFailed")}
                      description={t("transcript.startupDataFailedHint")}
                      actionLabel={t("state.retry")}
                      onAction={() => void loadSecondaryStartupData()}
                    />
                  </Show>
                  <div class={styles.mainWrap}>
                    <Transcript
                      messages={renderedMainMessages()}
                      emptyTitle={t("transcript.emptyMainTitle")}
                      emptyHint={t("transcript.emptyMainHint")}
                      assistantName="Natalia"
                      assistantInitial="N"
                      toolCards={toolCards}
                      apiRef={(api) => {
                        transcriptRefs.main = api;
                      }}
                      onFollowChange={(following) => {
                        mainFollowing = following;
                        setShowJumpToBottom(!following);
                      }}
                      onScroll={saveMainScrollAnchor}
                      onNearTop={() => void loadOlderHistory()}
                      hasOlder={mainPaging().hasOlder}
                      historyLoading={transcriptHistoryLoading()}
                      olderHistoryLoading={transcriptOlderLoading()}
                      loadAttachmentUrl={loadAttachmentUrl}
                      onFork={forkSessionAtTurn}
                      onRollback={rollbackDraftFromMessage}
                      checkpointIDForMessage={checkpointIDForMessage}
                      suspendVirtualization={resizing()}
                    />
                    <Show when={showJumpToBottom()}>
                      <button
                        type="button"
                        class="neu-jump-bottom"
                        onClick={jumpToBottom}
                        title={t("transcript.jumpToBottom")}
                      >
                        ↓
                      </button>
                    </Show>
                    {/* A plugin's own entry beside an empty transcript, under
                        the shell's empty state. */}
                    <SlotMount slots={slots} name="transcript.empty" t={t} />
                  </div>
                </Show>
              </div>
            </Show>

            {/* THE RUNBAR — the active run, in one band above the input.
                What is running, how long it has been, the model, the
                reasoning档 and the permission rung it is running under, and
                the one control that stops it. It used to be an activity
                line above a toolbar of selects inside each agent's own
                pane; now it is one bar whichever agent the pane shows. */}
            <div class={styles.runbar}>
              <Show when={focusAgent() === "natalia"}>
                <div class="neu-activity-bar">
                  <span class="neu-activity-pulse" />
                  <Show when={state().goal}>
                    {(goal) => (
                      <span class={styles.slot}>
                        <span class={styles.control} data-phase={goal()!.phase}>
                          <span
                            class={styles.chip}
                            title={`${goal()!.objective}${
                              goal()!.blockedReason
                                ? ` — ${goal()!.blockedReason!.code}: ${goal()!.blockedReason!.message}`
                                : ""
                            }`}
                          >
                            <span class={styles.chipLabel}>Goal</span>
                            <span class={styles.chipText}>
                              {goal()!.objective.length > 40
                                ? `${goal()!.objective.slice(0, 40)}…`
                                : goal()!.objective}
                            </span>
                            <span class={styles.chipRound}>
                              R{goal()!.roundsStarted}
                            </span>
                            <Show when={goal()!.phase === "complete"}>
                              <span class={styles.chipDone}>done</span>
                            </Show>
                          </span>
                          <button
                            type="button"
                            class={`${styles.action} ${styles.toggle}`}
                            disabled={goalBusy()}
                            onClick={() =>
                              void runGoalControl(
                                goal()!.phase === "paused" ? "resume" : "pause",
                              )
                            }
                          >
                            {goal()!.phase === "paused" ? "▶" : "⏸"}
                          </button>
                          <button
                            type="button"
                            class={`${styles.action} ${styles.clear}`}
                            disabled={goalBusy()}
                            onClick={() => void runGoalControl("clear")}
                          >
                            ✕
                          </button>
                        </span>
                      </span>
                    )}
                  </Show>
                  <Show when={goalNotice()}>
                    <span class={styles.notice}>{goalNotice()}</span>
                  </Show>
                  <span class="neu-activity-label">
                    {state().natalia.activeTurn
                      ? `${activityLabel()} · ${
                          turnStartAt() === undefined
                            ? t("transcript.timingUnknown")
                            : formatDuration(turnElapsedMs())
                        }`
                      : "idle"}
                  </span>
                </div>
                <div class="neu-main-toolbar">
                  <NeuSelect
                    value={modelSelectionSignal()?.modelID ?? ""}
                    options={modelOptions()}
                    // No provider configured means an empty menu, so this
                    // click goes to the model settings instead of listing
                    // nothing. The control itself is untouched: same box,
                    // same chevron, in the same position. With a model to
                    // pick, the menu opens as it always did.
                    onActivate={
                      modelOptions().length > 0 ? undefined : openModelSettings
                    }
                    onChange={(modelID) => {
                      const sessionID =
                        selectedSessionID() || state().sessionID;
                      setModelSelectionSignal({
                        modelID,
                        variant: undefined,
                      });
                      void props.ctx.runtime.selectModel?.(
                        modelID,
                        undefined,
                        sessionID,
                      );
                    }}
                    placeholder={t("transcript.selectModel")}
                    menuPosition="top"
                  />
                  <NeuSelect
                    value={reasoningEffort()}
                    options={[
                      { value: "minimal", label: "minimal" },
                      { value: "low", label: "low" },
                      { value: "medium", label: "medium" },
                      { value: "high", label: "high" },
                      { value: "xhigh", label: "xhigh" },
                    ]}
                    onChange={(effort) => {
                      const sessionID =
                        selectedSessionID() || state().sessionID;
                      setReasoningEffortSignal(effort);
                      void props.ctx.runtime.setReasoningEffort?.(
                        effort as
                          | "minimal"
                          | "low"
                          | "medium"
                          | "high"
                          | "xhigh",
                        sessionID,
                      );
                    }}
                    placeholder={t("transcript.reasoningEffort")}
                    menuPosition="top"
                  />
                  <NeuSelect
                    value={currentRung()?.id ?? configRungID() ?? "ask"}
                    options={
                      startupDataDegraded()
                        ? [
                            {
                              value: "__retry",
                              label: t("transcript.configLoadFailedRetry"),
                            },
                          ]
                        : permissionOptions()
                    }
                    // With no permissions to choose from the menu would open
                    // empty — the same bug the model controls had — and the
                    // place to configure this is the settings' model page, so
                    // the click goes there. The degraded state keeps its
                    // retry: that entry IS a real option with a real action.
                    onActivate={
                      !startupDataDegraded() && permissionOptions().length === 0
                        ? openModelSettings
                        : undefined
                    }
                    onChange={(permission) => {
                      // The degraded entry is the retry, not a mode:
                      // choosing it re-runs the fetch instead of
                      // writing a config value that does not exist.
                      if (permission === "__retry") {
                        void loadSecondaryStartupData();
                        return;
                      }
                      void changePermission(permission);
                    }}
                    placeholder={
                      startupDataDegraded()
                        ? t("transcript.configLoadFailed")
                        : t("transcript.selectPermission")
                    }
                    menuPosition="top"
                  />
                </div>
                {/* The run's one control: stop it. It lives here, in the
                    runbar, rather than beside the send key — the runbar is
                    the run's surface and the dock is the message's. */}
                <Show when={state().natalia.activeTurn}>
                  <button
                    type="button"
                    class={styles.runbarStop}
                    onClick={() => props.ctx.runtime.cancel?.()}
                    title={t("composer.stopTitle")}
                  >
                    {t("composer.stop")}
                  </button>
                </Show>
                {/* A switch that did not take says so. A control that looks
                      alive while writing nothing is the exact failure this path
                      had before the runtime face was wired. */}
                <Show when={permissionProblem()}>
                  <div class={styles.banner}>
                    <span>{permissionProblem()}</span>
                  </div>
                </Show>
                <Show when={pendingRollback()}>
                  <div class={styles.banner}>
                    <span>
                      {t("transcript.rollbackPrepared", {
                        label: pendingRollback()!.label,
                      })}
                    </span>
                    <span class={styles.hint}>
                      {t("transcript.rollbackEffectiveOnSend")}
                    </span>
                    <button
                      type="button"
                      class={styles.cancel}
                      onClick={() => cancelPendingRollback()}
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                </Show>
                <Show when={!pendingRollback() && rollbackNotice()}>
                  <div class={styles.banner}>
                    <span>{rollbackNotice()!.text}</span>
                    <span class={styles.hint}>
                      {t("transcript.rollbackRedoHint")}
                    </span>
                    <Show when={rollbackNotice()!.safetyCheckpointID}>
                      <button
                        type="button"
                        class={styles.redo}
                        onClick={() => void redoAppliedRollback()}
                      >
                        {t("transcript.redo")}
                      </button>
                    </Show>
                    <button
                      type="button"
                      class={styles.cancel}
                      onClick={() => setRollbackNotice(undefined)}
                    >
                      {t("transcript.acknowledged")}
                    </button>
                  </div>
                </Show>
                <MainInputArea
                  slots={slots}
                  commands={commands}
                  t={t}
                  ctx={props.ctx}
                  state={state}
                  selectedSessionID={selectedSessionID}
                  mainDraft={mainDraft}
                  setMainDraft={setMainDraft}
                  mainAttachments={mainAttachments}
                  setMainAttachments={setMainAttachments}
                  handlePasteAttachments={handlePasteAttachments}
                  pendingTakeoverCount={pendingTakeoverCount}
                  pendingTakeoverMinimized={pendingTakeoverMinimized}
                  setPendingTakeoverMinimized={setPendingTakeoverMinimized}
                  pendingTakeoverFocus={pendingTakeoverFocus}
                  setPendingTakeoverFocus={setPendingTakeoverFocus}
                  pendingRollback={pendingRollback}
                  setPendingRollback={setPendingRollback}
                  setRollbackNotice={setRollbackNotice}
                  refreshTranscript={refreshTranscript}
                  perfLog={perfLog}
                />
              </Show>

              <Show when={focusAgent() === "navi"}>
                <Show
                  when={selectedSessionID() || state().sessionID || "none"}
                  keyed
                >
                  <div class={styles.chatWrap}>
                    <Transcript
                      messages={renderedChatMessages()}
                      emptyTitle={t("transcript.emptyChatTitle")}
                      emptyHint={t("transcript.emptyChatHint")}
                      assistantName="Navi"
                      assistantInitial="V"
                      toolCards={toolCards}
                      apiRef={(api) => {
                        transcriptRefs.chat = api;
                      }}
                      onFollowChange={(following) =>
                        setChatShowJumpToBottom(!following)
                      }
                      onNearTop={() => void loadOlderNaviChat()}
                      hasOlder={naviPaging().hasOlder}
                      historyLoading={!naviPaging().initialized}
                      olderHistoryLoading={naviPaging().loadingOlder}
                      loadAttachmentUrl={loadAttachmentUrl}
                      suspendVirtualization={resizing()}
                    />
                    <Show when={chatShowJumpToBottom()}>
                      <button
                        type="button"
                        class="neu-jump-bottom"
                        onClick={jumpChatToBottom}
                        title={t("transcript.jumpToBottom")}
                      >
                        ↓
                      </button>
                    </Show>
                  </div>
                </Show>
              </Show>

              <Show when={focusAgent() === "navi"}>
                <div
                  class="neu-activity-bar"
                  data-running={Boolean(naviChatActivity())}
                >
                  <span class="neu-activity-pulse" />
                  <span class="neu-activity-label">
                    {naviChatActivity()
                      ? `${chatActivityLabel()} · ${formatDuration(chatElapsedMs())}`
                      : "idle"}
                  </span>
                </div>
                <div class="neu-main-toolbar">
                  <NeuSelect
                    value={chatProfile().normal?.modelID ?? ""}
                    options={modelOptions()}
                    // See the main toolbar's model control: no model to
                    // choose means this click opens the model settings.
                    onActivate={
                      modelOptions().length > 0 ? undefined : openModelSettings
                    }
                    onChange={(modelID) =>
                      void updateChatProfile({
                        ...chatProfile(),
                        normal: { ...chatProfile().normal, modelID },
                      })
                    }
                    placeholder={t("transcript.chatModel")}
                    menuPosition="top"
                  />
                  <NeuSelect
                    value={chatProfile().normal?.reasoningEffort ?? ""}
                    options={[
                      { value: "minimal", label: "minimal" },
                      { value: "low", label: "low" },
                      { value: "medium", label: "medium" },
                      { value: "high", label: "high" },
                      { value: "xhigh", label: "xhigh" },
                    ]}
                    onChange={(effort) =>
                      void updateChatProfile({
                        ...chatProfile(),
                        normal: {
                          ...chatProfile().normal,
                          reasoningEffort: effort as
                            | "minimal"
                            | "low"
                            | "medium"
                            | "high"
                            | "xhigh",
                        },
                      })
                    }
                    placeholder={t("transcript.chatReasoning")}
                    menuPosition="top"
                  />
                  <NeuSelect
                    value={chatProfile().expert?.modelID ?? ""}
                    options={modelOptions()}
                    onActivate={
                      modelOptions().length > 0 ? undefined : openModelSettings
                    }
                    onChange={(modelID) =>
                      void updateChatProfile({
                        ...chatProfile(),
                        expert: { ...chatProfile().expert, modelID },
                      })
                    }
                    placeholder={t("transcript.expertModel")}
                    menuPosition="top"
                  />
                  <NeuSelect
                    value={chatProfile().expert?.reasoningEffort ?? ""}
                    options={[
                      { value: "minimal", label: "minimal" },
                      { value: "low", label: "low" },
                      { value: "medium", label: "medium" },
                      { value: "high", label: "high" },
                      { value: "xhigh", label: "xhigh" },
                    ]}
                    onChange={(effort) =>
                      void updateChatProfile({
                        ...chatProfile(),
                        expert: {
                          ...chatProfile().expert,
                          reasoningEffort: effort as
                            | "minimal"
                            | "low"
                            | "medium"
                            | "high"
                            | "xhigh",
                        },
                      })
                    }
                    placeholder={t("transcript.expertReasoning")}
                    menuPosition="top"
                  />
                </div>
                <Show when={naviChatActivity()}>
                  <button
                    type="button"
                    class={styles.runbarStop}
                    onClick={() =>
                      void props.ctx.runtime.naviChat?.abort?.(
                        selectedSessionID() || state().sessionID,
                      )
                    }
                    title={t("composer.stopTitle")}
                  >
                    {t("composer.stop")}
                  </button>
                </Show>
                <ChatInputArea
                  slots={slots}
                  t={t}
                  naviChatActivity={naviChatActivity}
                  ctx={props.ctx}
                  state={state}
                  selectedSessionID={selectedSessionID}
                  chatDraft={chatDraft}
                  setChatDraft={setChatDraft}
                  chatAttachments={chatAttachments}
                  setChatAttachments={setChatAttachments}
                  handlePasteAttachments={handlePasteAttachments}
                  updateChatProfile={updateChatProfile}
                  perfLog={perfLog}
                />
              </Show>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
