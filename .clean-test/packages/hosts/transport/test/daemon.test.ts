import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFakeBackend } from "@natalia/client/fixture";
import {
  createRuntimeHttpServer,
  createRuntimeDaemonStore,
  daemonToken,
  registerRuntimeDaemon,
  runtimeDaemonStatus,
  stopRuntimeDaemon,
  spawnRuntimeDaemon,
} from "../src/host";

test("native TS daemon store writes private token registration and stale cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-daemon-"));
  const store = createRuntimeDaemonStore({
    dir: root,
    version: "test-version",
  });
  const token = await daemonToken(store);
  expect(token.length).toBeGreaterThan(20);
  expect(await readFile(store.tokenPath, "utf8")).toContain(token);
  await registerRuntimeDaemon(store, {
    url: "http://127.0.0.1:8787",
    pid: 99999999,
    transport: "http",
  });
  expect(await runtimeDaemonStatus(store)).toMatchObject({ state: "stale" });
  expect(await runtimeDaemonStatus(store)).toMatchObject({ state: "missing" });
});

test("native TS daemon process can be spawned and stopped without Go launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-daemon-process-"));
  const store = createRuntimeDaemonStore({
    dir: root,
    version: "test-version",
  });
  const pid = spawnRuntimeDaemon({
    command: ["bash", "-lc", "sleep 30"],
    cwd: root,
  });
  await registerRuntimeDaemon(store, {
    url: "http://127.0.0.1:8788",
    pid,
    transport: "http",
  });
  expect(await runtimeDaemonStatus(store)).toMatchObject({ state: "running" });
  expect(await stopRuntimeDaemon(store)).toMatchObject({ stopped: true, pid });
});

test("the daemon carries a task delivery without knowing how to run one", async () => {
  const seen: unknown[] = [];
  const server = createRuntimeHttpServer({
    client: createFakeBackend(),
    port: 0,
    token: "delivery-token",
    events: false,
    taskExecution: true,
    runTask: async (request) => {
      seen.push(request);
      if (request.taskPath === "broken.yaml")
        throw new Error("natalia flow not found: flow_missing");
      return {
        invocationID: "inv_1",
        status: "succeeded",
        waterlineAdvanced: true,
        exitCode: 0,
        output: ['{"type":"task.invocation","status":"succeeded"}'],
      };
    },
  });
  try {
    const submit = (body: unknown, token = "delivery-token") =>
      fetch(new URL("/tasks/run", server.url).href, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    const delivered = await submit({
      taskPath: "nightly.yaml",
      workspaceRoot: "/srv/workspace",
    });
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      output: ['{"type":"task.invocation","status":"succeeded"}'],
    });
    expect(seen).toEqual([
      { taskPath: "nightly.yaml", workspaceRoot: "/srv/workspace" },
    ]);
    // Delivery is authenticated like every other daemon route.
    expect((await submit({ taskPath: "nightly.yaml" }, "wrong")).status).toBe(
      401,
    );
    expect((await submit({})).status).toBe(400);
    // A definition error is the submitter's problem, not a daemon crash.
    const rejected = await submit({ taskPath: "broken.yaml" });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({
      error: "natalia flow not found: flow_missing",
    });
    const wrongMethod = await fetch(new URL("/tasks/run", server.url).href, {
      headers: { authorization: "Bearer delivery-token" },
    });
    expect(wrongMethod.status).toBe(405);
  } finally {
    server.stop(true);
  }
});

test("a daemon without task execution opt-in returns a typed refusal", async () => {
  const server = createRuntimeHttpServer({
    client: createFakeBackend(),
    port: 0,
    token: "no-tasks",
    events: false,
  });
  try {
    const response = await fetch(new URL("/tasks/run", server.url).href, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer no-tasks",
      },
      body: JSON.stringify({ taskPath: "nightly.yaml" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      kind: "refused",
      reason: "task execution is not enabled by this host",
    });
  } finally {
    server.stop(true);
  }
});

test("a read-only state home never breaks the status read (stale cleanup is best-effort)", async () => {
  const root = mkdtempSync(join(tmpdir(), "daemon-ro-"));
  const dir = join(root, "state");
  mkdirSync(dir, { recursive: true });
  const store = createRuntimeDaemonStore({ dir });
  // a leftover registration whose pid is dead (999999 is never ours)
  writeFileSync(
    store.registrationPath,
    JSON.stringify({
      version: store.version,
      url: "http://127.0.0.1:1",
      pid: 999999,
      tokenFile: store.tokenPath,
      transport: "http",
      createdAt: "2020-01-01T00:00:00.000Z",
    }),
  );
  chmodSync(dir, 0o555); // EROFS/EACCES on any unlink inside
  try {
    const status = await runtimeDaemonStatus(store);
    // the state is REPORTED even when the courtesy cleanup cannot run —
    // before the fix this rm threw and every caller (the update
    // command) crashed before doing anything.
    expect(status.state).toBe("stale");
    expect(existsSync(store.registrationPath)).toBe(true);
  } finally {
    chmodSync(dir, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});
