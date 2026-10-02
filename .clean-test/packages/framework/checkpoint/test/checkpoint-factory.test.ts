import { expect, test } from "bun:test";
import { createCheckpointFactory } from "../src";

function fakeAccessors(overrides: {
  workspaceRoot: string;
  sessionID: string;
}) {
  const events: Array<{ type: string }> = [];
  const context = {
    journalStatus: () => ({ tokenEstimate: 0, messageCount: 0 }),
    durableCheckpoint: (step: number) => ({
      entries: [],
      journalOffset: step,
      step,
      tokenEstimate: 0,
      compactionGeneration: 0,
    }),
  };
  return {
    accessors: {
      sessionID: () => overrides.sessionID,
      workspaceRoot: overrides.workspaceRoot,
      checkpoint: () => undefined,
      workspace: () => undefined,
      publish: (event: { type: string }) => events.push(event),
      context: () => context,
      subagents: () => undefined,
      activeAbort: () => undefined,
      workLedger: () => ({
        checkpointNode: (input: { type?: string }) => ({
          type: "workgraph.node_added",
          ...input,
        }),
        rollbackCheckpointEdge: (input: { type?: string }) => ({
          type: "workgraph.edge_added",
          ...input,
        }),
      }),
    } as never,
    events,
  };
}

test("checkpoint factory returns one controller per session", () => {
  const factory = createCheckpointFactory({ workspaceRoot: "/tmp/ws" });
  const { accessors: first } = fakeAccessors({
    workspaceRoot: "/tmp/ws",
    sessionID: "ses_a",
  });
  const { accessors: second } = fakeAccessors({
    workspaceRoot: "/tmp/ws",
    sessionID: "ses_a",
  });
  const { accessors: other } = fakeAccessors({
    workspaceRoot: "/tmp/ws",
    sessionID: "ses_b",
  });
  expect(factory(first)).toBe(factory(second));
  expect(factory(first)).not.toBe(factory(other));
});

test("checkpoint factory close clears per-session controllers", () => {
  const factory = createCheckpointFactory({ workspaceRoot: "/tmp/ws" });
  const { accessors } = fakeAccessors({
    workspaceRoot: "/tmp/ws",
    sessionID: "ses_c",
  });
  const controller = factory(accessors);
  expect(controller.isEnabled()).toBe(false);
  expect(() => controller.get()).toThrow("checkpoint store is not initialized");
  expect(controller.resources()).toEqual([]);
  factory.close();
  const next = factory(
    fakeAccessors({ workspaceRoot: "/tmp/ws", sessionID: "ses_c" }).accessors,
  );
  expect(next).not.toBe(controller);
});
