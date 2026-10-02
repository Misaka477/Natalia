import { expect, test } from "bun:test";
import { SubagentRegistry } from "../src/registry";
import type { RunnerContext, SubagentRecord } from "../src/types";

/** A registry whose runner blocks until its signal aborts, like a stuck call. */
function registryWithStuckRunner(budgetMs: number) {
  const aborted: string[] = [];
  const registry = new SubagentRegistry({
    workDir: "/tmp/natalia-wallclock",
    runner: async (_task: string, ctx: RunnerContext) => {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) {
          aborted.push("already-aborted");
          resolve();
          return;
        }
        ctx.signal.addEventListener("abort", () => {
          aborted.push("aborted");
          resolve();
        });
      });
    },
    sessionID: "s1",
    wallClockBudgetMs: budgetMs,
  });
  return { registry, aborted };
}

test("a run that outlives its budget is stopped", async () => {
  const { registry, aborted } = registryWithStuckRunner(30);
  await registry.spawn("stuck forever");
  // Give the deadline room to fire.
  await new Promise((resolve) => setTimeout(resolve, 120));

  const record = registry.get("a1") as SubagentRecord;
  expect(record.status).toBe("stopped");
  // The run's own completion path overwrites the detail with its status, so the
  // reason lives in the audit trail.
  expect(registry.audit()).toContain("wall-clock budget");
  expect(aborted).toContain("aborted");
});

test("a budget stop is attributed to the runtime, not the model", async () => {
  const { registry } = registryWithStuckRunner(20);
  await registry.spawn("stuck forever");
  await new Promise((resolve) => setTimeout(resolve, 120));

  // Attributed to the runtime rather than the model: nothing asked for this
  // stop, the deadline did.
  expect(registry.audit()).toContain("requested_by=runtime");
});

test("a healthy run is never stopped by its budget", async () => {
  const registry = new SubagentRegistry({
    workDir: "/tmp/natalia-wallclock",
    runner: async (_task: string, ctx: RunnerContext) => {
      ctx.log("working");
    },
    sessionID: "s1",
    wallClockBudgetMs: 5_000,
  });
  await registry.spawn("quick work");
  await new Promise((resolve) => setTimeout(resolve, 60));

  const record = registry.get("a1") as SubagentRecord;
  expect(record.status).toBe("completed");
  expect(registry.audit()).not.toContain("action=stop");
});

test("a disabled budget leaves a stuck run alone", async () => {
  // `0` means no budget, which is the pre-existing behaviour: the run continues
  // until something else stops it.
  const { registry } = registryWithStuckRunner(0);
  await registry.spawn("stuck forever");
  await new Promise((resolve) => setTimeout(resolve, 120));

  expect((registry.get("a1") as SubagentRecord).status).toBe("running");
});

test("each retry gets a fresh budget", async () => {
  // The budget is per run, so a retry is a deliberate new run with its own
  // allowance rather than inheriting the exhausted one.
  let runs = 0;
  const registry = new SubagentRegistry({
    workDir: "/tmp/natalia-wallclock",
    runner: async (_task: string, ctx: RunnerContext) => {
      runs += 1;
      if (runs === 1) {
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve());
        });
        return;
      }
      ctx.log("second run finished");
    },
    sessionID: "s1",
    wallClockBudgetMs: 40,
  });
  await registry.spawn("retry me");
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect((registry.get("a1") as SubagentRecord).status).toBe("stopped");

  await registry.retry("a1");
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The retry was given its own budget and finished inside it.
  expect((registry.get("a1") as SubagentRecord).status).toBe("completed");
});

test("a budget stop carries the configured duration in its reason", async () => {
  const { registry } = registryWithStuckRunner(25);
  await registry.spawn("stuck forever");
  await new Promise((resolve) => setTimeout(resolve, 120));

  expect(registry.audit()).toContain("25ms");
});
