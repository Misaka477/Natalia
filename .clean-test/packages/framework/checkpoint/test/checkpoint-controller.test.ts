import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpointController } from "../src";

function makeController(workspaceRoot: string, enabled: boolean) {
  const events: Array<{ type: string }> = [];
  const controller = createCheckpointController({
    sessionID: () => "ses_ctrl" as const,
    workspaceRoot,
    checkpoint: () =>
      (enabled ? { enabled: true } : { enabled: false }) as never,
    workspace: () => undefined,
    publish: (event) => events.push(event),
    context: () =>
      ({
        journalStatus: () => ({ tokenEstimate: 0, messageCount: 0 }),
        durableCheckpoint: (step: number) => ({
          entries: [],
          journalOffset: step,
          step,
          tokenEstimate: 0,
          compactionGeneration: 0,
        }),
      }) as never,
    subagents: () => undefined,
    activeAbort: () => undefined,
    workLedger: () => ({
      checkpointNode: (input) =>
        ({ type: "workgraph.node_added", ...input }) as never,
      rollbackCheckpointEdge: (input) =>
        ({ type: "workgraph.edge_added", ...input }) as never,
    }),
  });
  return { controller, events };
}

test("checkpoint controller reports disabled before init and empty resources", () => {
  const { controller } = makeController("/tmp/ws", true);
  expect(controller.isEnabled()).toBe(false);
  expect(() => controller.get()).toThrow("checkpoint store is not initialized");
  expect(controller.resources()).toEqual([]);
});

test("checkpoint controller init opens disabled stores", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-checkpoint-controller-"));
  const { controller } = makeController(root, false);
  await controller.init();
  expect(controller.isEnabled()).toBe(false);
  expect(controller.get()).toBeDefined();
  expect(controller.resources()).toEqual([]);
});

test("enabled checkpoint controller initializes a baseline", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-checkpoint-controller-2-"),
  );
  const { controller } = makeController(root, true);
  await controller.init();
  expect(controller.isEnabled()).toBe(true);
  expect(controller.get()).toBeDefined();
});
