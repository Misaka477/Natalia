import type { AppState } from "./state";
import type { RuntimeEvent } from "@anthelia/contracts";

/**
 * Multi-workspace navigation projection.
 *
 * Workspace summaries are runtime facts, not UI-local state. Projecting them
 * here lets any host/plugin render the same workspace -> session tree without
 * each UI re-implementing add/activate/remove bookkeeping.
 */
export function applyWorkspaceEvent(
  state: AppState,
  event: RuntimeEvent,
): boolean {
  if (event.type === "workspace.added") {
    const workspace = event.workspace;
    const existing = state.workspaces.find(
      (entry) => entry.workspaceID === workspace.workspaceID,
    );
    if (existing) Object.assign(existing, workspace);
    else state.workspaces.push({ ...workspace });
    if (workspace.status === "active") {
      state.activeWorkspaceID = workspace.workspaceID;
      for (const entry of state.workspaces) {
        if (entry.workspaceID !== workspace.workspaceID) entry.status = "idle";
      }
    }
    return true;
  }

  if (event.type === "workspace.activated") {
    const workspace = event.workspace;
    const existing = state.workspaces.find(
      (entry) => entry.workspaceID === workspace.workspaceID,
    );
    if (existing) Object.assign(existing, workspace);
    else state.workspaces.push({ ...workspace });
    state.activeWorkspaceID = workspace.workspaceID;
    for (const entry of state.workspaces) {
      entry.status =
        entry.workspaceID === workspace.workspaceID ? "active" : "idle";
    }
    return true;
  }

  if (event.type === "workspace.removed") {
    const before = state.workspaces.length;
    state.workspaces = state.workspaces.filter(
      (entry) => entry.workspaceID !== event.workspaceID,
    );
    if (state.activeWorkspaceID === event.workspaceID) {
      state.activeWorkspaceID =
        state.workspaces.find((entry) => entry.status === "active")
          ?.workspaceID ?? state.workspaces[0]?.workspaceID;
      if (state.activeWorkspaceID) {
        const active = state.workspaces.find(
          (entry) => entry.workspaceID === state.activeWorkspaceID,
        );
        if (active) active.status = "active";
      }
    }
    state.sessions = state.sessions.filter(
      (session) => session.workspaceID !== event.workspaceID,
    );
    return before !== state.workspaces.length;
  }

  if (event.type === "session.created" || event.type === "session.ready") {
    if (event.workspaceID) {
      // Keep the current routing facts in sync even before a full session list
      // refresh lands. Full summaries arrive via sessionList().
      const existing = state.sessions.find(
        (session) => session.id === event.sessionID,
      );
      if (!existing) {
        state.sessions.push({
          id: event.sessionID,
          workspaceID: event.workspaceID,
          title: event.type === "session.created" ? event.title : "Session",
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
          pinned: false,
          events: 0,
          pendingInputs: 0,
          cancelled: false,
          resumable: true,
          status: "idle",
        });
      } else {
        existing.workspaceID = event.workspaceID;
      }
      if (!state.sessionID || state.sessionID === event.sessionID) {
        state.activeWorkspaceID = event.workspaceID;
        state.activeSessionID = event.sessionID;
        state.sessionID = event.sessionID;
      }
      return true;
    }
  }

  return false;
}
