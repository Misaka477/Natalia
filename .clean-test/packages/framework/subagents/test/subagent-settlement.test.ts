import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentRegistry, subagentSettlementReason } from "../src";
import type { RunnerCallback, RunnerContext } from "../src";

/**
 * The settlement spine's subagent adopter (the Natalia settlement plan's
 * block 4): every terminal transition fires the hook the composition
 * binds to the spine, so the parent is told instead of polling
 * `agent_wait`. The registry-level pins here; the composition's binding is
 * the thin part.
 */

const instantRunner: RunnerCallback = async () => undefined;

async function registryFor(
  workDir: string,
  onSettled: (record: { status: string; outputs: unknown[] }) => void,
) {
  return new SubagentRegistry({
    workDir,
    runner: instantRunner,
    clock: () => Date.now(),
    onSettled: onSettled as never,
  });
}

test("the reason mapping is the record's status, pure", () => {
  expect(subagentSettlementReason("completed")).toBe("completed");
  expect(subagentSettlementReason("failed")).toBe("failed");
  expect(subagentSettlementReason("stopped")).toBe("stopped");
});

test("a completed run fires the hook once with its record", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "subagent-settle-ok-"));
  const seen: Array<{ status: string; outputs: unknown[] }> = [];
  const registry = await registryFor(workDir, (record) => seen.push(record));
  await registry.spawn("do the thing", { parentSessionID: "ses_parent" });
  // The runPromise settles the run asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(seen).toHaveLength(1);
  expect(seen[0]!.status).toBe("completed");
  // One transition, one notice: a settled record does not re-fire.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(seen).toHaveLength(1);
});

test("a failed run fires the hook with the failure on the record", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "subagent-settle-fail-"));
  const seen: Array<{ status: string; outputs: unknown[] }> = [];
  const registry = new SubagentRegistry({
    workDir,
    runner: (async () => {
      throw new Error("provider exploded");
    }) as RunnerCallback,
    onSettled: (record) => seen.push(record) as never,
  });
  await registry.spawn("do the thing");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(seen).toHaveLength(1);
  expect(seen[0]!.status).toBe("failed");
});

test("a run the restart interrupted tells its parent on load", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "subagent-settle-restore-"));
  // Seed a store whose record is still "running" (an interrupted run).
  const first = new SubagentRegistry({
    workDir,
    runner: (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }) as RunnerCallback,
  });
  const record = await first.spawn("long work", {
    parentSessionID: "ses_gone",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await first.save();
  // A fresh registry (the restart) recovers it, and the hook fires.
  const seen: Array<{ status: string }> = [];
  const second = new SubagentRegistry({
    workDir,
    runner: instantRunner,
    onSettled: (recovered) => seen.push(recovered) as never,
  });
  await second.load();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.status).toBe("stopped");
  expect(record.status).toBe("running");
});

test("a throwing hook degrades — the child's ending never fails on it", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "subagent-settle-throw-"));
  const registry = new SubagentRegistry({
    workDir,
    runner: instantRunner,
    onSettled: () => {
      throw new Error("notice could not fly");
    },
  });
  // The run settles despite the hook's throw (the spine's discipline).
  const record = await registry.spawn("do the thing");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(registry.status(record.id)).toBe("completed");
});

test("a registry without the hook behaves exactly as before", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "subagent-settle-bare-"));
  const registry = new SubagentRegistry({
    workDir,
    runner: instantRunner,
  });
  const record = await registry.spawn("do the thing");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(registry.status(record.id)).toBe("completed");
});

test("a child sends findings to its parent mid-run, and still settles", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "subagent-sendmid-"));
  const messages: Array<{ agentId: string; text: string }> = [];
  const settled: Array<{ status: string }> = [];
  const registry = new SubagentRegistry({
    workDir,
    runner: (async (_task: string, ctx: RunnerContext) => {
      // A finding mid-run — the parent hears it live, before the end.
      ctx.sendToParent("the first decomposed task is done");
      await new Promise((resolve) => setTimeout(resolve, 10));
      ctx.sendToParent("the second one failed on the schema");
    }) as never,
    onChildMessage: (message) => messages.push(message),
    onSettled: (record) => settled.push(record) as never,
  });
  await registry.spawn("decompose and build");
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(messages.map((entry) => entry.text)).toEqual([
    "the first decomposed task is done",
    "the second one failed on the schema",
  ]);
  // The live messages are ALSO the run's durable record …
  const record = [...(registry.list() as never[])] as Array<{
    outputs: Array<{ text: string }>;
  }>;
  expect(record[0]!.outputs.map((entry) => entry.text)).toContain(
    "the first decomposed task is done",
  );
  // … and the settlement still fires at the end: the message channel
  // never replaces the ending.
  expect(settled).toHaveLength(1);
  expect(settled[0]!.status).toBe("completed");
});

test("a child's message never fails its run (the hook's degrade)", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "subagent-sendthrow-"));
  const registry = new SubagentRegistry({
    workDir,
    runner: (async (_task: string, ctx: RunnerContext) => {
      ctx.sendToParent("a report to a broken channel");
    }) as never,
    onChildMessage: () => {
      throw new Error("the parent cannot be reached");
    },
  });
  const record = await registry.spawn("decompose and build");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(registry.status(record.id)).toBe("completed");
});

test("a bare registry's sendToParent is a silent no-op", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "subagent-sendbare-"));
  const registry = new SubagentRegistry({
    workDir,
    runner: (async (_task: string, ctx: RunnerContext) => {
      ctx.sendToParent("nobody is listening");
    }) as never,
  });
  const record = await registry.spawn("decompose and build");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(registry.status(record.id)).toBe("completed");
});
