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
  nataliaVisible: () => boolean;
  naviVisible: () => boolean;
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
    nataliaVisible,
    naviVisible,
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
  return (
    <>
      {/* Middle dual agent panes */}
      <section class="neu-main">
        <div class={styles.panes}>
          <Show when={nataliaVisible()}>
            <div class="neu-pane">
              <div class="neu-pane-header">
                <span class="neu-pane-title">Natalia</span>
                <span class={styles.headerRight}>
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
                </span>
              </div>
              <div class="neu-pane-content">
                <Show
                  when={selectedSessionID() || state().sessionID || "none"}
                  keyed
                >
                  <Show when={feedbackNotice()}>
                    <div class="neu-gov-action-note">{feedbackNotice()}</div>
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
                      onFollowChange={(following) =>
                        setShowJumpToBottom(!following)
                      }
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
                <div
                  class="neu-activity-bar"
                  data-running={Boolean(state().natalia.activeTurn)}
                >
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
                              {`Round ${goal()!.roundsStarted}${
                                goal()!.maxGoalRounds === 0
                                  ? ""
                                  : `/${goal()!.maxGoalRounds}`
                              }`}
                            </span>
                            {/* A completed goal SAYS so. The chip used to
                                  keep showing the round count with the
                                  pause/resume button simply gone — neither
                                  disappearing (the reference harness's
                                  GoalBar drops a complete goal) nor stating
                                  the completion, so a finished goal read as
                                  a stalled one until the human cleared it
                                  by hand. */}
                            <Show when={goal()!.phase === "complete"}>
                              <span
                                class={styles.chipDone}
                                title={t("transcript.goalDoneTitle")}
                              >
                                {t("transcript.goalDone")}
                              </span>
                            </Show>
                          </span>
                          <Show when={goal()!.phase !== "complete"}>
                            <button
                              class={`${styles.action} ${styles.toggle}`}
                              data-phase={goal()!.phase}
                              disabled={goalBusy()}
                              title={
                                goal()!.phase === "active"
                                  ? t("transcript.goalPause")
                                  : t("transcript.goalResume")
                              }
                              onClick={() =>
                                void runGoalControl(
                                  goal()!.phase === "active"
                                    ? "pause"
                                    : "resume",
                                )
                              }
                            >
                              {goal()!.phase === "active" ? "❚❚" : "▶"}
                            </button>
                          </Show>
                          <button
                            class={styles.action}
                            disabled={goalBusy()}
                            title={t("transcript.goalEditTitle")}
                            onClick={() => openGoalEditor(goal()!)}
                          >
                            ✎
                          </button>
                          <button
                            class={`${styles.action} ${styles.clear}`}
                            disabled={goalBusy()}
                            title={t("transcript.goalClearTitle")}
                            onClick={() => void runGoalControl("clear")}
                          >
                            ✕
                          </button>
                        </span>
                        <Show when={goalEditOpen()}>
                          <div class={styles.editor}>
                            <label class={styles.editorField}>
                              <span>{t("transcript.goalLabel")}</span>
                              <textarea
                                rows={2}
                                value={goalEditObjective()}
                                onInput={(event) =>
                                  setGoalEditObjective(
                                    event.currentTarget.value,
                                  )
                                }
                                onKeyDown={(event) => {
                                  if (
                                    event.key === "Enter" &&
                                    !event.shiftKey
                                  ) {
                                    event.preventDefault();
                                    void saveGoalEditor(goal()!);
                                  } else if (event.key === "Escape")
                                    setGoalEditOpen(false);
                                }}
                              />
                            </label>
                            <label
                              class={`${styles.editorField} ${styles.editorCap}`}
                            >
                              <span>{t("transcript.goalCapLabel")}</span>
                              <input
                                type="number"
                                min="0"
                                placeholder={t("transcript.goalCapHint")}
                                value={goalEditCap()}
                                onInput={(event) =>
                                  setGoalEditCap(event.currentTarget.value)
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Enter")
                                    void saveGoalEditor(goal()!);
                                  else if (event.key === "Escape")
                                    setGoalEditOpen(false);
                                }}
                              />
                            </label>
                            <div class={styles.editorActions}>
                              <button
                                class={styles.editorSave}
                                disabled={goalBusy()}
                                onClick={() => void saveGoalEditor(goal()!)}
                              >
                                {t("common.save")}
                              </button>
                              <button
                                class={styles.editorCancel}
                                onClick={() => setGoalEditOpen(false)}
                              >
                                {t("common.cancel")}
                              </button>
                            </div>
                          </div>
                        </Show>
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
                {/* A switch that did not take says so. A control that looks
                      alive while writing nothing is the exact failure this path
                      had before the runtime face was wired. */}
                <Show when={permissionProblem()}>
                  <div class="neu-rollback-banner">
                    <span>{permissionProblem()}</span>
                  </div>
                </Show>
                <Show when={pendingRollback()}>
                  <div class="neu-rollback-banner">
                    <span>
                      {t("transcript.rollbackPrepared", {
                        label: pendingRollback()!.label,
                      })}
                    </span>
                    <span class="neu-rollback-hint">
                      {t("transcript.rollbackEffectiveOnSend")}
                    </span>
                    <button
                      type="button"
                      class="neu-rollback-cancel"
                      onClick={() => cancelPendingRollback()}
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                </Show>
                <Show when={!pendingRollback() && rollbackNotice()}>
                  <div class="neu-rollback-banner">
                    <span>{rollbackNotice()!.text}</span>
                    <span class="neu-rollback-hint">
                      {t("transcript.rollbackRedoHint")}
                    </span>
                    <Show when={rollbackNotice()!.safetyCheckpointID}>
                      <button
                        type="button"
                        class="neu-rollback-redo"
                        onClick={() => void redoAppliedRollback()}
                      >
                        {t("transcript.redo")}
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="neu-rollback-cancel"
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
              </div>
            </div>
          </Show>

          <Show when={layoutMode() !== "tiny"}>
            <div class={styles.divider} />
          </Show>

          <Show when={naviVisible()}>
            <div class="neu-pane">
              <div class="neu-pane-header">
                <span class="neu-pane-title">Navi</span>
                <span class={styles.headerRight}>
                  <ContextMeter usage={state().navi.context} compact />
                  <span
                    class="neu-pane-status"
                    data-running={Boolean(naviChatActivity())}
                  >
                    {naviChatActivity() ? "running" : "idle"}
                  </span>
                </span>
              </div>
              <div class="neu-pane-content">
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
              </div>
            </div>
          </Show>
        </div>
      </section>
    </>
  );
}
