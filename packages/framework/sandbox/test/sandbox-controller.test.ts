import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxController } from "../src/sandbox-controller";

test("sandbox controller initializes lazily and refuses before init", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sandbox-controller-"));
  const controller = createSandboxController({ workspaceRoot: root });
  await expect(controller.list()).rejects.toThrow(
    "sandbox manager is not initialized",
  );
  await expect(controller.referencedObjectIDs()).rejects.toThrow(
    "sandbox manager is not initialized",
  );
  expect(controller.runningResourceCount()).toBe(0);
  await controller.init();
  expect(await controller.list()).toEqual([]);
  expect(await controller.referencedObjectIDs()).toBeInstanceOf(Set);
  expect(controller.runningResourceCount()).toBe(0);
});

test("sandbox controller init is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sandbox-controller-2-"));
  const controller = createSandboxController({ workspaceRoot: root });
  await controller.init();
  await controller.init();
  await controller.create("idempotent");
  await controller.init();
  expect((await controller.list()).map(({ id }) => id)).toEqual(["idempotent"]);
});

test("sandbox controller close is lazy, idempotent, and final", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sandbox-close-"));
  const controller = createSandboxController({ workspaceRoot: root });

  await controller.close();
  await controller.close();
  await expect(controller.init()).rejects.toThrow(
    "sandbox controller is closed",
  );
  await expect(controller.list()).rejects.toThrow(
    "sandbox manager is not initialized",
  );
});

test("sandbox controller close releases its initialized manager", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sandbox-release-"));
  const controller = createSandboxController({ workspaceRoot: root });
  await controller.init();
  await controller.close();
  await expect(controller.list()).rejects.toThrow(
    "sandbox manager is not initialized",
  );
  await expect(controller.init()).rejects.toThrow(
    "sandbox controller is closed",
  );
});

test("the default sandbox backend is our own git-free snapshot manager", async () => {
  // A git repo workspace, but no backend configured: our own snapshot backend
  // is the default — git is not required.
  const root = await mkdtemp(join(tmpdir(), "natalia-sandbox-default-"));
  await mkdir(join(root, ".git"), { recursive: true });
  const controller = createSandboxController({ workspaceRoot: root });
  await controller.init();
  expect(await controller.referencedObjectIDs()).toBeInstanceOf(Set);
});

test("sandbox.backend=worktree opts into the real-git backend when a repo exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sandbox-worktree-opt-"));
  await mkdir(join(root, ".git"), { recursive: true });
  const controller = createSandboxController({
    workspaceRoot: root,
    backend: () => "worktree",
  });
  await controller.init();
  expect(await controller.referencedObjectIDs()).toBeUndefined();
});

test("the controller passes the resolved confinement mode to its manager", async () => {
  // The production path: the client resolves the effective mode (composition
  // default, config fallback, schema default, then the platform gate) and
  // hands it to the controller. A manager that never received it would run
  // every candidate command unconfined while the tool surface advertised a
  // sandbox — the wiring is the whole of T2-4's second half.
  const root = await mkdtemp(
    join(tmpdir(), "natalia-sandbox-controller-floor-"),
  );
  const controller = createSandboxController({
    workspaceRoot: root,
    confinement: () => "workspace-write",
  });
  await controller.init();
  await controller.create("box");
  const run = await controller.execute("box", "echo confined");
  expect(run.exitCode).toBe(0);
  // The run reports the mode it ran under, from the manager the controller
  // built with the mode it was given.
  expect(run.sandbox?.mode).toBe("workspace-write");
});

test("the controller links the declared dependency roots into its candidates", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-sandbox-controller-deps-"),
  );
  await mkdir(join(root, "node_modules", "fixture"), { recursive: true });
  await writeFile(join(root, "node_modules", "fixture", "pkg.json"), "{}");
  const controller = createSandboxController({
    workspaceRoot: root,
    dependencyRoots: () => ["node_modules"],
  });
  await controller.init();
  const manifest = await controller.create("box");
  expect(
    existsSync(join(manifest.root, "node_modules", "fixture", "pkg.json")),
  ).toBe(true);
});

test("a dependency declaration that escapes the workspace refuses the controller", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-sandbox-controller-escape-"),
  );
  const controller = createSandboxController({
    workspaceRoot: root,
    dependencyRoots: () => ["../../.."],
  });
  await expect(controller.init()).rejects.toThrow(/escapes the workspace/u);
});
