import { expect, test } from "bun:test";
import type {
  RuntimeSessionSummary,
  WorkspaceSummary,
} from "@anthelia/contracts";
import {
  collapsedSessionSlice,
  compactRelativeTime,
  findReusableBlankSession,
  isBlankSession,
  pinCurrentBlank,
  resolveTargetWorkspaceID,
  sectionSessions,
  sessionVisible,
} from "../src/controllers/workspace-tree";

function makeSession(
  overrides: Partial<RuntimeSessionSummary> & { id: string },
): RuntimeSessionSummary {
  return {
    id: overrides.id,
    title: overrides.title ?? "New session",
    createdAt: overrides.createdAt ?? "2026-10-20T00:00:00.000Z",
    pinned: overrides.pinned ?? false,
    archived: overrides.archived ?? false,
    events: overrides.events ?? 0,
    pendingInputs: overrides.pendingInputs ?? 0,
    cancelled: overrides.cancelled ?? false,
    resumable: overrides.resumable ?? true,
    status: overrides.status ?? "idle",
    ...(overrides.workspaceID ? { workspaceID: overrides.workspaceID } : {}),
    ...(overrides.lastAccessedAt
      ? { lastAccessedAt: overrides.lastAccessedAt }
      : {}),
  };
}

test("unselected blank sessions are hidden while the selected blank session is visible", () => {
  const blankA = makeSession({ id: "ses_blank_a", events: 0 });
  const blankB = makeSession({ id: "ses_blank_b", events: 0 });
  const engaged = makeSession({
    id: "ses_engaged",
    events: 4,
    title: "Real chat",
  });

  expect(isBlankSession(blankA)).toBe(true);
  expect(isBlankSession(engaged)).toBe(false);

  // When nothing is selected, no blank session appears in the tree.
  expect(sessionVisible(blankA, "", "default")).toBe(false);
  expect(sessionVisible(engaged, "", "default")).toBe(true);

  // When blankA is the selected session, only blankA appears; blankB stays hidden.
  expect(sessionVisible(blankA, "ses_blank_a", "default")).toBe(true);
  expect(sessionVisible(blankB, "ses_blank_a", "default")).toBe(false);
});

test("archived filter controls archived session visibility across all three modes", () => {
  const active = makeSession({ id: "ses_active", events: 2 });
  const archived = makeSession({ id: "ses_arch", events: 3, archived: true });

  expect(sessionVisible(active, "", "default")).toBe(true);
  expect(sessionVisible(archived, "", "default")).toBe(false);

  expect(sessionVisible(active, "", "show")).toBe(true);
  expect(sessionVisible(archived, "", "show")).toBe(true);

  expect(sessionVisible(active, "", "only")).toBe(false);
  expect(sessionVisible(archived, "", "only")).toBe(true);
});

test("sectionSessions fronts the selected blank session, then pinned, then ordinary by recency", () => {
  const older = makeSession({
    id: "ses_older",
    events: 2,
    lastAccessedAt: "2026-10-20T01:00:00.000Z",
  });
  const newer = makeSession({
    id: "ses_newer",
    events: 5,
    lastAccessedAt: "2026-10-20T03:00:00.000Z",
  });
  const pinned = makeSession({
    id: "ses_pinned",
    events: 1,
    pinned: true,
    lastAccessedAt: "2026-10-20T00:30:00.000Z",
  });
  const blank = makeSession({
    id: "ses_blank",
    events: 0,
    lastAccessedAt: "2026-10-20T00:10:00.000Z",
  });

  const ordered = sectionSessions(
    [older, newer, pinned, blank],
    "ses_blank",
    "updated",
  );
  expect(ordered.map((s) => s.id)).toEqual([
    "ses_blank",
    "ses_pinned",
    "ses_newer",
    "ses_older",
  ]);
});

test("collapsedSessionSlice keeps blank and running rows outside the 5-idle quota", () => {
  const rows = [
    { id: "blank", blank: true, running: false },
    { id: "run", blank: false, running: true },
    { id: "idle1", blank: false, running: false },
    { id: "idle2", blank: false, running: false },
    { id: "idle3", blank: false, running: false },
    { id: "idle4", blank: false, running: false },
    { id: "idle5", blank: false, running: false },
    { id: "idle6", blank: false, running: false },
  ];
  const slice = collapsedSessionSlice(rows, 5);
  expect(slice.rows.map((r) => r.id)).toEqual([
    "blank",
    "run",
    "idle1",
    "idle2",
    "idle3",
    "idle4",
    "idle5",
  ]);
  expect(slice.hiddenCount).toBe(1);
});

test("findReusableBlankSession reuses an existing blank session in the target workspace", () => {
  const sessions = [
    makeSession({ id: "ses_1", workspaceID: "ws_1", events: 3 }),
    makeSession({ id: "ses_blank_1", workspaceID: "ws_1", events: 0 }),
    makeSession({ id: "ses_blank_2", workspaceID: "ws_2", events: 0 }),
  ];
  expect(findReusableBlankSession(sessions, "ws_1")?.id).toBe("ses_blank_1");
  expect(findReusableBlankSession(sessions, "ws_2")?.id).toBe("ses_blank_2");
  expect(findReusableBlankSession(sessions, "ws_3")).toBeUndefined();
});

test("resolveTargetWorkspaceID prefers explicit, then selected session's workspace, then active workspace", () => {
  const workspaces: WorkspaceSummary[] = [
    {
      workspaceID: "ws_1",
      root: "/a",
      title: "A",
      status: "idle",
      sessionCount: 1,
      runningSessionCount: 0,
    },
    {
      workspaceID: "ws_2",
      root: "/b",
      title: "B",
      status: "active",
      sessionCount: 1,
      runningSessionCount: 0,
    },
  ];
  const sessions = [
    makeSession({ id: "ses_in_1", workspaceID: "ws_1", events: 2 }),
  ];

  expect(
    resolveTargetWorkspaceID("ws_1", "ses_in_1", sessions, workspaces, "ws_2"),
  ).toBe("ws_1");
  expect(
    resolveTargetWorkspaceID(
      undefined,
      "ses_in_1",
      sessions,
      workspaces,
      "ws_2",
    ),
  ).toBe("ws_1");
  expect(
    resolveTargetWorkspaceID(undefined, "", sessions, workspaces, "ws_2"),
  ).toBe("ws_2");
  expect(
    resolveTargetWorkspaceID(undefined, "", [], [], undefined),
  ).toBeUndefined();
});

test("compactRelativeTime formats distances into compact localized labels", () => {
  const t = (key: string, params?: Record<string, unknown>) =>
    params?.n !== undefined ? `${key}:${params.n}` : key;
  const now = Date.parse("2026-10-20T12:00:00.000Z");

  expect(compactRelativeTime("2026-10-20T11:59:40.000Z", now, t)).toBe(
    "sidebar.time.now",
  );
  expect(compactRelativeTime("2026-10-20T11:48:00.000Z", now, t)).toBe(
    "sidebar.time.minutes:12",
  );
  expect(compactRelativeTime("2026-10-20T09:00:00.000Z", now, t)).toBe(
    "sidebar.time.hours:3",
  );
  expect(compactRelativeTime("2026-10-18T12:00:00.000Z", now, t)).toBe(
    "sidebar.time.days:2",
  );
});
