/**
 * Pure workspace and session tree derivation: blank-session visibility,
 * reuse, section ordering, collapsed row limits, and relative-time labels.
 *
 * A newly created session with zero durable events is a provisional blank
 * session. Only the currently selected blank session appears in the sidebar
 * tree; unselected blank sessions stay hidden so workspaces without real
 * conversations display zero rows instead of empty "New session" placeholders,
 * and starting a session in a workspace reuses its existing blank session.
 */
import type {
  RuntimeSessionSummary,
  WorkspaceSummary,
} from "@anthelia/contracts";

/** Archived-row visibility choice applied to both tree and flat views. */
export type ArchivedFilter = "default" | "show" | "only";

/** Grouping choice in the workspace browser's view options menu. */
export type SessionGroupBy = "workspace" | "workspace-tree" | "flat";

/** Ordering choice in the workspace browser's view options menu. */
export type SessionOrderBy = "manual" | "updated";

/**
 * Whether a session summary is a provisional blank session (no durable events,
 * no queued inputs, not running, and not archived).
 */
export function isBlankSession(session: RuntimeSessionSummary): boolean {
  return (
    (session.events === 0 || session.title === "New session") &&
    (session.pendingInputs ?? 0) === 0 &&
    session.status !== "running" &&
    !session.archived
  );
}

/**
 * Whether a session row should appear in the sidebar under the current
 * selection and archived filter.
 *
 * Among blank sessions, only the currently selected one is visible.
 */
export function sessionVisible(
  session: RuntimeSessionSummary,
  currentSessionID: string | undefined,
  archivedFilter: ArchivedFilter = "default",
): boolean {
  if (isBlankSession(session) && session.id !== currentSessionID) return false;
  switch (archivedFilter) {
    case "default":
      return !session.archived;
    case "show":
      return true;
    case "only":
      return Boolean(session.archived);
  }
}

/** Epoch ms used for recency sorting and relative-time labels. */
export function sessionUpdatedAtMs(session: RuntimeSessionSummary): number {
  const raw = session.lastAccessedAt ?? session.createdAt;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Keep the selected provisional blank session ahead of the base order.
 */
export function pinCurrentBlank<T extends { id: string }>(
  items: readonly T[],
  currentBlankID: string | undefined,
): T[] {
  if (!currentBlankID) return [...items];
  const target = items.find((item) => item.id === currentBlankID);
  if (!target) return [...items];
  return [target, ...items.filter((item) => item.id !== currentBlankID)];
}

/**
 * Order a section's visible sessions: the selected blank placeholder first,
 * then unarchived pinned sessions, then ordinary sessions, then archived
 * sessions (when visible), ordered by recency or saved manual order.
 */
export function sectionSessions(
  sessions: readonly RuntimeSessionSummary[],
  currentSessionID: string | undefined,
  orderBy: SessionOrderBy = "updated",
  manualOrder?: readonly string[],
): RuntimeSessionSummary[] {
  const byRecency = [...sessions].sort((left, right) => {
    const diff = sessionUpdatedAtMs(right) - sessionUpdatedAtMs(left);
    if (diff !== 0) return diff;
    return left.id < right.id ? -1 : 1;
  });

  const baseOrdered: RuntimeSessionSummary[] = [];
  if (orderBy === "manual" && manualOrder && manualOrder.length > 0) {
    const byId = new Map(byRecency.map((item) => [item.id, item]));
    const seen = new Set<string>();
    for (const id of manualOrder) {
      const found = byId.get(id);
      if (!found || seen.has(id)) continue;
      baseOrdered.push(found);
      seen.add(id);
    }
    for (const item of byRecency) {
      if (!seen.has(item.id)) baseOrdered.push(item);
    }
  } else {
    baseOrdered.push(...byRecency);
  }

  const placeholders: RuntimeSessionSummary[] = [];
  const pinned: RuntimeSessionSummary[] = [];
  const ordinary: RuntimeSessionSummary[] = [];
  const archived: RuntimeSessionSummary[] = [];

  for (const session of baseOrdered) {
    if (isBlankSession(session) && session.id === currentSessionID) {
      placeholders.push(session);
    } else if (session.archived) {
      archived.push(session);
    } else if (session.pinned) {
      pinned.push(session);
    } else {
      ordinary.push(session);
    }
  }

  return [...placeholders, ...pinned, ...ordinary, ...archived];
}

/**
 * Keep provisional blank and running rows outside the idle-session quota
 * (5 by default) before the overflow button.
 */
export function collapsedSessionSlice<
  T extends { blank: boolean; running: boolean },
>(
  sessions: readonly T[],
  limit = 5,
): {
  rows: T[];
  hiddenCount: number;
} {
  let idleCount = 0;
  const rows = sessions.filter((session) => {
    if (session.blank || session.running) return true;
    if (idleCount >= limit) return false;
    idleCount += 1;
    return true;
  });
  return { rows, hiddenCount: sessions.length - rows.length };
}

/**
 * Find an existing reusable blank session in the target workspace so starting
 * a new session does not create duplicate empty records.
 */
export function findReusableBlankSession(
  sessions: readonly RuntimeSessionSummary[],
  workspaceID: string,
  activeWorkspaceID?: string,
): RuntimeSessionSummary | undefined {
  return sessions.find((session) => {
    const owner = session.workspaceID ?? activeWorkspaceID;
    return owner === workspaceID && isBlankSession(session);
  });
}

/**
 * Resolve which workspace a top-level "New Session" action targets:
 *   1. explicit workspaceID argument;
 *   2. workspace owning the currently selected session;
 *   3. active workspace from projection or workspace list;
 *   4. workspace with the most recent session activity, or the first workspace.
 */
export function resolveTargetWorkspaceID(
  explicitWorkspaceID: string | undefined,
  selectedSessionID: string,
  sessions: readonly RuntimeSessionSummary[],
  workspaces: readonly WorkspaceSummary[],
  activeWorkspaceID?: string,
): string | undefined {
  if (explicitWorkspaceID) return explicitWorkspaceID;
  if (selectedSessionID) {
    const owner = sessions.find(
      (session) => session.id === selectedSessionID,
    )?.workspaceID;
    if (owner && workspaces.some((ws) => ws.workspaceID === owner)) {
      return owner;
    }
  }
  if (
    activeWorkspaceID &&
    workspaces.some((ws) => ws.workspaceID === activeWorkspaceID)
  ) {
    return activeWorkspaceID;
  }
  const active = workspaces.find((ws) => ws.status === "active")?.workspaceID;
  if (active) return active;

  let bestID: string | undefined;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const ws of workspaces) {
    let latest = Number.NEGATIVE_INFINITY;
    for (const session of sessions) {
      if (session.workspaceID === ws.workspaceID) {
        latest = Math.max(latest, sessionUpdatedAtMs(session));
      }
    }
    if (bestID === undefined || latest > bestTime) {
      bestID = ws.workspaceID;
      bestTime = latest;
    }
  }
  return bestID;
}

/** Normalize path separators for ancestor workspace comparisons. */
function normalizeFolderPath(path: string): string {
  const windows = /^[A-Za-z]:[/\\]/u.test(path) || path.startsWith("\\\\");
  return (windows ? path.replaceAll("\\", "/") : path).replace(/\/+$/u, "");
}

/**
 * Find the nearest registered ancestor workspace path for `workspace-tree`
 * grouping mode.
 */
export function owningParentWorkspaceID(
  workspace: WorkspaceSummary,
  workspaces: readonly WorkspaceSummary[],
): string | undefined {
  const child = normalizeFolderPath(workspace.root);
  let bestParent: WorkspaceSummary | undefined;
  let bestLength = -1;
  for (const candidate of workspaces) {
    if (candidate.workspaceID === workspace.workspaceID) continue;
    const root = normalizeFolderPath(candidate.root);
    if (
      root.length > bestLength &&
      child !== root &&
      child.startsWith(`${root}/`)
    ) {
      bestParent = candidate;
      bestLength = root.length;
    }
  }
  return bestParent?.workspaceID;
}

/**
 * Format compact relative time for session rows ("刚刚", "12分钟", "18小时", "2天").
 */
export function compactRelativeTime(
  isoOrEpoch: string | number | undefined,
  now: number,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (isoOrEpoch === undefined || isoOrEpoch === "") return "";
  const timestamp =
    typeof isoOrEpoch === "number" ? isoOrEpoch : Date.parse(isoOrEpoch);
  if (!Number.isFinite(timestamp)) return "";
  const elapsedMs = Math.max(0, now - timestamp);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return t("sidebar.time.now");
  if (minutes < 60) return t("sidebar.time.minutes", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("sidebar.time.hours", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("sidebar.time.days", { n: days });
  const months = Math.floor(days / 30);
  if (months < 12) return t("sidebar.time.months", { n: months });
  const years = Math.floor(days / 365);
  return t("sidebar.time.years", { n: Math.max(1, years) });
}
