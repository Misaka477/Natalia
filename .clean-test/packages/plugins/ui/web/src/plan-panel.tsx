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

const PLAN_STATUS_LABELS: Record<string, string> = {
  handed_off: "已交接",
  executing: "执行中",
  paused: "已暂停",
  awaiting_audit: "待审计",
  auditing: "审计中",
  audit_pending: "审计待重试",
  audit_gaps: "有缺口",
  completed: "已完成",
  unmarked: "未标记",
};

function planStatusLabel(status: string): string {
  return PLAN_STATUS_LABELS[status] ?? status;
}

const TASK_STATE_LABELS: Record<string, string> = {
  verified: "已验证",
  gap: "缺证据",
  in_progress: "进行中",
  pending: "待办",
  skipped: "跳过",
};

function taskStateLabel(state: string): string {
  return TASK_STATE_LABELS[state] ?? state;
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
  return <div class="plan-panel-preview markdown-body" innerHTML={html()} />;
}

export function PlanPanel(props: {
  state: AppState;
  /** Explicit selected session. Falls back to the projection session. */
  sessionID?: string;
  runtime?: RuntimeClient;
  events?: {
    subscribe(listener: (event: RuntimeEvent) => void): () => void;
  };
}) {
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
      .map((entry) => `${taskStateLabel(entry.state)} ${entry.count}`)
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
      setNotice(result?.written ? `已保存 ${plan.documentPath}` : "保存未生效");
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
          ? `已将「${plan.title}」设为当前活跃计划`
          : "设置未生效",
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
      setError("请输入要标记为 Plan 的 Markdown 路径");
      return;
    }
    try {
      const result = await props.runtime?.planDocMark?.({
        path,
        sessionID: sessionID(),
      });
      setNotice(
        result?.marked && result.planID
          ? `已标记为 Plan：${result.planID}`
          : "标记未生效",
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
    const title = `新计划 ${id}`;
    try {
      await props.runtime?.planDocWrite?.({
        path,
        title,
        sessionID: sessionID(),
        content: `# ${title}

## 目标


## 步骤


## 验证


## 总结

`,
      });
      const result = await props.runtime?.planDocMark?.({
        path,
        title,
        sessionID: sessionID(),
      });
      setNotice(
        result?.marked && result.planID
          ? `已创建并标记为 Plan：${result.planID}`
          : "创建未生效",
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
      <div class="review-section-label">计划文档</div>
      <div class="review-checkpoint-rename">
        <input
          class="review-checkpoint-rename-input"
          type="text"
          placeholder="输入 .natalia/plans/ 下的 Markdown 文件路径"
          value={markPath()}
          onInput={(event) => setMarkPath(event.currentTarget.value)}
        />
        <button
          type="button"
          class="plan-panel-btn"
          onClick={() => void markPlan()}
        >
          标记为 Plan
        </button>
        <button
          type="button"
          class="plan-panel-btn"
          onClick={() => void newPlan()}
        >
          新建
        </button>
      </div>
      <Show when={!plans().length}>
        <div class="agent-empty-full">
          <div class="review-empty-icon">📄</div>
          <div class="review-empty-title">暂无计划文档</div>
          <div class="review-empty-desc">
            可手动新建计划文档，或先用 Navi 写入 .natalia/plans/ 下的 Markdown
            文件，再在这里标记为 Plan。
          </div>
        </div>
      </Show>
      <Show when={plans().length}>
        <div class="agent-layout">
          <div class="agent-sidebar">
            <div class="review-section-label">已标记 Plan</div>
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
                    {planStatusLabel(plan.status)}
                  </div>
                  <div class="agent-card-detail">{plan.documentPath}</div>
                </button>
              )}
            </For>
          </div>
          <div class="agent-stream">
            <Show
              when={selected()}
              fallback={<div class="agent-empty">先选择或标记一个 Plan</div>}
            >
              <div class="agent-stream-header">
                <div class="agent-stream-title">{selected()!.title}</div>
                <div class="agent-stream-meta">
                  {selected()!.planID} · {selected()!.documentPath}
                  <Show when={activePlan()?.planID === selected()!.planID}>
                    <span class="plan-panel-active-badge">当前活跃</span>
                  </Show>
                </div>
              </div>
              <Show
                when={
                  selected() && props.state.workContracts[selected()!.planID]
                }
              >
                {(contract) => (
                  <div class="plan-contract-bar">
                    <span class="plan-contract-seg">
                      WorkContract v{contract().version}
                    </span>
                    <span
                      class="plan-contract-seg"
                      data-status={contract().status}
                    >
                      {contract().status === "current"
                        ? `已批准 (${contract().acceptedBy})`
                        : "草案 · 待批准"}
                    </span>
                    <Show when={contract().scope?.length}>
                      <span class="plan-contract-seg">
                        scope ×{contract().scope!.length}
                      </span>
                    </Show>
                    <Show when={contract().verification?.length}>
                      <span class="plan-contract-seg">
                        验证 ×{contract().verification!.length}
                      </span>
                    </Show>
                    <Show when={contract().stale}>
                      <span class="plan-contract-seg" data-status="stale">
                        计划已变更 · 需重新提案
                      </span>
                    </Show>
                    <Show when={contract().unverifiable}>
                      <span class="plan-contract-seg" data-status="stale">
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
                      <div class="plan-constraints">
                        <div class="plan-constraints-title">
                          适用约束 ×{rules().length}（critical/high）
                        </div>
                        <For each={rules()}>
                          {(rule) => (
                            <div
                              class="plan-constraint-row"
                              data-priority={rule.priority}
                            >
                              <span class="plan-constraint-id">
                                {rule.ruleID}
                              </span>
                              <span class="plan-constraint-text">
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
              <div class="plan-panel-doc-buttons">
                <button
                  type="button"
                  class="plan-panel-btn"
                  onClick={() => void saveSelected()}
                  disabled={saving()}
                >
                  保存
                </button>
                <button
                  type="button"
                  class="plan-panel-btn"
                  onClick={() => setPreview(!preview())}
                >
                  {preview() ? "编辑" : "预览"}
                </button>
                <button
                  type="button"
                  class="plan-panel-btn"
                  disabled={activePlan()?.planID === selected()!.planID}
                  onClick={() => void setActivePlan()}
                >
                  {activePlan()?.planID === selected()!.planID
                    ? "活跃中"
                    : "设为当前活跃"}
                </button>
                <button
                  type="button"
                  class="plan-panel-btn"
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
                  删除标记
                </button>
              </div>
              <Show when={taskStates().length}>
                <div class="plan-task-states">
                  <button
                    type="button"
                    class="plan-task-summary"
                    onClick={() => setTasksExpanded(!tasksExpanded())}
                  >
                    <span class="review-section-label">任务态</span>
                    <span class="plan-task-counts">{taskStateSummary()}</span>
                    <span class="plan-task-toggle">
                      {tasksExpanded() ? "收起" : `展开 ${taskStates().length}`}
                    </span>
                  </button>
                  <Show when={tasksExpanded()}>
                    <For each={taskStates()}>
                      {(task) => (
                        <div class="plan-task-row" data-state={task.state}>
                          <span class="plan-task-badge" data-state={task.state}>
                            {taskStateLabel(task.state)}
                          </span>
                          <span
                            class="plan-task-text"
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
                    class="plan-panel-editor"
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
        <div class="plan-panel-notice">{notice()}</div>
      </Show>
      <Show when={error()}>
        <div class="plan-panel-error">{error()}</div>
      </Show>
    </div>
  );
}
