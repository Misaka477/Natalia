import { expect, test, afterEach } from "bun:test";
import { mkdtemp, mkdir, readdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SubagentRegistry, SubagentStore } from "../src";
import type { SubagentEvent } from "../src";

function tempDir() {
  return mkdtemp(join(tmpdir(), "natalia-subagent-"));
}

function fakeClock(initial = 0) {
  let current = initial;
  return {
    now: () => current,
    advance: (milliseconds: number) => (current += milliseconds),
  };
}

function subscribeTo(registry: SubagentRegistry) {
  const events: SubagentEvent[] = [];
  const unsubscribe = registry.subscribe((event) => events.push(event));
  return { events, unsubscribe };
}

function immediateRunner(
  task: string,
  ctx: { log: (t: string) => void; setStatus: (s: string) => void },
) {
  ctx.log(`starting: ${task}`);
  ctx.log(`done: ${task}`);
  ctx.setStatus("completed");
}

async function delayedRunner(
  task: string,
  ctx: {
    log: (t: string) => void;
    setStatus: (s: string) => void;
    signal: AbortSignal;
  },
) {
  ctx.log(`starting: ${task}`);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      ctx.setStatus("stopped");
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (ctx.signal.aborted) {
      onAbort();
      return;
    }
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    setTimeout(() => {
      ctx.signal.removeEventListener("abort", onAbort);
      ctx.log(`done: ${task}`);
      ctx.setStatus("completed");
      resolve();
    }, 50);
  });
}

afterEach(() => {});

test("spawn creates record and runs runner", async () => {
  const dir = await tempDir();
  const reg = new SubagentRegistry({ runner: immediateRunner, workDir: dir });
  const rec = await reg.spawn("test task");
  expect(rec.id).toBe("a1");
  expect(rec.task).toBe("test task");
  expect(rec.status).toBe("completed");
  expect(rec.outputs.length).toBe(2);
  expect(rec.outputs[0].text).toBe("starting: test task");
  expect(rec.outputs[1].text).toBe("done: test task");
});

test("a runner that sets an unknown status fails the run instead of storing it", async () => {
  const dir = await tempDir();
  const bogusStatusRunner = (
    _task: string,
    ctx: { setStatus: (status: string) => void },
  ) => {
    ctx.setStatus("not-a-real-status");
  };
  const reg = new SubagentRegistry({
    runner: bogusStatusRunner,
    workDir: dir,
  });
  const rec = await reg.spawn("task");
  // The record's status is the closed SubagentStatus union; an unknown value is
  // rejected at the write, failing the run — never silently stored.
  expect(rec.status).toBe("failed");
  expect(rec.activityDetail).toContain("invalid subagent status");
});

test("spawn rejects empty task", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  expect(reg.spawn("")).rejects.toThrow("task is required");
});

test("list returns spawned agents", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  expect(reg.list()).toHaveLength(0);
  await reg.spawn("task1");
  await reg.spawn("task2");
  expect(reg.list()).toHaveLength(2);
});

test("get returns agent by id", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  const rec = await reg.spawn("get test");
  expect(reg.get("a1")).toBe(rec);
  expect(reg.get("nonexistent" as any)).toBeUndefined();
});

test("status returns agent status", async () => {
  const reg = new SubagentRegistry({
    runner: delayedRunner,
    workDir: await tempDir(),
  });
  const rec = await reg.spawn("status test");
  expect(rec.status).toBe("running");
  expect(reg.runningCount()).toBe(1);
  await new Promise((r) => setTimeout(r, 100));
  expect(rec.status).toBe("completed");
  expect(reg.runningCount()).toBe(0);
});

test("output returns agent outputs", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  await reg.spawn("output test");
  const outputs = reg.output("a1");
  expect(outputs).toBeDefined();
  expect(outputs).toHaveLength(2);
  expect(reg.output("missing" as any)).toBeUndefined();
});

test("formatOutput defaults to the concise final result and keeps verbose audit opt-in", async () => {
  const root = await tempDir();
  const registry = new SubagentRegistry({
    workDir: root,
    runner: async (_task, context) => {
      context.log("thinking: internal detail");
      context.log("final factual result");
    },
  });
  const agent = await registry.spawn("concise output");
  for (let index = 0; index < 50; index++) {
    if (registry.status(agent.id) === "completed") break;
    await Bun.sleep(10);
  }
  expect(await registry.formatOutput(agent.id)).toContain(
    "final factual result",
  );
  expect(await registry.formatOutput(agent.id)).not.toContain("thinking:");
  expect(await registry.formatOutput(agent.id, true)).toContain(
    "thinking: internal detail",
  );
});

test("stop compatibility wrapper protects an active agent", async () => {
  const dir = await tempDir();
  const reg = new SubagentRegistry({ runner: delayedRunner, workDir: dir });
  await reg.spawn("stop test");
  expect(reg.status("a1")).toBe("running");
  const ok = reg.stop("a1");
  expect(ok).toBeFalse();
  expect(reg.status("a1")).toBe("running");
});

test("force stop persists a running agent status without waiting for completion", async () => {
  const dir = await tempDir();
  const reg = new SubagentRegistry({ runner: delayedRunner, workDir: dir });
  await reg.spawn("persist stop");
  expect(reg.requestStop("a1", "operator override", true).outcome).toBe(
    "stopped",
  );
  await Bun.sleep(20);
  expect((await new SubagentStore(dir).load())[0]?.status).toBe("stopped");
});

test("stop returns false for unknown agent", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  expect(reg.stop("missing" as any)).toBeFalse();
});

test("requestStop protects an active agent", async () => {
  const clock = fakeClock(1_000);
  const reg = new SubagentRegistry({
    runner: delayedRunner,
    workDir: await tempDir(),
    clock: clock.now,
    stallThresholdMs: 1_000,
  });
  const rec = await reg.spawn("protected stop");
  expect(reg.requestStop(rec.id, "no longer needed")).toEqual({
    outcome: "protected",
    id: rec.id,
    health: "active",
    retryAfterMs: 1_000,
  });
  expect(rec.status).toBe("running");
});

test("requestStop with force interrupts an active agent and records why", async () => {
  const reg = new SubagentRegistry({
    runner: delayedRunner,
    workDir: await tempDir(),
  });
  const { events } = subscribeTo(reg);
  const rec = await reg.spawn("forced stop");
  expect(reg.requestStop(rec.id, "operator override", true)).toEqual({
    outcome: "stopped",
    id: rec.id,
  });
  const stopped = events.find((event) => event.event === "stopped");
  expect(stopped).toMatchObject({
    stopReason: "operator override",
    requestedBy: "model",
    force: true,
  });
  expect(reg.getAuditEntries()).toContainEqual(
    expect.objectContaining({
      action: "stop",
      stopReason: "operator override",
      requestedBy: "model",
      force: true,
    }),
  );
});

test("requestStop allows a stalled agent with a reason", async () => {
  const clock = fakeClock(1_000);
  const reg = new SubagentRegistry({
    runner: delayedRunner,
    workDir: await tempDir(),
    clock: clock.now,
    stallThresholdMs: 1_000,
  });
  const rec = await reg.spawn("stalled stop");
  clock.advance(1_000);
  expect(reg.health(rec.id)).toBe("stalled");
  expect(reg.requestStop(rec.id, "no activity for one second")).toEqual({
    outcome: "stopped",
    id: rec.id,
  });
  expect(rec.activityDetail).toBe("no activity for one second");
});

test("requestStop is idempotent after an agent stops", async () => {
  const reg = new SubagentRegistry({
    runner: delayedRunner,
    workDir: await tempDir(),
  });
  const rec = await reg.spawn("double stop");
  expect(reg.requestStop(rec.id, "first stop", true).outcome).toBe("stopped");
  expect(reg.requestStop(rec.id, "second stop", true)).toEqual({
    outcome: "not_running",
    id: rec.id,
    status: "stopped",
  });
  expect(
    reg.getAuditEntries().filter((entry) => entry.action === "stop"),
  ).toHaveLength(1);
});

test("resume restarts a paused runner", async () => {
  let runs = 0;
  const reg = new SubagentRegistry({
    runner: async () => {
      runs++;
    },
    workDir: await tempDir(),
  });
  await reg.spawn("resume test");
  await Bun.sleep(10);
  expect(await reg.resume("a1")).toBeFalse();
  const rec = reg.get("a1")!;
  (rec as any).status = "paused";
  expect(await reg.resume("a1")).toBeTrue();
  await Bun.sleep(10);
  expect(runs).toBe(2);
  expect(rec.status).toBe("completed");
});

test("resume returns false for unknown agent", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  expect(await reg.resume("missing" as any)).toBeFalse();
});

test("attach/detach toggle attached flag", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  await reg.spawn("attach test");
  const rec = reg.get("a1")!;
  expect(rec.attached).toBeTrue();
  expect(reg.detach("a1")).toBeTrue();
  expect(rec.attached).toBeFalse();
  expect(reg.attach("a1")).toBeTrue();
  expect(rec.attached).toBeTrue();
  expect(reg.detach("missing" as any)).toBeFalse();
  expect(reg.attach("missing" as any)).toBeFalse();
});

test("cleanup removes completed/failed/stopped agents", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  await reg.spawn("c1");
  await reg.spawn("c2");
  await new Promise((r) => setTimeout(r, 10));
  const affected = reg.cleanup();
  expect(affected).toHaveLength(2);
  expect(reg.list()).toHaveLength(0);
});

test("cleanup dry run does not remove agents", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  await reg.spawn("dry");
  await new Promise((r) => setTimeout(r, 10));
  const affected = reg.cleanup(true);
  expect(affected).toHaveLength(1);
  expect(reg.list()).toHaveLength(1);
});

test("audit returns text format by default", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  await reg.spawn("audit test");
  const audit = reg.audit();
  expect(audit).not.toBe("<no agent audit entries>");
  expect(audit).toContain("event_id=");
  expect(audit).toContain("agent_id=");
  expect(audit).toContain("action=");
  expect(audit).toContain("status=");
});

test("audit returns json format", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  await reg.spawn("json audit");
  const json = reg.audit(undefined, "json");
  expect(json).toStartWith("[");
  expect(json).toContain("event_id");
  expect(json).toContain("resource_type");
  expect(json).toContain("agent_id");
  expect(json).toContain("action");
  expect(json).toContain("status");
  expect(json).toContain("time");
});

test("audit tail limits entries", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  await reg.spawn("tail test");
  await reg.spawn("tail test 2");
  const tail = reg.audit(1);
  const lines = tail.split("\n");
  expect(lines).toHaveLength(1);
});

test("audit returns no entries message when empty", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  expect(reg.audit()).toBe("<no agent audit entries>");
});

test("subscribe receives events", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  const { events, unsubscribe } = subscribeTo(reg);
  await reg.spawn("events");
  await new Promise((r) => setTimeout(r, 10));
  const eventNames = events.map((e) => e.event);
  expect(eventNames.length).toBeGreaterThanOrEqual(3);
  expect(eventNames).toContain("created");
  const done = events.find((e) => e.event === "done");
  expect(done).toBeDefined();
  unsubscribe();
});

test("subscribe unsubscribe stops events", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  const { events, unsubscribe } = subscribeTo(reg);
  unsubscribe();
  await reg.spawn("unsub");
  await new Promise((r) => setTimeout(r, 10));
  expect(events).toHaveLength(0);
});

test("fake clock advances deterministically", () => {
  const clock = fakeClock(1_000);
  expect(clock.now()).toBe(1_000);
  clock.advance(250);
  expect(clock.now()).toBe(1_250);
});

test("formatList returns formatted output", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  const formatted = await reg.formatList();
  expect(formatted).toBe("no subagents");
  await reg.spawn("format list");
  const list = await reg.formatList();
  expect(list).toContain("a1");
  expect(list).toContain("completed");
  expect(list).toContain("format list");
  expect(list).toContain("remaining_resources:");
});

test("formatOutput returns a concise result and can expose full agent outputs", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  await reg.spawn("format out");
  const out = await reg.formatOutput("a1");
  expect(out).toContain("done: format out");
  expect(out).not.toContain("starting: format out");
  expect(await reg.formatOutput("a1", true)).toContain("starting: format out");
  expect(reg.formatOutput("missing" as any)).rejects.toThrow("not found");
});

test("formatStatus returns detailed agent info", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  await reg.spawn("status detail");
  const s = await reg.formatStatus("a1");
  expect(s).toContain("a1");
  expect(s).toContain("completed");
  expect(s).toContain("status detail");
  expect(reg.formatStatus("missing" as any)).rejects.toThrow("not found");
});

test("store saves and loads manifest", async () => {
  const dir = await tempDir();
  const store = new SubagentStore(dir);
  const records = await store.load();
  expect(records).toHaveLength(0);
  const now = Date.now();
  await store.save([
    {
      id: "a1" as any,
      task: "persist",
      mode: "code",
      status: "completed",
      attached: true,
      modelProfile: "",
      allowedTools: [],
      excludeTools: [],
      outputs: [{ step: 1, text: "ok", timestamp: now }],
      createdAt: now,
      updatedAt: now,
      phase: "finalizing",
      lastActivityAt: now,
      activityDetail: "completed",
      startedAt: now,
    },
  ]);
  const loaded = await store.load();
  expect(loaded).toHaveLength(1);
  expect(loaded[0].id).toBe("a1");
  expect(loaded[0].task).toBe("persist");
  expect(loaded[0].outputs[0].text).toBe("ok");
});

test("store handles missing directory", async () => {
  const dir = await tempDir();
  const store = new SubagentStore(join(dir, "nonexistent"));
  const records = await store.load();
  expect(records).toHaveLength(0);
});

test("store handles corrupt manifest", async () => {
  const dir = await tempDir();
  const store = new SubagentStore(dir);
  await mkdir(store.dir, { recursive: true });
  await writeFile(join(store.dir, "manifest.json"), "{corrupt");
  const records = await store.load();
  expect(records).toHaveLength(0);
});

test("store keeps its state under .natalia and never in the workspace root", async () => {
  const dir = await tempDir();
  const store = new SubagentStore(dir);
  expect(store.dir).toBe(join(dir, ".natalia", "subagents"));
  const now = Date.now();
  await store.save([
    {
      id: "a1" as any,
      task: "placement",
      mode: "code",
      status: "completed",
      attached: false,
      modelProfile: "",
      allowedTools: [],
      excludeTools: [],
      outputs: [{ step: 1, text: "done", timestamp: now }],
      createdAt: now,
      updatedAt: now,
      phase: "finalizing",
      lastActivityAt: now,
      activityDetail: "completed",
      startedAt: now,
    },
  ]);
  // A workspace root is the user's project directory. Writing a manifest there
  // would leave a stray file next to their own sources.
  expect(await readdir(dir)).toEqual([".natalia"]);
  expect(await readdir(store.dir)).toEqual(["manifest.json"]);
  expect((await store.load())[0]?.task).toBe("placement");
});

test("spawn respects AbortSignal from options", async () => {
  const reg = new SubagentRegistry({
    runner: delayedRunner,
    workDir: await tempDir(),
  });
  const ac = new AbortController();
  const spawnPromise = reg.spawn("abortable", { signal: ac.signal });
  ac.abort();
  const rec = await spawnPromise;
  expect(rec.status).toBe("stopped");
});

test("spawn sets mode and modelProfile from options", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  const rec = await reg.spawn("options", {
    mode: "debug",
    modelProfile: "strong",
    allowedTools: ["read", "write"],
    excludeTools: ["delete"],
  });
  expect(rec.mode).toBe("debug");
  expect(rec.modelProfile).toBe("strong");
  expect(rec.allowedTools).toEqual(["read", "write"]);
  expect(rec.excludeTools).toEqual(["delete"]);
});

test("load restores agents from store on construction", async () => {
  const dir = await tempDir();
  const store = new SubagentStore(dir);
  const now = Date.now();
  await store.save([
    {
      id: "a1" as any,
      task: "pre existing",
      mode: "code",
      status: "completed",
      attached: false,
      modelProfile: "",
      allowedTools: [],
      excludeTools: [],
      outputs: [{ step: 1, text: "done", timestamp: now }],
      createdAt: now,
      updatedAt: now,
      phase: "finalizing",
      lastActivityAt: now,
      activityDetail: "completed",
      startedAt: now,
    },
  ]);
  const reg = new SubagentRegistry({ runner: immediateRunner, workDir: dir });
  await reg.load();
  expect(reg.list()).toHaveLength(1);
  expect(reg.get("a1" as any)?.task).toBe("pre existing");
});

test("load marks process-local running agents stopped after runtime restart", async () => {
  const dir = await tempDir();
  const store = new SubagentStore(dir);
  const now = Date.now();
  await store.save([
    {
      id: "a1" as any,
      task: "interrupted",
      mode: "code",
      status: "running",
      attached: true,
      modelProfile: "",
      allowedTools: [],
      excludeTools: [],
      outputs: [],
      createdAt: now,
      updatedAt: now,
      phase: "provider",
      lastActivityAt: now,
      activityDetail: "running",
      startedAt: now,
    },
  ]);
  const registry = new SubagentRegistry({
    runner: immediateRunner,
    workDir: dir,
  });
  await registry.load();
  expect(registry.status("a1" as any)).toBe("stopped");
  expect(registry.output("a1" as any)?.at(-1)?.text).toContain(
    "runtime restarted",
  );
  expect((await store.load())[0]?.status).toBe("stopped");
});

test("retry explicitly starts a new continuation for stopped subagents", async () => {
  const root = await tempDir();
  let calls = 0;
  const registry = new SubagentRegistry({
    workDir: root,
    runner: async (_task, context) => {
      calls++;
      context.log(`run ${calls}`);
      if (calls === 1) throw new Error("first run failed");
    },
  });
  const record = await registry.spawn("retry task", {
    parentSessionID: "ses_parent",
  });
  for (let attempt = 0; attempt < 20 && record.status !== "failed"; attempt++)
    await Bun.sleep(5);
  expect(record.status).toBe("failed");
  const retried = await registry.retry(record.id);
  for (
    let attempt = 0;
    attempt < 20 && record.status !== "completed";
    attempt++
  )
    await Bun.sleep(5);
  expect(retried?.continuation).toBe(1);
  expect(record.status).toBe("completed");
  expect(record.parentSessionID).toBe("ses_parent");
  expect(
    record.outputs.some((output) =>
      output.text.includes("retrying continuation 1"),
    ),
  ).toBe(true);
});

test("spawn enforces configured nested subagent depth", async () => {
  const registry = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  const root = await registry.spawn("root", { maxDepth: 2 });
  const child = await registry.spawn("child", {
    parentAgentID: root.id,
    maxDepth: 2,
  });
  await expect(
    registry.spawn("grandchild", { parentAgentID: child.id, maxDepth: 2 }),
  ).rejects.toThrow("depth limit reached (2)");
  expect(child.parentAgentID).toBe(root.id);
});

test("save persists to store", async () => {
  const dir = await tempDir();
  const reg = new SubagentRegistry({ runner: immediateRunner, workDir: dir });
  await reg.spawn("save test");
  await reg.save();
  const store = new SubagentStore(dir);
  const records = await store.load();
  expect(records).toHaveLength(1);
  expect(records[0].task).toBe("save test");
});

test("spawn auto-saves after runner completes", async () => {
  const dir = await tempDir();
  const reg = new SubagentRegistry({ runner: delayedRunner, workDir: dir });
  await reg.spawn("auto save");
  const store = new SubagentStore(dir);
  let records = await store.load();
  // Auto-save is asynchronous; poll instead of racing a fixed sleep.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (records.length === 1 && records[0]?.status === "completed") break;
    await Bun.sleep(10);
    records = await store.load();
  }
  expect(records).toHaveLength(1);
  expect(records[0].status).toBe("completed");
});

test("runner failure sets failed status", async () => {
  const reg = new SubagentRegistry({
    runner: async (
      _task: string,
      ctx: {
        log: (t: string) => void;
        setStatus: (s: string) => void;
        signal: AbortSignal;
      },
    ) => {
      ctx.setStatus("running");
      throw new Error("runner failed");
    },
    workDir: await tempDir(),
  });
  const rec = await reg.spawn("fail test");
  await new Promise((r) => setTimeout(r, 10));
  expect(rec.status).toBe("failed");
  expect(rec.outputs.some((o) => o.text.includes("runner failed"))).toBeTrue();
});

test("reportActivity updates lastActivityAt and phase", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  const rec = await reg.spawn("activity test");
  expect(rec.phase).not.toBe("idle");
  expect(rec.lastActivityAt).toBeGreaterThanOrEqual(rec.createdAt);
  expect(rec.activityDetail).toBeTruthy();
});

test("reportActivity from external caller updates the record without touching status", async () => {
  const dir = await tempDir();
  const reg = new SubagentRegistry({
    runner: async (_task, ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
    workDir: dir,
  });
  const rec = await reg.spawn("external activity");
  const prevActivity = rec.lastActivityAt;
  await Bun.sleep(5);
  reg.reportActivity(rec.id, "tool", "read_file");
  const updated = reg.get(rec.id)!;
  expect(updated.lastActivityAt).toBeGreaterThan(prevActivity);
  expect(updated.phase).toBe("tool");
  expect(updated.activityDetail).toBe("read_file");
  expect(updated.status).toBe("running");
});

test("health returns terminal for completed agents", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  const rec = await reg.spawn("health completed");
  await Bun.sleep(10);
  expect(reg.health(rec.id)).toBe("terminal");
});

test("health returns active shortly after activity and quiet after stall threshold", async () => {
  let aborted = false;
  const reg = new SubagentRegistry({
    runner: async (_task, ctx) => {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      });
    },
    workDir: await tempDir(),
    stallThresholdMs: 800,
  });
  const rec = await reg.spawn("health phases");
  expect(reg.health(rec.id)).toBe("active");
  await Bun.sleep(900);
  expect(reg.health(rec.id)).toBe("stalled");
  reg.stop(rec.id);
  await Bun.sleep(100);
  expect(aborted).toBeTrue();
  expect(reg.health(rec.id)).toBe("terminal");
});

test("wait resolves when all agents reach terminal", async () => {
  let callCount = 0;
  const reg = new SubagentRegistry({
    runner: async () => {
      callCount++;
      if (callCount === 1) await Bun.sleep(30);
    },
    workDir: await tempDir(),
  });
  const a1 = await reg.spawn("wait a1");
  const a2 = await reg.spawn("wait a2");
  const results = await reg.wait([a1.id, a2.id], "all_terminal", 5000);
  expect(results[a1.id].status).toBe("completed");
  expect(results[a2.id].status).toBe("completed");
});

test("wait resolves when any agent reaches terminal", async () => {
  const reg = new SubagentRegistry({
    runner: async () => {
      await Bun.sleep(100);
    },
    workDir: await tempDir(),
  });
  const a1 = await reg.spawn("wait any fast");
  const a2 = await reg.spawn("wait any slow");
  const results = await reg.wait([a1.id, a2.id], "any_terminal", 10000);
  const terminalIds = Object.entries(results).filter(([, r]) =>
    ["completed", "failed", "stopped"].includes(r.status),
  );
  expect(terminalIds.length).toBeGreaterThanOrEqual(1);
});

test("wait returns current results on timeout", async () => {
  const reg = new SubagentRegistry({
    runner: async () => {
      await Bun.sleep(500);
    },
    workDir: await tempDir(),
  });
  const a1 = await reg.spawn("wait timeout");
  const results = await reg.wait([a1.id], "all_terminal", 100);
  expect(results[a1.id].status).toBe("running");
});

test("wait respects caller abort signal", async () => {
  const reg = new SubagentRegistry({
    runner: async () => {
      await Bun.sleep(500);
    },
    workDir: await tempDir(),
  });
  const a1 = await reg.spawn("wait abort");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const results = await reg.wait([a1.id], "all_terminal", 5000, ac.signal);
  expect(results[a1.id].status).toBe("running");
});

test("activity events carry phase information to subscribers", async () => {
  const reg = new SubagentRegistry({
    runner: async (_task, ctx) => {
      ctx.setStatus("running");
      await Bun.sleep(5);
      ctx.log("midway");
      await Bun.sleep(5);
    },
    workDir: await tempDir(),
  });
  const { events } = subscribeTo(reg);
  await reg.spawn("activity events");
  await Bun.sleep(30);
  const activityEvents = events.filter((e) => e.event === "activity");
  expect(activityEvents.length).toBeGreaterThanOrEqual(1);
  const phases = activityEvents.map((e) => e.phase).filter(Boolean);
  expect(phases).toContain("provider");
});

test("registry with sessionID isolates records from other sessions", async () => {
  const dir = await tempDir();
  const regA = new SubagentRegistry({
    runner: immediateRunner,
    workDir: dir,
    sessionID: "session-a",
  });
  const regB = new SubagentRegistry({
    runner: immediateRunner,
    workDir: dir,
    sessionID: "session-b",
  });
  await regA.spawn("session-a task");
  await regB.spawn("session-b task");
  const listA = regA.list();
  const listB = regB.list();
  expect(listA).toHaveLength(1);
  expect(listB).toHaveLength(1);
  expect(listA[0]!.id).toBe("a1");
  expect(listB[0]!.id).toBe("a1");
  expect(listA[0]!.task).toBe("session-a task");
  expect(listB[0]!.task).toBe("session-b task");
});

test("same sessionID resumes id counter across registry restarts", async () => {
  const dir = await tempDir();
  const reg1 = new SubagentRegistry({
    runner: immediateRunner,
    workDir: dir,
    sessionID: "persistent",
  });
  await reg1.spawn("first");
  expect(reg1.list()[0]!.id).toBe("a1");

  const reg2 = new SubagentRegistry({
    runner: immediateRunner,
    workDir: dir,
    sessionID: "persistent",
  });
  await reg2.load();
  expect(reg2.list()).toHaveLength(1);
  expect(reg2.list()[0]!.id).toBe("a1");

  const rec = await reg2.spawn("second");
  expect(rec.id).toBe("a2");
});

test("store uses session-scoped path when sessionID is provided", async () => {
  const dir = await tempDir();
  const store = new SubagentStore(dir, "ses_abc");
  expect(store.dir).toBe(
    join(dir, ".natalia", "sessions", "ses_abc", "subagents"),
  );
});

test("session-scoped store backfills missing parentSessionID for legacy records", async () => {
  const dir = await tempDir();
  const store = new SubagentStore(dir, "ses_legacy");
  const now = Date.now();
  await store.save([
    {
      id: "a1" as any,
      task: "legacy",
      mode: "code",
      status: "failed",
      attached: true,
      modelProfile: "",
      allowedTools: [],
      excludeTools: [],
      outputs: [{ step: 1, text: "old failure", timestamp: now }],
      createdAt: now,
      updatedAt: now,
      phase: "finalizing",
      lastActivityAt: now,
      activityDetail: "old failure",
      startedAt: now,
    },
  ]);

  const loaded = await store.load();
  expect(loaded[0]!.parentSessionID).toBe("ses_legacy");
  const persisted = JSON.parse(
    await readFile(join(store.dir, "manifest.json"), "utf8"),
  ) as Array<{ parentSessionID?: string }>;
  expect(persisted[0]!.parentSessionID).toBe("ses_legacy");
});

test("registry without sessionID uses the legacy shared store path", async () => {
  const dir = await tempDir();
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: dir,
  });
  expect(reg.list()).toHaveLength(0);
  await reg.spawn("shared task");
  expect(reg.list()).toHaveLength(1);
  // Second registry without sessionID sees the first agent (legacy behaviour).
  const reg2 = new SubagentRegistry({
    runner: immediateRunner,
    workDir: dir,
  });
  await reg2.load();
  expect(reg2.list()).toHaveLength(1);
});

test("formatStatus includes phase and activity info", async () => {
  const reg = new SubagentRegistry({
    runner: immediateRunner,
    workDir: await tempDir(),
  });
  await reg.spawn("format status detail");
  const s = await reg.formatStatus("a1");
  expect(s).toContain("phase:");
  expect(s).toContain("activity:");
  expect(s).toContain("last_activity:");
});

test("reportActivity with throttled updates does not flood subscribers", async () => {
  const reg = new SubagentRegistry({
    runner: async (_task, ctx) => {
      await Bun.sleep(20);
    },
    workDir: await tempDir(),
  });
  const { events } = subscribeTo(reg);
  const rec = await reg.spawn("throttle");
  for (let i = 0; i < 50; i++) {
    reg.reportActivity(rec.id, "tool", `op-${i}`);
  }
  const activityEvents = events.filter(
    (e) => e.event === "activity" && e.agentId === rec.id,
  );
  expect(activityEvents.length).toBeLessThan(50);
});
