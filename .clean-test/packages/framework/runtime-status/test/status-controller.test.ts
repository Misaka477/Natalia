import { expect, test } from "bun:test";
import { createStatusSnapshotController } from "../src";

function makeController(overrides?: {
  running?: number;
  context?: { tokenEstimate: number; messageCount: number };
  fail?: boolean;
}) {
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  const runningCount = overrides?.fail
    ? async () => {
        throw new Error("count exploded");
      }
    : async () => overrides?.running ?? 0;
  const controller = createStatusSnapshotController({
    provider: () => ({ provider: "test", model: "m1" }),
    context: () => ({
      journalStatus: () =>
        overrides?.context ?? { tokenEstimate: 42, messageCount: 3 },
    }),
    workspaceRoot: "/tmp/ws",
    permissionMode: () => "ask",
    runningCount,
    publish: (event) =>
      events.push(event as { type: string } & Record<string, unknown>),
  });
  return { controller, events };
}

test("snapshot reports provider, context, permissions and running counts", async () => {
  const { controller } = makeController({ running: 2 });
  const snapshot = await controller.snapshot();
  expect(snapshot.type).toBe("status.snapshot");
  expect(snapshot.model).toBe("m1");
  expect(snapshot.context).toBe("42 tokens");
  expect(snapshot.step).toBe("3");
  expect(snapshot.permissions).toBe("ask");
  expect(snapshot.cwd).toBe("/tmp/ws");
  expect(snapshot.background).toBe("2 running");
});

test("schedule coalesces: two schedules publish one snapshot", async () => {
  const { controller, events } = makeController();
  controller.schedule();
  controller.schedule();
  await Bun.sleep(10);
  expect(
    events.filter((event) => event.type === "status.snapshot"),
  ).toHaveLength(1);
});

test("a failed refresh publishes a warning diagnostic, not a crash", async () => {
  const { controller, events } = makeController({ fail: true });
  controller.schedule();
  await Bun.sleep(10);
  const warning = events.find((event) => event.type === "diagnostic");
  expect(warning?.level).toBe("warning");
  expect(String(warning?.message)).toContain("count exploded");
});

test("dispose cancels a queued status publication", async () => {
  const { controller, events } = makeController();
  controller.schedule();
  controller.dispose();
  await Bun.sleep(10);
  expect(events).toEqual([]);
});
