import { expect, test } from "bun:test";
import {
  buildSessionIntelligenceSnapshot,
  buildSessionIntelligenceSnapshotFromFacts,
  countChangedFiles,
  countValidatedChanges,
  hasLivePTY,
  hasLiveSandbox,
  latestConfirmedOutput,
} from "../src/session-intelligence";
import type { RuntimeEvent } from "@anthelia/contracts";
import { sessionIntelligenceFactsFromEvents } from "@anthelia/session";

test("changed files count only work-graph workspace_change nodes", () => {
  const events: RuntimeEvent[] = [
    {
      type: "workgraph.node_added",
      id: "wg:action:t1",
      nodeID: "wg:action:t1",
      kind: "agent_action",
      summary: "turn",
      sessionID: "ses_1",
    },
    {
      type: "workgraph.node_added",
      id: "wg:change:t1:src/a.ts",
      nodeID: "wg:change:t1:src/a.ts",
      kind: "workspace_change",
      summary: "write_file changed",
      target: "src/a.ts",
      actor: "write_file",
      sessionID: "ses_1",
    },
    {
      type: "workgraph.node_added",
      id: "wg:change:t1:src/b.ts",
      nodeID: "wg:change:t1:src/b.ts",
      kind: "workspace_change",
      summary: "edit_file changed",
      target: "src/b.ts",
      actor: "edit_file",
      sessionID: "ses_1",
    },
  ];
  expect(countChangedFiles(events)).toBe(2);
});

test("validated changes come from evidence events, none today", () => {
  const events: RuntimeEvent[] = [
    {
      type: "evidence.recorded",
      id: "evidence_1",
      taskID: "task_1",
      objective: "objective",
      status: "validated",
      changes: [{ path: "src/a.ts", changeType: "modified", summary: "fixed" }],
    },
  ];
  expect(countValidatedChanges(events)).toBe(1);
  expect(countChangedFiles(events)).toBe(0);
});

test("latest confirmed output is the last content.done text", () => {
  const events: RuntimeEvent[] = [
    { type: "content.delta", id: "t1", text: "unconfirmed" },
    { type: "content.done", id: "t1", text: "confirmed one" },
    { type: "content.done", id: "t2", text: "final" },
  ];
  expect(latestConfirmedOutput(events)).toBe("final");
});

test("the snapshot bounds recent output to the schema's 2000-character cap", () => {
  const events: RuntimeEvent[] = [
    { type: "content.done", id: "t1", text: "x".repeat(3000) },
  ];
  const snapshot = buildSessionIntelligenceSnapshot({
    id: "snapshot:bound",
    events,
    live: { agentStatus: "idle" },
  });
  expect(snapshot.recentOutput?.length).toBe(2000);
});

test("PTY presence follows the last timeline action per pane", () => {
  const base = { target: { kind: "host", cwd: "/w" } } as const;
  const started: RuntimeEvent = {
    type: "terminal.timeline",
    id: "term_1",
    actor: "model",
    action: "started",
    status: "executed",
    summary: "started",
    at: "now",
    ...base,
  };
  const wrote: RuntimeEvent = {
    type: "terminal.timeline",
    id: "term_1",
    actor: "model",
    action: "write",
    status: "executed",
    summary: "write",
    at: "now",
    ...base,
  };
  const exited: RuntimeEvent = {
    type: "terminal.timeline",
    id: "term_1",
    actor: "model",
    action: "exit",
    status: "executed",
    summary: "exit",
    at: "now",
    ...base,
  };
  expect(hasLivePTY([started])).toBe(true);
  expect(hasLivePTY([started, wrote])).toBe(true);
  expect(hasLivePTY([started, wrote, exited])).toBe(false);
  expect(hasLivePTY([exited])).toBe(false);
});

test("sandbox presence follows the last status per sandbox", () => {
  const created: RuntimeEvent = {
    type: "sandbox.update",
    id: "sb_1",
    status: "created",
    root: "/w/.natalia/sandboxes/sb_1",
    isolationLevel: "workspace",
    changedFiles: 0,
    runningResources: 0,
    target: {
      kind: "sandbox",
      sandboxID: "sb_1",
      root: "/r",
      isolationLevel: "workspace",
    },
    resourcePolicy: "policy",
  };
  const deleted: RuntimeEvent = { ...created, status: "deleted" };
  expect(hasLiveSandbox([created])).toBe(true);
  expect(hasLiveSandbox([created, deleted])).toBe(false);
  expect(hasLiveSandbox([])).toBe(false);
});

test("snapshot builder is secret-safe and carries only derived counts", () => {
  const events: RuntimeEvent[] = [
    {
      type: "content.done",
      id: "t1",
      text: "the model reply",
    },
    {
      type: "workgraph.node_added",
      id: "wg:change:t1:src/a.ts",
      nodeID: "wg:change:t1:src/a.ts",
      kind: "workspace_change",
      summary: "write_file changed",
      target: "src/a.ts",
      actor: "write_file",
      sessionID: "ses_1",
    },
  ];
  const snapshot = buildSessionIntelligenceSnapshot({
    id: "snapshot:1",
    events,
    live: {
      agentStatus: "running",
      currentStep: "step 3",
      activeTool: "write_file",
    },
  });
  expect(snapshot).toMatchObject({
    type: "session.snapshot",
    id: "snapshot:1",
    agentStatus: "running",
    currentStep: "step 3",
    activeTool: "write_file",
    changedFiles: 1,
    unvalidatedChanges: 1,
    recentOutput: "the model reply",
    hasPTY: false,
    hasSandbox: false,
  });
  // The secret-safe boundary: no file content, no tool arguments, no results.
  expect(JSON.stringify(snapshot)).not.toContain("source code");
  expect(JSON.stringify(snapshot)).not.toContain("command");
  expect(JSON.stringify(snapshot)).not.toContain("arguments");
});

test("the snapshot carries the confinement posture: the live mode plus the last escalation", () => {
  const escalated: RuntimeEvent = {
    type: "confinement.escalated",
    at: "2026-09-24T00:00:00.000Z",
    from: "workspace-write",
    to: "danger-full-access",
    justification: "the user asked for a host-wide install",
    toolID: "run_shell",
  };
  const later: RuntimeEvent = {
    type: "confinement.escalated",
    at: "2026-09-24T01:00:00.000Z",
    from: "workspace-write",
    to: "danger-full-access",
    justification: "the second one",
    toolID: "run_shell",
  };
  // Both builder variants carry it: the last escalation wins, the mode
  // rides live (a runtime truth, not a journal fact).
  const events = [escalated, later];
  const live = {
    agentStatus: "idle",
    confinementMode: "workspace-write" as const,
  };
  const fromEvents = buildSessionIntelligenceSnapshot({
    id: "snap:1",
    events,
    live,
  });
  expect(fromEvents.confinement).toEqual({
    mode: "workspace-write",
    escalatedAt: "2026-09-24T01:00:00.000Z",
    escalatedTo: "danger-full-access",
    justification: "the second one",
  });
  const fromFacts = buildSessionIntelligenceSnapshotFromFacts({
    id: "snap:2",
    facts: sessionIntelligenceFactsFromEvents(events),
    live: { agentStatus: "idle", confinementMode: "danger-full-access" },
  });
  expect(fromFacts.confinement).toEqual({
    mode: "danger-full-access",
    escalatedAt: "2026-09-24T01:00:00.000Z",
    escalatedTo: "danger-full-access",
    justification: "the second one",
  });
  // No escalation: the mode alone, no invented facts.
  const quiet = buildSessionIntelligenceSnapshot({
    id: "snap:3",
    events: [],
    live,
  });
  expect(quiet.confinement).toEqual({ mode: "workspace-write" });
  // No mode passed (a surface that does not know it): no posture field.
  const bare = buildSessionIntelligenceSnapshot({
    id: "snap:4",
    events,
    live: { agentStatus: "idle" },
  });
  expect(bare.confinement).toBeUndefined();
});

test("the snapshot carries the L1 fabric's counters, and stays silent without them", () => {
  // DoD #3's "命中", observable: the cache's earning rides the snapshot's
  // live half (a runtime truth, like the confinement mode), per-kind split
  // intact. A bare context (no fabric) rides nothing rather than zeros.
  const cache = {
    hits: 7,
    misses: 3,
    byKind: {
      "tool.fs-read": { hits: 5, misses: 1, evictions: 0 },
      "tool.search": { hits: 2, misses: 2, evictions: 1 },
    },
  };
  const snapshot = buildSessionIntelligenceSnapshot({
    id: "snap:cache",
    events: [],
    live: { agentStatus: "idle", confinementMode: "workspace-write", cache },
  });
  expect(snapshot.cache).toEqual(cache);
  const bare = buildSessionIntelligenceSnapshot({
    id: "snap:bare",
    events: [],
    live: { agentStatus: "idle" },
  });
  expect(bare.cache).toBeUndefined();
});

test("the snapshot carries the provider prefix-cache tier beside the L1", () => {
  // RINA Phase 5's observable: the provider's own prefix cache is a tier
  // independent of the fabric (present with or without an L1), and an
  // absent tier stays absent rather than riding zeros.
  const snapshot = buildSessionIntelligenceSnapshot({
    id: "snap:provider",
    events: [],
    live: {
      agentStatus: "idle",
      confinementMode: "workspace-write",
      cache: {
        hits: 1,
        misses: 1,
        byKind: {},
        provider: {
          steps: 5,
          inputTokens: 500,
          cacheReadTokens: 485,
          hitShare: 0.97,
        },
      },
    },
  });
  expect(snapshot.cache?.provider).toEqual({
    steps: 5,
    inputTokens: 500,
    cacheReadTokens: 485,
    hitShare: 0.97,
  });
  const without = buildSessionIntelligenceSnapshot({
    id: "snap:provider-off",
    events: [],
    live: {
      agentStatus: "idle",
      confinementMode: "workspace-write",
      cache: { hits: 1, misses: 1, byKind: {} },
    },
  });
  expect(without.cache?.provider).toBeUndefined();
});
