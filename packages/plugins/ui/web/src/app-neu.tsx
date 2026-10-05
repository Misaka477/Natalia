import type { UiPluginContext } from "@natalia/ui-host";
import { selectPrimaryActivity } from "@natalia/view-store";
import type {
  ChatMessageRow,
  RuntimeModelCatalogEntry,
  RuntimeProjectedMessage,
  RuntimeSessionSummary,
  ChatModelProfile,
  ConfigV3,
  WorkspaceSummary,
} from "@anthelia/contracts";
import { type AppState, cloneState } from "@natalia/view-store";
import { cloneStateInWorker } from "./clone-state-worker-client";
import {
  createSignal,
  createEffect,
  createMemo,
  createResource,
  onCleanup,
  onMount,
  batch,
  For,
  Show,
} from "solid-js";
import {
  ContextMeter,
  PagedTranscriptController,
  PendingBadge,
  Transcript,
  type Attachment,
  type PagedTranscriptState,
  type TranscriptHandle,
} from "@natalia/ui-kit";
import type { UiPanelDefinition } from "@natalia/ui-host";
import { pendingToolLink } from "@natalia/ui-model";
import { useConfirmDialog } from "./components/ConfirmDialog";
import { Composer, type ComposerAttachment } from "./components/Composer";
import { QueueDock } from "./components/QueueDock";
import { SessionUsageBar } from "./components/SessionUsageBar";
import { ReviewPane } from "./components/RightPanel";
import { SettingsPanel, type RegisteredToolView } from "./settings-panel";
import {
  createUiPanelRequirementContext,
  uiPanelRequirementsSatisfied,
  type UiPanelRequirementContext,
} from "./ui-requirements";
import { PluginManagerPanel } from "./plugin-manager-panel";
import { applyNeuTheme, NATALIA_SKINS, NEU_THEME_MODES } from "./styles";
import { SessionActionsPanel } from "./session-actions-panel";
import { AgentPanel } from "./agent-panel";
import { PlanPanel } from "./plan-panel";
import { NiaPanel } from "./nia-panel";
import { WorkspacePanel } from "./workspace-panel";
import { WorkspaceSettingsPanel } from "./workspace-settings-panel";
import { NeuSelect } from "./components/NeuSelect";
import { StatusPanel } from "./status-panel";
import { DangerBadge } from "./danger-badge";
import { SearchPanel } from "./search-panel";
import { HelpPanel } from "./help-panel";
import { StashPanel } from "./stash-panel";
import { SandboxPanel } from "./sandbox-panel";
import { GovernancePane, type GovernanceTab } from "./governance-panel";
import { ModelPanel } from "./model-panel";
import type { Message } from "./types";
import { parseGoalRoundPrompt } from "./goal-round";
import {
  collapseDuplicateTranscriptRows,
  dedupeTranscriptRowsById,
  stableRows,
  type RowSignature,
} from "./stable-rows";

const perfLog = (...args: unknown[]) => {
  if (
    (globalThis as { __NATALIA_PERF_VERBOSE?: number })
      .__NATALIA_PERF_VERBOSE === 1
  ) {
    console.warn(...args);
  }
};
const attachmentDataUrlCache = new Map<string, Promise<string>>();

type RightTab = string;

const GOVERNANCE_TABS: GovernanceTab[] = [
  "drift",
  "constitution",
  "decisions",
  "evidence",
  "completions",
  "workgraph",
  "notices",
];

/**
 * Read a deep-link parameter once. A host can open a specific governance view
 * (`?rightTab=governance&governance=decisions`) without scripted clicking — this
 * is also what the real-CEF smoke uses to exercise every tab.
 */
function queryParam(name: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return new URLSearchParams(window.location.search).get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 360;
const MIN_RIGHT_WIDTH = 440;
const MAX_RIGHT_WIDTH = 560;

function sessionTurnID(messageID: string) {
  if (!messageID.startsWith("turn_")) return undefined;
  return messageID.replace(/:(?:user|assistant|thinking|system)$/u, "");
}

function rightPanelMaxWidth(): number {
  if (typeof window === "undefined") return MAX_RIGHT_WIDTH;
  // On small/compact layouts the right panel is the most space-hungry
  // surface (terminal/diff), so allow it to take up to 2/3 width.
  return Math.max(MIN_RIGHT_WIDTH, Math.floor((window.innerWidth * 2) / 3));
}

function StatusDot(props: { status: string }) {
  return (
    <span
      class="neu-status-dot"
      data-status={props.status}
      title={props.status}
    />
  );
}

function TreeRow(props: {
  label: string;
  selected?: boolean;
  status?: string;
  badge?: string;
  depth?: number;
  onClick?: () => void;
  onEdit?: () => void;
  onAction?: () => void;
  actionTitle?: string;
  actionIcon?: string;
  bulkMode?: boolean;
  bulkSelected?: boolean;
  onBulkToggle?: () => void;
  editValue?: string;
  onEditChange?: (value: string) => void;
  onEditCommit?: () => void;
  onEditCancel?: () => void;
}) {
  return (
    <button
      type="button"
      class="neu-tree-row"
      data-selected={props.selected}
      style={{ "padding-left": `${18 + (props.depth ?? 1) * 14}px` }}
      onClick={() => {
        if (props.bulkMode) props.onBulkToggle?.();
        else props.onClick?.();
      }}
    >
      <Show when={props.bulkMode}>
        <span class="neu-bulk-check" data-checked={props.bulkSelected} />
      </Show>
      {props.status ? <StatusDot status={props.status} /> : null}
      <Show
        when={props.editValue !== undefined}
        fallback={
          <>
            <span class="neu-tree-label">{props.label}</span>
            {props.status === "running" ? (
              <span class="neu-badge neu-badge-running">并行中</span>
            ) : null}
            {props.badge ? <span class="neu-badge">{props.badge}</span> : null}
            <Show when={!props.bulkMode && (props.onAction || props.onEdit)}>
              <span class="neu-tree-actions">
                <Show when={props.onAction}>
                  <button
                    type="button"
                    class="neu-tree-edit"
                    title={props.actionTitle}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onAction?.();
                    }}
                  >
                    {props.actionIcon}
                  </button>
                </Show>
                <Show when={props.onEdit}>
                  <button
                    type="button"
                    class="neu-tree-edit"
                    title="重命名"
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onEdit?.();
                    }}
                  >
                    ✎
                  </button>
                </Show>
              </span>
            </Show>
          </>
        }
      >
        <input
          class="neu-tree-edit-input"
          value={props.editValue}
          onInput={(event) => props.onEditChange?.(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.stopPropagation();
              props.onEditCommit?.();
            } else if (event.key === "Escape") {
              event.stopPropagation();
              props.onEditCancel?.();
            }
          }}
          onBlur={() => props.onEditCommit?.()}
          onClick={(event) => event.stopPropagation()}
        />
      </Show>
    </button>
  );
}

function SessionTree(props: {
  selected: string;
  sessions: RuntimeSessionSummary[];
  workspaces: WorkspaceSummary[];
  onSelect: (id: string, name: string) => void;
  onRename?: (id: string, title: string) => unknown;
  onRemoveWorkspace?: (workspaceID: string) => void;
  onWorkspaceSettings?: (workspaceID: string) => void;
  onRenameWorkspace?: (workspaceID: string, title: string) => void;
  onCreateSessionInWorkspace?: (workspaceID: string) => void;
  onRestore?: (sessionID: string) => void;
  onArchive?: (sessionID: string) => void;
  bulkMode?: boolean;
  bulkSelected?: (id: string) => boolean;
  onBulkToggle?: (id: string) => void;
}) {
  const [editingID, setEditingID] = createSignal<string | null>(null);
  const [draftName, setDraftName] = createSignal("");
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const [expandedSessionGroups, setExpandedSessionGroups] = createSignal<
    Set<string>
  >(new Set());
  const [activeWorkspaceMenu, setActiveWorkspaceMenu] = createSignal<
    string | null
  >(null);
  const [editingWorkspaceID, setEditingWorkspaceID] = createSignal<
    string | null
  >(null);
  const [draftWorkspaceName, setDraftWorkspaceName] = createSignal("");

  const groups = createMemo(() => {
    const byWorkspace = new Map<string, RuntimeSessionSummary[]>();
    const activeID = props.workspaces.find(
      (workspace) => workspace.status === "active",
    )?.workspaceID;
    for (const session of props.sessions) {
      const key = session.workspaceID ?? activeID;
      if (!key) continue;
      const list = byWorkspace.get(key) ?? [];
      list.push(session);
      byWorkspace.set(key, list);
    }
    return props.workspaces.map((workspace) => ({
      workspaceID: workspace.workspaceID,
      workspace: workspace.title,
      sessions: (byWorkspace.get(workspace.workspaceID) ?? []).map(
        (session) => ({
          id: session.id,
          name: session.title,
          status:
            session.status ??
            (session.cancelled
              ? "error"
              : session.resumable
                ? "idle"
                : "running"),
          archived: Boolean(session.archived),
        }),
      ),
    }));
  });

  const runningSessions = createMemo(() =>
    props.sessions
      .map((session) => ({
        id: session.id,
        name: session.title,
        status:
          session.status ??
          (session.cancelled
            ? "error"
            : session.resumable
              ? "idle"
              : "running"),
        archived: Boolean(session.archived),
      }))
      .filter((session) => session.status === "running"),
  );

  const isCollapsed = (id: string) => collapsed().has(id);
  const isSessionsExpanded = (id: string) => expandedSessionGroups().has(id);
  const isWorkspaceMenuOpen = (id: string) => activeWorkspaceMenu() === id;

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const expandWorkspace = (id: string) => {
    setCollapsed((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const toggleSessionGroup = (id: string) => {
    setExpandedSessionGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleWorkspaceMenu = (id: string, event: MouseEvent) => {
    event.stopPropagation();
    setActiveWorkspaceMenu((prev) => (prev === id ? null : id));
  };

  const beginWorkspaceRename = (id: string, title: string) => {
    setEditingWorkspaceID(id);
    setDraftWorkspaceName(title);
    setActiveWorkspaceMenu(null);
  };

  const cancelWorkspaceRename = () => {
    setEditingWorkspaceID(null);
    setDraftWorkspaceName("");
  };

  const commitWorkspaceRename = (id: string, currentTitle: string) => {
    const title = draftWorkspaceName().trim();
    cancelWorkspaceRename();
    if (!title || title === currentTitle) return;
    props.onRenameWorkspace?.(id, title);
  };

  createEffect(() => {
    if (!activeWorkspaceMenu()) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        !target.closest(".neu-workspace-popup") &&
        !target.closest(".neu-workspace-menu-btn")
      ) {
        setActiveWorkspaceMenu(null);
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("click", handler);
    }, 0);
    onCleanup(() => {
      clearTimeout(timer);
      document.removeEventListener("click", handler);
    });
  });

  return (
    <div class="neu-tree">
      <Show when={runningSessions().length > 0}>
        <div class="neu-workspace-row">
          <span class="neu-workspace-name">并行会话</span>
          <span class="neu-count">{runningSessions().length}</span>
        </div>
        <For each={runningSessions()}>
          {(session) => (
            <TreeRow
              label={session.name}
              selected={props.selected === session.id}
              status={session.status}
              depth={1}
              onClick={() => props.onSelect(session.id, session.name)}
            />
          )}
        </For>
      </Show>
      <For each={groups()}>
        {(group) => {
          const open = () => !isCollapsed(group.workspaceID);
          const menuForThis = () => isWorkspaceMenuOpen(group.workspaceID);
          const displayedSessions = createMemo(() =>
            isSessionsExpanded(group.workspaceID)
              ? group.sessions
              : group.sessions.slice(0, 5),
          );
          return (
            <div class="neu-workspace-group">
              <div
                class="neu-workspace-folder"
                data-menu-open={menuForThis()}
                onClick={() => {
                  if (editingWorkspaceID() === group.workspaceID) return;
                  toggleCollapse(group.workspaceID);
                }}
              >
                <span class="neu-workspace-folder-icon">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M1 4.5A2.5 2.5 0 013.5 2H6l1.2 1.2H12.5A2.5 2.5 0 0115 6v6.5a2.5 2.5 0 01-2.5 2.5h-9A2.5 2.5 0 011 12.5v-8z"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.2"
                      stroke-linejoin="round"
                    />
                  </svg>
                </span>
                <span class="neu-workspace-chevron" data-open={open()}>
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M5 3L11 8L5 13"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </span>
                <Show
                  when={editingWorkspaceID() === group.workspaceID}
                  fallback={
                    <span class="neu-workspace-name">{group.workspace}</span>
                  }
                >
                  <input
                    class="neu-workspace-rename-input"
                    value={draftWorkspaceName()}
                    autofocus
                    onInput={(event) =>
                      setDraftWorkspaceName(event.currentTarget.value)
                    }
                    onClick={(event) => event.stopPropagation()}
                    onFocus={(event) => event.currentTarget.select()}
                    onBlur={() =>
                      commitWorkspaceRename(group.workspaceID, group.workspace)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.stopPropagation();
                        commitWorkspaceRename(
                          group.workspaceID,
                          group.workspace,
                        );
                      } else if (event.key === "Escape") {
                        event.stopPropagation();
                        cancelWorkspaceRename();
                      }
                    }}
                  />
                </Show>
                <span
                  class="neu-workspace-actions"
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    class="neu-workspace-menu-btn"
                    title="工作区操作"
                    onClick={(event) =>
                      toggleWorkspaceMenu(group.workspaceID, event)
                    }
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="3.5" r="1.3" fill="currentColor" />
                      <circle cx="8" cy="8" r="1.3" fill="currentColor" />
                      <circle cx="8" cy="12.5" r="1.3" fill="currentColor" />
                    </svg>
                  </button>
                  <Show when={props.onCreateSessionInWorkspace}>
                    <button
                      type="button"
                      class="neu-workspace-menu-btn"
                      title="新建会话"
                      onClick={() => {
                        expandWorkspace(group.workspaceID);
                        props.onCreateSessionInWorkspace?.(group.workspaceID);
                      }}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        fill="none"
                      >
                        <path
                          d="M8 3v10M3 8h10"
                          stroke="currentColor"
                          stroke-width="1.6"
                          stroke-linecap="round"
                        />
                      </svg>
                    </button>
                  </Show>
                  {menuForThis() && (
                    <div
                      class="neu-workspace-popup"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          beginWorkspaceRename(
                            group.workspaceID,
                            group.workspace,
                          )
                        }
                      >
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 16 16"
                          fill="none"
                        >
                          <path
                            d="M11.5 2.5l2 2L6 12H4v-2l7.5-7.5z"
                            stroke="currentColor"
                            stroke-width="1.3"
                            stroke-linejoin="round"
                          />
                        </svg>
                        重命名
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveWorkspaceMenu(null);
                          props.onWorkspaceSettings?.(group.workspaceID);
                        }}
                      >
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 16 16"
                          fill="none"
                        >
                          <path
                            d="M8 2.2l.7 1.5 1.6.2-.3 1.6 1.2 1.1-1.2 1.1.3 1.6-1.6.2L8 11l-.7-1.5-1.6-.2.3-1.6L4.8 6.6 6 5.5l-.3-1.6 1.6-.2L8 2.2z"
                            stroke="currentColor"
                            stroke-width="1.1"
                            stroke-linejoin="round"
                          />
                          <circle
                            cx="8"
                            cy="6.6"
                            r="1.2"
                            stroke="currentColor"
                            stroke-width="1.1"
                          />
                        </svg>
                        工作区设置
                      </button>
                      <button
                        type="button"
                        class="neu-workspace-popup-danger"
                        onClick={() => {
                          setActiveWorkspaceMenu(null);
                          props.onRemoveWorkspace?.(group.workspaceID);
                        }}
                      >
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 16 16"
                          fill="none"
                        >
                          <path
                            d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 8h5.8l.6-8"
                            stroke="currentColor"
                            stroke-width="1.3"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                        删除工作区
                      </button>
                    </div>
                  )}
                </span>
              </div>
              {open() && (
                <>
                  <For each={displayedSessions()}>
                    {(session) => (
                      <TreeRow
                        label={session.name}
                        selected={props.selected === session.id}
                        status={session.status}
                        badge={session.archived ? "点击恢复" : undefined}
                        depth={1}
                        onClick={() => {
                          if (session.archived && props.onRestore) {
                            props.onRestore(session.id);
                          } else {
                            props.onSelect(session.id, session.name);
                          }
                        }}
                        onAction={
                          session.archived
                            ? props.onRestore
                              ? () => props.onRestore?.(session.id)
                              : undefined
                            : props.onArchive
                              ? () => props.onArchive?.(session.id)
                              : undefined
                        }
                        actionTitle={session.archived ? "恢复会话" : "归档会话"}
                        actionIcon={session.archived ? "↩" : "↓"}
                        bulkMode={props.bulkMode}
                        bulkSelected={props.bulkSelected?.(session.id)}
                        onBulkToggle={
                          props.onBulkToggle
                            ? () => props.onBulkToggle?.(session.id)
                            : undefined
                        }
                        onEdit={() => {
                          setEditingID(session.id);
                          setDraftName(session.name);
                        }}
                        editValue={
                          editingID() === session.id ? draftName() : undefined
                        }
                        onEditChange={setDraftName}
                        onEditCommit={() => {
                          const title = draftName().trim();
                          if (
                            editingID() === session.id &&
                            title &&
                            title !== session.name
                          ) {
                            void props.onRename?.(session.id, title);
                          }
                          setEditingID(null);
                        }}
                        onEditCancel={() => setEditingID(null)}
                      />
                    )}
                  </For>
                  <Show when={group.sessions.length > 5}>
                    <button
                      type="button"
                      class="neu-session-overflow"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleSessionGroup(group.workspaceID);
                      }}
                    >
                      {isSessionsExpanded(group.workspaceID)
                        ? "收起"
                        : `展开其余 ${group.sessions.length - 5} 个会话`}
                    </button>
                  </Show>
                </>
              )}
            </div>
          );
        }}
      </For>
    </div>
  );
}

type GoalEditorTarget = {
  goalID: string;
  revision: number;
  objective: string;
  maxGoalRounds: number;
};

export function AppNeu(props: { ctx: UiPluginContext }) {
  const appNeuStart = performance.now();
  perfLog(
    `[perf] AppNeu component start +${(appNeuStart - ((globalThis as unknown as { __nataliaStartupStart?: number }).__nataliaStartupStart ?? appNeuStart)).toFixed(1)}ms`,
  );
  const [state, setState] = createSignal(
    cloneState(props.ctx.projection.getState()),
  );
  const requestedRightTab = queryParam("rightTab") ?? queryParam("tab");
  const [rightTab, setRightTab] = createSignal<RightTab>(
    requestedRightTab &&
      ["diff", "plan", "governance", "nia", "agent"].includes(requestedRightTab)
      ? requestedRightTab
      : "plan",
  );
  const requestedGovernanceTab = queryParam("governance");
  const governanceInitialTab =
    requestedGovernanceTab &&
    GOVERNANCE_TABS.includes(requestedGovernanceTab as GovernanceTab)
      ? (requestedGovernanceTab as GovernanceTab)
      : undefined;
  const [leftWidth, setLeftWidth] = createSignal(240);
  const [rightWidth, setRightWidth] = createSignal(
    typeof window === "undefined"
      ? 440
      : Math.max(MIN_RIGHT_WIDTH, Math.floor(window.innerWidth / 3)),
  );
  const [resizing, setResizing] = createSignal(false);
  const [leftVisible, setLeftVisible] = createSignal(true);
  const [rightVisible, setRightVisible] = createSignal(true);
  const [layoutMode, setLayoutMode] = createSignal<"wide" | "compact" | "tiny">(
    "wide",
  );
  const [naviOpen, setNaviOpen] = createSignal(true);
  const [mainDraft, setMainDraft] = createSignal("");
  const [chatDraft, setChatDraft] = createSignal("");
  const [mainAttachments, setMainAttachments] = createSignal<
    ComposerAttachment[]
  >([]);
  const [chatAttachments, setChatAttachments] = createSignal<
    ComposerAttachment[]
  >([]);
  const [selectedSession, setSelectedSession] = createSignal("");
  const [selectedSessionID, setSelectedSessionID] = createSignal("");
  const [sessionList, setSessionList] = createSignal<RuntimeSessionSummary[]>(
    [],
  );
  const [workspaces, setWorkspaces] = createSignal<WorkspaceSummary[]>([]);
  const [registeredTools, setRegisteredTools] = createSignal<
    RegisteredToolView[]
  >([]);
  const [panelRequirementContext, setPanelRequirementContext] = createSignal<
    UiPanelRequirementContext | undefined
  >(undefined);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [pluginManagerOpen, setPluginManagerOpen] = createSignal(false);
  const [themeMode, setThemeMode] = createSignal(
    props.ctx.preferences.get<string>("themeMode") ?? "light",
  );
  const layoutProfile = () => NATALIA_SKINS[themeMode()]?.layout;

  createEffect(() => {
    const layout = layoutProfile();
    const left = layout?.regions?.left;
    const right = layout?.regions?.right;
    if (left?.width) setLeftWidth(left.width);
    if (right?.width) setRightWidth(right.width);
    if (left?.visible !== undefined) setLeftVisible(left.visible);
    if (right?.visible !== undefined) setRightVisible(right.visible);
    if (right?.order?.[0]) {
      const first = right.order[0] as RightTab;
      if (rightTabs().some((tab) => tab.id === first)) setRightTab(first);
    }
  });
  const [sessionMenuOpen, setSessionMenuOpen] = createSignal(false);
  const [showArchived, setShowArchived] = createSignal(false);
  const [sessionSearchOpen, setSessionSearchOpen] = createSignal(false);
  const [sessionQuery, setSessionQuery] = createSignal("");
  const [sidebarMenuOpen, setSidebarMenuOpen] = createSignal(false);
  const [bulkSelectMode, setBulkSelectMode] = createSignal(false);
  const [bulkSelected, setBulkSelected] = createSignal<Set<string>>(new Set());
  const [workspaceOpen, setWorkspaceOpen] = createSignal(false);
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = createSignal(false);
  const [settingsWorkspaceID, setSettingsWorkspaceID] = createSignal<
    string | undefined
  >(undefined);
  const [workspaceError, setWorkspaceError] = createSignal<string>("");
  const [reviewRequestedTab, setReviewRequestedTab] = createSignal<
    "git" | "sandbox" | "checkpoint"
  >("git");
  const [reviewRequestedCheckpointID, setReviewRequestedCheckpointID] =
    createSignal<string | undefined>();
  const [pendingRollback, setPendingRollback] = createSignal<
    | {
        turnID: string;
        checkpointID?: string;
        label: string;
        hiddenAfter?: number;
      }
    | undefined
  >();
  const [rollbackNotice, setRollbackNotice] = createSignal<
    | {
        text: string;
        safetyCheckpointID?: string;
        restoredCount: number;
      }
    | undefined
  >();
  const [panelRevision, setPanelRevision] = createSignal(0);
  const [interactiveTerminalAvailable, setInteractiveTerminalAvailable] =
    createSignal(false);
  const [transcriptHistoryLoading, setTranscriptHistoryLoading] =
    createSignal(true);
  const [transcriptOlderLoading, setTranscriptOlderLoading] =
    createSignal(false);
  let historyReplayDone = false;
  let userSelectedSession = false;
  let sessionsRefreshToken = 0;
  let sessionsRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let workspacesRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let sessionsRefreshInFlight: Promise<void> | undefined;
  let workspacesRefreshInFlight: Promise<void> | undefined;
  const naviPager = new PagedTranscriptController<ChatMessageRow>({
    pageSize: 100,
    onPage: (page, direction) => {
      props.ctx.projection.hydrateNaviMessages?.(
        page.data,
        direction === "initial" ? { replace: true } : { direction },
      );
    },
  });
  const niaPager = new PagedTranscriptController<ChatMessageRow>({
    pageSize: 100,
    onPage: (page, direction) => {
      props.ctx.projection.hydrateNiaMessages?.(
        page.data,
        direction === "initial" ? { replace: true } : { direction },
      );
    },
  });
  const [naviPaging, setNaviPaging] = createSignal<PagedTranscriptState>(
    naviPager.snapshot(),
  );
  const [niaPaging, setNiaPaging] = createSignal<PagedTranscriptState>(
    niaPager.snapshot(),
  );
  onCleanup(naviPager.subscribe(() => setNaviPaging(naviPager.snapshot())));
  function chatPageSource(
    channel: "navi" | "nia",
    sessionID: string | undefined,
    input: { cursor?: string; limit: number },
  ) {
    if (!sessionID) return Promise.resolve({ data: [], cursor: {} });
    const surface =
      channel === "navi"
        ? props.ctx.runtime.naviChat
        : props.ctx.runtime.niaChat;
    if (surface?.messagesPage)
      return surface.messagesPage({
        sessionID,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
    return Promise.resolve(surface?.messages?.(sessionID)).then((data) => ({
      data: data ?? [],
      cursor: {},
    }));
  }

  function naviChatPageSource(input: { cursor?: string; limit: number }) {
    return chatPageSource(
      "navi",
      selectedSessionID() || state().sessionID,
      input,
    );
  }

  function niaChatPageSource(input: { cursor?: string; limit: number }) {
    return chatPageSource(
      "nia",
      selectedSessionID() || state().sessionID,
      input,
    );
  }

  async function loadOlderNaviChat() {
    await naviPager.loadOlder();
    setState(cloneState(props.ctx.projection.getState()));
  }

  async function loadOlderNiaChat() {
    await niaPager.loadOlder();
    setState(cloneState(props.ctx.projection.getState()));
  }

  function mainTranscriptPageSource(
    sessionID: string | undefined,
    input: { cursor?: string; limit: number },
  ) {
    if (!sessionID || !props.ctx.runtime.messages)
      return Promise.resolve({ data: [], cursor: {} });
    return props.ctx.runtime.messages({
      sessionID,
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
  }

  const mainPager = new PagedTranscriptController<RuntimeProjectedMessage>({
    pageSize: 100,
    onPage: (page, direction) => {
      props.ctx.projection.hydrateMessages?.(
        [...page.data].reverse(),
        direction === "initial" ? "newer" : direction,
        { replace: direction === "initial" },
      );
    },
  });
  const [mainPaging, setMainPaging] = createSignal<PagedTranscriptState>(
    mainPager.snapshot(),
  );
  onCleanup(mainPager.subscribe(() => setMainPaging(mainPager.snapshot())));
  onCleanup(() => mainPager.dispose());

  onCleanup(niaPager.subscribe(() => setNiaPaging(niaPager.snapshot())));
  onCleanup(() => naviPager.dispose());
  onCleanup(() => niaPager.dispose());

  const [statusOpen, setStatusOpen] = createSignal(false);
  const [turnElapsedMs, setTurnElapsedMs] = createSignal(0);
  const [showJumpToBottom, setShowJumpToBottom] = createSignal(false);
  const [chatShowJumpToBottom, setChatShowJumpToBottom] = createSignal(false);
  let transcriptApi: TranscriptHandle | undefined;
  let chatTranscriptApi: TranscriptHandle | undefined;
  const [chatElapsedMs, setChatElapsedMs] = createSignal(0);

  function scrollMainTranscriptToBottom() {
    transcriptApi?.scrollToBottom();
  }

  function scrollChatTranscriptToBottom() {
    chatTranscriptApi?.scrollToBottom();
  }

  // --- Goal status-bar controls: one pause/resume toggle + inline editor ---
  const [goalEditOpen, setGoalEditOpen] = createSignal(false);
  const [goalEditObjective, setGoalEditObjective] = createSignal("");
  const [goalEditCap, setGoalEditCap] = createSignal("");
  const [goalNotice, setGoalNotice] = createSignal("");
  const [goalBusy, setGoalBusy] = createSignal(false);
  let goalNoticeTimer: ReturnType<typeof setTimeout> | undefined;

  function goalTargetSessionID(): string | undefined {
    return selectedSessionID() || state().sessionID;
  }

  function flashGoalNotice(message: string) {
    setGoalNotice(message);
    if (goalNoticeTimer) clearTimeout(goalNoticeTimer);
    goalNoticeTimer = setTimeout(() => setGoalNotice(""), 4000);
  }

  async function runGoalControl(
    action: "pause" | "resume" | "clear",
  ): Promise<void> {
    const sessionID = goalTargetSessionID();
    if (!sessionID) return;
    setGoalBusy(true);
    try {
      const result = await props.ctx.runtime.goalControl?.(action, sessionID);
      if (result && !result.ok)
        flashGoalNotice(result.message ?? `goal ${action} refused`);
      else if (action === "clear") setGoalEditOpen(false);
    } catch (error) {
      flashGoalNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setGoalBusy(false);
    }
  }

  function openGoalEditor(goal: GoalEditorTarget) {
    setGoalEditObjective(goal.objective);
    setGoalEditCap(goal.maxGoalRounds === 0 ? "" : String(goal.maxGoalRounds));
    setGoalEditOpen(true);
  }

  async function saveGoalEditor(goal: GoalEditorTarget): Promise<void> {
    const sessionID = goalTargetSessionID();
    if (!sessionID) return;
    const objective = goalEditObjective().trim();
    if (!objective) {
      flashGoalNotice("goal objective must not be empty");
      return;
    }
    const capRaw = goalEditCap().trim();
    const maxGoalRounds = capRaw === "" ? undefined : Number(capRaw);
    if (
      maxGoalRounds !== undefined &&
      (!Number.isInteger(maxGoalRounds) || maxGoalRounds < 0)
    ) {
      flashGoalNotice("round cap must be a non-negative integer");
      return;
    }
    if (objective === goal.objective && maxGoalRounds === undefined) {
      setGoalEditOpen(false);
      return;
    }
    setGoalBusy(true);
    try {
      const result = await props.ctx.runtime.goalEdit?.(
        {
          goalID: goal.goalID,
          revision: goal.revision,
          ...(objective !== goal.objective ? { objective } : {}),
          ...(maxGoalRounds !== undefined ? { maxGoalRounds } : {}),
        },
        sessionID,
      );
      if (result && !result.ok) {
        flashGoalNotice(result.message ?? "goal edit refused");
        return;
      }
      setGoalEditOpen(false);
    } catch (error) {
      flashGoalNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setGoalBusy(false);
    }
  }

  const activeTurnStartedAt = createSignal<number | undefined>(undefined);
  const [activeTurnStartedAtValue, setActiveTurnStartedAt] =
    activeTurnStartedAt;
  const [modelOpen, setModelOpen] = createSignal(false);
  const [modelCatalog, setModelCatalog] = createSignal<
    RuntimeModelCatalogEntry[]
  >([]);
  const [modelSelectionSignal, setModelSelectionSignal] = createSignal<
    { modelID?: string; variant?: string } | undefined
  >(undefined);
  const [config, setConfig] = createSignal<ConfigV3 | undefined>(undefined);
  const [reasoningEffort, setReasoningEffortSignal] =
    createSignal<string>("medium");
  const [chatProfile, setChatProfile] = createSignal<ChatModelProfile>({});
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [stashOpen, setStashOpen] = createSignal(false);
  const [sandboxOpen, setSandboxOpen] = createSignal(false);
  const [topbarPanel, setTopbarPanel] = createSignal<{
    pluginId: string;
    panelId: string;
  } | null>(null);
  const [moreOpen, setMoreOpen] = createSignal(false);
  const { confirm, alert, dialog } = useConfirmDialog();
  const [viewOpen, setViewOpen] = createSignal(false);
  let topbarPanelRef: HTMLDivElement | undefined;

  async function refreshModelConfig() {
    if (!props.ctx.runtime.configGet) {
      throw new Error("configGet runtime method unavailable");
    }
    if (!props.ctx.runtime.modelCatalog) {
      throw new Error("modelCatalog runtime method unavailable");
    }
    const [nextConfig, nextCatalog] = await Promise.all([
      props.ctx.runtime.configGet(),
      props.ctx.runtime.modelCatalog(),
    ]);
    setConfig(nextConfig);
    setModelCatalog(nextCatalog);
  }

  let projectionFramePending = false;
  let suppressProjectionClones = false;
  onCleanup(
    props.ctx.projection.subscribe((next) => {
      const replaying = (
        globalThis as unknown as {
          __nataliaReplayingHistory?: boolean;
        }
      ).__nataliaReplayingHistory;
      // During a full history replay the projection emits one event at a time.
      // Cloning the whole AppState after every raw event is O(n^2) for long
      // sessions, so skip the heavy clones until the replay completes and then
      // take one final snapshot in openUnresolvedInteractives.
      if (replaying || suppressProjectionClones) return;
      // Live events stream as many small deltas per second. Clone the
      // projection at most once per animation frame and let Solid paint one
      // batched frame instead of one clone/update per raw event.
      if (projectionFramePending) return;
      projectionFramePending = true;
      requestAnimationFrame(() => {
        projectionFramePending = false;
        void (async () => {
          let projected: AppState;
          try {
            projected = await cloneStateInWorker(
              props.ctx.projection.getState(),
            );
          } catch {
            projected = cloneState(props.ctx.projection.getState());
          }
          const setStart = performance.now();
          setState(projected);
          const setMs = performance.now() - setStart;
          perfLog(
            `[perf] renderer projection frame messages=${projected.messages.length} navi=${projected.navi.messages.length} nia=${projected.nia.messages.length} set=${setMs.toFixed(1)}ms`,
          );
          if (projected.workspaces.length)
            mergeProjectedWorkspaces(projected.workspaces);
          const currentTurn = projected.activeTurn;
          if (currentTurn && activeTurnStartedAtValue() === undefined) {
            setActiveTurnStartedAt(Date.now());
          } else if (!currentTurn && activeTurnStartedAtValue() !== undefined) {
            setActiveTurnStartedAt(undefined);
            setTurnElapsedMs(0);
          }
        })();
      });
    }),
  );

  async function refreshWorkspaces() {
    if (workspacesRefreshInFlight) return workspacesRefreshInFlight;
    const phaseStart = performance.now();
    workspacesRefreshInFlight = (async () => {
      const roots = await props.ctx.runtime.workspaceRoots?.();
      perfLog(
        `[perf] refreshWorkspaces done roots=${roots?.length ?? 0} +${(performance.now() - phaseStart).toFixed(1)}ms`,
      );
      if (roots) {
        const current = workspaces();
        if (!current || JSON.stringify(current) !== JSON.stringify(roots)) {
          setWorkspaces(roots);
        }
      }
    })().finally(() => {
      workspacesRefreshInFlight = undefined;
    });
    return workspacesRefreshInFlight;
  }

  function mergeProjectedWorkspaces(projected: WorkspaceSummary[]) {
    setWorkspaces((current) => {
      const byID = new Map(
        current.map((workspace) => [workspace.workspaceID, workspace]),
      );
      for (const workspace of projected) {
        const existing = byID.get(workspace.workspaceID);
        byID.set(
          workspace.workspaceID,
          existing ? { ...existing, ...workspace } : workspace,
        );
      }
      return [...byID.values()];
    });
  }

  function markStartup(phase: string) {
    const global = globalThis as unknown as {
      __nataliaStartupStart?: number;
      __nataliaStartupTimings?: Record<string, number>;
    };
    global.__nataliaStartupStart ??= performance.now();
    const timings = (global.__nataliaStartupTimings ??= {});
    const elapsed = performance.now() - global.__nataliaStartupStart;
    timings[phase] = elapsed;
    perfLog(`[startup] ${phase} +${elapsed.toFixed(1)}ms`);
  }

  function logStartupSummary() {
    (
      globalThis as unknown as {
        __nataliaStartupComplete?: boolean;
      }
    ).__nataliaStartupComplete = true;
    perfLog("[web-ui] startup complete");
  }

  async function loadAttachmentUrl(attachment: Attachment) {
    const sessionID = selectedSessionID() || state().sessionID;
    const key =
      attachment.id && sessionID
        ? `${sessionID}:${attachment.id}`
        : `path:${attachment.path}`;
    const cached = attachmentDataUrlCache.get(key);
    if (cached) return cached;
    const load = Promise.resolve(
      props.ctx.runtime.attachmentDataUrl?.({
        ...(attachment.id && sessionID
          ? { attachmentID: attachment.id, sessionID }
          : {}),
        path: attachment.path,
        mediaType: attachment.mediaType ?? "image/png",
      }),
    )
      .then((result) => result ?? "")
      .catch((error) => {
        attachmentDataUrlCache.delete(key);
        throw error;
      });
    attachmentDataUrlCache.set(key, load);
    return load;
  }

  function handlePasteAttachments(
    event: ClipboardEvent,
    current: ComposerAttachment[],
    setAttachments: (value: ComposerAttachment[]) => void,
  ) {
    const items = Array.from(event.clipboardData?.items ?? []);
    const files = items
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!files.length) return;
    event.preventDefault();
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? "");
        const base64 = dataUrl.split(",")[1];
        if (!base64) return;
        void props.ctx.runtime
          .uploadAttachment?.({
            name: file.name || "attachment",
            mediaType: file.type || "application/octet-stream",
            data: base64,
          })
          .then((attachment) => {
            setAttachments([
              ...current,
              {
                path: attachment.path,
                name: attachment.filename,
                ...(file.type.startsWith("image/")
                  ? { previewUrl: dataUrl }
                  : {}),
              },
            ]);
          });
      };
      reader.readAsDataURL(file);
    }
  }

  function debouncedRefreshWorkspaces(delay = 1000) {
    if (workspacesRefreshTimer) clearTimeout(workspacesRefreshTimer);
    workspacesRefreshTimer = setTimeout(() => {
      workspacesRefreshTimer = undefined;
      runIdle(() => void refreshWorkspaces());
    }, delay);
  }

  function sessionRecency(session: RuntimeSessionSummary) {
    return new Date(session.lastAccessedAt ?? session.createdAt).getTime();
  }

  function debouncedRefreshSessions(delay = 1000) {
    if (sessionsRefreshTimer) clearTimeout(sessionsRefreshTimer);
    sessionsRefreshTimer = setTimeout(() => {
      sessionsRefreshTimer = undefined;
      runIdle(() => void refreshSessions());
    }, delay);
  }

  async function refreshSessions() {
    if (sessionsRefreshInFlight) return sessionsRefreshInFlight;
    const phaseStart = performance.now();
    const token = ++sessionsRefreshToken;
    let operation: Promise<void>;
    operation = (async () => {
      try {
        const sessions = await props.ctx.runtime.sessionList?.();
        perfLog(
          `[perf] refreshSessions done count=${sessions?.length ?? 0} +${(performance.now() - phaseStart).toFixed(1)}ms`,
        );
        if (token !== sessionsRefreshToken) return;
        if (sessions) {
          const current = sessionList();
          if (
            !current ||
            JSON.stringify(current) !== JSON.stringify(sessions)
          ) {
            setSessionList(sessions);
          }
          if (!userSelectedSession && sessions.length) {
            const active = state().sessionID;
            const target = active
              ? sessions.find(
                  (session) => session.id === active && !session.archived,
                )
              : undefined;
            if (target) {
              setSelectedSessionID(target.id);
              setSelectedSession(target.title);
            } else if (!selectedSessionID()) {
              // While the runtime is still attaching/restoring the startup session,
              // do not race it with a local fallback. The final selection is
              // determined by natalia:recent-session-restored / session.ready and
              // then projected once by openUnresolvedInteractives.
              const load = globalThis as unknown as {
                __nataliaReplayingHistory?: boolean;
              };
              if (load.__nataliaReplayingHistory) return;
              const recent = sessions
                .filter((session) => !session.archived)
                .sort((a, b) => sessionRecency(b) - sessionRecency(a));
              const touched = recent.filter(
                (session) => session.lastAccessedAt,
              );
              const meaningful = recent.filter(
                (session) => session.title && session.title !== "New session",
              );
              const nonEmpty = recent.filter((session) => session.events > 0);
              const fallbackSource = touched.length
                ? touched
                : meaningful.length
                  ? meaningful
                  : nonEmpty.length
                    ? nonEmpty
                    : recent;
              const fallback = fallbackSource[0] ?? sessions[0];
              if (fallback) {
                setSelectedSessionID(fallback.id);
                setSelectedSession(fallback.title);
              }
            }
          }
        }
      } finally {
        if (token === sessionsRefreshToken) {
          sessionsRefreshInFlight = undefined;
        }
      }
    })();
    sessionsRefreshInFlight = operation;
    return operation;
  }

  const visibleSessions = (): RuntimeSessionSummary[] => {
    const query = sessionQuery().trim().toLowerCase();
    return sessionList().filter((session) => {
      if (showArchived() ? !session.archived : session.archived) return false;
      if (query && !session.title.toLowerCase().includes(query)) return false;
      return true;
    });
  };

  async function createSession(workspaceID?: string) {
    if (workspaceID) {
      if (!props.ctx.runtime.workspaceActivate) {
        await alert({
          title: "新建会话",
          message: "当前 runtime 不支持切换工作区。",
        });
        return;
      }
      await props.ctx.runtime.workspaceActivate(workspaceID);
    }
    const created = await props.ctx.runtime.sessionNew?.();
    if (created?.sessionID) {
      userSelectedSession = true;
      const nextSessionID = created.sessionID;
      setSelectedSessionID(nextSessionID);
      setSelectedSession("新会话");
      await props.ctx.runtime.sessionAttach?.(nextSessionID);
      void loadPerSessionModelConfig(nextSessionID);
    }
    await refreshWorkspaces();
    // A refresh requested before sessionNew may still be in flight. Drop it so
    // the newly created session cannot be missed by a stale list response.
    sessionsRefreshInFlight = undefined;
    await refreshSessions();
  }

  async function renameWorkspace(workspaceID: string, title: string) {
    const workspace = workspaces().find(
      (entry) => entry.workspaceID === workspaceID,
    );
    const nextTitle = title.trim();
    if (!workspace || !nextTitle) return;
    if (
      workspaces().some(
        (entry) =>
          entry.workspaceID !== workspaceID && entry.title === nextTitle,
      )
    ) {
      await alert({
        title: "重命名工作区",
        message: `已存在名为“${nextTitle}”的工作区。`,
      });
      return;
    }
    if (!props.ctx.runtime.workspaceAdd) {
      await alert({
        title: "重命名工作区",
        message: "当前 runtime 不支持重命名工作区。",
      });
      return;
    }
    try {
      await props.ctx.runtime.workspaceAdd({
        path: workspace.root,
        title: nextTitle,
      });
      await refreshWorkspaces();
    } catch (error: unknown) {
      await alert({
        title: "重命名失败",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function removeWorkspace(workspaceID: string) {
    const workspace = workspaces().find(
      (entry) => entry.workspaceID === workspaceID,
    );
    const confirmed = await confirm({
      title: "删除工作区",
      message: `将把“${workspace?.title ?? workspaceID}”从工作区列表中移除。工作区中的文件和会话不会被删除。`,
      confirmLabel: "删除工作区",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await props.ctx.runtime.workspaceRemove?.(workspaceID);
      await refreshWorkspaces();
      await refreshSessions();
    } catch (error: unknown) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    }
  }

  function selectedSessionIsActive() {
    return Boolean(
      selectedSessionID() && selectedSessionID() === state().sessionID,
    );
  }

  function workspaceIDForSessionID(sessionID: string): string | undefined {
    const fromList = sessionList().find(
      (session) => session.id === sessionID,
    )?.workspaceID;
    if (fromList) return fromList;
    const fromState = state().sessions.find(
      (session) => session.id === sessionID,
    )?.workspaceID;
    if (fromState) return fromState;
    if (sessionID === selectedSessionID() || sessionID === state().sessionID)
      return state().activeWorkspaceID;
    return undefined;
  }

  async function attachAndSelectSession(session: {
    id: string;
    title: string;
  }): Promise<void> {
    const attach = props.ctx.runtime.sessionAttach;
    if (typeof attach !== "function")
      throw new Error("当前 runtime 不支持会话切换。");
    // Select locally before awaiting attach: the web runtime emits
    // `natalia:session-attached` from inside the attach promise, and the
    // hydration listener reads selectedSessionID() at that moment. Updating the
    // signals afterwards makes hydration load the previous session even though
    // the tree already shows the new one.
    const previousID = selectedSessionID();
    const previousTitle = selectedSession();
    const previousUserSelected = userSelectedSession;
    userSelectedSession = true;
    setSelectedSessionID(session.id);
    setSelectedSession(session.title);
    try {
      await attach(session.id);
      void loadPerSessionModelConfig(session.id);
    } catch (error) {
      userSelectedSession = previousUserSelected;
      setSelectedSessionID(previousID);
      setSelectedSession(previousTitle);
      throw error;
    }
  }

  async function switchAwayFromSession(targetID: string): Promise<boolean> {
    const findOther = (list: RuntimeSessionSummary[]) => {
      const candidates = list.filter(
        (session) => session.id !== targetID && !session.archived,
      );
      if (!candidates.length) return undefined;
      const targetWorkspaceID = workspaceIDForSessionID(targetID);
      if (targetWorkspaceID) {
        const sameWorkspace = candidates.find(
          (session) => session.workspaceID === targetWorkspaceID,
        );
        if (sameWorkspace) return sameWorkspace;
      }
      return candidates[0];
    };
    let other = findOther(sessionList());
    if (!other) {
      // A stale/short list must not force a brand-new session when older
      // sessions already exist. Refresh once before falling back to creation.
      sessionsRefreshInFlight = undefined;
      await refreshSessions();
      other = findOther(sessionList());
    }
    if (!other) other = findOther(state().sessions);
    if (other) {
      await attachAndSelectSession(other);
      return true;
    }
    const created = await props.ctx.runtime.sessionNew?.();
    if (!created?.sessionID) return false;
    await attachAndSelectSession({
      id: created.sessionID,
      title: "新会话",
    });
    return true;
  }

  async function archiveSession(targetID: string) {
    try {
      if (targetID === selectedSessionID()) {
        const switched = await switchAwayFromSession(targetID);
        if (!switched) {
          props.ctx.runtime.diagnostic?.(
            "归档当前会话前需要先创建或切换到其他会话，但当前 runtime 不支持。",
            "warning",
          );
          return;
        }
      }
      await props.ctx.runtime.sessionArchive?.(targetID);
      await refreshSessions();
    } catch (error: unknown) {
      props.ctx.runtime.diagnostic?.(
        `归档会话失败：${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  }

  async function restoreSession(sessionID: string) {
    try {
      await props.ctx.runtime.sessionRestore?.(sessionID);
      await refreshSessions();
    } catch (error: unknown) {
      props.ctx.runtime.diagnostic?.(
        `恢复会话失败：${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  }

  async function forkSessionAtTurn(turnID: string) {
    const sourceID = selectedSessionID() || state().sessionID;
    if (!sourceID) return;
    try {
      const result = await props.ctx.runtime.sessionFork?.(
        sourceID,
        turnID,
        `Fork of ${selectedSession()}`,
      );
      if (result) await refreshSessions();
    } catch (error: unknown) {
      props.ctx.runtime.diagnostic?.(
        `Fork 会话失败：${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  }

  function toggleBulkSelected(id: string) {
    const next = new Set(bulkSelected());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setBulkSelected(next);
  }

  function toggleSelectAllVisible() {
    const ids = visibleSessions().map((session) => session.id);
    if (!ids.length) return;
    const next = new Set(bulkSelected());
    const allSelected = ids.every((id) => next.has(id));
    for (const id of ids) {
      if (allSelected) next.delete(id);
      else next.add(id);
    }
    setBulkSelected(next);
  }

  async function switchAwayFromActiveIfNeeded(ids: string[]) {
    const active = state().sessionID;
    if (!active || !ids.includes(active)) return true;
    const activeWorkspaceID =
      workspaceIDForSessionID(active) ?? state().activeWorkspaceID;
    const candidates = sessionList().filter(
      (session) => !ids.includes(session.id) && !session.archived,
    );
    const other =
      (activeWorkspaceID
        ? candidates.find(
            (session) => session.workspaceID === activeWorkspaceID,
          )
        : undefined) ?? candidates[0];
    if (other) {
      await attachAndSelectSession(other);
      return true;
    }
    const created = await props.ctx.runtime.sessionNew?.();
    if (!created?.sessionID) {
      props.ctx.runtime.diagnostic?.(
        "批量操作当前唯一会话前需要先创建并切换到新会话。",
        "warning",
      );
      return false;
    }
    await attachAndSelectSession({
      id: created.sessionID,
      title: "新会话",
    });
    return true;
  }

  async function bulkArchiveSelected() {
    const ids = [...bulkSelected()];
    if (!ids.length) return;
    if (!(await switchAwayFromActiveIfNeeded(ids))) return;
    for (const id of ids) await props.ctx.runtime.sessionArchive?.(id);
    await refreshSessions();
    setBulkSelected(new Set<string>());
    setBulkSelectMode(false);
  }

  async function bulkRestoreSelected() {
    const ids = [...bulkSelected()];
    if (!ids.length) return;
    for (const id of ids) await props.ctx.runtime.sessionRestore?.(id);
    await refreshSessions();
    setBulkSelected(new Set<string>());
    setBulkSelectMode(false);
  }

  async function bulkDeleteSelected() {
    const ids = [...bulkSelected()];
    if (!ids.length) return;
    if (
      !(await confirm({
        title: "删除会话",
        message: `确定彻底删除选中的 ${ids.length} 个会话吗？这会删除会话记录和附件，无法恢复。`,
        confirmLabel: "确定",
        cancelLabel: "取消",
        danger: true,
      }))
    )
      return;
    try {
      if (!(await switchAwayFromActiveIfNeeded(ids))) return;
      if (!props.ctx.runtime.sessionDelete) {
        props.ctx.runtime.diagnostic?.(
          "当前 runtime 不支持彻底删除会话。",
          "warning",
        );
        return;
      }
      for (const id of ids) await props.ctx.runtime.sessionDelete(id);
      await refreshSessions();
      setBulkSelected(new Set<string>());
      setBulkSelectMode(false);
    } catch (error: unknown) {
      props.ctx.runtime.diagnostic?.(
        `批量删除失败：${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  }

  function checkpointIDForMessage(message: Message) {
    const turnID = sessionTurnID(message.id);
    if (!turnID) return undefined;
    const checkpoint = state()
      .checkpoints.filter((candidate) => candidate.turnID === turnID)
      .sort((a, b) => b.sequence - a.sequence)[0];
    return checkpoint?.id;
  }

  function rollbackDraftFromMessage(message: Message) {
    const checkpointID = checkpointIDForMessage(message);
    const turnID = sessionTurnID(message.id);
    const messages = mainMessages();
    const userMessage = turnID
      ? messages.find(
          (candidate) =>
            sessionTurnID(candidate.id) === turnID && candidate.role === "user",
        )
      : undefined;
    const targetIndex = messages.findIndex(
      (candidate) => candidate.id === message.id,
    );
    if (userMessage) setMainDraft(userMessage.content);
    setPendingRollback({
      turnID: turnID ?? message.id,
      ...(checkpointID ? { checkpointID } : {}),
      label: userMessage?.content || message.content || "该消息",
      hiddenAfter: targetIndex >= 0 ? targetIndex + 1 : undefined,
    });
    setRollbackNotice(undefined);
    if (checkpointID) {
      setReviewRequestedTab("checkpoint");
      setReviewRequestedCheckpointID(checkpointID);
      setRightVisible(true);
      setRightTab("diff");
    }
  }

  async function hydrateRecentMessages(options?: { replace?: boolean }) {
    const sessionID = selectedSessionID() || state().sessionID;
    await hydrateRecentMessagesForSession(sessionID, () => true, options);
  }

  async function hydrateRecentMessagesForSession(
    sessionID: string | undefined,
    isCurrent: () => boolean,
    options?: { replace?: boolean },
  ) {
    const hydrateStart = performance.now();
    setTranscriptHistoryLoading(true);
    mainPager.setSource((input) => mainTranscriptPageSource(sessionID, input));
    try {
      await mainPager.loadInitial();
    } catch (error) {
      setTranscriptHistoryLoading(false);
      throw error;
    }
    // A superseded/expired load must still release the transcript's initial
    // loading gate, otherwise the tail state machine waits forever.
    if (!isCurrent()) {
      setTranscriptHistoryLoading(false);
      return;
    }
    const hydrated = props.ctx.projection.getState();
    if (
      options?.replace ||
      state().natalia.messages.length !== hydrated.natalia.messages.length
    ) {
      setState(cloneState(hydrated));
    }
    perfLog(
      "[hydrate] applied",
      JSON.stringify({
        sessionID,
        projectedMessages: hydrated.natalia.messages.length,
        uiMessages: state().natalia.messages.length,
      }),
    );
    setTranscriptHistoryLoading(false);
    perfLog(
      `[perf] messages hydrate total ${(performance.now() - hydrateStart).toFixed(1)}ms`,
    );
  }

  async function refreshTranscript() {
    await hydrateRecentMessages({ replace: true });
    setState(cloneState(props.ctx.projection.getState()));
  }

  function cancelPendingRollback() {
    setPendingRollback(undefined);
  }

  async function redoAppliedRollback() {
    const notice = rollbackNotice();
    if (!notice?.safetyCheckpointID) {
      setRollbackNotice(undefined);
      return;
    }
    try {
      await props.ctx.runtime.checkpointRollback?.({
        id: notice.safetyCheckpointID,
        sessionID: selectedSessionID() || state().sessionID,
      });
      await refreshTranscript();
    } catch (error: unknown) {
      props.ctx.runtime.diagnostic?.(
        `重做失败：${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    } finally {
      setRollbackNotice(undefined);
    }
  }

  async function physicallyDeleteSelectedSession() {
    const targetID = selectedSessionID();
    if (!targetID) return;
    if (
      !(await confirm({
        title: "删除会话",
        message: `确定要彻底删除会话“${selectedSession()}”吗？这会删除会话记录和附件，无法恢复。`,
        confirmLabel: "确定",
        cancelLabel: "取消",
        danger: true,
      }))
    ) {
      return;
    }
    const deleteSession = props.ctx.runtime.sessionDelete;
    if (typeof deleteSession !== "function") {
      await alert({
        title: "删除失败",
        message: "当前 runtime 不支持彻底删除会话。",
      });
      return;
    }
    try {
      if (targetID === selectedSessionID()) {
        const switched = await switchAwayFromSession(targetID);
        if (!switched) {
          await alert({
            title: "删除失败",
            message: "彻底删除当前会话前无法创建或切换到其他会话。",
          });
          return;
        }
      }
      await deleteSession(targetID);
      setSessionMenuOpen(false);
      await refreshSessions();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      props.ctx.runtime.diagnostic?.(`彻底删除会话失败：${message}`, "warning");
      await alert({
        title: "删除失败",
        message,
      });
    }
  }

  let perSessionLoadToken = 0;
  async function loadPerSessionModelConfig(sessionID: string) {
    const token = ++perSessionLoadToken;
    setModelSelectionSignal(undefined);
    setReasoningEffortSignal("medium");
    setChatProfile({});
    const [selectionResult, effortResult, profileResult] =
      await Promise.allSettled([
        props.ctx.runtime.modelSelection?.(sessionID),
        props.ctx.runtime.reasoningEffort?.(sessionID),
        props.ctx.runtime.naviChat?.modelProfile?.(sessionID),
      ]);
    const appliedStart = performance.now();
    if (token !== perSessionLoadToken) return;
    const selectionValue =
      selectionResult.status === "fulfilled"
        ? selectionResult.value
        : undefined;
    const effortValue =
      effortResult.status === "fulfilled" ? effortResult.value : undefined;
    const profileValue =
      profileResult.status === "fulfilled" ? profileResult.value : undefined;
    batch(() => {
      if (selectionValue?.modelID) setModelSelectionSignal(selectionValue);
      if (effortValue) setReasoningEffortSignal(effortValue);
      if (
        profileValue &&
        (profileValue.normal?.modelID || profileValue.expert?.modelID)
      )
        setChatProfile(profileValue);
    });
    perfLog(
      `[perf] perSessionModelConfig applied selection=${selectionValue?.modelID ?? "-"} reasoning=${effortValue ?? "-"} profile=${profileValue?.normal?.modelID ?? "-"} +${(performance.now() - appliedStart).toFixed(1)}ms`,
    );
  }

  createEffect(() => {
    const sessionID = selectedSessionID() || state().sessionID;
    if (sessionID) void loadPerSessionModelConfig(sessionID);
  });

  onMount(() => {
    const mountStart = performance.now();
    perfLog(
      `[perf] AppNeu onMount +${(mountStart - ((globalThis as unknown as { __nataliaStartupStart?: number }).__nataliaStartupStart ?? mountStart)).toFixed(1)}ms`,
    );
    const handleKeydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setLeftVisible((value) => !value);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setRightVisible((value) => !value);
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeydown);
    onCleanup(() => window.removeEventListener("keydown", handleKeydown));

    // Real runtime integration: open the approval modal when the model asks
    // for permission during a turn, and refresh workspace/session navigation
    // whenever the multi-workspace runtime publishes a routing event.
    onCleanup(
      props.ctx.events.subscribe((event) => {
        const replaying = (
          globalThis as unknown as {
            __nataliaReplayingHistory?: boolean;
          }
        ).__nataliaReplayingHistory;
        if (replaying) return;
        if (event.type === "turn.submitted" || event.type === "turn.input") {
          // A turn that starts (or an input injected into one) should be visible.
          scrollMainTranscriptToBottom();
          setShowJumpToBottom(false);
        }
        if (
          (event.type === "navi.chat.message.new" ||
            event.type === "navi.chat.message.added") &&
          event.role === "user"
        ) {
          scrollChatTranscriptToBottom();
          setChatShowJumpToBottom(false);
        }
        if (
          event.type.startsWith("workspace.") ||
          event.type === "session.created" ||
          event.type === "session.ready"
        ) {
          debouncedRefreshWorkspaces();
          debouncedRefreshSessions();
        }
      }),
    );

    // After history replay completes, surface only still-unresolved
    // approvals/questions from the restored session. Resolved historical
    // requests are not re-opened because their response events clear them
    // from the view-store pending state during replay.
    const resetProjectionForSessionSwitch = () => {
      historyReplayDone = false;
      setTranscriptHistoryLoading(true);
      lastHydratedSessionID = undefined;
      // A stale in-flight load must not block the same session from being
      // retried after the reset.
      hydratingSessionID = undefined;
      mainPager.reset();
      toolOutputCache.clear();
      setShowJumpToBottom(false);
      setChatShowJumpToBottom(false);
      setMainDraft("");
      setChatDraft("");
      setMainAttachments([]);
      setChatAttachments([]);
      const projected = cloneState(props.ctx.projection.getState());
      setState(projected);
    };
    const unsubscribePanels = props.ctx.host?.subscribePanels(() => {
      setPanelRevision((revision) => revision + 1);
    });
    onCleanup(() => unsubscribePanels?.());
    const elapsedTimer = setInterval(() => {
      if (activeTurnStartedAtValue() !== undefined)
        setTurnElapsedMs(Date.now() - activeTurnStartedAtValue()!);
      if (naviChatActivity()?.startedAt)
        setChatElapsedMs(Date.now() - naviChatActivity()!.startedAt);
    }, 1000);
    onCleanup(() => clearInterval(elapsedTimer));

    window.addEventListener(
      "natalia:session-switch-reset",
      resetProjectionForSessionSwitch,
    );
    onCleanup(() =>
      window.removeEventListener(
        "natalia:session-switch-reset",
        resetProjectionForSessionSwitch,
      ),
    );

    const onRecentSessionRestored = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionID?: string }>).detail;
      if (!detail?.sessionID || userSelectedSession) return;
      const restored = sessionList().find(
        (session) => session.id === detail.sessionID && !session.archived,
      );
      if (restored) {
        setSelectedSessionID(restored.id);
        setSelectedSession(restored.title);
      } else {
        setSelectedSessionID(detail.sessionID);
        setSelectedSession("");
      }
    };
    window.addEventListener(
      "natalia:recent-session-restored",
      onRecentSessionRestored,
    );
    onCleanup(() =>
      window.removeEventListener(
        "natalia:recent-session-restored",
        onRecentSessionRestored,
      ),
    );

    let lastHydratedSessionID: string | undefined;
    let hydratingSessionID: string | undefined;
    const workspaceIDForSession = (sessionID: string) =>
      sessionList().find((session) => session.id === sessionID)?.workspaceID ??
      state().activeWorkspaceID;
    const hydrateRecentMessagesOnLoad = async () => {
      const sessionID = selectedSessionID() || state().sessionID;
      if (!sessionID) {
        // Startup may not have selected/restored the session yet. Retry until
        // runtime publishes the active session rather than hydrating empty data.
        setTimeout(() => void hydrateRecentMessagesOnLoad(), 100);
        return;
      }
      if (
        sessionID === lastHydratedSessionID ||
        sessionID === hydratingSessionID
      )
        return;
      hydratingSessionID = sessionID;
      props.ctx.projection.activateSession?.(
        sessionID,
        workspaceIDForSession(sessionID),
      );
      const loadToken = (
        globalThis as unknown as { __nataliaSessionLoadToken?: number }
      ).__nataliaSessionLoadToken;
      const isCurrentLoad = () =>
        loadToken ===
          (globalThis as unknown as { __nataliaSessionLoadToken?: number })
            .__nataliaSessionLoadToken &&
        sessionID === (selectedSessionID() || state().sessionID);
      const hydrateStart = performance.now();
      perfLog(
        `[perf] hydrateRecentMessagesOnLoad start +${(hydrateStart - ((globalThis as unknown as { __nataliaStartupStart?: number }).__nataliaStartupStart ?? hydrateStart)).toFixed(1)}ms`,
      );
      // Message-first startup: the latest projected page replaces the old
      // full-log replay. The page is newest-last on the wire; reverse it so the
      // projection's older-merge keeps transcript order. This is a baseline
      // replacement, not a paging merge: merging a whole baseline page with
      // live rows via the paging path put new messages before history.
      try {
        await hydrateRecentMessagesForSession(sessionID, isCurrentLoad, {
          replace: true,
        });
      } catch (error) {
        // Release the in-flight guard so the history-replay-complete path can
        // retry instead of leaving the transcript with only live rows.
        perfLog(
          "[hydrate] failed",
          JSON.stringify({
            sessionID,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        if (hydratingSessionID === sessionID) hydratingSessionID = undefined;
        throw error;
      }
      if (!isCurrentLoad()) {
        // A reconnect/newer attach superseded this load. Do not mark the
        // session hydrated; clearing the guard lets the next attach retry the
        // page instead of leaving the transcript partial forever.
        perfLog(
          "[hydrate] stale",
          JSON.stringify({
            sessionID,
            loadToken,
            currentToken: (globalThis as { __nataliaSessionLoadToken?: number })
              .__nataliaSessionLoadToken,
            selected: selectedSessionID() || state().sessionID,
          }),
        );
        if (hydratingSessionID === sessionID) hydratingSessionID = undefined;
        return;
      }
      lastHydratedSessionID = sessionID;
      if (hydratingSessionID === sessionID) hydratingSessionID = undefined;
      // The attach-triggered hydrate can finish while the runtime replay guard
      // is still set; the projection subscription intentionally ignores those
      // notifications, and finishSessionLoad only flushes live events rather
      // than re-syncing an already-applied projection. Push the hydrated state
      // into the UI signal explicitly so the transcript is not left at 0 rows.
      if (
        (globalThis as unknown as { __nataliaReplayingHistory?: boolean })
          .__nataliaReplayingHistory
      ) {
        setState(cloneState(props.ctx.projection.getState()));
      }
      perfLog(
        "[hydrate] onLoad applied",
        JSON.stringify({
          sessionID,
          projectedMessages:
            props.ctx.projection.getState().natalia.messages.length,
          uiMessages: state().natalia.messages.length,
        }),
      );
      markStartup("main.messages");
      // Chat and subagents are secondary surfaces. Hydrate them in the
      // background so the primary transcript paints first and does not wait
      // for extra RPCs before the first visible frame.
      void (async () => {
        const chatStart = performance.now();
        props.ctx.projection.beginNaviHydration?.();
        props.ctx.projection.beginNiaHydration?.();
        naviPager.setSource(naviChatPageSource);
        niaPager.setSource(niaChatPageSource);
        const [, , runtimeNotices] = await Promise.all([
          naviPager.loadInitial(),
          niaPager.loadInitial(),
          // ADR Phase C dual ingestion: the server-projected notices merge
          // into the same view the live `context.instructions` stream feeds.
          props.ctx.runtime.notices?.(sessionID),
        ]);
        perfLog(
          `[perf] secondary chatMessages ${(performance.now() - chatStart).toFixed(1)}ms`,
        );
        if (isCurrentLoad()) {
          if (runtimeNotices?.length)
            props.ctx.projection.hydrateRuntimeNotices?.(runtimeNotices);
          // The projection listener may be suppressed while history is still
          // replaying, so copy the paged Chat projection into the UI signal.
          setState(cloneState(props.ctx.projection.getState()));
          perfLog(
            `[perf] secondary chat applied +${(performance.now() - chatStart).toFixed(1)}ms`,
          );
        }
        markStartup("secondary.loaded");
        const timings = (
          globalThis as unknown as {
            __nataliaStartupTimings?: Record<string, number>;
          }
        ).__nataliaStartupTimings;
        if (timings) {
          perfLog("[startup] complete", timings);
          if (
            (globalThis as { __NATALIA_PERF_VERBOSE?: number })
              .__NATALIA_PERF_VERBOSE === 1
          ) {
            console.table(timings);
          }
        }
        // Sub-agent data is not part of the primary Natalia/Navi/Nia view.
        // Load it slightly later on idle so it never delays first paint or the
        // main-agent chat surfaces.
        void new Promise<void>((resolve) => {
          if (typeof requestIdleCallback !== "undefined") {
            requestIdleCallback(() => resolve(), { timeout: 3000 });
          } else {
            setTimeout(resolve, 1500);
          }
        }).then(async () => {
          if (!isCurrentLoad()) return;
          const subagentsStart = performance.now();
          const subagents = await props.ctx.runtime.subagents?.(sessionID);
          perfLog(
            `[perf] background subagents ${(performance.now() - subagentsStart).toFixed(1)}ms`,
          );
          if (subagents && isCurrentLoad())
            props.ctx.projection.hydrateSubagents?.(subagents);
        });
      })();
    };

    const onSessionAttached = (event: Event) => {
      const sessionID = (event as CustomEvent<{ sessionID?: string }>).detail
        ?.sessionID;
      if (sessionID)
        props.ctx.projection.activateSession?.(
          sessionID,
          workspaceIDForSession(sessionID),
        );
      void hydrateRecentMessagesOnLoad();
    };
    window.addEventListener("natalia:session-attached", onSessionAttached);
    onCleanup(() =>
      window.removeEventListener("natalia:session-attached", onSessionAttached),
    );
    // The host may start and restore the session before this plugin mounts, so
    // hydration must not depend solely on the session-attached event.
    void hydrateRecentMessagesOnLoad();

    const openUnresolvedInteractives = (event: Event) => {
      const openStart = performance.now();
      perfLog(
        `[perf] openUnresolvedInteractives start +${(openStart - ((globalThis as unknown as { __nataliaStartupStart?: number }).__nataliaStartupStart ?? openStart)).toFixed(1)}ms`,
      );
      const detail = (
        event as CustomEvent<{ token?: number; sessionID?: string }>
      ).detail;
      const replayGlobal = globalThis as unknown as {
        __nataliaReplayingHistory?: boolean;
        __nataliaSessionLoadToken?: number;
      };
      const isStaleLoad = () =>
        detail?.token !== undefined &&
        replayGlobal.__nataliaSessionLoadToken !== undefined &&
        detail.token !== replayGlobal.__nataliaSessionLoadToken;
      if (isStaleLoad()) return;
      void (async () => {
        if (isStaleLoad()) return;
        suppressProjectionClones = true;
        try {
          await Promise.all([refreshSessions(), hydrateRecentMessagesOnLoad()]);
        } finally {
          suppressProjectionClones = false;
        }
        if (isStaleLoad()) return;
        // Attach hydrates Navi/Nia in the background, but that request is
        // dropped when the load token changes. Re-request after main history is
        // settled so a slow old session cannot leave both chat streams empty.
        const secondarySessionID =
          detail?.sessionID || selectedSessionID() || state().sessionID;
        if (secondarySessionID) {
          naviPager.setSource((input) =>
            chatPageSource("navi", secondarySessionID, input),
          );
          niaPager.setSource((input) =>
            chatPageSource("nia", secondarySessionID, input),
          );
          await Promise.all([naviPager.loadInitial(), niaPager.loadInitial()]);
          if (isStaleLoad()) return;
        }
        // Session loading finished; take one projection snapshot instead of
        // cloning once per raw event.
        const projected = cloneState(props.ctx.projection.getState());
        const cloneStart = performance.now();
        setState(projected);
        perfLog(
          "[hydrate] ui state",
          JSON.stringify({
            selected: selectedSessionID(),
            projectedSession: projected.sessionID,
            projectedMessages: projected.natalia.messages.length,
          }),
        );
        if (projected.workspaces.length)
          mergeProjectedWorkspaces(projected.workspaces);
        perfLog(
          `[perf] openUnresolvedInteractives hydrate/state clone +${(performance.now() - cloneStart).toFixed(1)}ms`,
        );
        markStartup("first.paint");
        const startupMask = document.getElementById("natalia-startup-mask");
        if (startupMask) {
          startupMask.classList.add("natalia-startup-mask-hide");
          setTimeout(() => startupMask.remove(), 500);
        }
        logStartupSummary();
        void loadSecondaryStartupData();
        // One explicit initial tail alignment. Later measurement/data
        // changes are owned by the shared Transcript controller.
        scrollMainTranscriptToBottom();
        scrollChatTranscriptToBottom();
        perfLog(
          `[perf] openUnresolvedInteractives done +${(performance.now() - openStart).toFixed(1)}ms`,
        );
        historyReplayDone = true;
      })();
    };
    window.addEventListener(
      "natalia:history-replay-complete",
      openUnresolvedInteractives,
    );
    onCleanup(() =>
      window.removeEventListener(
        "natalia:history-replay-complete",
        openUnresolvedInteractives,
      ),
    );
    // Fast session restore can finish before this UI module mounts. When the
    // history-replay-complete event has already fired, replay it locally so
    // the first attach still hydrates messages/chat/terminal instead of
    // waiting forever for an event that will never arrive again.
    const startupTimings = (
      globalThis as unknown as {
        __nataliaStartupTimings?: Record<string, number>;
      }
    ).__nataliaStartupTimings;
    if (startupTimings?.["session.loaded"] !== undefined) {
      queueMicrotask(() =>
        openUnresolvedInteractives(
          new Event("natalia:history-replay-complete"),
        ),
      );
    }

    const applyTheme = () => {
      applyNeuTheme(themeMode(), props.ctx.root);
    };
    applyTheme();
    createEffect(applyTheme);

    // Non-critical startup queries are deferred until the primary transcript
    // has painted. Running them before session.messages competes for the
    // desktop main-process event loop and makes first paint wait longer.
  });

  function runIdle(callback: () => void) {
    const idle = (
      globalThis as unknown as {
        requestIdleCallback?: (
          cb: () => void,
          opts?: { timeout?: number },
        ) => number;
      }
    ).requestIdleCallback;
    if (idle) {
      idle(callback, { timeout: 1000 });
    } else {
      setTimeout(callback, 0);
    }
  }

  function loadSecondaryStartupData() {
    const secondaryStart = performance.now();
    perfLog(
      `[perf] loadSecondaryStartupData start +${(secondaryStart - ((globalThis as unknown as { __nataliaStartupStart?: number }).__nataliaStartupStart ?? secondaryStart)).toFixed(1)}ms`,
    );
    runIdle(() => {
      void Promise.all([
        createUiPanelRequirementContext(props.ctx.runtime).catch(
          () => undefined,
        ),
        props.ctx.runtime.modelCatalog?.().catch(() => undefined),
        props.ctx.runtime
          .registeredTools?.(selectedSessionID() || state().sessionID)
          .catch(() => undefined),
        props.ctx.runtime.configGet?.().catch(() => undefined),
        props.ctx.runtime.plugins?.().catch(() => undefined),
      ]).then(([requirementContext, catalog, tools, nextConfig, plugins]) => {
        const appliedAt = performance.now();
        batch(() => {
          if (requirementContext)
            setPanelRequirementContext(requirementContext);
          if (catalog) setModelCatalog(catalog);
          if (tools) setRegisteredTools(tools);
          if (nextConfig) setConfig(nextConfig);
          setInteractiveTerminalAvailable(
            Boolean(
              plugins?.some((plugin) => plugin.id === "natalia-tool-terminal"),
            ),
          );
        });
        perfLog(
          `[perf] secondary all applied catalog=${catalog?.length ?? 0} tools=${tools?.length ?? 0} plugins=${plugins?.length ?? 0} +${(performance.now() - appliedAt).toFixed(1)}ms`,
        );
      });
    });
    runIdle(() => {
      void debouncedRefreshSessions();
    });
    runIdle(() => {
      void debouncedRefreshWorkspaces();
    });
    perfLog(
      `[perf] loadSecondaryStartupData scheduled +${(performance.now() - secondaryStart).toFixed(1)}ms`,
    );
  }

  const modelOptions = () =>
    (modelCatalog() ?? []).map((entry) => ({
      value: entry.id,
      label: entry.id,
    }));

  const workspaceIDForSelectedSession = () =>
    sessionList().find(
      (session) => session.id === (selectedSessionID() || state().sessionID),
    )?.workspaceID ?? state().activeWorkspaceID;

  const workspaceIDForRightPanels = () =>
    state().activeWorkspaceID ?? workspaceIDForSelectedSession();

  // Remount every right-side panel when the workspace/session changes. The
  // panels hold their own async cursors and editors, so relying on prop
  // updates left plan/review/files showing the previous workspace. Include
  // both the immediately-selected session and the projection's active
  // workspace/session because the runtime hydrates them in separate frames.
  const rightPanelScopeKey = createMemo(
    () =>
      `${workspaceIDForSelectedSession() ?? ""}:${
        state().activeWorkspaceID ?? ""
      }:${selectedSessionID() || "none"}:${state().sessionID || "none"}`,
  );

  const permissionOptions = () =>
    Object.entries(config()?.agentModes ?? {}).map(([name, mode]) => ({
      value: name,
      label: `${name}${config()?.defaultAgentMode === name ? "（默认）" : ""}`,
    }));

  async function changePermission(permission: string) {
    await props.ctx.runtime.updateConfig?.({
      patch: { defaultAgentMode: permission },
      scope: "global",
    } as never);
    const next = await props.ctx.runtime.configGet?.();
    if (next) setConfig(next);
  }

  async function updateChatProfile(next: ChatModelProfile) {
    setChatProfile(next);
    const sessionID = selectedSessionID() || state().sessionID;
    await props.ctx.runtime.naviChat?.setModelProfile?.(next, sessionID);
  }
  function formatValue(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean")
      return String(value);
    if (Array.isArray(value))
      return value
        .map((item) =>
          typeof item === "object" && item !== null
            ? JSON.stringify(item)
            : String(item),
        )
        .join(", ");
    return "";
  }

  const toolOutputCache = new Map<string, string>();
  function formatToolOutput(name: string, output: string): string {
    const cacheKey = `${name}\n${output}`;
    const cached = toolOutputCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const formatted = formatToolOutputUncached(name, output);
    if (toolOutputCache.size >= 512) {
      const oldest = toolOutputCache.keys().next().value;
      if (oldest !== undefined) toolOutputCache.delete(oldest);
    }
    toolOutputCache.set(cacheKey, formatted);
    return formatted;
  }

  function formatToolOutputUncached(name: string, output: string): string {
    if (name === "ask_user") {
      try {
        const parsed = JSON.parse(output) as { answers?: unknown };
        if (Array.isArray(parsed.answers)) {
          const text = parsed.answers
            .flatMap((answer) =>
              Array.isArray(answer) ? answer.map(String) : [String(answer)],
            )
            .filter(Boolean)
            .join("; ");
          if (text) return text;
        }
      } catch {
        // fall through
      }
      return output;
    }
    try {
      const parsed = JSON.parse(output) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => formatValue(item))
          .filter(Boolean)
          .join("\n");
      }
      if (parsed && typeof parsed === "object") {
        return Object.entries(parsed as Record<string, unknown>)
          .map(([key, value]) => {
            const text = formatValue(value);
            return text ? `${key}: ${text}` : key;
          })
          .join("\n");
      }
    } catch {
      // not JSON: keep plain text
    }
    return output;
  }

  async function loadOlderHistory(): Promise<boolean> {
    if (
      !historyReplayDone ||
      !mainPaging().hasOlder ||
      mainPaging().loadingOlder
    )
      return false;
    setTranscriptOlderLoading(true);
    const before = props.ctx.projection.getState().natalia.messages.length;
    try {
      await mainPager.loadOlder();
    } catch {
      return false;
    } finally {
      setTranscriptOlderLoading(false);
    }
    setState(cloneState(props.ctx.projection.getState()));
    return props.ctx.projection.getState().natalia.messages.length > before;
  }

  async function loadNewerHistory() {
    if (
      !historyReplayDone ||
      !mainPaging().hasNewer ||
      mainPaging().loadingNewer
    )
      return;
    await mainPager.loadNewer();
    setState(cloneState(props.ctx.projection.getState()));
  }

  function jumpToBottom() {
    scrollMainTranscriptToBottom();
    setShowJumpToBottom(false);
  }

  function jumpChatToBottom() {
    scrollChatTranscriptToBottom();
    setChatShowJumpToBottom(false);
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 1) return `${seconds}s`;
    return `${minutes}m ${seconds}s`;
  }

  function chatActivityLabel(): string {
    const activity = naviChatActivity();
    if (!activity) return "idle";
    switch (activity.phase) {
      case "waiting":
        return "Waiting";
      case "thinking":
        return "Thinking";
      case "generating":
        return "Generating";
      case "using_tool":
        return activity.toolName
          ? `Using ${activity.toolName}`
          : "Using a tool";
    }
  }

  function activityLabel(): string {
    const activity = selectPrimaryActivity(state());
    if (activity) {
      switch (activity.kind) {
        case "planning":
          return "Planning";
        case "thinking":
          return "Thinking";
        case "generating":
          return "Generating";
        case "tool":
          return activity.label ? `Using ${activity.label}` : "Using a tool";
        case "command":
          return "Running command";
        case "workflow":
          return "Running workflow";
        case "subagent":
          return "Working with subagent";
        case "compacting":
          return "Compacting context";
        case "retrying":
          return "Retrying";
        case "waiting_for_user":
          return "Waiting for input";
        case "paused":
          return "Paused";
      }
    }
    return state().natalia.activeTurn ? "Working" : "Ready";
  }

  const pendingByMessageID = createMemo(() => {
    const map = new Map<string, string>();
    for (const approval of state().pendingApprovals) {
      const link = pendingToolLink(approval.id);
      if (link) map.set(link.messageID, approval.id);
    }
    for (const question of state().pendingQuestions) {
      const link = pendingToolLink(question.id);
      if (link) map.set(link.messageID, question.id);
    }
    return map;
  });

  const pendingCount = createMemo(
    () => state().pendingApprovals.length + state().pendingQuestions.length,
  );

  // Open/disputed drift findings — the治理 tab's PendingBadge (EI Phase 2).
  const [openDriftCount] = createResource(
    () => selectedSessionID() || state().sessionID,
    async (sessionID) => {
      try {
        const page = await props.ctx.runtime.driftFindings?.({ sessionID });
        return (page?.items ?? []).filter(
          (finding) =>
            finding.status === "open" || finding.status === "disputed",
        ).length;
      } catch {
        return 0;
      }
    },
  );

  const mainMessageCache = new Map<
    string,
    { signature: RowSignature; value: Message }
  >();

  const mainMessages = createMemo<Message[]>(() => {
    const list = state().natalia.messages;
    const active = state().natalia.activeTurn;
    // The running marker belongs to the last message of the active turn, not to
    // whatever message happens to be last — a queued or steering input is not
    // running.
    let lastActiveIndex = -1;
    if (active)
      for (let index = list.length - 1; index >= 0; index -= 1)
        if (list[index]!.id.startsWith(`${active}:`)) {
          lastActiveIndex = index;
          break;
        }
    return stableRows(
      mainMessageCache,
      list.map((msg, idx) => {
        const isLast = idx === lastActiveIndex;
        const tool = msg.tool;
        if (tool) {
          const status =
            active && isLast ? "running" : (tool.status as Message["status"]);
          const pendingRequestID = pendingByMessageID().get(msg.id);
          return {
            id: msg.id,
            signature: [
              tool.name,
              tool.result,
              tool.summary,
              tool.status,
              status,
              Boolean(active),
              isLast,
              pendingRequestID,
            ],
            create: () => ({
              id: msg.id,
              role: "assistant",
              content: "",
              status,
              ...(pendingRequestID
                ? {
                    actions: [
                      {
                        label: "处理",
                        primary: true,
                        onClick: () => {
                          setRightTab("pending");
                          props.ctx.pending.controller.focus(pendingRequestID);
                        },
                      },
                    ],
                  }
                : {}),
              toolCalls: [
                {
                  name: tool.name,
                  output: formatToolOutput(
                    tool.name,
                    tool.result ?? tool.summary,
                  ),
                  status: tool.status,
                  summary: tool.summary,
                },
              ],
            }),
          };
        }
        const role =
          msg.role === "user"
            ? "user"
            : msg.role === "system"
              ? "system"
              : "assistant";
        // The attachment array reference survives cloneState, so comparing it
        // by reference is both cheap and correct.
        const attachments =
          msg.role === "user" && msg.attachments?.length
            ? msg.attachments
            : undefined;
        const content = msg.text + (msg.pendingText || "");
        const goalRound =
          msg.role === "system" ? parseGoalRoundPrompt(msg.text) : undefined;
        const status = active && isLast ? "running" : undefined;
        const steering = msg.status === "steering";
        const streaming = Boolean(
          active &&
            isLast &&
            msg.role !== "user" &&
            (msg.pendingText ?? "").length > 0,
        );
        return {
          id: msg.id,
          signature: [
            role,
            msg.role,
            msg.text,
            msg.pendingText ?? "",
            msg.reasoningVisible,
            content,
            status,
            steering,
            streaming,
            goalRound?.round ?? 0,
            Boolean(active),
            isLast,
            attachments,
          ],
          create: () => ({
            id: msg.id,
            role,
            thinking: msg.role === "thinking" && msg.reasoningVisible !== false,
            ...(attachments
              ? {
                  attachments: attachments.map((attachment) => ({
                    id: attachment.id,
                    path: attachment.path,
                    name: attachment.filename,
                    mediaType: attachment.mediaType,
                    ...(attachment.width ? { width: attachment.width } : {}),
                    ...(attachment.height ? { height: attachment.height } : {}),
                  })),
                }
              : {}),
            ...(goalRound ? { goalRound } : {}),
            content,
            status,
            steering,
            streaming,
          }),
        };
      }),
    );
  });

  const visibleMainMessages = createMemo<Message[]>(() => {
    const hiddenAfter = pendingRollback()?.hiddenAfter;
    const messages = mainMessages();
    if (hiddenAfter === undefined) return messages;
    return messages.slice(0, hiddenAfter);
  });

  // The shared Transcript virtualizes long histories, so do not switch
  // between a synthetic tail window and the full paged window here. That
  // data-window swap was racing the scroll anchor restore in CEF.
  const renderedMainMessages = createMemo<Message[]>(() =>
    collapseDuplicateTranscriptRows(
      dedupeTranscriptRowsById(visibleMainMessages()),
    ),
  );

  const naviChatActivity = () => state().navi.activity;

  const chatMessageCache = new Map<
    string,
    { signature: RowSignature; value: Message }
  >();

  const chatMessages = createMemo<Message[]>(() => {
    const list = state().navi.messages;
    const activity = naviChatActivity();
    const lastIndex = list.length - 1;
    return stableRows(
      chatMessageCache,
      list.map((msg, idx) => {
        const isLast = idx === lastIndex;
        const tool = msg.tool;
        if (tool) {
          return {
            id: msg.id,
            signature: [tool.name, tool.result, tool.summary, tool.status],
            create: () => ({
              id: msg.id,
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  name: tool.name,
                  output: formatToolOutput(
                    tool.name,
                    tool.result ?? tool.summary,
                  ),
                },
              ],
            }),
          };
        }
        const role =
          msg.role === "user" ? ("user" as const) : ("assistant" as const);
        const content = msg.text + (msg.pendingText || "");
        const streaming = Boolean(activity && isLast && msg.role !== "user");
        const attachments =
          msg.role === "user" && msg.attachments?.length
            ? msg.attachments
            : undefined;
        return {
          id: msg.id,
          signature: [
            role,
            msg.role,
            msg.text,
            msg.pendingText ?? "",
            msg.reasoningVisible,
            content,
            attachments,
            streaming,
            isLast,
            Boolean(activity),
          ],
          create: () => ({
            id: msg.id,
            role,
            thinking: msg.role === "thinking" && msg.reasoningVisible !== false,
            ...(attachments
              ? {
                  attachments: attachments.map((attachment) => ({
                    id: attachment.id,
                    path: attachment.path,
                    name: attachment.filename,
                    mediaType: attachment.mediaType,
                    ...(attachment.width ? { width: attachment.width } : {}),
                    ...(attachment.height ? { height: attachment.height } : {}),
                  })),
                }
              : {}),
            content,
            streaming,
          }),
        };
      }),
    );
  });

  const renderedChatMessages = createMemo<Message[]>(() =>
    collapseDuplicateTranscriptRows(dedupeTranscriptRowsById(chatMessages())),
  );
  function startResize(
    event: PointerEvent,
    computeWidth: (clientX: number) => number,
    applyWidth: (width: number) => void,
  ) {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture?.(event.pointerId);
    setResizing(true);
    let frame: number | undefined;
    let latest: number | undefined;
    const flush = () => {
      frame = undefined;
      if (latest !== undefined) applyWidth(latest);
    };
    const move = (next: PointerEvent) => {
      latest = computeWidth(next.clientX);
      if (frame === undefined) frame = requestAnimationFrame(flush);
    };
    const finish = (next: PointerEvent) => {
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
        frame = undefined;
      }
      if (latest !== undefined) applyWidth(latest);
      target.releasePointerCapture?.(next.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
      setResizing(false);
      // The Transcript controller pauses follow while resizing and resumes
      // it only if follow was still true when the drag ended.
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
  }

  function startLeftResize(event: PointerEvent) {
    const startX = event.clientX;
    const startWidth = leftWidth();
    startResize(
      event,
      (clientX) =>
        Math.max(
          MIN_SIDEBAR_WIDTH,
          Math.min(MAX_SIDEBAR_WIDTH, startWidth + clientX - startX),
        ),
      setLeftWidth,
    );
  }

  function startRightResize(event: PointerEvent) {
    const startX = event.clientX;
    const startWidth = rightWidth();
    const maxRight = rightPanelMaxWidth();
    startResize(
      event,
      (clientX) =>
        Math.max(
          MIN_RIGHT_WIDTH,
          Math.min(maxRight, startWidth - (clientX - startX)),
        ),
      setRightWidth,
    );
  }

  function cycleThemeMode() {
    const modes = NEU_THEME_MODES;
    const current = themeMode() as (typeof modes)[number];
    const next = modes[(modes.indexOf(current) + 1) % modes.length];
    setThemeMode(next);
    props.ctx.preferences.set("themeMode", next);
  }

  function panelVisible(panel: {
    requires?: import("@anthelia/contracts").UiPanelRequirement[];
  }) {
    const context = panelRequirementContext();
    if (!context) return true;
    return uiPanelRequirementsSatisfied(context, panel.requires);
  }

  // `listPanels()` returns fresh wrapper objects every call, and Solid's
  // <For> keys by identity. Keep stable descriptors so a panelRevision bump
  // does not destroy/recreate the mounted panel (which would remount it and
  // bump the revision again forever).
  const sidePanelCache = new Map<
    string,
    {
      signature: RowSignature;
      value: {
        id: string;
        item: { pluginId: string; panel: UiPanelDefinition };
      };
    }
  >();

  const sidePanels = createMemo(() => {
    panelRevision();
    const list = props.ctx.host?.listPanels() ?? [];
    const rows = list
      .filter((item) => item.panel.region === "side")
      // Metadata-only panels (e.g. the shell's own `chat`) have no mount and
      // cannot be rendered into the rail.
      .filter((item) => typeof item.panel.mount === "function")
      .filter((item) => panelVisible(item.panel))
      // One row per panel id: the shell keys its tabs on the panel id alone, so
      // a duplicate is not a second tab but a second mount slot — and two slots
      // split the sidebar's height between them (the terminal occupied exactly
      // half of it). The host's own dedup covers the armed/mounted split; this
      // keeps the invariant local to the place that mounts.
      .filter(
        (item, index, all) =>
          all.findIndex((other) => other.panel.id === item.panel.id) === index,
      )
      .filter(
        (item) =>
          item.panel.id !== "terminal" || interactiveTerminalAvailable(),
      )
      .map((item) => {
        const id = `${item.pluginId}:${item.panel.id}`;
        return {
          id,
          signature: [
            item.pluginId,
            item.panel.id,
            item.panel.title,
            item.panel.order,
          ] as RowSignature,
          create: () => ({ id, item }),
        };
      });
    return stableRows(sidePanelCache, rows).map((entry) => entry.item);
  });

  const rightTabs = () => {
    panelRevision();
    const tabs: { id: RightTab; label: string }[] = [
      { id: "diff", label: "审阅 / Diff" },
      { id: "plan", label: "计划" },
      { id: "governance", label: "治理" },
      { id: "nia", label: "Nia" },
      { id: "agent", label: "协同" },
      ...sidePanels().map((item) => ({
        id: item.panel.id,
        label: item.panel.title,
      })),
    ];
    const seen = new Set<string>();
    const unique = tabs.filter((tab) =>
      seen.has(tab.id) ? false : (seen.add(tab.id), true),
    );
    const layout = layoutProfile();
    const order = layout?.regions?.right?.order;
    if (order?.length) {
      unique.sort((a, b) => {
        const ai = order.indexOf(a.id);
        const bi = order.indexOf(b.id);
        return (
          (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi)
        );
      });
    }
    return unique;
  };

  function mountSidePanel(
    item: { pluginId: string; panel: { id: string } },
    container: HTMLDivElement,
  ) {
    if (!props.ctx.host) return;
    // The mount races the plugin catalog: a panel whose plugin is still loading
    // throws "ui plugin not loaded", and an unhandled rejection is noise in the
    // console. The catalog's revision change re-renders this slot and retries,
    // so a miss here is expected once — it must be visible, not fatal.
    void props.ctx.host
      .mountPanel(item.pluginId, item.panel.id, container)
      .catch((error: unknown) => {
        console.warn(
          `[panel] ${item.pluginId}:${item.panel.id} mount deferred:`,
          error instanceof Error ? error.message : String(error),
        );
      });
  }

  const topbarPanels = () => {
    panelRevision();
    return (
      props.ctx.host
        ?.listPanels()
        .filter(
          (item) => item.panel.region === "topbar" && panelVisible(item.panel),
        ) ?? []
    );
  };

  const groupedTopbarPanels = () => {
    const groups = new Map<string, ReturnType<typeof topbarPanels>>();
    for (const item of topbarPanels()) {
      const group = item.panel.group ?? "更多";
      const list = groups.get(group) ?? [];
      list.push(item);
      groups.set(group, list);
    }
    return [...groups.entries()];
  };

  function mountTopbarPanel(panel: ReturnType<typeof topbarPanels>[number]) {
    setTopbarPanel({ pluginId: panel.pluginId, panelId: panel.panel.id });
    requestAnimationFrame(() => {
      if (topbarPanelRef && props.ctx.host) {
        void props.ctx.host.mountPanel(
          panel.pluginId,
          panel.panel.id,
          topbarPanelRef,
        );
      }
    });
  }

  onMount(() => {
    const updateLayout = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const screenWidth =
        window.screen?.availWidth || window.screen?.width || width;
      const screenHeight =
        window.screen?.availHeight || window.screen?.height || height;
      const area = width * height;
      const quarterArea = screenWidth * screenHeight * 0.25;
      const tiny =
        width <= 1000 || height <= screenHeight * 0.5 || area <= quarterArea;
      const mode = tiny ? "tiny" : width <= 1700 ? "compact" : "wide";
      setLayoutMode(mode);
      if (mode !== "wide") {
        setLeftVisible(false);
        setRightVisible(false);
      } else {
        setLeftVisible(true);
        setRightVisible(true);
      }
      setNaviOpen(mode !== "tiny");
    };
    updateLayout();
    window.addEventListener("resize", updateLayout);
    onCleanup(() => window.removeEventListener("resize", updateLayout));
  });

  const nataliaVisible = () => layoutMode() !== "tiny" || !naviOpen();
  const naviVisible = () =>
    layoutMode() === "wide" ||
    (layoutMode() === "compact" && !leftVisible() && !rightVisible()) ||
    (layoutMode() === "tiny" &&
      naviOpen() &&
      !leftVisible() &&
      !rightVisible());

  let leftSidebarWasVisible = true;
  createEffect(() => {
    const visible = leftVisible();
    if (visible && !leftSidebarWasVisible) {
      debouncedRefreshSessions();
      debouncedRefreshWorkspaces();
    }
    leftSidebarWasVisible = visible;
  });

  return (
    <div
      class="neu-shell"
      data-compact={layoutMode() !== "wide"}
      data-tiny={layoutMode() === "tiny"}
      data-left-open={leftVisible()}
      data-left-wide={leftWidth() >= 230}
      data-right-open={rightVisible()}
      data-resizing={resizing()}
    >
      <header class="neu-topbar">
        <div class="neu-topbar-left">
          <span class="neu-topbar-logo">N</span>
          <div class="neu-topbar-meta">
            <span class="neu-topbar-title">Natalia</span>
            <span class="neu-topbar-sub">
              The world is not beautiful; therefore it is.
            </span>
          </div>
          {/*
            The danger indicator (sandbox study §6b①): a persistent,
            pre-attentive badge in the app chrome — never inside the PTY
            stream. It reads the session snapshot's confinement posture,
            which is journal-derived; the audit trail reads the same fact.
          */}
          <DangerBadge confinement={state().intelligence?.confinement} />
        </div>
        <div class="neu-topbar-right">
          <button
            type="button"
            class="neu-topbar-btn"
            data-active={viewOpen()}
            onClick={() => setViewOpen((value) => !value)}
          >
            视图
          </button>
          <button
            type="button"
            class="neu-topbar-btn"
            onClick={() => setSearchOpen(true)}
          >
            搜索
          </button>
          <button
            type="button"
            class="neu-topbar-btn neu-topbar-btn-primary"
            onClick={() => setSettingsOpen(true)}
          >
            设置
          </button>
          <button
            type="button"
            class="neu-topbar-btn"
            data-active={moreOpen()}
            onClick={() => setMoreOpen((value) => !value)}
          >
            更多
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
              关闭
            </button>
          </div>
        </Show>
        <Show when={viewOpen()}>
          <div class="neu-topbar-view-dropdown">
            <button
              type="button"
              class="neu-topbar-more-item"
              data-active={leftVisible()}
              onClick={() => {
                setLeftVisible((value) => !value);
                setViewOpen(false);
              }}
            >
              左栏
            </button>
            <button
              type="button"
              class="neu-topbar-more-item"
              data-active={rightVisible()}
              onClick={() => {
                setRightVisible((value) => !value);
                setViewOpen(false);
              }}
            >
              右栏
            </button>
            <Show when={layoutMode() === "tiny"}>
              <button
                type="button"
                class="neu-topbar-more-item"
                data-active={naviOpen()}
                onClick={() => {
                  setNaviOpen((value) => !value);
                  setViewOpen(false);
                }}
              >
                Navi
              </button>
            </Show>
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
              状态
            </button>
            <button
              type="button"
              class="neu-topbar-more-item"
              onClick={() => {
                setHelpOpen(true);
                setMoreOpen(false);
              }}
            >
              帮助
            </button>
            <button
              type="button"
              class="neu-topbar-more-item"
              onClick={() => {
                setStashOpen(true);
                setMoreOpen(false);
              }}
            >
              暂存
            </button>
            <button
              type="button"
              class="neu-topbar-more-item"
              onClick={() => {
                setSandboxOpen(true);
                setMoreOpen(false);
              }}
            >
              沙箱
            </button>
            <button
              type="button"
              class="neu-topbar-more-item"
              onClick={() => {
                setPluginManagerOpen(true);
                setMoreOpen(false);
              }}
            >
              插件
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
      <div class="neu-app">
        {/* Left session tree */}
        {leftVisible() ? (
          <>
            <aside class="neu-sidebar" style={{ width: `${leftWidth()}px` }}>
              <div class="neu-sidebar-header">
                <span class="neu-sidebar-title">工作区</span>
                <div class="neu-sidebar-actions">
                  <button
                    type="button"
                    class="neu-icon-btn"
                    title="搜索会话"
                    data-active={sessionSearchOpen()}
                    onClick={() => {
                      setSessionSearchOpen((value) => !value);
                      setSidebarMenuOpen(false);
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                      <circle
                        cx="7"
                        cy="7"
                        r="4.5"
                        stroke="currentColor"
                        stroke-width="1.4"
                      />
                      <path
                        d="M10.3 10.3L13.5 13.5"
                        stroke="currentColor"
                        stroke-width="1.4"
                        stroke-linecap="round"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="neu-icon-btn"
                    title="更多会话操作"
                    data-active={sidebarMenuOpen()}
                    onClick={() => {
                      setSidebarMenuOpen((value) => !value);
                      setSessionSearchOpen(false);
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                      <path
                        d="M3 4.5h10"
                        stroke="currentColor"
                        stroke-width="1.3"
                        stroke-linecap="round"
                      />
                      <circle
                        cx="6"
                        cy="4.5"
                        r="1.6"
                        fill="var(--neu-bg-light)"
                        stroke="currentColor"
                        stroke-width="1.3"
                      />
                      <path
                        d="M3 11.5h10"
                        stroke="currentColor"
                        stroke-width="1.3"
                        stroke-linecap="round"
                      />
                      <circle
                        cx="10"
                        cy="11.5"
                        r="1.6"
                        fill="var(--neu-bg-light)"
                        stroke="currentColor"
                        stroke-width="1.3"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="neu-icon-btn"
                    title="批量选择"
                    data-active={bulkSelectMode()}
                    onClick={() => {
                      setSidebarMenuOpen(false);
                      setSessionSearchOpen(false);
                      setBulkSelectMode((value) => !value);
                      setBulkSelected(new Set<string>());
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                      <rect
                        x="2.5"
                        y="2.5"
                        width="11"
                        height="11"
                        rx="2"
                        stroke="currentColor"
                        stroke-width="1.3"
                      />
                      <path
                        d="M5.2 8.2L7 10L10.8 6.2"
                        stroke="currentColor"
                        stroke-width="1.3"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="neu-icon-btn"
                    title="新建会话"
                    onClick={() => {
                      setSidebarMenuOpen(false);
                      void createSession();
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                      <path
                        d="M8 3v10M3 8h10"
                        stroke="currentColor"
                        stroke-width="1.4"
                        stroke-linecap="round"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="neu-icon-btn neu-new-workspace-btn"
                    data-tooltip="添加工作区"
                    aria-label="添加工作区"
                    onClick={() => {
                      setSidebarMenuOpen(false);
                      setWorkspaceOpen(true);
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path
                        d="M2 4h4l1-2h5l3 3v9a2 2 0 01-2 2H4a2 2 0 01-2-2V4z"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.3"
                        stroke-linejoin="round"
                      />
                      <path
                        d="M8 7v6M6 9h4"
                        stroke="currentColor"
                        stroke-width="1.3"
                        stroke-linecap="round"
                      />
                    </svg>
                  </button>
                </div>
              </div>
              <Show when={sessionSearchOpen()}>
                <input
                  class="neu-session-search"
                  placeholder="搜索会话..."
                  value={sessionQuery()}
                  onInput={(event) =>
                    setSessionQuery(event.currentTarget.value)
                  }
                />
              </Show>
              <Show when={bulkSelectMode()}>
                <div class="neu-bulk-bar">
                  <span class="neu-bulk-count">
                    已选 {bulkSelected().size} 项
                  </span>
                  <div class="neu-bulk-actions">
                    <button
                      type="button"
                      class="neu-bulk-btn"
                      onClick={() => toggleSelectAllVisible()}
                    >
                      全选
                    </button>
                    <button
                      type="button"
                      class="neu-bulk-btn"
                      onClick={() => void bulkArchiveSelected()}
                    >
                      归档
                    </button>
                    <button
                      type="button"
                      class="neu-bulk-btn"
                      onClick={() => void bulkRestoreSelected()}
                    >
                      恢复
                    </button>
                    <button
                      type="button"
                      class="neu-bulk-btn neu-bulk-btn-danger"
                      onClick={() => void bulkDeleteSelected()}
                    >
                      删除
                    </button>
                    <button
                      type="button"
                      class="neu-bulk-btn"
                      onClick={() => {
                        setBulkSelectMode(false);
                        setBulkSelected(new Set<string>());
                      }}
                    >
                      取消
                    </button>
                  </div>
                </div>
              </Show>
              <Show when={sidebarMenuOpen()}>
                <div class="neu-sidebar-menu">
                  <button
                    type="button"
                    class="neu-sidebar-menu-item"
                    onClick={() => {
                      setSidebarMenuOpen(false);
                      setSessionMenuOpen(true);
                    }}
                  >
                    会话操作
                  </button>
                  <button
                    type="button"
                    class="neu-sidebar-menu-item neu-sidebar-menu-toggle"
                    data-active={showArchived()}
                    onClick={() => setShowArchived((value) => !value)}
                  >
                    显示归档
                  </button>
                </div>
              </Show>
              <div class="neu-sidebar-content">
                <SessionTree
                  selected={selectedSessionID()}
                  sessions={visibleSessions()}
                  workspaces={workspaces()}
                  onRename={(id, title) => {
                    void props.ctx.runtime
                      .sessionRename?.(id, title)
                      .then(() => refreshSessions());
                  }}
                  onSelect={(id, name) => {
                    userSelectedSession = true;
                    setSelectedSessionID(id);
                    setSelectedSession(name);
                    void props.ctx.runtime
                      .sessionAttach?.(id)
                      .then(async () => {
                        await refreshWorkspaces();
                        await refreshSessions();
                        void loadPerSessionModelConfig(id);
                      });
                  }}
                  onRemoveWorkspace={(workspaceID) => {
                    void removeWorkspace(workspaceID);
                  }}
                  onWorkspaceSettings={(workspaceID) => {
                    setSettingsWorkspaceID(workspaceID);
                    setWorkspaceSettingsOpen(true);
                  }}
                  onRenameWorkspace={(workspaceID, title) => {
                    void renameWorkspace(workspaceID, title);
                  }}
                  onCreateSessionInWorkspace={(workspaceID) => {
                    void createSession(workspaceID);
                  }}
                  onRestore={(sessionID) => {
                    void restoreSession(sessionID);
                  }}
                  onArchive={(sessionID) => {
                    void archiveSession(sessionID);
                  }}
                  bulkMode={bulkSelectMode()}
                  bulkSelected={(sessionID) => bulkSelected().has(sessionID)}
                  onBulkToggle={(sessionID) => toggleBulkSelected(sessionID)}
                />
              </div>
            </aside>
            <div
              class="neu-resizer"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={startLeftResize}
            />
          </>
        ) : (
          <button
            type="button"
            class="neu-collapsed-rail neu-left-rail"
            onClick={() => setLeftVisible(true)}
            title="展开左侧栏（Ctrl+B）"
          >
            <span class="neu-rail-dots" />
          </button>
        )}

        {/* Middle dual agent panes */}
        <section class="neu-main">
          <div class="neu-main-panes">
            <Show when={nataliaVisible()}>
              <div class="neu-pane">
                <div class="neu-pane-header">
                  <span class="neu-pane-title">Natalia</span>
                  <span class="neu-pane-header-right">
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
                    <div class="main-transcript-wrap">
                      <Transcript
                        messages={renderedMainMessages()}
                        emptyTitle="Natalia 已准备好"
                        emptyHint="Natalia 会直接处理工作区任务。"
                        assistantName="Natalia"
                        assistantInitial="N"
                        apiRef={(api) => {
                          transcriptApi = api;
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
                          title="跳到底部"
                        >
                          ↓
                        </button>
                      </Show>
                    </div>
                  </Show>
                  <div
                    class="neu-activity-bar"
                    data-running={Boolean(state().natalia.activeTurn)}
                  >
                    <span class="neu-activity-pulse" />
                    <Show when={state().goal}>
                      {(goal) => (
                        <span class="neu-goal-slot">
                          <span
                            class="neu-goal-control"
                            data-phase={goal()!.phase}
                          >
                            <span
                              class="neu-goal-chip"
                              title={`${goal()!.objective}${
                                goal()!.blockedReason
                                  ? ` — ${goal()!.blockedReason!.code}: ${goal()!.blockedReason!.message}`
                                  : ""
                              }`}
                            >
                              <span class="neu-goal-chip-label">Goal</span>
                              <span class="neu-goal-chip-text">
                                {goal()!.objective.length > 40
                                  ? `${goal()!.objective.slice(0, 40)}…`
                                  : goal()!.objective}
                              </span>
                              <span class="neu-goal-chip-round">
                                {`Round ${goal()!.roundsStarted}${
                                  goal()!.maxGoalRounds === 0
                                    ? ""
                                    : `/${goal()!.maxGoalRounds}`
                                }`}
                              </span>
                            </span>
                            <Show when={goal()!.phase !== "complete"}>
                              <button
                                class="neu-goal-action neu-goal-toggle"
                                data-phase={goal()!.phase}
                                disabled={goalBusy()}
                                title={
                                  goal()!.phase === "active"
                                    ? "暂停（停止当前轮，稍后可继续）"
                                    : "继续（开启新一轮）"
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
                              class="neu-goal-action"
                              disabled={goalBusy()}
                              title="编辑 goal 目标 / 轮次上限"
                              onClick={() => openGoalEditor(goal()!)}
                            >
                              ✎
                            </button>
                            <button
                              class="neu-goal-action neu-goal-clear"
                              disabled={goalBusy()}
                              title="清除 goal"
                              onClick={() => void runGoalControl("clear")}
                            >
                              ✕
                            </button>
                          </span>
                          <Show when={goalEditOpen()}>
                            <div class="neu-goal-editor">
                              <label class="neu-goal-editor-field">
                                <span>目标</span>
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
                              <label class="neu-goal-editor-field neu-goal-editor-cap">
                                <span>轮次上限</span>
                                <input
                                  type="number"
                                  min="0"
                                  placeholder="留空=不改，0=无限"
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
                              <div class="neu-goal-editor-actions">
                                <button
                                  class="neu-goal-editor-save"
                                  disabled={goalBusy()}
                                  onClick={() => void saveGoalEditor(goal()!)}
                                >
                                  保存
                                </button>
                                <button
                                  class="neu-goal-editor-cancel"
                                  onClick={() => setGoalEditOpen(false)}
                                >
                                  取消
                                </button>
                              </div>
                            </div>
                          </Show>
                        </span>
                      )}
                    </Show>
                    <Show when={goalNotice()}>
                      <span class="neu-goal-notice">{goalNotice()}</span>
                    </Show>
                    <span class="neu-activity-label">
                      {state().natalia.activeTurn
                        ? `${activityLabel()} · ${formatDuration(turnElapsedMs())}`
                        : "idle"}
                    </span>
                  </div>
                  <div class="neu-main-toolbar">
                    <NeuSelect
                      value={modelSelectionSignal()?.modelID ?? ""}
                      options={modelOptions()}
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
                      placeholder="选择模型"
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
                      placeholder="推理强度"
                      menuPosition="top"
                    />
                    <NeuSelect
                      value={config()?.defaultAgentMode ?? "ask"}
                      options={permissionOptions()}
                      onChange={(permission) =>
                        void changePermission(permission)
                      }
                      placeholder="选择权限"
                      menuPosition="top"
                    />
                  </div>
                  <Show when={pendingRollback()}>
                    <div class="neu-rollback-banner">
                      <span>已准备回滚：{pendingRollback()!.label}</span>
                      <span class="neu-rollback-hint">发送新消息后生效</span>
                      <button
                        type="button"
                        class="neu-rollback-cancel"
                        onClick={() => cancelPendingRollback()}
                      >
                        取消
                      </button>
                    </div>
                  </Show>
                  <Show when={!pendingRollback() && rollbackNotice()}>
                    <div class="neu-rollback-banner">
                      <span>{rollbackNotice()!.text}</span>
                      <span class="neu-rollback-hint">
                        发送新消息前可以重做这些更改
                      </span>
                      <Show when={rollbackNotice()!.safetyCheckpointID}>
                        <button
                          type="button"
                          class="neu-rollback-redo"
                          onClick={() => void redoAppliedRollback()}
                        >
                          重做
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="neu-rollback-cancel"
                        onClick={() => setRollbackNotice(undefined)}
                      >
                        知道了
                      </button>
                    </div>
                  </Show>
                  <QueueDock
                    items={state().pendingInputs}
                    onRemove={(id) => {
                      void props.ctx.runtime.removeInput?.({
                        id,
                        sessionID: selectedSessionID() || state().sessionID,
                      });
                    }}
                    onReplace={(id, text) => {
                      void props.ctx.runtime.replaceInput?.({
                        id,
                        text,
                        sessionID: selectedSessionID() || state().sessionID,
                      });
                    }}
                    onPromote={(id) => {
                      void props.ctx.runtime.promoteInput?.({
                        id,
                        sessionID: selectedSessionID() || state().sessionID,
                      });
                    }}
                  />
                  <SessionUsageBar usage={state().usageByChannel.main} />
                  <Composer
                    value={mainDraft()}
                    placeholder="输入消息，使用 @ 提及文件…"
                    busy={Boolean(state().natalia.activeTurn)}
                    onInput={setMainDraft}
                    attachments={mainAttachments()}
                    onRemoveAttachment={(path) =>
                      setMainAttachments(
                        mainAttachments().filter((item) => item.path !== path),
                      )
                    }
                    onPaste={(event) =>
                      handlePasteAttachments(
                        event,
                        mainAttachments(),
                        setMainAttachments,
                      )
                    }
                    onSubmit={() => {
                      const text = mainDraft();
                      const paths = mainAttachments().map((item) => item.path);
                      if (text.trim() || paths.length) {
                        const rollback = pendingRollback();
                        const submit = async () => {
                          try {
                            if (rollback) {
                              const sessionID =
                                selectedSessionID() || state().sessionID;
                              const messageResult =
                                rollback.turnID && sessionID
                                  ? await props.ctx.runtime.sessionRollbackMessages?.(
                                      sessionID,
                                      rollback.turnID,
                                    )
                                  : undefined;
                              const preview = rollback.checkpointID
                                ? await props.ctx.runtime.checkpointRollback?.({
                                    id: rollback.checkpointID,
                                    sessionID,
                                  })
                                : undefined;
                              await refreshTranscript();
                              if (messageResult || preview) {
                                setRollbackNotice({
                                  text:
                                    messageResult && preview
                                      ? `已还原消息，并恢复工作区检查点。`
                                      : preview
                                        ? `已恢复工作区检查点。`
                                        : messageResult?.safetyCheckpointID
                                          ? `已还原 1 条消息，并创建了安全后悔点。`
                                          : `已还原 1 条消息。没有可用的文件检查点，因此未恢复工作区更改。`,
                                  safetyCheckpointID:
                                    messageResult?.safetyCheckpointID ??
                                    preview?.safetyCheckpointID,
                                  restoredCount: 1,
                                });
                              }
                            } else {
                              setRollbackNotice(undefined);
                            }
                            perfLog("[web-plugin] send", text);
                            // The Composer opts into mid-turn injection by
                            // default. The settings panel can switch a busy send
                            // to `next-turn`, which queues a separate turn.
                            const busy = Boolean(state().natalia.activeTurn);
                            const busySendDelivery =
                              props.ctx.preferences.get<
                                "next-step" | "next-turn"
                              >("busySendDelivery") ?? "next-step";
                            const sessionID =
                              selectedSessionID() || state().sessionID;
                            const outgoing =
                              goalCommandInstruction(text) ?? text;
                            if (props.ctx.runtime.submitInput) {
                              props.ctx.runtime.submitInput({
                                text: outgoing,
                                ...(paths.length ? { attachments: paths } : {}),
                                ...(busy ? { delivery: busySendDelivery } : {}),
                                sessionID,
                              });
                            } else {
                              props.ctx.runtime.submit?.(text, sessionID);
                            }
                          } finally {
                            setMainDraft("");
                            setMainAttachments([]);
                            setPendingRollback(undefined);
                          }
                        };
                        void submit();
                      }
                    }}
                    onStop={() => props.ctx.runtime.cancel?.()}
                  />
                </div>
              </div>
            </Show>

            <Show when={layoutMode() !== "tiny"}>
              <div class="neu-pane-divider" />
            </Show>

            <Show when={naviVisible()}>
              <div class="neu-pane">
                <div class="neu-pane-header">
                  <span class="neu-pane-title">Navi</span>
                  <span class="neu-pane-header-right">
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
                    <div class="chat-transcript-wrap">
                      <Transcript
                        messages={renderedChatMessages()}
                        emptyTitle="向 Navi 提问"
                        emptyHint="Navi 用于规划和审查，不直接操作工作区。"
                        assistantName="Navi"
                        assistantInitial="V"
                        apiRef={(api) => {
                          chatTranscriptApi = api;
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
                          title="跳到底部"
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
                      onChange={(modelID) =>
                        void updateChatProfile({
                          ...chatProfile(),
                          normal: { ...chatProfile().normal, modelID },
                        })
                      }
                      placeholder="Chat 模型"
                      menuPosition="top"
                    />
                    <NeuSelect
                      value={chatProfile().normal?.reasoningEffort ?? "medium"}
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
                      placeholder="Chat 推理"
                      menuPosition="top"
                    />
                    <NeuSelect
                      value={chatProfile().expert?.modelID ?? ""}
                      options={modelOptions()}
                      onChange={(modelID) =>
                        void updateChatProfile({
                          ...chatProfile(),
                          expert: { ...chatProfile().expert, modelID },
                        })
                      }
                      placeholder="专家模型"
                      menuPosition="top"
                    />
                    <NeuSelect
                      value={chatProfile().expert?.reasoningEffort ?? "medium"}
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
                      placeholder="专家推理"
                      menuPosition="top"
                    />
                  </div>
                  <SessionUsageBar usage={state().usageByChannel.navi} />
                  <Composer
                    value={chatDraft()}
                    placeholder="向 Navi 提问…"
                    busy={Boolean(naviChatActivity())}
                    onInput={setChatDraft}
                    onStop={() =>
                      void props.ctx.runtime.naviChat?.abort?.(
                        selectedSessionID() || state().sessionID,
                      )
                    }
                    attachments={chatAttachments()}
                    onRemoveAttachment={(path) =>
                      setChatAttachments(
                        chatAttachments().filter((item) => item.path !== path),
                      )
                    }
                    onPaste={(event) =>
                      handlePasteAttachments(
                        event,
                        chatAttachments(),
                        setChatAttachments,
                      )
                    }
                    onSubmit={() => {
                      const text = chatDraft();
                      if (text.trim() || chatAttachments().length) {
                        perfLog("[navi-ui] submitting chat", {
                          text,
                          attachments: chatAttachments().map(
                            (item) => item.path,
                          ),
                        });
                        const result = props.ctx.runtime.naviChat?.submit?.({
                          text,
                          sessionID: selectedSessionID() || state().sessionID,
                          ...(chatAttachments().length
                            ? {
                                attachments: chatAttachments().map(
                                  (item) => item.path,
                                ),
                              }
                            : {}),
                        });
                        if (result && typeof result.then === "function") {
                          void result
                            .then((value) =>
                              perfLog("[navi-ui] chatSubmit resolved", value),
                            )
                            .catch((cause) =>
                              console.error(
                                "[navi-ui] chatSubmit failed",
                                cause instanceof Error
                                  ? cause.message
                                  : String(cause),
                              ),
                            );
                        }
                        setChatDraft("");
                        setChatAttachments([]);
                      }
                    }}
                  />
                </div>
              </div>
            </Show>
          </div>
        </section>

        {/* Right secondary tabs */}
        {rightVisible() ? (
          <>
            <div
              class="neu-right-resizer"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={startRightResize}
            />
            <aside class="neu-secondary" style={{ width: `${rightWidth()}px` }}>
              <div class="neu-secondary-tabs">
                <For each={rightTabs()}>
                  {(tab) => (
                    <button
                      type="button"
                      class="neu-secondary-tab"
                      data-active={rightTab() === tab.id}
                      onClick={() => setRightTab(tab.id)}
                    >
                      {tab.label}
                      <Show when={tab.id === "pending"}>
                        <PendingBadge count={pendingCount()} />
                      </Show>
                      <Show when={tab.id === "governance"}>
                        <PendingBadge count={openDriftCount() ?? 0} />
                      </Show>
                    </button>
                  )}
                </For>
              </div>
              <div class="neu-secondary-content">
                <Show
                  keyed
                  when={
                    rightTab() === "diff" ? rightPanelScopeKey() : undefined
                  }
                >
                  <ReviewPane
                    runtime={props.ctx.runtime}
                    events={props.ctx.events}
                    requestedTab={reviewRequestedTab()}
                    requestedCheckpointID={reviewRequestedCheckpointID()}
                    sessionID={selectedSessionID() || state().sessionID}
                    workspaceID={workspaceIDForRightPanels()}
                  />
                </Show>
                <Show
                  keyed
                  when={
                    rightTab() === "plan" ? rightPanelScopeKey() : undefined
                  }
                >
                  <PlanPanel
                    state={state()}
                    sessionID={selectedSessionID() || state().sessionID}
                    runtime={props.ctx.runtime}
                    events={props.ctx.events}
                  />
                </Show>
                <Show
                  keyed
                  when={
                    rightTab() === "governance"
                      ? rightPanelScopeKey()
                      : undefined
                  }
                >
                  <GovernancePane
                    state={state()}
                    runtime={props.ctx.runtime}
                    sessionID={selectedSessionID() || state().sessionID}
                    initialTab={governanceInitialTab}
                  />
                </Show>
                <Show
                  when={rightTab() === "nia" ? rightPanelScopeKey() : undefined}
                  keyed
                >
                  <NiaPanel
                    state={state()}
                    runtime={props.ctx.runtime}
                    catalog={modelCatalog()}
                    sessionID={selectedSessionID() || state().sessionID}
                    loadAttachmentUrl={loadAttachmentUrl}
                    suspendVirtualization={resizing()}
                    paging={niaPaging()}
                    onLoadOlder={() => void loadOlderNiaChat()}
                  />
                </Show>
                <Show
                  keyed
                  when={
                    rightTab() === "agent" ? rightPanelScopeKey() : undefined
                  }
                >
                  <AgentPanel
                    state={state()}
                    runtime={props.ctx.runtime}
                    sessionID={selectedSessionID() || state().sessionID}
                    onOpenTerminal={() => setRightTab("terminal")}
                    onHydrateSubagentHistory={(history, options) => {
                      props.ctx.projection.hydrateSubagentHistory?.(
                        history,
                        options,
                      );
                      setState(cloneState(props.ctx.projection.getState()));
                    }}
                  />
                </Show>
                <For each={sidePanels()}>
                  {(item) => (
                    <Show
                      keyed
                      when={
                        rightTab() === item.panel.id
                          ? rightPanelScopeKey()
                          : undefined
                      }
                    >
                      <div
                        class="neu-side-panel-host"
                        style="height:100%;"
                        ref={(element) => {
                          if (element) mountSidePanel(item, element);
                        }}
                      />
                    </Show>
                  )}
                </For>
              </div>
            </aside>
          </>
        ) : (
          <button
            type="button"
            class="neu-collapsed-rail neu-right-rail"
            onClick={() => setRightVisible(true)}
            title="展开右侧栏（Ctrl+J）"
          >
            <span class="neu-rail-dots" />
          </button>
        )}
      </div>
      <WorkspaceSettingsPanel
        open={workspaceSettingsOpen()}
        workspaceID={
          settingsWorkspaceID() ??
          workspaces().find((entry) => entry.status === "active")?.workspaceID
        }
        runtime={props.ctx.runtime}
        onClose={() => setWorkspaceSettingsOpen(false)}
      />
      <WorkspacePanel
        open={workspaceOpen()}
        onClose={() => setWorkspaceOpen(false)}
        error={workspaceError()}
        onAdd={async (path) => {
          setWorkspaceError("");
          try {
            if (!path) return;
            if (!props.ctx.runtime.workspaceAdd) {
              setWorkspaceError(
                "当前 runtime 不支持 workspaceAdd，请确认连接的是 Natalia runtime serve",
              );
              throw new Error("workspaceAdd unsupported");
            }
            const workspace = (await props.ctx.runtime.workspaceAdd({
              path,
            })) as WorkspaceSummary;
            if (!workspace)
              throw new Error("workspaceAdd returned no workspace");
            if (workspace.status !== "active") {
              await props.ctx.runtime.workspaceActivate?.(
                workspace.workspaceID,
              );
            }
            await refreshWorkspaces();
            await refreshSessions();
          } catch (error: unknown) {
            setWorkspaceError(
              error instanceof Error ? error.message : String(error),
            );
            throw error;
          }
        }}
      />
      <SessionActionsPanel
        open={sessionMenuOpen()}
        session={selectedSession()}
        onClose={() => setSessionMenuOpen(false)}
        onPin={async () => {
          if (!selectedSessionID()) return;
          const target = sessionList().find(
            (entry) => entry.id === selectedSessionID(),
          );
          await props.ctx.runtime.sessionPin?.(
            selectedSessionID(),
            !target?.pinned,
          );
          await refreshSessions();
        }}
        onSnapshot={() => props.ctx.runtime.snapshot()}
        onRollback={() =>
          props.ctx.runtime.checkpointRollback?.({
            id: state().checkpoints[state().checkpoints.length - 1]?.id ?? "",
            sessionID: selectedSessionID() || state().sessionID,
          })
        }
        onDelete={() => physicallyDeleteSelectedSession()}
      />
      <SandboxPanel
        open={sandboxOpen()}
        onClose={() => setSandboxOpen(false)}
        sandboxes={state().sandboxes}
        sessionID={selectedSessionID() || state().sessionID}
        runtime={props.ctx.runtime}
      />
      <StashPanel open={stashOpen()} onClose={() => setStashOpen(false)} />
      <HelpPanel open={helpOpen()} onClose={() => setHelpOpen(false)} />
      <SearchPanel
        open={searchOpen()}
        onClose={() => setSearchOpen(false)}
        onSearch={(query) =>
          props.ctx.runtime.workspaceSearch?.({
            workspaceID: workspaceIDForSelectedSession(),
            query,
            limit: 50,
          })
        }
        onSelect={(result) => {
          window.dispatchEvent(
            new CustomEvent("natalia:open-file", {
              detail: { path: result.path, line: result.line },
            }),
          );
          setSearchOpen(false);
        }}
      />
      <ModelPanel
        open={modelOpen()}
        onClose={() => setModelOpen(false)}
        catalog={modelCatalog()}
        selection={modelSelectionSignal() ?? undefined}
        providers={config()?.providers}
        config={config()}
        onSetDefault={async (modelID) => {
          // The same post-write refresh the add/remove handlers do: the
          // runtime reloads its config, and the panel's rows (the 默认 tag)
          // are only re-read on a restart otherwise — the click looked dead.
          const result = await props.ctx.runtime.setDefaultModel?.(modelID);
          await refreshModelConfig();
          return result;
        }}
        onAddProvider={async (input) => {
          if (!props.ctx.runtime.providerAdd) {
            throw new Error("providerAdd runtime method unavailable");
          }
          const result = await props.ctx.runtime.providerAdd(input);
          if (!result.saved)
            throw new Error("providerAdd did not save provider");
          await refreshModelConfig();
        }}
        onDiscoverModels={async (input) => {
          if (!props.ctx.runtime.providerDiscover) {
            throw new Error("providerDiscover runtime method unavailable");
          }
          return await props.ctx.runtime.providerDiscover(input);
        }}
        onRemoveProvider={async (name) => {
          if (!props.ctx.runtime.providerRemove) {
            throw new Error("providerRemove runtime method unavailable");
          }
          const result = await props.ctx.runtime.providerRemove(name);
          if (result.removed) await refreshModelConfig();
          return result;
        }}
      />
      <StatusPanel
        open={statusOpen()}
        onClose={() => setStatusOpen(false)}
        state={state()}
        runtime={props.ctx.runtime}
      />
      <PluginManagerPanel
        open={pluginManagerOpen()}
        onClose={() => setPluginManagerOpen(false)}
        ctx={props.ctx}
      />
      <SettingsPanel
        host={props.ctx.host}
        open={settingsOpen()}
        onClose={() => setSettingsOpen(false)}
        onOpenModels={() => {
          setModelOpen(true);
          setSettingsOpen(false);
        }}
        themeMode={themeMode()}
        onCycleThemeMode={cycleThemeMode}
        onQuit={() => {
          // The app's exit. This exists because the window's close button may
          // hide it instead (the minimise policy), and a hidden window with no
          // exit is a trap. It calls the same shutdown the RPC surface does, so
          // there is one exit path, not two.
          void props.ctx.runtime?.shutdown?.();
        }}
        state={state()}
        config={config()}
        preferences={props.ctx.preferences}
        registeredTools={registeredTools()}
        runtime={props.ctx.runtime}
        onUpdateConfig={async (patch) => {
          perfLog("[settings] write ->", JSON.stringify(patch));
          const applied = await props.ctx.runtime.updateConfig?.({
            patch,
            scope: "global",
          });
          perfLog("[settings] write applied <-", applied);
          const next = await props.ctx.runtime.configGet?.();
          perfLog(
            "[settings] re-read <-",
            JSON.stringify({
              compactionEnabled: next?.context?.compactionEnabled,
              terminalMode: next?.runtime?.terminal?.windowMode,
              maxSteps: next?.runtime?.maxStepsPerTurn,
            }),
          );
          if (next) setConfig(next);
        }}
        // The runtime's own answer after a write: the panel's `config` prop is a
        // snapshot, and a compose-time row changes the live runtime rather than
        // that snapshot, so the re-read keeps the value cell honest.
        onConfig={(next) => {
          perfLog("[settings] onConfig ->", JSON.stringify(next));
          setConfig(next as unknown as ConfigV3);
        }}
      />
      {dialog}
    </div>
  );
}

/**
 * Turns the `/goal` composer shortcut into an explicit instruction for the
 * agent, which then uses the model-facing goal tools. This is the human
 * "manual" path: `/goal <objective>` creates, `/goal` reads, and
 * `/goal pause|resume|clear` control the current goal.
 */
export function goalCommandInstruction(text: string): string | undefined {
  const match = /^\/goal(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match) return undefined;
  const arg = (match[1] ?? "").trim();
  if (!arg)
    return "The user issued the direct command /goal. Call get_goal and report the current goal (objective, phase, rounds started/max, blockedReason, activation) to the user.";
  const control = arg.toLowerCase();
  if (control === "status")
    return "The user issued the direct command /goal status. Call get_goal and report the current goal to the user.";
  if (control === "pause")
    return "The user issued the direct command /goal pause. Call get_goal, then call update_goal with action pause.";
  if (control === "resume")
    return "The user issued the direct command /goal resume. Call get_goal, then call update_goal with action resume.";
  if (control === "clear")
    return "The user issued the direct command /goal clear. Call get_goal, then call update_goal with action clear.";
  return `The user issued the direct command /goal. This is an explicit human request, so do not ask for confirmation: call create_goal with objective ${JSON.stringify(arg)}, then continue working toward it.`;
}
