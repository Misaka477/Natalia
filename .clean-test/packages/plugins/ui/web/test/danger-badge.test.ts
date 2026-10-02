import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  dangerBadgeView,
  postureFromSnapshot,
  type DangerBadgeInput,
} from "../src/danger-badge";

/**
 * The danger indicator's view contract (sandbox study §6b①): a confined
 * session that never escalated is invisible (the indicator marks the
 * exception, not the norm); a danger-full-access session is always
 * marked; a confined session that escalated carries the escalation's
 * reason and time. The posture comes from the journal-derived snapshot
 * — the same source the audit trail reads.
 */

const confined: DangerBadgeInput = { mode: "workspace-write" };
const danger: DangerBadgeInput = { mode: "danger-full-access" };

test("a confined session with no escalation shows nothing", () => {
  expect(dangerBadgeView(confined).visible).toBe(false);
  expect(dangerBadgeView(undefined).visible).toBe(false);
  expect(dangerBadgeView({ mode: "read-only" }).visible).toBe(false);
});

test("a danger-full-access session is always marked", () => {
  const view = dangerBadgeView(danger);
  expect(view).toMatchObject({ visible: true, danger: true, label: "DANGER" });
  expect(view.title).toContain("文件影响模式：danger-full-access");
});

test("a confined session that escalated carries the reason and time", () => {
  const view = dangerBadgeView({
    mode: "workspace-write",
    escalatedTo: "danger-full-access",
    escalatedAt: "2026-09-24T00:00:00.000Z",
    justification: "the user asked for a host-wide install",
  });
  expect(view).toMatchObject({
    visible: true,
    danger: false,
    label: "ESCALATED",
  });
  // The title names the mode, the escalation, and its justification —
  // the same facts the audit trail holds.
  expect(view.title).toContain("文件影响模式：workspace-write");
  expect(view.title).toContain("本会话曾升级到 danger-full-access");
  expect(view.title).toContain("理由：the user asked for a host-wide install");
});

test("the posture rides the session snapshot event", () => {
  const snapshot = {
    type: "session.snapshot",
    id: "snap:1",
    agentStatus: "idle",
    changedFiles: 0,
    unvalidatedChanges: 0,
    hasPTY: false,
    hasSandbox: false,
    confinement: {
      mode: "danger-full-access",
      escalatedTo: "danger-full-access",
      escalatedAt: "2026-09-24T00:00:00.000Z",
      justification: "one-off",
    },
  } as unknown as Extract<RuntimeEvent, { type: "session.snapshot" }>;
  expect(postureFromSnapshot(snapshot)).toEqual(snapshot.confinement);
  expect(dangerBadgeView(postureFromSnapshot(snapshot)).danger).toBe(true);
  // A snapshot without the posture (an older build's event) answers
  // undefined, and the badge stays invisible — no invented state.
  const bare = {
    type: "session.snapshot",
    id: "snap:2",
    agentStatus: "idle",
    changedFiles: 0,
    unvalidatedChanges: 0,
    hasPTY: false,
    hasSandbox: false,
  } as unknown as Extract<RuntimeEvent, { type: "session.snapshot" }>;
  expect(postureFromSnapshot(bare)).toBeUndefined();
});
