import { expect, test } from "bun:test";
import { applyEvent, cloneState, initialState } from "../src";
import type { RuntimeEvent } from "@anthelia/contracts";

test("workspace.added and workspace.activated drive navigation state", () => {
  const state = initialState();
  applyEvent(state, {
    type: "workspace.added",
    workspace: {
      workspaceID: "ws_a",
      root: "/tmp/a",
      title: "A",
      status: "active",
      sessionCount: 1,
      runningSessionCount: 1,
    },
    workspaceID: "ws_a",
  } satisfies RuntimeEvent);

  expect(state.workspaces).toHaveLength(1);
  expect(state.activeWorkspaceID).toBe("ws_a");

  applyEvent(state, {
    type: "workspace.added",
    workspace: {
      workspaceID: "ws_b",
      root: "/tmp/b",
      title: "B",
      status: "idle",
      sessionCount: 0,
      runningSessionCount: 0,
    },
    workspaceID: "ws_b",
  } satisfies RuntimeEvent);

  applyEvent(state, {
    type: "workspace.activated",
    workspace: {
      workspaceID: "ws_b",
      root: "/tmp/b",
      title: "B",
      status: "active",
      sessionCount: 2,
      runningSessionCount: 0,
    },
    workspaceID: "ws_b",
  } satisfies RuntimeEvent);

  expect(state.activeWorkspaceID).toBe("ws_b");
  expect(
    state.workspaces.find((entry) => entry.workspaceID === "ws_a")?.status,
  ).toBe("idle");
  expect(
    state.workspaces.find((entry) => entry.workspaceID === "ws_b")?.status,
  ).toBe("active");
});

test("workspace.removed removes sessions from that workspace", () => {
  const state = initialState();
  applyEvent(state, {
    type: "workspace.added",
    workspace: {
      workspaceID: "ws_a",
      root: "/tmp/a",
      title: "A",
      status: "active",
      sessionCount: 1,
      runningSessionCount: 0,
    },
    workspaceID: "ws_a",
  } satisfies RuntimeEvent);
  applyEvent(state, {
    type: "session.created",
    sessionID: "ses_a",
    title: "Session A",
    workspaceID: "ws_a",
  } satisfies RuntimeEvent);

  applyEvent(state, {
    type: "workspace.removed",
    workspaceID: "ws_a",
  } satisfies RuntimeEvent);

  expect(state.workspaces).toHaveLength(0);
  expect(state.sessions).toHaveLength(0);
  expect(state.activeWorkspaceID).toBeUndefined();
});

test("session.created keeps a synthetic session summary for the active workspace", () => {
  const state = initialState();
  applyEvent(state, {
    type: "session.created",
    sessionID: "ses_a",
    title: "Session A",
    workspaceID: "ws_a",
  } satisfies RuntimeEvent);

  expect(state.activeWorkspaceID).toBe("ws_a");
  expect(state.activeSessionID).toBe("ses_a");
  expect(state.sessions[0]).toMatchObject({
    id: "ses_a",
    workspaceID: "ws_a",
    title: "Session A",
  });
});

test("cloneState copies workspace/session arrays", () => {
  const state = initialState();
  state.workspaces.push({
    workspaceID: "ws_a",
    root: "/tmp/a",
    title: "A",
    status: "active",
    sessionCount: 0,
    runningSessionCount: 0,
  });
  const next = cloneState(state);
  expect(next.workspaces).not.toBe(state.workspaces);
  expect(next.workspaces[0]).not.toBe(state.workspaces[0]);
});
