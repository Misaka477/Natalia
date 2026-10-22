/** Session tree controller: the workspace-grouped session sidebar.
 *
 * Extracted verbatim from the shell (the SessionTree component) plus the
 * sidebar chrome the shell renders around it (SessionSidebar). Open state
 * still lives in the shell; this is the JSX-first cut of the controller split.
 */

import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  For,
  Show,
} from "solid-js";
import type {
  RuntimeSessionSummary,
  WorkspaceSummary,
} from "@anthelia/contracts";
import type { UiPluginContext } from "@natalia/ui-host";
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
export interface SessionSidebarProps {
  ctx: UiPluginContext;
  leftVisible: () => boolean;
  leftWidth: () => number;
  setLeftVisible: (visible: boolean) => void;
  sessionSearchOpen: () => boolean;
  setSessionSearchOpen: (open: boolean | ((value: boolean) => boolean)) => void;
  sessionQuery: () => string;
  setSessionQuery: (query: string) => void;
  sidebarMenuOpen: () => boolean;
  setSidebarMenuOpen: (open: boolean | ((value: boolean) => boolean)) => void;
  bulkSelectMode: () => boolean;
  setBulkSelectMode: (open: boolean | ((value: boolean) => boolean)) => void;
  bulkSelected: () => Set<string>;
  setBulkSelected: (selected: Set<string>) => void;
  showArchived: () => boolean;
  setShowArchived: (open: boolean | ((value: boolean) => boolean)) => void;
  selectedSessionID: () => string;
  selectedSession: () => string;
  setSelectedSessionID: (id: string) => void;
  setSelectedSession: (name: string) => void;
  workspaces: () => WorkspaceSummary[];
  visibleSessions: () => RuntimeSessionSummary[];
  setSettingsWorkspaceID: (id: string | undefined) => void;
  setWorkspaceSettingsOpen: (open: boolean) => void;
  setSessionMenuOpen: (open: boolean) => void;
  setWorkspaceOpen: (open: boolean) => void;
  createSession: (workspaceID?: string) => Promise<void> | void;
  refreshSessions: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  loadPerSessionModelConfig: (id: string) => Promise<void> | void;
  removeWorkspace: (workspaceID: string) => Promise<void> | void;
  renameWorkspace: (workspaceID: string, title: string) => Promise<void> | void;
  restoreSession: (sessionID: string) => Promise<void> | void;
  archiveSession: (sessionID: string) => Promise<void> | void;
  toggleSelectAllVisible: () => void;
  toggleBulkSelected: (sessionID: string) => void;
  bulkArchiveSelected: () => Promise<void> | void;
  bulkRestoreSelected: () => Promise<void> | void;
  bulkDeleteSelected: () => Promise<void> | void;
  startLeftResize: (event: PointerEvent) => void;
  markUserSelectedSession: () => void;
}

/** The left session tree: workspace groups, session rows, bulk and search chrome. */
export function SessionSidebar(props: SessionSidebarProps) {
  return (
    <>
      {props.leftVisible() ? (
        <>
          <aside
            class="neu-sidebar"
            style={{ width: `${props.leftWidth()}px` }}
          >
            <div class="neu-sidebar-header">
              <span class="neu-sidebar-title">工作区</span>
              <div class="neu-sidebar-actions">
                <button
                  type="button"
                  class="neu-icon-btn"
                  title="搜索会话"
                  data-active={props.sessionSearchOpen()}
                  onClick={() => {
                    props.setSessionSearchOpen((value) => !value);
                    props.setSidebarMenuOpen(false);
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
                  data-active={props.sidebarMenuOpen()}
                  onClick={() => {
                    props.setSidebarMenuOpen((value) => !value);
                    props.setSessionSearchOpen(false);
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
                  data-active={props.bulkSelectMode()}
                  onClick={() => {
                    props.setSidebarMenuOpen(false);
                    props.setSessionSearchOpen(false);
                    props.setBulkSelectMode((value) => !value);
                    props.setBulkSelected(new Set<string>());
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
                    props.setSidebarMenuOpen(false);
                    void props.createSession();
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
                    props.setSidebarMenuOpen(false);
                    props.setWorkspaceOpen(true);
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
            <Show when={props.sessionSearchOpen()}>
              <input
                class="neu-session-search"
                placeholder="搜索会话..."
                value={props.sessionQuery()}
                onInput={(event) =>
                  props.setSessionQuery(event.currentTarget.value)
                }
              />
            </Show>
            <Show when={props.bulkSelectMode()}>
              <div class="neu-bulk-bar">
                <span class="neu-bulk-count">
                  已选 {props.bulkSelected().size} 项
                </span>
                <div class="neu-bulk-actions">
                  <button
                    type="button"
                    class="neu-bulk-btn"
                    onClick={() => props.toggleSelectAllVisible()}
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    class="neu-bulk-btn"
                    onClick={() => void props.bulkArchiveSelected()}
                  >
                    归档
                  </button>
                  <button
                    type="button"
                    class="neu-bulk-btn"
                    onClick={() => void props.bulkRestoreSelected()}
                  >
                    恢复
                  </button>
                  <button
                    type="button"
                    class="neu-bulk-btn neu-bulk-btn-danger"
                    onClick={() => void props.bulkDeleteSelected()}
                  >
                    删除
                  </button>
                  <button
                    type="button"
                    class="neu-bulk-btn"
                    onClick={() => {
                      props.setBulkSelectMode(false);
                      props.setBulkSelected(new Set<string>());
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            </Show>
            <Show when={props.sidebarMenuOpen()}>
              <div class="neu-sidebar-menu">
                <button
                  type="button"
                  class="neu-sidebar-menu-item"
                  onClick={() => {
                    props.setSidebarMenuOpen(false);
                    props.setSessionMenuOpen(true);
                  }}
                >
                  会话操作
                </button>
                <button
                  type="button"
                  class="neu-sidebar-menu-item neu-sidebar-menu-toggle"
                  data-active={props.showArchived()}
                  onClick={() => props.setShowArchived((value) => !value)}
                >
                  显示归档
                </button>
              </div>
            </Show>
            <div class="neu-sidebar-content">
              <SessionTree
                selected={props.selectedSessionID()}
                sessions={props.visibleSessions()}
                workspaces={props.workspaces()}
                onRename={(id, title) => {
                  void props.ctx.runtime
                    .sessionRename?.(id, title)
                    .then(() => props.refreshSessions());
                }}
                onSelect={(id, name) => {
                  props.markUserSelectedSession();
                  props.setSelectedSessionID(id);
                  props.setSelectedSession(name);
                  void props.ctx.runtime.sessionAttach?.(id).then(async () => {
                    await props.refreshWorkspaces();
                    await props.refreshSessions();
                    void props.loadPerSessionModelConfig(id);
                  });
                }}
                onRemoveWorkspace={(workspaceID) => {
                  void props.removeWorkspace(workspaceID);
                }}
                onWorkspaceSettings={(workspaceID) => {
                  props.setSettingsWorkspaceID(workspaceID);
                  props.setWorkspaceSettingsOpen(true);
                }}
                onRenameWorkspace={(workspaceID, title) => {
                  void props.renameWorkspace(workspaceID, title);
                }}
                onCreateSessionInWorkspace={(workspaceID) => {
                  void props.createSession(workspaceID);
                }}
                onRestore={(sessionID) => {
                  void props.restoreSession(sessionID);
                }}
                onArchive={(sessionID) => {
                  void props.archiveSession(sessionID);
                }}
                bulkMode={props.bulkSelectMode()}
                bulkSelected={(sessionID) =>
                  props.bulkSelected().has(sessionID)
                }
                onBulkToggle={(sessionID) =>
                  props.toggleBulkSelected(sessionID)
                }
              />
            </div>
          </aside>
          <div
            class="neu-resizer"
            role="separator"
            aria-orientation="vertical"
            onPointerDown={props.startLeftResize}
          />
        </>
      ) : (
        <button
          type="button"
          class="neu-collapsed-rail neu-left-rail"
          onClick={() => props.setLeftVisible(true)}
          title="展开左侧栏（Ctrl+B）"
        >
          <span class="neu-rail-dots" />
        </button>
      )}
    </>
  );
}
