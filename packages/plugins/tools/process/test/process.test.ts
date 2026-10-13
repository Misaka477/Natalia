import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistry } from "@anthelia/plugin";
import { createToolRegistry } from "@anthelia/tools";
import {
  echoSleepCmd,
  groupWithChildCmd,
  sleepCmd,
  utf8SleepCmd,
  zFillCmd,
} from "./fixtures";
import {
  createProcessPlugin,
  ManagedProcessRegistry,
  managedProcessTools,
  PROCESS_PLUGIN_ID,
  processToolFamily,
} from "../src";

function processRegistryTools(registry = new ManagedProcessRegistry()) {
  return new Map(
    managedProcessTools(registry).map((tool) => [tool.name, tool]),
  );
}

test("the process family describes the tools it ships", () => {
  const family = processToolFamily();
  expect(family.id).toBe("process");
  expect(family.scope).toBe("session");
  expect(family.tools.map((tool) => tool.name)).toEqual(
    managedProcessTools(new ManagedProcessRegistry()).map((tool) => tool.name),
  );
});

test("the process family ships the twelve process_* tools and no alias family", () => {
  // The background_* aliases were deleted (2026-10-06, user ruling: the smoke
  // run showed all twelve process_* tools working, so the duplicate surface
  // only lied about them). The alias wrapper shared `process_start`'s execute
  // while its own schema never declared `description`, so every
  // `background_start` call failed with "description must be a string"
  // (T-05). This guard keeps both facts true: the names are gone, and the
  // surviving surface is exactly process_*.
  const names = managedProcessTools(new ManagedProcessRegistry()).map(
    (tool) => tool.name,
  );
  expect(names).toEqual([
    "process_start",
    "process_list",
    "process_status",
    "process_wait",
    "process_output",
    "process_ready",
    "process_stop",
    "process_restart",
    "process_attach",
    "process_detach",
    "process_cleanup",
    "process_audit",
  ]);
  for (const name of names) expect(name.startsWith("background_")).toBe(false);
});

test("the process plugin owns its tools and provides the registry service", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  await registry.load(createProcessPlugin());
  expect(registry.list()[0]).toMatchObject({
    id: PROCESS_PLUGIN_ID,
    scope: "session",
  });
  for (const tool of managedProcessTools(new ManagedProcessRegistry()))
    expect(tools.has(tool.name)).toBe(true);
  await registry.unload(PROCESS_PLUGIN_ID);
  for (const tool of managedProcessTools(new ManagedProcessRegistry()))
    expect(tools.has(tool.name)).toBe(false);
});

async function waitForOutput(read: () => Promise<string>, expected = "ready") {
  for (let index = 0; index < 50; index++) {
    if ((await read()).includes(expected)) return;
    await Bun.sleep(20);
  }
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string) {
  for (let index = 0; index < 50; index++) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await Bun.sleep(20);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}
test("default process tools execute real commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-process-"));
  const tools = processRegistryTools();
  const started = JSON.parse(
    await tools.get("process_start")!.execute(
      {
        id: "proc_test",
        command: echoSleepCmd("ready", 0.2),
        description: "Start the managed process",

        readyPattern: "ready",
        maxOutputBytes: 100,
      },
      { workspaceRoot: root },
    ),
  ) as { id: string; status: string };
  expect(started).toMatchObject({ id: "proc_test", status: "running" });
  await waitForOutput(async () =>
    tools
      .get("process_output")!
      .execute({ id: "proc_test" }, { workspaceRoot: root }),
  );
  expect(
    await tools
      .get("process_output")!
      .execute({ id: "proc_test" }, { workspaceRoot: root }),
  ).toContain("ready");
  expect(
    JSON.parse(
      await tools
        .get("process_ready")!
        .execute({ id: "proc_test", timeoutMs: 2000 }, { workspaceRoot: root }),
    ),
  ).toMatchObject({ ready: true, readyPattern: "ready", maxOutputBytes: 100 });
  const listed = JSON.parse(
    await tools.get("process_list")!.execute({}, { workspaceRoot: root }),
  ) as Array<{ id: string }>;
  expect(listed.some((item) => item.id === "proc_test")).toBe(true);
  const detached = JSON.parse(
    await tools
      .get("process_detach")!
      .execute({ id: "proc_test" }, { workspaceRoot: root }),
  ) as { attached: boolean };
  expect(detached.attached).toBe(false);
  const audit = JSON.parse(
    await tools.get("process_audit")!.execute({}, { workspaceRoot: root }),
  ) as { processes: Array<{ id: string; persistent: boolean }> };
  expect(
    audit.processes.some((item) => item.id === "proc_test" && item.persistent),
  ).toBe(true);
  await tools
    .get("process_stop")!
    .execute({ id: "proc_test" }, { workspaceRoot: root });
});

test("managed process registry reports live workspace process counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-process-count-"));
  const registry = new ManagedProcessRegistry();
  const tools = processRegistryTools(registry);
  await tools.get("process_start")!.execute(
    {
      id: "proc_count",
      command: sleepCmd(30),
      description: "Sleep for thirty seconds",
    },
    { workspaceRoot: root },
  );
  expect(await registry.runningCount({ workspaceRoot: root })).toBe(1);
  await tools
    .get("process_stop")!
    .execute({ id: "proc_count" }, { workspaceRoot: root });
  expect(await registry.runningCount({ workspaceRoot: root })).toBe(0);
});

test("managed process registry persists state across registry instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-persist-"));
  const first = processRegistryTools();
  await first.get("process_start")!.execute(
    {
      id: "proc_persist",
      command: echoSleepCmd("persisted", 0.2),
      description: "Echo persisted then sleep",
    },
    { workspaceRoot: root },
  );
  await waitForOutput(async () =>
    first
      .get("process_output")!
      .execute({ id: "proc_persist" }, { workspaceRoot: root }),
  );

  const second = processRegistryTools();
  const listed = JSON.parse(
    await second.get("process_list")!.execute({}, { workspaceRoot: root }),
  ) as Array<{ id: string }>;
  expect(listed.some((item) => item.id === "proc_persist")).toBe(true);
  expect(
    await second
      .get("process_output")!
      .execute({ id: "proc_persist" }, { workspaceRoot: root }),
  ).toContain("persisted");
  await second
    .get("process_stop")!
    .execute({ id: "proc_persist" }, { workspaceRoot: root });
});

test("managed process restart preserves readiness configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-restart-"));
  const tools = processRegistryTools();
  await tools.get("process_start")!.execute(
    {
      id: "proc_restart",
      command: echoSleepCmd("ready", 1),
      description: "Start the managed process",

      readyPattern: "ready",
      maxOutputBytes: 91,
      stopTimeoutMs: 77,
    },
    { workspaceRoot: root },
  );
  const restarted = JSON.parse(
    await tools
      .get("process_restart")!
      .execute({ id: "proc_restart" }, { workspaceRoot: root }),
  ) as {
    readyPattern?: string;
    maxOutputBytes?: number;
    stopTimeoutMs?: number;
  };
  expect(restarted).toMatchObject({
    readyPattern: "ready",
    maxOutputBytes: 91,
    stopTimeoutMs: 77,
  });
  await tools
    .get("process_stop")!
    .execute({ id: "proc_restart" }, { workspaceRoot: root });
});

test("managed process stop terminates the owned process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-process-group-"));
  const tools = processRegistryTools();
  const started = JSON.parse(
    await tools.get("process_start")!.execute(
      {
        id: "proc_group",
        command: groupWithChildCmd,
        description: "Start the managed process",
        stopTimeoutMs: 50,
      },
      { workspaceRoot: root },
    ),
  ) as { pid?: number };
  const childPID = Number(await waitForFile(join(root, "child.pid")));
  expect(started.pid).toBeNumber();
  await tools
    .get("process_stop")!
    .execute({ id: "proc_group" }, { workspaceRoot: root });
  await Bun.sleep(100);
  expect(processAlive(started.pid!)).toBe(false);
  expect(processAlive(childPID)).toBe(false);
});

test("managed process output uses a UTF-8 byte budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-process-output-"));
  const tools = processRegistryTools();
  await tools.get("process_start")!.execute(
    {
      id: "proc_output",
      command: utf8SleepCmd("abc界界", 1),
      description: "Start the managed process",
      maxOutputBytes: 6,
    },
    { workspaceRoot: root },
  );
  await waitForOutput(
    async () =>
      await tools
        .get("process_output")!
        .execute({ id: "proc_output" }, { workspaceRoot: root }),
    "界",
  );
  const output = await tools
    .get("process_output")!
    .execute({ id: "proc_output" }, { workspaceRoot: root });
  // The budget bounds the PAGE. The truncation note is metadata about the
  // page and rides after it — measuring the whole result would pin the note's
  // own length into the budget, which is a different (and wrong) claim.
  const page = output.split("\n[output truncated")[0] ?? output;
  expect(Buffer.byteLength(page, "utf8")).toBeLessThanOrEqual(6);
  expect(output).toContain("[output truncated");
  await tools
    .get("process_stop")!
    .execute({ id: "proc_output" }, { workspaceRoot: root });
});

test("managed process max runtime stops the owned process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-process-deadline-"));
  const tools = processRegistryTools();
  // The deadline must outlive the launcher chain's STARTUP, not just the
  // work: on Windows the chain is cmd -> pwsh, and a 100ms budget there
  // killed the process before it ever spawned the child whose death is the
  // evidence this test exists to collect. The point is the deadline
  // terminating the GROUP, which a longer budget still proves.
  const deadlineMs = process.platform === "win32" ? 3_000 : 100;
  const started = JSON.parse(
    await tools.get("process_start")!.execute(
      {
        id: "proc_deadline",
        command: groupWithChildCmd,
        description: "Start the managed process",
        maxRuntimeMs: deadlineMs,
      },
      { workspaceRoot: root },
    ),
  ) as { pid?: number; maxRuntimeMs?: number; deadlineAt?: string };
  const childPID = Number(await waitForFile(join(root, "child.pid")));
  expect(started.maxRuntimeMs).toBe(deadlineMs);
  expect(started.deadlineAt).toBeString();
  // The deadline stops the process at the budget, but the LIVENESS SWEEP is
  // what observes it — a ~500ms poll whose timer stretches under the
  // full-suite load. The window here must outlive the sweep's cadence,
  // not the deadline's.
  await Bun.sleep(4_000);
  const status = JSON.parse(
    await tools
      .get("process_status")!
      .execute({ id: "proc_deadline" }, { workspaceRoot: root }),
  ) as { status: string };
  expect(["stopped", "exited"]).toContain(status.status);
  expect(processAlive(childPID)).toBe(false);
}, 30_000);

test("reopened managed process registry restores a durable deadline", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-tools-process-reopen-deadline-"),
  );
  const first = processRegistryTools();
  await first.get("process_start")!.execute(
    {
      id: "proc_reopen_deadline",
      command: sleepCmd(30),
      description: "Start the managed process",
      maxRuntimeMs: 150,
    },
    { workspaceRoot: root },
  );
  const reopened = processRegistryTools();
  await reopened.get("process_list")!.execute({}, { workspaceRoot: root });
  let status = { status: "" };
  for (let elapsed = 0; elapsed < 3_000; elapsed += 25) {
    status = JSON.parse(
      await reopened
        .get("process_status")!
        .execute({ id: "proc_reopen_deadline" }, { workspaceRoot: root }),
    ) as { status: string };
    if (status.status === "stopped" || status.status === "exited") break;
    await Bun.sleep(25);
  }
  expect(["stopped", "exited"]).toContain(status.status);
});

test("reopened registry immediately stops an overdue durable deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-process-overdue-"));
  const first = processRegistryTools();
  const started = JSON.parse(
    await first.get("process_start")!.execute(
      {
        id: "proc_overdue",
        command: sleepCmd(30),
        description: "Run the command",
        maxRuntimeMs: 10_000,
      },
      { workspaceRoot: root },
    ),
  ) as { pid?: number };
  const manifest = join(root, ".natalia", "processes", "processes.json");
  const parsed = JSON.parse(await readFile(manifest, "utf8")) as {
    processes: Array<{ deadlineAt?: string }>;
  };
  parsed.processes[0]!.deadlineAt = new Date(Date.now() - 1).toISOString();
  await writeFile(manifest, `${JSON.stringify(parsed)}\n`);
  const reopened = processRegistryTools();
  const status = JSON.parse(
    await reopened
      .get("process_status")!
      .execute({ id: "proc_overdue" }, { workspaceRoot: root }),
  ) as { status: string };
  expect(status.status).toBe("stopped");
  expect(processAlive(started.pid!)).toBe(false);
});

test("managed process resource limits require positive values", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-process-limits-"));
  const tools = processRegistryTools();
  await expect(
    tools.get("process_start")!.execute(
      {
        command: sleepCmd(1),
        description: "Sleep with a zero byte budget",
        maxOutputBytes: 0,
      },
      { workspaceRoot: root },
    ),
  ).rejects.toThrow("value must be a positive number");
  await expect(
    tools.get("process_start")!.execute(
      {
        command: sleepCmd(1),
        description: "Run the command",
        stopTimeoutMs: -1,
      },
      { workspaceRoot: root },
    ),
  ).rejects.toThrow("value must be a positive number");
});

test("managed process IDs and deadlines are isolated by workspace", async () => {
  const firstRoot = await mkdtemp(
    join(tmpdir(), "natalia-tools-process-first-"),
  );
  const secondRoot = await mkdtemp(
    join(tmpdir(), "natalia-tools-process-second-"),
  );
  const tools = processRegistryTools();
  await tools.get("process_start")!.execute(
    {
      id: "proc_same",
      command: sleepCmd(30),
      description: "Run the command",
      maxRuntimeMs: 100,
    },
    { workspaceRoot: firstRoot },
  );
  await tools
    .get("process_start")!
    .execute(
      {
        id: "proc_same",
        command: sleepCmd(30),
        description: "Run the command",
      },
      { workspaceRoot: secondRoot },
    );
  await Bun.sleep(250);
  const first = JSON.parse(
    await tools
      .get("process_status")!
      .execute({ id: "proc_same" }, { workspaceRoot: firstRoot }),
  ) as { status: string };
  const second = JSON.parse(
    await tools
      .get("process_status")!
      .execute({ id: "proc_same" }, { workspaceRoot: secondRoot }),
  ) as { status: string };
  expect(first.status).toBe("stopped");
  expect(second.status).toBe("running");
  await tools
    .get("process_stop")!
    .execute({ id: "proc_same" }, { workspaceRoot: secondRoot });
});

test("unloading the process plugin terminates the processes it started", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-process-dispose-"));
  const tools = createToolRegistry([]);
  const pluginRegistry = createPluginRegistry({ tools });
  await pluginRegistry.load(createProcessPlugin());
  const started = JSON.parse(
    await tools.get("process_start")!.execute(
      {
        id: "proc_dispose",
        command: sleepCmd(30),
        description: "Run the command",
      },
      { workspaceRoot: root },
    ),
  ) as { id: string; pid?: number };
  expect(typeof started.pid).toBe("number");
  const pid = started.pid!;
  expect(processAlive(pid)).toBe(true);

  await pluginRegistry.unload(PROCESS_PLUGIN_ID);

  // The plugin's dispose must terminate the process tree it started, so an
  // unload (disable / uninstall / reload) mid-run leaves no orphaned child and
  // no armed sweep timer behind.
  for (let attempt = 0; attempt < 50 && processAlive(pid); attempt += 1)
    await Bun.sleep(20);
  expect(processAlive(pid)).toBe(false);
  expect(tools.has("process_start")).toBe(false);
});

test("a capped process output names its spill file", async () => {
  // The audit's finding: process_output returned the tail and nothing else —
  // the earlier output existed on disk (the very file the read consumes) and
  // the result never mentioned it, so a model reading a long server log saw
  // only the end and no way to reach the beginning. The note now names the
  // file, which the paged read_file can walk.
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-spill-"));
  const tools = processRegistryTools();
  await tools.get("process_start")!.execute(
    {
      id: "proc_spill",
      command: zFillCmd(5001),
      description: "Start the managed process",
      maxOutputBytes: 200,
    },
    { workspaceRoot: root },
  );
  // Let the child finish so the output file holds everything it wrote.
  // Polled: the Windows launcher chain (cmd -> pwsh) needs longer to start
  // than the POSIX one, and a fixed wait raced it.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const seen = String(
      await tools
        .get("process_output")!
        .execute({ id: "proc_spill" }, { workspaceRoot: root }),
    );
    if (seen.includes("[output truncated")) break;
    await Bun.sleep(25);
  }
  const output = await tools
    .get("process_output")!
    .execute({ id: "proc_spill" }, { workspaceRoot: root });
  expect(output).toContain(
    "[output truncated; showing the last 200 of 5001 bytes;",
  );
  expect(output).toContain("full output at ");

  // And a small output says nothing about truncation.
  await tools.get("process_start")!.execute(
    {
      id: "proc_small",
      command: "echo hi",
      description: "Run the command",
      maxOutputBytes: 200,
    },
    { workspaceRoot: root },
  );
  await Bun.sleep(400);
  const small = await tools
    .get("process_output")!
    .execute({ id: "proc_small" }, { workspaceRoot: root });
  expect(small).not.toContain("truncated");
});

test("process_status output carries its freshness, and process_output refreshes it (T-04)", async () => {
  // The status read returns the retained output snapshot as it stands; for a
  // running process that snapshot lags, and a status without the snapshot's
  // timestamp reads as if it were live. The marker is the honest answer.
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-process-fresh-"));
  const tools = processRegistryTools();
  await tools.get("process_start")!.execute(
    {
      id: "proc_fresh",
      command: echoSleepCmd("first", 5),
      description: "Print once then idle",
    },
    { workspaceRoot: root },
  );
  await waitForOutput(async () =>
    tools
      .get("process_output")!
      .execute({ id: "proc_fresh" }, { workspaceRoot: root }),
  );
  // The fresh read establishes the snapshot's timestamp. (process_output
  // returns the retained text itself, not a JSON envelope.)
  const afterFresh = (await tools
    .get("process_output")!
    .execute({ id: "proc_fresh" }, { workspaceRoot: root })) as string;
  expect(afterFresh).toContain("first");
  // A status read carries the same timestamp the snapshot was taken at.
  const status = JSON.parse(
    await tools
      .get("process_status")!
      .execute({ id: "proc_fresh" }, { workspaceRoot: root }),
  ) as { outputUpdatedAt?: string; output: string };
  expect(status.outputUpdatedAt).toBeString();
  expect(status.output).toBe(afterFresh);
  await tools
    .get("process_stop")!
    .execute({ id: "proc_fresh" }, { workspaceRoot: root });
});

test("a natural death presents one terminal state across status, wait and audit (T-03)", async () => {
  // Two terminal states, one producer each: an explicit stop (or the
  // deadline) is `stopped`, a natural death is `exited` — and the sweep,
  // the poll and every reading face must agree, because the sweep used to
  // settle deaths itself while the poll classified them, and the two could
  // disagree about the same process.
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-process-death-"));
  const tools = processRegistryTools();
  const started = JSON.parse(
    await tools.get("process_start")!.execute(
      {
        id: "proc_dies",
        command: sleepCmd(30),
        description: "A process that will be killed",
      },
      { workspaceRoot: root },
    ),
  ) as { pid?: number };
  expect(started.pid).toBeNumber();
  // Kill it from outside: a natural death, no registry call involved.
  process.kill(started.pid!, "SIGKILL");
  // Wait for the sweep to notice (its cadence stretches under load, so the
  // window outlives the poll interval with room).
  let status = { status: "running" };
  for (let elapsed = 0; elapsed < 6_000; elapsed += 50) {
    status = JSON.parse(
      await tools
        .get("process_status")!
        .execute({ id: "proc_dies" }, { workspaceRoot: root }),
    ) as { status: string };
    if (status.status !== "running") break;
    await Bun.sleep(50);
  }
  expect(status.status).toBe("exited");
  // The audit face agrees.
  const audit = JSON.parse(
    await tools.get("process_audit")!.execute({}, { workspaceRoot: root }),
  ) as { processes: Array<{ id: string; status: string }> };
  expect(audit.processes.find((p) => p.id === "proc_dies")?.status).toBe(
    "exited",
  );
  // The wait face agrees: an already-terminal process returns its terminal
  // state at once (no timeout flag).
  const waited = JSON.parse(
    await tools
      .get("process_wait")!
      .execute({ id: "proc_dies", timeoutMs: 2_000 }, { workspaceRoot: root }),
  ) as { status: string; timedOut: boolean };
  expect(waited.status).toBe("exited");
  expect(waited.timedOut).toBe(false);
});

test("the process family's read tools project terminal cards (R1)", async () => {
  // The presentation plan's P1: each family gets presenters in the
  // vocabulary. The process reads project title=the handle, summary=the
  // state, meta=pills a reader scans without opening the card.
  //
  // R1 moved the kind from `generic` to `terminal`: a process IS a terminal
  // session (it has a command, an exit code, an output), so its card now
  // carries those structured fields and the terminal renderer draws them.
  // The listings (list/audit) stay `generic` — an envelope a reader scans.
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-process-card-"));
  const tools = processRegistryTools();
  await tools.get("process_start")!.execute(
    {
      id: "proc_card",
      command: sleepCmd(5),
      description: "A process for its card",
    },
    { workspaceRoot: root },
  );
  const status = tools.get("process_status")!;
  const statusCall = status.output!.presentCall!({ id: "proc_card" });
  expect(statusCall).toEqual({
    kind: "terminal",
    title: "proc_card",
    summary: "status",
  });
  const statusCard = status.output!.presentResult!(
    { id: "proc_card" },
    JSON.stringify({ id: "proc_card", status: "running", ready: true }),
  );
  expect(statusCard).toMatchObject({
    kind: "terminal",
    title: "proc_card",
    summary: "running",
    meta: [
      ["status", "running"],
      ["ready", "true"],
    ],
  });
  // A finished process carries its exit code as a pill.
  const exitedCard = status.output!.presentResult!(
    { id: "proc_card" },
    JSON.stringify({ id: "proc_card", status: "exited", exitCode: 0 }),
  ) as { meta: Array<[string, string]> };
  expect(exitedCard.meta).toEqual([
    ["status", "exited"],
    ["exit", "0"],
  ]);
  // The list and audit cards count, and keep the full table as the body.
  const list = tools.get("process_list")!;
  const listCard = list.output!.presentResult!(
    {},
    JSON.stringify([
      { id: "a", status: "running" },
      { id: "b", status: "exited" },
    ]),
  );
  expect(listCard).toMatchObject({
    kind: "generic",
    title: "processes",
    summary: "2 listed · 1 running",
    meta: [["running", "1"]],
  });
  const audit = tools.get("process_audit")!;
  const auditCard = audit.output!.presentResult!(
    {},
    JSON.stringify({ processes: [{ id: "a", status: "running" }] }),
  );
  expect(auditCard).toMatchObject({
    kind: "generic",
    title: "processes",
    summary: "audit · 1 listed · 1 running",
  });
  await tools
    .get("process_stop")!
    .execute({ id: "proc_card" }, { workspaceRoot: root });
});

test("a stop of an already-finished process keeps its real end time (P1-13)", async () => {
  // The 2026-10-08 audit's P1-13: stopping an exited process rewrote
  // `endedAt` with the stop's timestamp, so the record of when the process
  // really ended was lost (17:45:12 became 17:45:24).
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-process-idem-"));
  const tools = processRegistryTools();
  await tools.get("process_start")!.execute(
    {
      id: "proc_idem",
      command: "exit 0",
      description: "Exit immediately",
    },
    { workspaceRoot: root },
  );
  // Let it exit on its own, then read the end time it recorded. Polled
  // rather than slept: the Windows launcher chain (cmd -> pwsh) starts
  // slower than the POSIX one, and a fixed wait raced it.
  let finished: { status: string; endedAt?: string } = {
    status: "",
    endedAt: undefined,
  };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    finished = JSON.parse(
      await tools
        .get("process_status")!
        .execute({ id: "proc_idem" }, { workspaceRoot: root }),
    ) as { status: string; endedAt?: string };
    if (finished.status !== "running") break;
    await Bun.sleep(25);
  }
  expect(finished.status).not.toBe("running");
  const realEnd = finished.endedAt;
  expect(realEnd).toBeDefined();
  // A late stop is idempotent: the process stays finished and the original
  // end time survives.
  const stopped = JSON.parse(
    await tools
      .get("process_stop")!
      .execute({ id: "proc_idem" }, { workspaceRoot: root }),
  ) as { status: string; endedAt?: string };
  expect(stopped.status).toBe(finished.status);
  expect(stopped.endedAt).toBe(realEnd);
});

test("a status read reports the output the process actually produced (P1-12)", async () => {
  // The 2026-10-08 audit's P1-12: a status read answered `output: ""` and
  // `ready: false` while the process had already printed its ready pattern —
  // so a model reading only process_status concluded it had produced
  // nothing. The snapshot is refreshed from the process's own file now.
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-process-fresh-"));
  const tools = processRegistryTools();
  await tools.get("process_start")!.execute(
    {
      id: "proc_fresh",
      command: echoSleepCmd("server listening", 30),
      description: "Print then sleep",
      readyPattern: "server listening",
    },
    { workspaceRoot: root },
  );
  // Wait for the output to land on disk (the audit's shape: the output was
  // already there, and the status read still said nothing had arrived).
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const seen = String(
      await tools
        .get("process_output")!
        .execute({ id: "proc_fresh" }, { workspaceRoot: root }),
    );
    if (seen.includes("server listening")) break;
    await Bun.sleep(20);
  }
  // The very next status read — no process_output in between.
  const status = JSON.parse(
    await tools
      .get("process_status")!
      .execute({ id: "proc_fresh" }, { workspaceRoot: root }),
  ) as { output: string; ready: boolean; outputUpdatedAt?: string };
  expect(status.output).toContain("server listening");
  expect(status.ready).toBe(true);
  // And the snapshot says when it was taken.
  expect(status.outputUpdatedAt).toBeDefined();
  await tools
    .get("process_stop")!
    .execute({ id: "proc_fresh" }, { workspaceRoot: root });
});
