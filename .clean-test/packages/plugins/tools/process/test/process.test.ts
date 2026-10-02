import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistry } from "@anthelia/plugin";
import { createToolRegistry } from "@anthelia/tools";
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
        command: "echo ready; sleep 0.2",
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
  await tools
    .get("process_start")!
    .execute(
      { id: "proc_count", command: "sleep 30" },
      { workspaceRoot: root },
    );
  expect(await registry.runningCount({ workspaceRoot: root })).toBe(1);
  await tools
    .get("process_stop")!
    .execute({ id: "proc_count" }, { workspaceRoot: root });
  expect(await registry.runningCount({ workspaceRoot: root })).toBe(0);
});

test("managed process registry persists state for restart and background aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-persist-"));
  const first = processRegistryTools();
  await first
    .get("background_start")!
    .execute(
      { id: "proc_persist", command: "echo persisted; sleep 0.2" },
      { workspaceRoot: root },
    );
  await waitForOutput(async () =>
    first
      .get("background_output")!
      .execute({ id: "proc_persist" }, { workspaceRoot: root }),
  );

  const second = processRegistryTools();
  const listed = JSON.parse(
    await second.get("background_list")!.execute({}, { workspaceRoot: root }),
  ) as Array<{ id: string }>;
  expect(listed.some((item) => item.id === "proc_persist")).toBe(true);
  expect(
    await second
      .get("background_output")!
      .execute({ id: "proc_persist" }, { workspaceRoot: root }),
  ).toContain("persisted");
  await second
    .get("background_stop")!
    .execute({ id: "proc_persist" }, { workspaceRoot: root });
});

test("managed process restart preserves readiness configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-restart-"));
  const tools = processRegistryTools();
  await tools.get("process_start")!.execute(
    {
      id: "proc_restart",
      command: "echo ready; sleep 1",
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
        command: "sleep 30 & echo $! > child.pid; wait",
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
      command: "printf 'abc界界'; sleep 1",
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
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(6);
  await tools
    .get("process_stop")!
    .execute({ id: "proc_output" }, { workspaceRoot: root });
});

test("managed process max runtime stops the owned process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-process-deadline-"));
  const tools = processRegistryTools();
  const started = JSON.parse(
    await tools.get("process_start")!.execute(
      {
        id: "proc_deadline",
        command: "sleep 30 & echo $! > child.pid; wait",
        maxRuntimeMs: 100,
      },
      { workspaceRoot: root },
    ),
  ) as { pid?: number; maxRuntimeMs?: number; deadlineAt?: string };
  const childPID = Number(await waitForFile(join(root, "child.pid")));
  expect(started.maxRuntimeMs).toBe(100);
  expect(started.deadlineAt).toBeString();
  // The deadline stops the process at 100ms, but the LIVENESS SWEEP is
  // what observes it — a ~500ms poll whose timer stretches under the
  // full-suite load. The window here must outlive the sweep's cadence,
  // not the deadline's.
  await Bun.sleep(1_500);
  const status = JSON.parse(
    await tools
      .get("process_status")!
      .execute({ id: "proc_deadline" }, { workspaceRoot: root }),
  ) as { status: string };
  expect(["stopped", "exited"]).toContain(status.status);
  expect(processAlive(childPID)).toBe(false);
});

test("reopened managed process registry restores a durable deadline", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-tools-process-reopen-deadline-"),
  );
  const first = processRegistryTools();
  await first.get("process_start")!.execute(
    {
      id: "proc_reopen_deadline",
      command: "sleep 30",
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
    await first
      .get("process_start")!
      .execute(
        { id: "proc_overdue", command: "sleep 30", maxRuntimeMs: 10_000 },
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
    tools
      .get("process_start")!
      .execute(
        { command: "sleep 1", maxOutputBytes: 0 },
        { workspaceRoot: root },
      ),
  ).rejects.toThrow("value must be a positive number");
  await expect(
    tools
      .get("process_start")!
      .execute(
        { command: "sleep 1", stopTimeoutMs: -1 },
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
  await tools
    .get("process_start")!
    .execute(
      { id: "proc_same", command: "sleep 30", maxRuntimeMs: 100 },
      { workspaceRoot: firstRoot },
    );
  await tools
    .get("process_start")!
    .execute(
      { id: "proc_same", command: "sleep 30" },
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
    await tools
      .get("process_start")!
      .execute(
        { id: "proc_dispose", command: "sleep 30" },
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
