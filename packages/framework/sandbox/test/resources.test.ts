import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceSandboxManager } from "../src";

/**
 * The sandbox's RUNNING-RESOURCE lifecycle.
 *
 * These three tests start a real long-lived child inside a sandbox and read its
 * output file. They are in their own file because they are the part of the
 * sandbox layer that a HOSTED Windows runner cannot exercise: the resource
 * spawns through the compiled detached-process owner, and on that image the
 * worker starts and then never runs the command — measured on
 * `windows-substrate` (2026-10-17): "sandbox tracks running resources…" 10s,
 * "sandbox manager close stops every running resource" 15s, "sandbox resource
 * preserves a command containing single quotes" 30s, all timeouts, while the
 * same file is green on a developer Windows host and in the local full verify.
 * `files-to-come` at the CI layer excludes this file by name (the same
 * documented limitation `hosts/platform/test/detached-process.test.ts` and the
 * `process` tool layer carry), so the rest of the sandbox layer keeps running
 * where its behaviour IS observable.
 */
test("sandbox tracks running resources with output and stop lifecycle", async () => {
  const base = await mkdtemp(join(tmpdir(), "natalia-sandbox-resource-"));
  const manager = new WorkspaceSandboxManager(base);
  await manager.create("box");
  const resource = await manager.startResource(
    "box",
    process.platform === "win32"
      ? "Write-Output resource-ok; Start-Sleep 30"
      : "printf resource-ok; sleep 30",
    "res_1",
  );
  expect(resource).toMatchObject({ id: "res_1", status: "running" });
  expect(manager.runningResourceCount()).toBe(1);
  expect(manager.updateEvent("box")).toMatchObject({ runningResources: 1 });
  await waitFor(async () => await manager.resourceOutput("box", "res_1"));
  expect(await manager.resourceOutput("box", "res_1")).toContain("resource-ok");
  expect(await manager.stopResource("box", "res_1")).toMatchObject({
    status: "stopped",
  });
  expect(manager.runningResourceCount()).toBe(0);
  expect(manager.updateEvent("box")).toMatchObject({ runningResources: 0 });
});

test("sandbox manager close stops every running resource", async () => {
  const base = await mkdtemp(join(tmpdir(), "natalia-sandbox-close-"));
  const manager = new WorkspaceSandboxManager(base);
  await manager.create("first");
  await manager.create("second");
  const first = await manager.startResource(
    "first",
    process.platform === "win32" ? "Start-Sleep 30" : "sleep 30",
    "res_first",
  );
  const second = await manager.startResource(
    "second",
    process.platform === "win32" ? "Start-Sleep 30" : "sleep 30",
    "res_second",
  );

  await manager.close();

  expect(manager.runningResourceCount()).toBe(0);
  expect(manager.resourcesFor("first")).toEqual([]);
  expect(manager.resourcesFor("second")).toEqual([]);
  await waitForProcessExit(first.pid);
  await waitForProcessExit(second.pid);
}, 15_000);

test("sandbox resource preserves a command containing single quotes", async () => {
  const base = await mkdtemp(join(tmpdir(), "natalia-sandbox-quote-"));
  const manager = new WorkspaceSandboxManager(base);
  await manager.create("box");
  // Incorrect quoting silently truncated this command to `a`, so the assertion
  // guards against a corrupted command rather than only against a failure.
  const resource = await manager.startResource("box", "echo 'a b c'", "r1");
  expect(resource.pid).toBeGreaterThan(0);
  expect(await waitForResourceOutput(resource.outputPath)).toBe("a b c");
});

async function waitFor(read: () => Promise<string>) {
  for (let index = 0; index < 100; index++) {
    if ((await read()).includes("resource-ok")) return;
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting for sandbox resource output");
}

async function waitForResourceOutput(path: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await readFile(path, "utf8").catch(() => "");
    if (content.trim()) return content.trim();
    await Bun.sleep(100);
  }
  return "";
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
}
