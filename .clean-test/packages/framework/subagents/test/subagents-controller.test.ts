import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubagentsController } from "../src/subagents-controller";

test("subagents controller reports disabled before init", () => {
  const controller = createSubagentsController({ workDir: "/tmp/ws" });
  expect(controller.enabled()).toBe(false);
  expect(controller.runningCount()).toBe(0);
  expect(() => controller.list()).toThrow(
    "subagent registry is not initialized",
  );
});

test("subagents controller inits with an injected runner and spawns", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-subagents-controller-"));
  const controller = createSubagentsController({ workDir: root });
  await controller.init(async () => {});
  expect(controller.enabled()).toBe(true);
  const spawned = await controller.spawn("hello");
  expect(spawned.id).toBe("a1");
  const record = controller.get("a1");
  expect(record?.task).toBe("hello");
  expect(controller.runningCount()).toBe(0);
});
