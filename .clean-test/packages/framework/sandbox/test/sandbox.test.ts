import { expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceSandboxManager, containPath, isSecretEnvKey } from "../src";

/**
 * The symlink fixtures are skipped when the machine cannot create symlinks
 * (Windows without Developer Mode); the containment rule is unexercisable
 * without one.
 */
const symlinkSupported = await probeSymlinkSupport();
const symlinkTest = symlinkSupported ? test : test.skip;

async function probeSymlinkSupport(): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), "natalia-symlink-probe-"));
  try {
    await symlink("target", join(root, "link"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

test("sandbox containment blocks absolute and parent escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sandbox-"));
  await expect(containPath(root, "/etc/passwd")).rejects.toThrow("absolute");
  await expect(containPath(root, "../escape")).rejects.toThrow("escape");
  await expect(containPath(root, "safe/file.txt")).resolves.toContain(root);
});

symlinkTest("sandbox containment blocks symlink escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sandbox-"));
  await symlink("/tmp", join(root, "out"));
  await expect(containPath(root, "out/file.txt")).rejects.toThrow(
    "symlink escape",
  );
});

test("sandbox diff covers delete rename mode and env allowlist redacts secrets", async () => {
  const base = await mkdtemp(join(tmpdir(), "natalia-sandbox-base-"));
  const manager = new WorkspaceSandboxManager(base);
  await manager.create("box");
  await manager.write("box", "new.ts", "new");
  await manager.write("box", "old.ts", "old");
  await manager.renamePath("box", "old.ts", "renamed.ts");
  await manager.modePath("box", "script.sh", "100755");
  await manager.deletePath("box", "gone.ts");
  const changes = await manager.previewMerge("box");
  expect(changes.map((change) => change.kind)).toEqual([
    "modify",
    "rename",
    "mode",
    "delete",
  ]);
  expect(
    manager.environment(["PATH", "API_KEY"], {
      PATH: "/bin",
      API_KEY: "secret",
    }),
  ).toEqual({ PATH: "/bin" });
  expect(isSecretEnvKey("GITHUB_TOKEN")).toBe(true);
});

test("sandbox manager lists durable manifests without exposing mutable state", async () => {
  const base = await mkdtemp(join(tmpdir(), "natalia-sandbox-list-"));
  const manager = new WorkspaceSandboxManager(base);
  await manager.create("box");
  await manager.write("box", "draft.txt", "draft");
  const listed = await manager.list();
  expect(listed).toMatchObject([
    { id: "box", changedFiles: [{ path: "draft.txt" }] },
  ]);
  listed[0]!.changedFiles.length = 0;
  expect(await manager.previewMerge("box")).toHaveLength(1);
});

test("sandbox merge is atomic on failure", async () => {
  const base = await mkdtemp(join(tmpdir(), "natalia-sandbox-base-"));
  const host = await mkdtemp(join(tmpdir(), "natalia-host-"));
  const manager = new WorkspaceSandboxManager(base);
  await manager.create("box");
  await writeFile(join(host, "keep.txt"), "original");
  await manager.write("box", "keep.txt", "changed");
  await manager.write("box", "bad/child.txt", "bad");
  await writeFile(join(host, "bad"), "not a dir");
  await expect(manager.merge("box", host)).rejects.toThrow();
  expect(await readFile(join(host, "keep.txt"), "utf8")).toBe("original");
});

test("promoteWithValidation refuses an empty command and a failed check", async () => {
  const base = await mkdtemp(join(tmpdir(), "natalia-sandbox-promote-base-"));
  const host = await mkdtemp(join(tmpdir(), "natalia-sandbox-promote-host-"));
  const manager = new WorkspaceSandboxManager(base);
  await manager.create("box");
  await manager.write("box", "file.txt", "candidate");
  await expect(
    manager.promoteWithValidation("box", { command: "   ", hostRoot: host }),
  ).rejects.toThrow(/must not be empty/u);
  await expect(
    manager.promoteWithValidation("box", { command: "exit 1", hostRoot: host }),
  ).rejects.toThrow(/failed validation/u);
  await expect(readFile(join(host, "file.txt"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  const promotion = await manager.promoteWithValidation("box", {
    command: "true",
    hostRoot: host,
  });
  expect(promotion.changedFiles).toContainEqual(
    expect.objectContaining({ path: "file.txt" }),
  );
  expect(await readFile(join(host, "file.txt"), "utf8")).toBe("candidate");
});

test("sandbox merge authorizes every host mutation before writing", async () => {
  const base = await mkdtemp(join(tmpdir(), "natalia-sandbox-policy-base-"));
  const host = await mkdtemp(join(tmpdir(), "natalia-sandbox-policy-host-"));
  const manager = new WorkspaceSandboxManager(base);
  await manager.create("box");
  await manager.write("box", "allowed.txt", "allowed");
  await manager.write("box", "protected.txt", "blocked");
  const checked: string[][] = [];

  await expect(
    manager.merge("box", host, async (paths) => {
      checked.push(paths);
      if (paths.includes("protected.txt")) throw new Error("protected path");
    }),
  ).rejects.toThrow("protected path");
  expect(checked).toEqual([["allowed.txt", "protected.txt"]]);
  await expect(
    readFile(join(host, "allowed.txt"), "utf8"),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    readFile(join(host, "protected.txt"), "utf8"),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await manager.previewMerge("box")).toHaveLength(2);
});

test("sandbox merge rejects manifest changes during asynchronous authorization", async () => {
  const base = await mkdtemp(join(tmpdir(), "natalia-sandbox-race-base-"));
  const host = await mkdtemp(join(tmpdir(), "natalia-sandbox-race-host-"));
  const manager = new WorkspaceSandboxManager(base);
  await manager.create("box");
  await manager.write("box", "initial.txt", "initial");

  await expect(
    manager.merge("box", host, async () => {
      await manager.write("box", "later.txt", "later");
    }),
  ).rejects.toThrow("manifest changed during merge authorization");
  await expect(
    readFile(join(host, "initial.txt"), "utf8"),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    (await manager.previewMerge("box")).map((change) => change.path),
  ).toEqual(["initial.txt", "later.txt"]);
});

test("sandbox merge applies rename content and mode without orphaning host files", async () => {
  const base = await mkdtemp(join(tmpdir(), "natalia-sandbox-merge-base-"));
  const host = await mkdtemp(join(tmpdir(), "natalia-sandbox-merge-host-"));
  const manager = new WorkspaceSandboxManager(base);
  await manager.create("box");
  await writeFile(join(host, "old.ts"), "old host\n");
  await manager.write("box", "old.ts", "sandbox content\n");
  await manager.renamePath("box", "old.ts", "new.ts");
  await manager.write("box", "script.sh", "#!/bin/sh\n");
  await manager.modePath("box", "script.sh", "100755");
  await manager.merge("box", host);
  await expect(readFile(join(host, "old.ts"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(join(host, "new.ts"), "utf8")).toBe(
    "sandbox content\n",
  );
  // Windows file modes are advisory: chmod cannot set an execute bit there,
  // so the mode-change assertion applies on platforms where modes are real.
  if (process.platform !== "win32")
    expect((await stat(join(host, "script.sh"))).mode & 0o111).not.toBe(0);
  expect(await readFile(join(host, "script.sh"), "utf8")).toBe("#!/bin/sh\n");
});

test("sandbox target/audit/checkpoint contract exposes isolation level", async () => {
  const base = await mkdtemp(join(tmpdir(), "natalia-sandbox-base-"));
  const manager = new WorkspaceSandboxManager(base);
  await manager.create("box");
  expect(manager.target("box")).toMatchObject({
    kind: "sandbox",
    isolationLevel: "workspace",
  });
  expect(manager.updateEvent("box")).toMatchObject({
    type: "sandbox.update",
    isolationLevel: "workspace",
  });
  expect(manager.auditEvent("box", "workflow")).toMatchObject({
    type: "sandbox.audit",
    approvalRequired: true,
    checkpointPolicy: "sandbox_manifest",
  });
  expect(await manager.delete("box")).toMatchObject({
    pendingChanges: [],
    runningResources: [],
  });
});

test("sandbox executes a real command inside its workspace target", async () => {
  const base = await mkdtemp(join(tmpdir(), "natalia-sandbox-base-"));
  const manager = new WorkspaceSandboxManager(base);
  await manager.create("box");
  const result = await manager.execute("box", "pwd; printf sandbox-ok");
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("sandbox-ok");
  // Git Bash reports the MSYS-translated path on Windows (/tmp/...), so the
  // assertion checks for the sandbox directory segments instead of the exact
  // host spelling there.
  if (process.platform === "win32")
    expect(result.output).toContain("natalia-sandbox-base");
  else expect(result.output).toContain(join(base, "box"));
  expect(result.target).toMatchObject({ kind: "sandbox", sandboxID: "box" });
});

test("sandbox tracks running resources with output and stop lifecycle", async () => {
  const base = await mkdtemp(join(tmpdir(), "natalia-sandbox-resource-"));
  const manager = new WorkspaceSandboxManager(base);
  await manager.create("box");
  const resource = await manager.startResource(
    "box",
    "printf resource-ok; sleep 30",
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
  const first = await manager.startResource("first", "sleep 30", "res_first");
  const second = await manager.startResource(
    "second",
    "sleep 30",
    "res_second",
  );

  await manager.close();

  expect(manager.runningResourceCount()).toBe(0);
  expect(manager.resourcesFor("first")).toEqual([]);
  expect(manager.resourcesFor("second")).toEqual([]);
  await waitForProcessExit(first.pid);
  await waitForProcessExit(second.pid);
}, 15_000);

test("sandbox manifests restore changes but never falsely recover processes", async () => {
  const base = await mkdtemp(join(tmpdir(), "natalia-sandbox-restart-"));
  const first = new WorkspaceSandboxManager(base);
  await first.create("box");
  await first.write("box", "draft.txt", "persisted");
  await first.startResource("box", "sleep 0.1", "custom_resource");
  await Bun.sleep(150);
  const reopened = new WorkspaceSandboxManager(base);
  await reopened.initialize();
  expect(await reopened.previewMerge("box")).toMatchObject([
    { path: "draft.txt", content: "persisted" },
  ]);
  expect(reopened.resourcesFor("box")).toEqual([]);
  const result = await reopened.delete("box");
  expect(result.runningResources).toEqual([]);
});

async function waitFor(read: () => Promise<string>) {
  for (let index = 0; index < 100; index++) {
    if ((await read()).includes("resource-ok")) return;
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting for sandbox resource output");
}

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
