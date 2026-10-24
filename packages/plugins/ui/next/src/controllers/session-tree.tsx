/** Session tree controller: the workspace and session browsing region.
 *
 * Fills the shell's `sidebar.workspaces` slot in both wide and 56px rail
 * states. Wide state renders the section header (label, inline expanding
 * search, view options menu, and add-workspace button) over the grouped tree
 * or flat session list. Rail state renders the two 36x36 region icon controls
 * (Add Workspace and Search).
 */

import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  For,
  Show,
} from "solid-js";
import styles from "../styles/sidebar.module.css";
import type {
  RuntimeSessionSummary,
  WorkspaceSummary,
} from "@anthelia/contracts";
import type { UiPluginContext } from "@natalia/ui-host";
import {
  collapsedSessionSlice,
  compactRelativeTime,
  isBlankSession,
  owningParentWorkspaceID,
  sectionSessions,
  sessionVisible,
  type ArchivedFilter,
  type SessionGroupBy,
  type SessionOrderBy,
} from "./workspace-tree";

function StatusDot(props: { status: string }) {
  return (
    <span
      class="neu-status-dot"
      data-status={props.status}
      title={props.status}
    />
  );
}

interface DerivedSessionItem {
  id: string;
  name: string;
  blank: boolean;
  running: boolean;
  status: string;
  pinned: boolean;
  archived: boolean;
  timestamp: string;
}

function toDerivedSession(
  session: RuntimeSessionSummary,
  t: (key: string, params?: Record<string, unknown>) => string,
  liveStatus?: {
    running: boolean;
    pendingInteraction?: "approval" | "question";
    startedAt?: number;
  },
  unreadDone?: boolean,
): DerivedSessionItem {
  const blank = isBlankSession(session);
  const running =
    Boolean(liveStatus?.running) ||
    session.status === "running" ||
    (session.pendingInputs ?? 0) > 0;
  const status = liveStatus?.pendingInteraction
    ? "warning"
    : running
      ? "running"
      : unreadDone
        ? "done"
        : "idle";
  return {
    id: session.id,
    name: blank
      ? t("sidebar.newSessionShort")
      : session.title || t("sidebar.untitled"),
    blank,
    running,
    status,
    pinned: Boolean(session.pinned) && !session.archived,
    archived: Boolean(session.archived),
    timestamp: session.lastAccessedAt ?? session.createdAt,
  };
}

function SessionRow(props: {
  t: (key: string, params?: Record<string, unknown>) => string;
  item: DerivedSessionItem;
  selected: boolean;
  depth?: number;
  now: number;
  menuOpen: boolean;
  onToggleMenu: (event: MouseEvent) => void;
  onCloseMenu: () => void;
  onClick: () => void;
  onBeginEdit: () => void;
  onPinToggle?: () => void;
  onArchiveToggle?: () => void;
  onDelete?: () => void;
  bulkMode?: boolean;
  bulkSelected?: boolean;
  onBulkToggle?: () => void;
  editValue?: string;
  onEditChange?: (value: string) => void;
  onEditCommit?: () => void;
  onEditCancel?: () => void;
}) {
  const t = props.t;
  const timeText = () =>
    props.item.blank
      ? ""
      : compactRelativeTime(props.item.timestamp, props.now, t);

  return (
    <div
      role="treeitem"
      aria-selected={props.selected}
      class={styles.sessionRow}
      data-selected={props.selected}
      data-menu-open={props.menuOpen}
      data-archived={props.item.archived}
      style={{
        "padding-inline-start": `${8 + (props.depth ?? 0) * 12}px`,
      }}
      onClick={() => {
        if (props.bulkMode) props.onBulkToggle?.();
        else props.onClick();
      }}
    >
      <Show when={props.bulkMode}>
        <span class="neu-bulk-check" data-checked={props.bulkSelected} />
      </Show>
      <span class={styles.slot}>
        <Show
          when={
            !props.item.archived &&
            !props.item.blank &&
            props.item.status !== "idle"
          }
        >
          <StatusDot status={props.item.status} />
        </Show>
      </span>
      <Show
        when={props.editValue !== undefined}
        fallback={
          <>
            <span
              class={styles.sessionTitle}
              onDblClick={
                props.item.blank
                  ? undefined
                  : (event) => {
                      event.stopPropagation();
                      props.onBeginEdit();
                    }
              }
            >
              {props.item.name}
            </span>
            <Show when={props.item.running}>
              <span class="neu-badge neu-badge-running">
                {t("sidebar.parallelRunning")}
              </span>
            </Show>
            <Show when={!props.item.blank && timeText()}>
              <span class={styles.sessionTime}>{timeText()}</span>
            </Show>
            <Show when={props.item.pinned && !props.item.archived}>
              <span
                class={styles.pinIndicator}
                title={t("sidebar.pinSession")}
                aria-label={t("sidebar.pinSession")}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M9.96976 1.70572L13.1554 3.93629L10.9019 8.12317L11.5158 11.605L10.7192 12.7427L2.52767 7.00693L3.3243 5.86922L6.80612 5.25528L9.96976 1.70572Z"
                    fill="currentColor"
                    stroke="currentColor"
                    stroke-linejoin="round"
                  />
                  <path
                    d="M6.05285 9.47511C6.27284 9.16094 6.70586 9.08458 7.02003 9.30457C7.3342 9.52455 7.41055 9.95757 7.19057 10.2717L3.98587 14.4708L3.21223 13.9291L6.05285 9.47511Z"
                    fill="currentColor"
                  />
                </svg>
              </span>
            </Show>
            <Show when={!props.bulkMode && !props.item.blank}>
              <span
                class={styles.rowActions}
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  class={styles.rowIconBtn}
                  title={t("sidebar.sessionActions")}
                  aria-label={t("sidebar.sessionActions")}
                  onClick={(event) => props.onToggleMenu(event)}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M3 9C3.55228 9 4 8.55228 4 8C4 7.44772 3.55228 7 3 7C2.44772 7 2 7.44772 2 8C2 8.55228 2.44772 9 3 9Z"
                      fill="currentColor"
                    />
                    <path
                      d="M8 9C8.55228 9 9 8.55228 9 8C9 7.44772 8.55228 7 8 7C7.44772 7 7 7.44772 7 8C7 8.55228 7.44772 9 8 9Z"
                      fill="currentColor"
                    />
                    <path
                      d="M13 9C13.5523 9 14 8.55228 14 8C14 7.44772 13.5523 7 13 7C12.4477 7 12 7.44772 12 8C12 8.55228 12.4477 9 13 9Z"
                      fill="currentColor"
                    />
                  </svg>
                </button>
                <Show when={props.onArchiveToggle}>
                  <button
                    type="button"
                    class={styles.rowIconBtn}
                    title={
                      props.item.archived
                        ? t("sidebar.restoreSession")
                        : t("sidebar.archiveSession")
                    }
                    aria-label={
                      props.item.archived
                        ? t("sidebar.restoreSession")
                        : t("sidebar.archiveSession")
                    }
                    onClick={() => props.onArchiveToggle?.()}
                  >
                    <Show
                      when={props.item.archived}
                      fallback={
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1"
                        >
                          <path d="M13.5 2.5H2.5C1.94772 2.5 1.5 2.94772 1.5 3.5V4.5C1.5 5.05228 1.94772 5.5 2.5 5.5H13.5C14.0523 5.5 14.5 5.05228 14.5 4.5V3.5C14.5 2.94772 14.0523 2.5 13.5 2.5Z" />
                          <path d="M2.5 5.5V13.5C2.5 13.7652 2.60536 14.0196 2.79289 14.2071C2.98043 14.3946 3.23478 14.5 3.5 14.5H12.5C12.7652 14.5 13.0196 14.3946 13.2071 14.2071C13.3946 14.0196 13.5 13.7652 13.5 13.5V5.5" />
                          <path d="M6.5 9.5H9.5" />
                        </svg>
                      }
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.2"
                      >
                        <path d="M8 11.5V6.5M6 8.5L8 6.5L10 8.5" />
                        <rect x="2" y="2.5" width="12" height="11" rx="2" />
                      </svg>
                    </Show>
                  </button>
                </Show>
                <Show when={!props.item.archived && props.onPinToggle}>
                  <button
                    type="button"
                    class={styles.rowIconBtn}
                    title={
                      props.item.pinned
                        ? t("sidebar.unpinSession")
                        : t("sidebar.pinSession")
                    }
                    aria-label={
                      props.item.pinned
                        ? t("sidebar.unpinSession")
                        : t("sidebar.pinSession")
                    }
                    onClick={() => props.onPinToggle?.()}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path
                        d="M9.96976 1.70572L13.1554 3.93629L10.9019 8.12317L11.5158 11.605L10.7192 12.7427L2.52767 7.00693L3.3243 5.86922L6.80612 5.25528L9.96976 1.70572Z"
                        fill={props.item.pinned ? "currentColor" : "none"}
                        stroke="currentColor"
                        stroke-linejoin="round"
                      />
                      <path
                        d="M6.05285 9.47511C6.27284 9.16094 6.70586 9.08458 7.02003 9.30457C7.3342 9.52455 7.41055 9.95757 7.19057 10.2717L3.98587 14.4708L3.21223 13.9291L6.05285 9.47511Z"
                        fill="currentColor"
                      />
                    </svg>
                  </button>
                </Show>
                <Show when={props.menuOpen}>
                  <div
                    class={styles.popup}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Show when={!props.item.archived && props.onPinToggle}>
                      <button
                        type="button"
                        onClick={() => {
                          props.onCloseMenu();
                          props.onPinToggle?.();
                        }}
                      >
                        {props.item.pinned
                          ? t("sidebar.unpinSession")
                          : t("sidebar.pinSession")}
                      </button>
                    </Show>
                    <button
                      type="button"
                      onClick={() => {
                        props.onCloseMenu();
                        props.onBeginEdit();
                      }}
                    >
                      {t("sidebar.rename")}
                    </button>
                    <Show when={props.onArchiveToggle}>
                      <button
                        type="button"
                        onClick={() => {
                          props.onCloseMenu();
                          props.onArchiveToggle?.();
                        }}
                      >
                        {props.item.archived
                          ? t("sidebar.restoreSession")
                          : t("sidebar.archiveSession")}
                      </button>
                    </Show>
                    <Show when={props.onDelete}>
                      <button
                        type="button"
                        class={styles.popupDanger}
                        onClick={() => {
                          props.onCloseMenu();
                          props.onDelete?.();
                        }}
                      >
                        {t("sidebar.deleteSession")}
                      </button>
                    </Show>
                  </div>
                </Show>
              </span>
            </Show>
          </>
        }
      >
        <input
          class={styles.editInput}
          value={props.editValue}
          autofocus
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
    </div>
  );
}

function SessionTree(props: {
  t: (key: string, params?: Record<string, unknown>) => string;
  selected: string;
  sessions: RuntimeSessionSummary[];
  workspaces: WorkspaceSummary[];
  liveStatuses?: Record<
    string,
    {
      running: boolean;
      pendingInteraction?: "approval" | "question";
      startedAt?: number;
    }
  >;
  unreadCompleted?: Set<string>;
  groupBy: SessionGroupBy;
  orderBy: SessionOrderBy;
  archivedFilter: ArchivedFilter;
  onLeaveArchivedOnly: () => void;
  onSelect: (id: string, name: string) => void;
  onRename?: (id: string, title: string) => unknown;
  onPin?: (id: string, pinned: boolean) => unknown;
  onDeleteSession?: (id: string) => unknown;
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
  const t = props.t;
  const [editingID, setEditingID] = createSignal<string | null>(null);
  const [draftName, setDraftName] = createSignal("");
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const [expandedSessionGroups, setExpandedSessionGroups] = createSignal<
    Set<string>
  >(new Set());
  const [activeWorkspaceMenu, setActiveWorkspaceMenu] = createSignal<
    string | null
  >(null);
  const [activeSessionMenu, setActiveSessionMenu] = createSignal<string | null>(
    null,
  );
  const [editingWorkspaceID, setEditingWorkspaceID] = createSignal<
    string | null
  >(null);
  const [draftWorkspaceName, setDraftWorkspaceName] = createSignal("");
  const [now, setNow] = createSignal(Date.now());

  const clock = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(clock));

  const parentMap = createMemo(() => {
    if (props.groupBy !== "workspace-tree")
      return new Map<string, string | undefined>();
    return new Map<string, string | undefined>(
      props.workspaces.map((ws) => [
        ws.workspaceID,
        owningParentWorkspaceID(ws, props.workspaces),
      ]),
    );
  });

  const groups = createMemo(() => {
    const byWorkspace = new Map<string, RuntimeSessionSummary[]>();
    const ungrouped: RuntimeSessionSummary[] = [];
    const activeID = props.workspaces.find(
      (workspace) => workspace.status === "active",
    )?.workspaceID;
    const knownIDs = new Set(props.workspaces.map((ws) => ws.workspaceID));

    for (const session of props.sessions) {
      if (!sessionVisible(session, props.selected, props.archivedFilter))
        continue;
      const key = session.workspaceID ?? activeID;
      if (!key || !knownIDs.has(key)) {
        ungrouped.push(session);
        continue;
      }
      const list = byWorkspace.get(key) ?? [];
      list.push(session);
      byWorkspace.set(key, list);
    }

    const result = props.workspaces
      .map((workspace) => {
        const ordered = sectionSessions(
          byWorkspace.get(workspace.workspaceID) ?? [],
          props.selected,
          props.orderBy,
        );
        return {
          workspaceID: workspace.workspaceID,
          workspace:
            workspace.title === "default-workspace"
              ? t("hero.defaultWorkspace")
              : workspace.title,
          isRealWorkspace: true,
          containsCurrent: ordered.some((s) => s.id === props.selected),
          sessions: ordered.map((s) =>
            toDerivedSession(
              s,
              t,
              props.liveStatuses?.[s.id],
              props.unreadCompleted?.has(s.id),
            ),
          ),
        };
      })
      .filter(
        (group) => props.archivedFilter !== "only" || group.sessions.length > 0,
      );

    if (ungrouped.length > 0) {
      const ordered = sectionSessions(ungrouped, props.selected, props.orderBy);
      result.push({
        workspaceID: "__ungrouped",
        workspace: t("sidebar.ungrouped"),
        isRealWorkspace: false,
        containsCurrent: ordered.some((s) => s.id === props.selected),
        sessions: ordered.map((s) =>
          toDerivedSession(
            s,
            t,
            props.liveStatuses?.[s.id],
            props.unreadCompleted?.has(s.id),
          ),
        ),
      });
    }

    return result;
  });

  const flatSessions = createMemo(() => {
    const visible = props.sessions.filter((session) =>
      sessionVisible(session, props.selected, props.archivedFilter),
    );
    return sectionSessions(visible, props.selected, props.orderBy).map((s) =>
      toDerivedSession(
        s,
        t,
        props.liveStatuses?.[s.id],
        props.unreadCompleted?.has(s.id),
      ),
    );
  });

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
    setActiveSessionMenu(null);
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
    if (!activeWorkspaceMenu() && !activeSessionMenu()) return;
    const handler = () => {
      setActiveWorkspaceMenu(null);
      setActiveSessionMenu(null);
    };
    const timer = setTimeout(() => {
      document.addEventListener("click", handler);
    }, 0);
    onCleanup(() => {
      clearTimeout(timer);
      document.removeEventListener("click", handler);
    });
  });

  const renderSessionRow = (session: DerivedSessionItem, depth: number) => (
    <SessionRow
      t={t}
      item={session}
      selected={props.selected === session.id}
      depth={depth}
      now={now()}
      menuOpen={activeSessionMenu() === session.id}
      onToggleMenu={(event) => {
        event.stopPropagation();
        setActiveWorkspaceMenu(null);
        setActiveSessionMenu((prev) =>
          prev === session.id ? null : session.id,
        );
      }}
      onCloseMenu={() => setActiveSessionMenu(null)}
      onClick={() => {
        if (session.archived && props.onRestore) {
          props.onRestore(session.id);
        } else {
          props.onSelect(session.id, session.name);
        }
      }}
      onBeginEdit={() => {
        setEditingID(session.id);
        setDraftName(session.name);
      }}
      onPinToggle={
        props.onPin
          ? () => props.onPin?.(session.id, !session.pinned)
          : undefined
      }
      onArchiveToggle={
        session.archived
          ? props.onRestore
            ? () => props.onRestore?.(session.id)
            : undefined
          : props.onArchive
            ? () => props.onArchive?.(session.id)
            : undefined
      }
      onDelete={
        props.onDeleteSession
          ? () => props.onDeleteSession?.(session.id)
          : undefined
      }
      bulkMode={props.bulkMode}
      bulkSelected={props.bulkSelected?.(session.id)}
      onBulkToggle={
        props.onBulkToggle ? () => props.onBulkToggle?.(session.id) : undefined
      }
      editValue={editingID() === session.id ? draftName() : undefined}
      onEditChange={setDraftName}
      onEditCommit={() => {
        const title = draftName().trim();
        if (editingID() === session.id && title && title !== session.name) {
          void props.onRename?.(session.id, title);
        }
        setEditingID(null);
      }}
      onEditCancel={() => setEditingID(null)}
    />
  );

  return (
    <div class={`neu-tree ${styles.list}`}>
      <Show
        when={props.groupBy !== "flat"}
        fallback={
          <Show
            when={flatSessions().length > 0}
            fallback={
              <div class={styles.emptyState}>
                <span>
                  {props.archivedFilter === "only"
                    ? t("sidebar.emptyArchived")
                    : t("sidebar.emptySessions")}
                </span>
                <Show when={props.archivedFilter === "only"}>
                  <button
                    type="button"
                    class={styles.emptyAction}
                    onClick={() => props.onLeaveArchivedOnly()}
                  >
                    {t("sidebar.viewOtherSessions")}
                  </button>
                </Show>
              </div>
            }
          >
            <For each={flatSessions()}>
              {(session) => renderSessionRow(session, 0)}
            </For>
          </Show>
        }
      >
        <Show
          when={groups().length > 0}
          fallback={
            <div class={styles.emptyState}>
              <span>
                {props.archivedFilter === "only"
                  ? t("sidebar.emptyArchived")
                  : t("sidebar.emptySessions")}
              </span>
              <Show when={props.archivedFilter === "only"}>
                <button
                  type="button"
                  class={styles.emptyAction}
                  onClick={() => props.onLeaveArchivedOnly()}
                >
                  {t("sidebar.viewOtherSessions")}
                </button>
              </Show>
            </div>
          }
        >
          <For each={groups()}>
            {(group) => {
              const open = () => !isCollapsed(group.workspaceID);
              const menuForThis = () => isWorkspaceMenuOpen(group.workspaceID);
              const collapsedSlice = createMemo(() =>
                collapsedSessionSlice(group.sessions, 5),
              );
              const displayedSessions = createMemo(() =>
                isSessionsExpanded(group.workspaceID)
                  ? group.sessions
                  : collapsedSlice().rows,
              );
              const depth = () => {
                let d = 0;
                let cur = parentMap().get(group.workspaceID);
                while (cur) {
                  d += 1;
                  cur = parentMap().get(cur);
                }
                return d;
              };
              return (
                <div
                  class={styles.groupSection}
                  style={{
                    "--workspace-indent": `${depth() * 12}px`,
                  }}
                >
                  <div
                    role="treeitem"
                    aria-expanded={open()}
                    class={styles.projectRow}
                    data-menu-open={menuForThis()}
                    onClick={() => {
                      if (editingWorkspaceID() === group.workspaceID) return;
                      toggleCollapse(group.workspaceID);
                    }}
                  >
                    <span
                      class={`${styles.slot} ${styles.folderIcon}`}
                      data-active={group.containsCurrent}
                    >
                      <Show
                        when={open()}
                        fallback={
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1"
                          >
                            <path d="M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z" />
                            <path d="M3.63501 7.66614H12.3647" />
                          </svg>
                        }
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 16 16"
                          fill="none"
                        >
                          <path
                            d="M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z"
                            fill="currentColor"
                            opacity="0.16"
                          />
                          <path
                            d="M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z"
                            fill="currentColor"
                          />
                          <path
                            d="M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z"
                            fill="currentColor"
                          />
                        </svg>
                      </Show>
                    </span>
                    <span
                      class={`${styles.slot} ${styles.chevron}`}
                      data-open={open()}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        fill="none"
                      >
                        <path
                          d="M5.5 4.5C5.5 4.40714 5.52586 4.31612 5.57467 4.23713C5.62349 4.15815 5.69334 4.09431 5.77639 4.05279C5.85945 4.01126 5.95242 3.99368 6.0449 4.00202C6.13738 4.01036 6.22572 4.04429 6.3 4.1L10.967 7.6C11.0291 7.64657 11.0795 7.70697 11.1142 7.77639C11.1489 7.84582 11.167 7.92238 11.167 8C11.167 8.07762 11.1489 8.15418 11.1142 8.22361C11.0795 8.29303 11.0291 8.35343 10.967 8.4L6.3 11.9C6.22572 11.9557 6.13738 11.9896 6.0449 11.998C5.95242 12.0063 5.85945 11.9887 5.77639 11.9472C5.69334 11.9057 5.62349 11.8419 5.57467 11.7629C5.52586 11.6839 5.5 11.5929 5.5 11.5V4.5Z"
                          fill="currentColor"
                        />
                      </svg>
                    </span>
                    <Show
                      when={editingWorkspaceID() === group.workspaceID}
                      fallback={
                        <span class={styles.projectText}>
                          <span class={styles.workspaceName}>
                            {group.workspace}
                          </span>
                        </span>
                      }
                    >
                      <input
                        class={styles.renameInput}
                        value={draftWorkspaceName()}
                        autofocus
                        onInput={(event) =>
                          setDraftWorkspaceName(event.currentTarget.value)
                        }
                        onClick={(event) => event.stopPropagation()}
                        onFocus={(event) => event.currentTarget.select()}
                        onBlur={() =>
                          commitWorkspaceRename(
                            group.workspaceID,
                            group.workspace,
                          )
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
                    <Show when={group.isRealWorkspace}>
                      <span
                        class={styles.rowActions}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          class={styles.rowIconBtn}
                          title={t("sidebar.workspaceActions")}
                          aria-label={t("sidebar.workspaceActions")}
                          onClick={(event) =>
                            toggleWorkspaceMenu(group.workspaceID, event)
                          }
                        >
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 16 16"
                            fill="none"
                          >
                            <path
                              d="M3 9C3.55228 9 4 8.55228 4 8C4 7.44772 3.55228 7 3 7C2.44772 7 2 7.44772 2 8C2 8.55228 2.44772 9 3 9Z"
                              fill="currentColor"
                            />
                            <path
                              d="M8 9C8.55228 9 9 8.55228 9 8C9 7.44772 8.55228 7 8 7C7.44772 7 7 7.44772 7 8C7 8.55228 7.44772 9 8 9Z"
                              fill="currentColor"
                            />
                            <path
                              d="M13 9C13.5523 9 14 8.55228 14 8C14 7.44772 13.5523 7 13 7C12.4477 7 12 7.44772 12 8C12 8.55228 12.4477 9 13 9Z"
                              fill="currentColor"
                            />
                          </svg>
                        </button>
                        <Show when={props.onCreateSessionInWorkspace}>
                          <button
                            type="button"
                            class={styles.rowIconBtn}
                            title={t("sidebar.newSession")}
                            aria-label={t("sidebar.newSession")}
                            onClick={() => {
                              expandWorkspace(group.workspaceID);
                              props.onCreateSessionInWorkspace?.(
                                group.workspaceID,
                              );
                            }}
                          >
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="1"
                            >
                              <path d="M2.37091 11.2501C1.58745 9.89288 1.32067 8.29835 1.61969 6.76006C1.91872 5.22177 2.76342 3.8433 3.99826 2.87846C5.2331 1.91362 6.77494 1.42737 8.33988 1.50925C9.90482 1.59113 11.3875 2.23562 12.5149 3.32406C13.6425 4.41269 14.3387 5.87206 14.4754 7.4334C14.612 8.99474 14.18 10.5529 13.2587 11.8209C12.3375 13.0888 10.9891 13.9813 9.46194 14.3337C8.18691 14.628 6.85895 14.5294 5.64989 14.0605C5.1712 13.8748 4.76962 13.4932 4.26534 13.3967C3.67413 13.2835 2.95257 13.5598 2.03794 14.3337" />
                              <path d="M8 5V11" />
                              <path d="M5 8H11" />
                            </svg>
                          </button>
                        </Show>
                        <Show when={menuForThis()}>
                          <div
                            class={styles.popup}
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
                              {t("sidebar.rename")}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setActiveWorkspaceMenu(null);
                                props.onWorkspaceSettings?.(group.workspaceID);
                              }}
                            >
                              {t("sidebar.workspaceSettings")}
                            </button>
                            <button
                              type="button"
                              class={styles.popupDanger}
                              onClick={() => {
                                setActiveWorkspaceMenu(null);
                                props.onRemoveWorkspace?.(group.workspaceID);
                              }}
                            >
                              {t("sidebar.deleteWorkspace")}
                            </button>
                          </div>
                        </Show>
                      </span>
                    </Show>
                  </div>
                  <Show when={open()}>
                    <For each={displayedSessions()}>
                      {(session) => renderSessionRow(session, depth())}
                    </For>
                    <Show when={collapsedSlice().hiddenCount > 0}>
                      <button
                        type="button"
                        class={`neu-session-overflow ${styles.sessionOverflowButton}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleSessionGroup(group.workspaceID);
                        }}
                      >
                        {isSessionsExpanded(group.workspaceID)
                          ? t("common.collapse")
                          : t("sidebar.expandRestSessions", {
                              count: collapsedSlice().hiddenCount,
                            })}
                      </button>
                    </Show>
                  </Show>
                </div>
              );
            }}
          </For>
        </Show>
      </Show>
    </div>
  );
}

/** The left column's browsing region: the props the shell passes it. */
export interface SessionSidebarProps {
  ctx: UiPluginContext;
  t: (key: string, params?: Record<string, unknown>) => string;
  wide?: () => boolean;
  expandSidebar?: () => void;
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
  allSessions?: () => RuntimeSessionSummary[];
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
  deleteSessionByID?: (sessionID: string) => Promise<void> | void;
  toggleSelectAllVisible: () => void;
  toggleBulkSelected: (sessionID: string) => void;
  bulkArchiveSelected: () => Promise<void> | void;
  bulkRestoreSelected: () => Promise<void> | void;
  bulkDeleteSelected: () => Promise<void> | void;
  markUserSelectedSession: () => void;
  liveStatuses?: () => Record<
    string,
    {
      running: boolean;
      pendingInteraction?: "approval" | "question";
      startedAt?: number;
    }
  >;
  unreadCompleted?: () => Set<string>;
  onClearUnreadCompleted?: (sessionID: string) => void;
}

export function SessionTreeRegion(props: SessionSidebarProps) {
  const t = props.t;
  const wide = () => (props.wide ? props.wide() : true);
  let searchInputRef: HTMLInputElement | undefined;

  const [groupBy, setGroupBy] = createSignal<SessionGroupBy>("workspace");
  const [orderBy, setOrderBy] = createSignal<SessionOrderBy>("updated");
  const [archivedFilter, setArchivedFilter] = createSignal<ArchivedFilter>(
    props.showArchived() ? "show" : "default",
  );

  const pickArchivedFilter = (next: ArchivedFilter) => {
    setArchivedFilter(next);
    props.setShowArchived(next !== "default");
  };

  const filteredSessions = createMemo(() => {
    const source = props.allSessions
      ? props.allSessions()
      : props.visibleSessions();
    const query = props.sessionQuery().trim().toLowerCase();
    if (!query) return source;
    return source.filter((session) =>
      session.title.toLowerCase().includes(query),
    );
  });

  createEffect(() => {
    if (wide() && props.sessionSearchOpen()) {
      const timer = window.setTimeout(() => {
        searchInputRef?.focus({ preventScroll: true });
      }, 60);
      onCleanup(() => window.clearTimeout(timer));
    }
  });

  return (
    <div class={`${styles.browserRoot} ${wide() ? "" : styles.rail}`}>
      <div class={styles.railControls} aria-hidden={wide()}>
        <button
          type="button"
          class={styles.railIconBtn}
          data-tooltip={t("sidebar.addWorkspace")}
          aria-label={t("sidebar.addWorkspace")}
          tabIndex={wide() ? -1 : 0}
          onClick={() => {
            props.setSidebarMenuOpen(false);
            props.setWorkspaceOpen(true);
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            stroke-width="1"
          >
            <path
              d="M5.54492 2.06738C5.91034 2.06754 6.26318 2.20149 6.53711 2.44336L7.94043 3.68164V4.7998C7.71462 4.74105 7.50367 4.63139 7.32617 4.47461L5.87598 3.19238C5.78477 3.11185 5.66658 3.06754 5.54492 3.06738H2.94922C2.67322 3.06738 2.44946 3.29145 2.44922 3.56738V12.4326C2.44927 12.7087 2.67311 12.9326 2.94922 12.9326H12.9326C13.2086 12.9325 13.4326 12.7086 13.4326 12.4326V8.53613H14.4326V12.4326C14.4326 13.2609 13.7609 13.9325 12.9326 13.9326H2.94922C2.12083 13.9326 1.44927 13.261 1.44922 12.4326V3.56738C1.44946 2.73916 2.12094 2.06738 2.94922 2.06738H5.54492Z"
              fill="currentColor"
            />
            <path d="M9.75977 4.50208H14.5509" stroke="currentColor" />
            <path d="M12.1492 6.89758L12.1492 2.10642" stroke="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          class={styles.railIconBtn}
          data-tooltip={t("sidebar.search")}
          aria-label={t("sidebar.search")}
          tabIndex={wide() ? -1 : 0}
          onClick={() => {
            props.setSidebarMenuOpen(false);
            props.setSessionSearchOpen(true);
            props.expandSidebar?.();
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            stroke-width="1"
          >
            <path
              d="M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z"
              stroke="currentColor"
            />
            <path d="M10.2991 10.3933L14.7783 14.8725" stroke="currentColor" />
          </svg>
        </button>
      </div>
      <div class={styles.wideBrowser} aria-hidden={!wide()}>
        <div class={styles.sectionHeader}>
          <span
            class={`${styles.sectionLabel} ${props.sessionSearchOpen() ? styles.sectionLabelHidden : ""}`}
          >
            {groupBy() === "flat"
              ? t("sidebar.sessions")
              : t("sidebar.workspace")}
          </span>
          <div
            class={`${styles.searchSlot} ${props.sessionSearchOpen() ? styles.searchSlotExpanded : ""}`}
          >
            <div
              class={`${styles.searchBox} ${props.sessionSearchOpen() ? styles.searchBoxExpanded : ""}`}
              onClick={() => {
                props.setSidebarMenuOpen(false);
                props.setSessionSearchOpen(true);
                searchInputRef?.focus({ preventScroll: true });
              }}
            >
              <button
                type="button"
                class={styles.searchButton}
                title={t("sidebar.search")}
                aria-label={t("sidebar.search")}
                aria-expanded={props.sessionSearchOpen()}
                onClick={(event) => {
                  event.stopPropagation();
                  props.setSidebarMenuOpen(false);
                  props.setSessionSearchOpen((v) => !v);
                }}
              >
                <svg
                  width={props.sessionSearchOpen() ? "12" : "14"}
                  height={props.sessionSearchOpen() ? "12" : "14"}
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                  stroke-width="1"
                >
                  <path
                    d="M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z"
                    stroke="currentColor"
                  />
                  <path
                    d="M10.2991 10.3933L14.7783 14.8725"
                    stroke="currentColor"
                  />
                </svg>
              </button>
              <input
                ref={searchInputRef}
                class={styles.searchInput}
                type="text"
                placeholder={t("sidebar.searchSessions")}
                value={props.sessionQuery()}
                tabIndex={props.sessionSearchOpen() ? 0 : -1}
                onInput={(event) =>
                  props.setSessionQuery(event.currentTarget.value)
                }
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  props.setSessionQuery("");
                  props.setSessionSearchOpen(false);
                }}
              />
              <Show when={props.sessionSearchOpen()}>
                <button
                  type="button"
                  class={styles.clearButton}
                  aria-label={t("sidebar.searchClear")}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.setSessionQuery("");
                    props.setSessionSearchOpen(false);
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5"
                      stroke="currentColor"
                      stroke-width="1.2"
                    />
                  </svg>
                </button>
              </Show>
            </div>
          </div>
          <div
            class={`${styles.headerActions} ${props.sessionSearchOpen() ? styles.headerActionsHidden : ""}`}
          >
            <button
              type="button"
              class={styles.iconBtn}
              title={t("sidebar.viewOptions")}
              aria-label={t("sidebar.viewOptions")}
              data-active={props.sidebarMenuOpen()}
              onClick={() => {
                props.setSidebarMenuOpen((value) => !value);
                props.setSessionSearchOpen(false);
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-width="1"
              >
                <path d="M2.3 5h5.85M12.05 5h1.65" />
                <circle cx="9.95" cy="5" r="1.45" />
                <path d="M2.3 11h1.65M7.85 11h5.85" />
                <circle cx="5.75" cy="11" r="1.45" />
              </svg>
            </button>
            <button
              type="button"
              class={`${styles.iconBtn} ${styles.newWorkspaceBtn}`}
              title={t("sidebar.addWorkspace")}
              aria-label={t("sidebar.addWorkspace")}
              onClick={() => {
                props.setSidebarMenuOpen(false);
                props.setWorkspaceOpen(true);
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
                stroke-width="1"
              >
                <path
                  d="M5.54492 2.06738C5.91034 2.06754 6.26318 2.20149 6.53711 2.44336L7.94043 3.68164V4.7998C7.71462 4.74105 7.50367 4.63139 7.32617 4.47461L5.87598 3.19238C5.78477 3.11185 5.66658 3.06754 5.54492 3.06738H2.94922C2.67322 3.06738 2.44946 3.29145 2.44922 3.56738V12.4326C2.44927 12.7087 2.67311 12.9326 2.94922 12.9326H12.9326C13.2086 12.9325 13.4326 12.7086 13.4326 12.4326V8.53613H14.4326V12.4326C14.4326 13.2609 13.7609 13.9325 12.9326 13.9326H2.94922C2.12083 13.9326 1.44927 13.261 1.44922 12.4326V3.56738C1.44946 2.73916 2.12094 2.06738 2.94922 2.06738H5.54492Z"
                  fill="currentColor"
                />
                <path d="M9.75977 4.50208H14.5509" stroke="currentColor" />
                <path
                  d="M12.1492 6.89758L12.1492 2.10642"
                  stroke="currentColor"
                />
              </svg>
            </button>
          </div>
        </div>

        <Show when={props.bulkSelectMode()}>
          <div class="neu-bulk-bar">
            <span class="neu-bulk-count">
              {t("sidebar.selectedCount", {
                count: props.bulkSelected().size,
              })}
            </span>
            <div class="neu-bulk-actions">
              <button
                type="button"
                class="neu-bulk-btn"
                onClick={() => props.toggleSelectAllVisible()}
              >
                {t("common.selectAll")}
              </button>
              <button
                type="button"
                class="neu-bulk-btn"
                onClick={() => void props.bulkArchiveSelected()}
              >
                {t("common.archive")}
              </button>
              <button
                type="button"
                class="neu-bulk-btn"
                onClick={() => void props.bulkRestoreSelected()}
              >
                {t("common.restore")}
              </button>
              <button
                type="button"
                class="neu-bulk-btn neu-bulk-btn-danger"
                onClick={() => void props.bulkDeleteSelected()}
              >
                {t("common.delete")}
              </button>
              <button
                type="button"
                class="neu-bulk-btn"
                onClick={() => {
                  props.setBulkSelectMode(false);
                  props.setBulkSelected(new Set<string>());
                }}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </Show>

        <Show when={props.sidebarMenuOpen()}>
          <div class={styles.viewOptionsMenu}>
            <div class={styles.menuSectionLabel}>{t("sidebar.groupBy")}</div>
            <button
              type="button"
              class={`${styles.menuItem} ${styles.menuToggle}`}
              data-active={groupBy() === "workspace"}
              onClick={() => {
                setGroupBy("workspace");
                props.setSidebarMenuOpen(false);
              }}
            >
              {t("sidebar.groupByWorkspace")}
            </button>
            <button
              type="button"
              class={`${styles.menuItem} ${styles.menuToggle}`}
              data-active={groupBy() === "workspace-tree"}
              onClick={() => {
                setGroupBy("workspace-tree");
                props.setSidebarMenuOpen(false);
              }}
            >
              {t("sidebar.groupByTree")}
            </button>
            <button
              type="button"
              class={`${styles.menuItem} ${styles.menuToggle}`}
              data-active={groupBy() === "flat"}
              onClick={() => {
                setGroupBy("flat");
                props.setSidebarMenuOpen(false);
              }}
            >
              {t("sidebar.groupByFlat")}
            </button>

            <div class={styles.menuSeparator} />
            <div class={styles.menuSectionLabel}>{t("sidebar.orderBy")}</div>
            <button
              type="button"
              class={`${styles.menuItem} ${styles.menuToggle}`}
              data-active={orderBy() === "manual"}
              onClick={() => {
                setOrderBy("manual");
                props.setSidebarMenuOpen(false);
              }}
            >
              {t("sidebar.orderByManual")}
            </button>
            <button
              type="button"
              class={`${styles.menuItem} ${styles.menuToggle}`}
              data-active={orderBy() === "updated"}
              onClick={() => {
                setOrderBy("updated");
                props.setSidebarMenuOpen(false);
              }}
            >
              {t("sidebar.orderByUpdated")}
            </button>

            <div class={styles.menuSeparator} />
            <div class={styles.menuSectionLabel}>{t("sidebar.filterBy")}</div>
            <button
              type="button"
              class={`${styles.menuItem} ${styles.menuToggle}`}
              data-active={archivedFilter() === "default"}
              onClick={() => {
                pickArchivedFilter("default");
                props.setSidebarMenuOpen(false);
              }}
            >
              {t("sidebar.hideArchived")}
            </button>
            <button
              type="button"
              class={`${styles.menuItem} ${styles.menuToggle}`}
              data-active={archivedFilter() === "show"}
              onClick={() => {
                pickArchivedFilter("show");
                props.setSidebarMenuOpen(false);
              }}
            >
              {t("sidebar.showAllArchived")}
            </button>
            <button
              type="button"
              class={`${styles.menuItem} ${styles.menuToggle}`}
              data-active={archivedFilter() === "only"}
              onClick={() => {
                pickArchivedFilter("only");
                props.setSidebarMenuOpen(false);
              }}
            >
              {t("sidebar.onlyArchived")}
            </button>

            <div class={styles.menuSeparator} />
            <button
              type="button"
              class={styles.menuItem}
              onClick={() => {
                props.setSidebarMenuOpen(false);
                props.setBulkSelectMode((v) => !v);
                props.setBulkSelected(new Set<string>());
              }}
            >
              {t("sidebar.bulkSelect")}
            </button>
            <button
              type="button"
              class={styles.menuItem}
              onClick={() => {
                props.setSidebarMenuOpen(false);
                props.setSessionMenuOpen(true);
              }}
            >
              {t("sidebar.sessionActions")}
            </button>
          </div>
        </Show>

        <div class={styles.listArea}>
          <div class={styles.treeBody}>
            <SessionTree
              t={t}
              selected={props.selectedSessionID()}
              sessions={filteredSessions()}
              workspaces={props.workspaces()}
              liveStatuses={props.liveStatuses?.()}
              unreadCompleted={props.unreadCompleted?.()}
              groupBy={groupBy()}
              orderBy={orderBy()}
              archivedFilter={archivedFilter()}
              onLeaveArchivedOnly={() => pickArchivedFilter("default")}
              onRename={(id, title) => {
                void props.ctx.runtime
                  .sessionRename?.(id, title)
                  .then(() => props.refreshSessions());
              }}
              onPin={(id, pinned) => {
                void props.ctx.runtime
                  .sessionPin?.(id, pinned)
                  .then(() => props.refreshSessions());
              }}
              onDeleteSession={
                props.deleteSessionByID
                  ? (id) => void props.deleteSessionByID?.(id)
                  : undefined
              }
              onSelect={(id, name) => {
                props.markUserSelectedSession();
                props.onClearUnreadCompleted?.(id);
                props.setSelectedSessionID(id);
                props.setSelectedSession(name);
                // Instant switch from cached projection state before sessionAttach
                // dispatches natalia:session-switch-reset!
                const wsID = props
                  .allSessions?.()
                  .find((s) => s.id === id)?.workspaceID;
                props.ctx.projection.activateSession?.(id, wsID);
                void props.ctx.runtime.sessionAttach?.(id).then(() => {
                  void props.refreshWorkspaces();
                  void props.refreshSessions();
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
              bulkSelected={(sessionID) => props.bulkSelected().has(sessionID)}
              onBulkToggle={(sessionID) => props.toggleBulkSelected(sessionID)}
            />
            <span class={styles.fade} />
          </div>
        </div>
      </div>
    </div>
  );
}
