import { PanelState } from "./components/PanelState";
import styles from "./styles/plan-panel.module.css";
import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { marked } from "marked";
import type { RuntimeClient, RuntimeEvent } from "@anthelia/contracts";
import type { AppState } from "@natalia/view-store";
import { applicablePlanConstraints } from "@natalia/governance-ledger";
import { PathBrowseButton } from "./path-browse-button";

type PlanRow = {
  planID: string;
  title: string;
  documentPath: string;
  status: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  markedAt?: string;
};

const PLAN_STATUS_LABEL_KEYS: Record<string, string> = {
  handed_off: "plan.statusHandedOff",
  executing: "plan.statusExecuting",
  paused: "plan.statusPaused",
  awaiting_audit: "plan.statusAwaitingAudit",
  auditing: "plan.statusAuditing",
  audit_pending: "plan.statusAuditPending",
  audit_gaps: "plan.statusAuditGaps",
  completed: "plan.statusCompleted",
  unmarked: "plan.statusUnmarked",
};

function planStatusLabel(status: string, t: (key: string) => string): string {
  const key = PLAN_STATUS_LABEL_KEYS[status];
  return key ? t(key) : status;
}

const TASK_STATE_LABEL_KEYS: Record<string, string> = {
  verified: "plan.taskVerified",
  gap: "plan.taskGap",
  in_progress: "plan.taskInProgress",
  pending: "plan.taskPending",
  skipped: "plan.taskSkipped",
};

function taskStateLabel(state: string, t: (key: string) => string): string {
  const key = TASK_STATE_LABEL_KEYS[state];
  return key ? t(key) : state;
}

/**
 * A task label is one line of the plan document, so it can carry inline
 * Markdown (`**bold**`, `code`, links). Render it the way the plan preview
 * does instead of showing the raw syntax — raw labels are hard to read.
 */
function taskTextHtml(text: string): string {
  return marked.parseInline(text ?? "") as string;
}

function MarkdownPreview(props: { content: string }) {
  const html = createMemo(() => marked.parse(props.content ?? "") as string);
  return <div class={`${styles.preview} markdown-body`} innerHTML={html()} />;
}

export function PlanPanel(props: {
  t: (key: string, params?: Record<string, unknown>) => string;
  state: AppState;
  /** Explicit selected session. Falls back to the projection session. */
  sessionID?: string;
  runtime?: RuntimeClient;
  events?: {
    subscribe(listener: (event: RuntimeEvent) => void): () => void;
  };
}) {
  const t = props.t;
  const [selectedID, setSelectedID] = createSignal<string | undefined>();
  const [activePlanID, setActivePlanID] = createSignal<string | undefined>();
  const [draft, setDraft] = createSignal("");
  const [preview, setPreview] = createSignal(true);
  const [notice, setNotice] = createSignal("");
  const [error, setError] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [markPath, setMarkPath] = createSignal("");
  const [localPlans, setLocalPlans] = createSignal<PlanRow[]>([]);
  // EI §4 Phase 4: the selected plan's tasks projected evidence-first
  // (pending / in_progress / verified / gap / skipped).
  const [taskStates, setTaskStates] = createSignal<
    Array<{
      id: string;
      text: string;
      declaration: string;
      depth: number;
      state: string;
    }>
  >([]);
  // The task list is collapsed by default: a plan's controls (edit / preview /
  // active / delete) must stay immediately visible, so the states render as a
  // compact one-line summary the user expands on demand.
  const [tasksExpanded, setTasksExpanded] = createSignal(false);
  const taskStateSummary = createMemo(() =>
    ["verified", "gap", "in_progress", "pending", "skipped"]
      .map((state) => ({
        state,
        count: taskStates().filter((task) => task.state === state).length,
      }))
      .filter((entry) => entry.count > 0)
      .map((entry) => `${taskStateLabel(entry.state, t)} ${entry.count}`)
      .join(" · "),
  );
  const sessionID = () => props.sessionID ?? props.state.sessionID;

  const plans = createMemo(() =>
    localPlans().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
  const activePlan = createMemo(() =>
    plans().find((plan) => plan.planID === activePlanID()),
  );
  const selected = createMemo(
    () =>
      plans().find((plan) => plan.planID === selectedID()) ??
      activePlan() ??
      plans()[0],
  );

  function rememberSelected(planID?: string) {
    if (!planID) return;
    try {
      localStorage.setItem("natalia.selectedPlanID", planID);
    } catch {
      // localStorage may be unavailable in some hosts.
    }
  }

  async function refreshPlans() {
    try {
      const [list, active] = await Promise.all([
        Promise.resolve(props.runtime?.planDocList?.(sessionID()) ?? []),
        Promise.resolve(props.runtime?.planDocActive?.(sessionID())),
      ]);
      setLocalPlans(
        list.map((plan) => ({
          ...plan,
          createdBy: plan.createdBy,
        })),
      );
      const nextActivePlanID = active?.planID;
      setActivePlanID(nextActivePlanID);
      const next = (() => {
        const currentActive = nextActivePlanID
          ? list.find((plan) => plan.planID === nextActivePlanID)
          : undefined;
        try {
          const stored = localStorage.getItem("natalia.selectedPlanID");
          return (
            list.find((plan) => plan.planID === stored) ??
            currentActive ??
            list[0]
          );
        } catch {
          return currentActive ?? list[0];
        }
      })();
      if (next) {
        setSelectedID(next.planID);
        rememberSelected(next.planID);
        void readSelected(next.planID);
      }
    } catch {
      // Keep the current list if the runtime is not ready yet.
    }
  }

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const refreshOnPlanEvent = (event: RuntimeEvent) => {
    const relevant =
      event.type === "plan.doc.created" ||
      event.type === "plan.doc.updated" ||
      event.type === "plan.doc.marked" ||
      event.type === "plan.doc.status" ||
      event.type === "plan.doc.deleted";
    if (!relevant) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refreshPlans(), 200);
  };

  onMount(() => {
    void refreshPlans();
    const off = props.events?.subscribe(refreshOnPlanEvent);
    onCleanup(() => {
      off?.();
      if (refreshTimer) clearTimeout(refreshTimer);
    });
  });

  async function loadTaskStates(planID?: string) {
    if (!planID) {
      setTaskStates([]);
      return;
    }
    try {
      const result = await props.runtime?.planTaskStates?.(
        { planID },
        sessionID(),
      );
      setTaskStates(result ?? []);
    } catch {
      setTaskStates([]);
    }
  }

  async function readSelected(planID?: string) {
    const plan = planID
      ? plans().find((candidate) => candidate.planID === planID)
      : selected();
    if (!plan) return;
    try {
      const result = await props.runtime?.planDocRead?.({
        planID: plan.planID,
        sessionID: sessionID(),
      });
      setDraft(result?.content ?? "");
      setError("");
      void loadTaskStates(plan.planID);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function saveSelected() {
    const plan = selected();
    if (!plan) return;
    setSaving(true);
    try {
      const result = await props.runtime?.planDocWrite?.({
        path: plan.documentPath,
        content: draft(),
        title: plan.title,
        planID: plan.planID,
        sessionID: sessionID(),
      });
      setNotice(
        result?.written
          ? t("plan.saved", { path: plan.documentPath })
          : t("plan.saveFailed"),
      );
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function setActivePlan() {
    const plan = selected();
    if (!plan) return;
    try {
      const result = await props.runtime?.planDocActivate?.(
        plan.planID,
        sessionID(),
      );
      setNotice(
        result?.updated
          ? t("plan.setActive", { title: plan.title })
          : t("plan.setActiveFailed"),
      );
      setError("");
      await refreshPlans();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function markPlan() {
    const path = markPath().trim();
    if (!path) {
      setError(t("plan.markPathRequired"));
      return;
    }
    try {
      const result = await props.runtime?.planDocMark?.({
        path,
        sessionID: sessionID(),
      });
      setNotice(
        result?.marked && result.planID
          ? t("plan.marked", { planID: result.planID })
          : t("plan.markFailed"),
      );
      setMarkPath("");
      setError("");
      await refreshPlans();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function newPlan() {
    const id = `plan_${Date.now().toString(36)}`;
    const path = `.natalia/plans/${id}.md`;
    const title = t("plan.newTitle", { id });
    try {
      await props.runtime?.planDocWrite?.({
        path,
        title,
        sessionID: sessionID(),
        content: `# ${title}

t("plan.goalSection")


t("plan.stepsSection")


t("plan.verifySection")


t("plan.summarySection")

`,
      });
      const result = await props.runtime?.planDocMark?.({
        path,
        title,
        sessionID: sessionID(),
      });
      setNotice(
        result?.marked && result.planID
          ? t("plan.createdMarked", { planID: result.planID })
          : t("plan.createFailed"),
      );
      setMarkPath("");
      setError("");
      setSelectedID(result?.planID);
      setPreview(false);
      await refreshPlans();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function selectPlan(planID: string) {
    setSelectedID(planID);
    rememberSelected(planID);
    setPreview(true);
    void readSelected(planID);
  }

  return (
    <div class="review-pane">
      <div class="review-section-label">{t("plan.docSection")}</div>
      <div class="review-checkpoint-rename">
        <input
          class="review-checkpoint-rename-input"
          type="text"
          placeholder={t("plan.pathPh")}
          value={markPath()}
          onInput={(event) => setMarkPath(event.currentTarget.value)}
        />
        {/* The chooser rides the same row as the buttons beside it, so the
            dialog gains no line of its own. */}
        <PathBrowseButton
          runtime={props.runtime}
          onPick={(chosen) => setMarkPath(chosen)}
        />
        <button
          type="button"
          class={styles.btn}
          onClick={() => void markPlan()}
        >
          {t("plan.markButton")}
        </button>
        <button type="button" class={styles.btn} onClick={() => void newPlan()}>
          {t("plan.create")}
        </button>
      </div>
      <Show when={!plans().length}>
        <PanelState
          state="empty"
          title={t("plan.emptyTitle")}
          description={t("plan.emptyHint")}
        />
      </Show>
      <Show when={plans().length}>
        <div class="agent-layout">
          <div class="agent-sidebar">
            <div class="review-section-label">{t("plan.markedSection")}</div>
            <For each={plans()}>
              {(plan) => (
                <button
                  type="button"
                  class="agent-card"
                  data-active={selected()?.planID === plan.planID}
                  onClick={() => selectPlan(plan.planID)}
                >
                  <div class="agent-card-title">{plan.title}</div>
                  <div
                    class="agent-card-status"
                    data-active={activePlanID() === plan.planID}
                  >
                    {planStatusLabel(plan.status, t)}
                  </div>
                  <div class="agent-card-detail">{plan.documentPath}</div>
                </button>
              )}
            </For>
          </div>
          <div class="agent-stream">
            <Show
              when={selected()}
              fallback={
                <PanelState state="empty" title={t("plan.selectFirst")} />
              }
            >
              <div class="agent-stream-header">
                <div class="agent-stream-title">{selected()!.title}</div>
                <div class="agent-stream-meta">
                  {selected()!.planID} · {selected()!.documentPath}
                  <Show when={activePlan()?.planID === selected()!.planID}>
                    <span class={styles.activeBadge}>
                      {t("plan.activeBadge")}
                    </span>
                  </Show>
                </div>
              </div>
              <Show
                when={
                  selected() && props.state.workContracts[selected()!.planID]
                }
              >
                {(contract) => (
                  <div class={styles.contractBar}>
                    <span class={styles.contractSeg}>
                      WorkContract v{contract().version}
                    </span>
                    <span
                      class={styles.contractSeg}
                      data-status={contract().status}
                    >
                      {contract().status === "current"
                        ? t("plan.approved", { by: contract().acceptedBy })
                        : t("plan.draft")}
                    </span>
                    <Show when={contract().scope?.length}>
                      <span class={styles.contractSeg}>
                        scope ×{contract().scope!.length}
                      </span>
                    </Show>
                    <Show when={contract().verification?.length}>
                      <span class={styles.contractSeg}>
                        {t("plan.verification", {
                          count: contract().verification!.length,
                        })}
                      </span>
                    </Show>
                    <Show when={contract().stale}>
                      <span class={styles.contractSeg} data-status="stale">
                        {t("plan.stale")}
                      </span>
                    </Show>
                    <Show when={contract().unverifiable}>
                      <span class={styles.contractSeg} data-status="stale">
                        unverifiable
                      </span>
                    </Show>
                  </div>
                )}
              </Show>
              {/*
                Constitution/decision ledger plan §5: the active plan's
                header shows the applicable critical/high constraints —
                the plan is judged against them, so the header names them.
                The scope is the work contract's; a rule without a path
                anchor is prose, not an executable constraint on the plan.
              */}
              <Show
                when={
                  selected() &&
                  (props.state.workContracts[selected()!.planID]?.scope
                    ?.length ?? 0) > 0
                }
              >
                {(() => {
                  const rules = () =>
                    applicablePlanConstraints(
                      Object.values(props.state.constitutionRules ?? {}),
                      props.state.workContracts[selected()!.planID]?.scope ??
                        [],
                    );
                  return (
                    <Show when={rules().length > 0}>
                      <div class={styles.constraints}>
                        <div class={styles.constraintsTitle}>
                          {t("plan.constraints", { count: rules().length })}
                        </div>
                        <For each={rules()}>
                          {(rule) => (
                            <div
                              class={styles.constraintRow}
                              data-priority={rule.priority}
                            >
                              <span class={styles.constraintId}>
                                {rule.ruleID}
                              </span>
                              <span class={styles.constraintText}>
                                {rule.statement}
                              </span>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  );
                })()}
              </Show>
              <div class={styles.docButtons}>
                <button
                  type="button"
                  class={styles.btn}
                  onClick={() => void saveSelected()}
                  disabled={saving()}
                >
                  {t("plan.save")}
                </button>
                <button
                  type="button"
                  class={styles.btn}
                  onClick={() => setPreview(!preview())}
                >
                  {preview() ? t("plan.edit") : t("plan.preview")}
                </button>
                <button
                  type="button"
                  class={styles.btn}
                  disabled={activePlan()?.planID === selected()!.planID}
                  onClick={() => void setActivePlan()}
                >
                  {activePlan()?.planID === selected()!.planID
                    ? t("plan.activeNow")
                    : t("plan.setActiveButton")}
                </button>
                <button
                  type="button"
                  class={styles.btn}
                  onClick={() =>
                    void (async () => {
                      await props.runtime?.planDocDelete?.(
                        selected()!.planID,
                        sessionID(),
                      );
                      setSelectedID(undefined);
                      await refreshPlans();
                    })()
                  }
                >
                  {t("plan.unmark")}
                </button>
              </div>
              <Show when={taskStates().length}>
                <div class={styles.taskStates}>
                  <button
                    type="button"
                    class={styles.taskSummary}
                    onClick={() => setTasksExpanded(!tasksExpanded())}
                  >
                    <span class="review-section-label">
                      {t("plan.tasksSection")}
                    </span>
                    <span class={styles.taskCounts}>{taskStateSummary()}</span>
                    <span class={styles.taskToggle}>
                      {tasksExpanded()
                        ? t("common.collapse")
                        : t("plan.tasksExpand", { count: taskStates().length })}
                    </span>
                  </button>
                  <Show when={tasksExpanded()}>
                    <For each={taskStates()}>
                      {(task) => (
                        <div class={styles.taskRow} data-state={task.state}>
                          <span
                            class={styles.taskBadge}
                            data-state={task.state}
                          >
                            {taskStateLabel(task.state, t)}
                          </span>
                          <span
                            class={styles.taskText}
                            style={{ "padding-left": `${task.depth * 14}px` }}
                            innerHTML={taskTextHtml(task.text)}
                          />
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              </Show>
              <Show
                when={preview()}
                fallback={
                  <textarea
                    class={styles.editor}
                    value={draft()}
                    onInput={(event) => setDraft(event.currentTarget.value)}
                  />
                }
              >
                <MarkdownPreview content={draft()} />
              </Show>
            </Show>
          </div>
        </div>
      </Show>
      <Show when={notice()}>
        <div class={styles.notice}>{notice()}</div>
      </Show>
      <Show when={error()}>
        <div class={styles.error}>{error()}</div>
      </Show>
    </div>
  );
}
