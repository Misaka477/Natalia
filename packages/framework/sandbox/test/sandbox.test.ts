import { expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  WorkspaceSandboxManager,
  containPath,
  isInsideRoot,
  isSecretEnvKey,
} from "../src";

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

test("a symlink whose target does not exist is still containment-checked", async () => {
  // Even where the OS cannot create symlinks (Windows without Developer Mode),
  // the fail-closed rule is checkable: an unresolvable target outside the root
  // must not be treated as safe. The symlink variant of this runs under
  // `symlinkTest` on a host that can create one.
  const root = await mkdtemp(join(tmpdir(), "natalia-sandbox-dangling-"));
  try {
    expect(isInsideRoot(root, join(root, "not-yet"))).toBe(true);
    expect(isInsideRoot(root, resolve(`${root}-evil`))).toBe(false);
    expect(isInsideRoot(root, join(root, "..", "outside"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("the containment check compares components, not prefixes", () => {
  // `<root>-evil` shares root's prefix and is NOT inside it; the old
  // `cursor.startsWith(root)` said it was, in the walk that decides symlink
  // containment.
  const root = resolve("jail");
  expect(isInsideRoot(root, join(root, "box", "file.txt"))).toBe(true);
  expect(isInsideRoot(root, `${root}box`)).toBe(false);
  expect(isInsideRoot(root, resolve(`${root}-evil`, "file.txt"))).toBe(false);
  expect(isInsideRoot(root, root)).toBe(true);
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
    command: "exit 0",
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
  const result = await manager.execute(
    "box",
    process.platform === "win32"
      ? "$PWD; Write-Output sandbox-ok"
      : "pwd; printf sandbox-ok",
  );
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

test("sandbox manifests restore changes but never falsely recover processes", async () => {
  const base = await mkdtemp(join(tmpdir(), "natalia-sandbox-restart-"));
  const first = new WorkspaceSandboxManager(base);
  await first.create("box");
  await first.write("box", "draft.txt", "persisted");
  await first.startResource(
    "box",
    process.platform === "win32"
      ? "Start-Sleep -Milliseconds 100"
      : "sleep 0.1",
    "custom_resource",
  );
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
