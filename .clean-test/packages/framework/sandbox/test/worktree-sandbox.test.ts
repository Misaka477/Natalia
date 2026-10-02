import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorktreeSandboxManager } from "../src/worktree-sandbox";

async function git(cwd: string, args: string[]) {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim());
  return stdout.trim();
}

/** A scratch git repo with one committed file, ready to branch candidates from. */
async function scratchRepo() {
  const root = await mkdtemp(join(tmpdir(), "natalia-sandbox-advanced-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@natalia"]);
  await git(root, ["config", "user.name", "Natalia Test"]);
  await writeFile(join(root, "file.txt"), "base\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  return root;
}

test("a sandbox is a worktree on a candidate branch off the system head", async () => {
  const root = await scratchRepo();
  const manager = new WorktreeSandboxManager(root);
  const sandbox = await manager.create("sbx.1");
  expect(await manager.exists("sbx.1")).toBe(true);
  // The worktree branched off the system head, so it starts identical.
  expect(await manager.systemHead()).toBeDefined();
  // The worktree starts identical to the system.
  expect(await readFile(join(sandbox.root, "file.txt"), "utf8")).toBe("base\n");
  await manager.delete("sbx.1");
  expect(await manager.exists("sbx.1")).toBe(false);
});

test("previewMerge reports the candidate's changes against its base", async () => {
  const root = await scratchRepo();
  const manager = new WorktreeSandboxManager(root);
  const sandbox = await manager.create("sbx.2");
  // The agent edits in the candidate worktree and commits there.
  await writeFile(join(sandbox.root, "file.txt"), "changed\n");
  await writeFile(join(sandbox.root, "new.txt"), "added\n");
  await git(sandbox.root, ["add", "file.txt", "new.txt"]);
  await git(sandbox.root, ["commit", "-m", "agent change"]);
  const changes = await manager.previewMerge("sbx.2");
  expect(changes.map((change) => change.path).sort()).toEqual([
    "file.txt",
    "new.txt",
  ]);
  expect(changes.find((change) => change.path === "file.txt")?.kind).toBe(
    "modify",
  );
  expect(changes.find((change) => change.path === "new.txt")?.kind).toBe("add");
});

test("promote merges the candidate into the system slot and records last-known-good", async () => {
  const root = await scratchRepo();
  const manager = new WorktreeSandboxManager(root);
  const sandbox = await manager.create("sbx.3");
  const base = await manager.systemHead();
  await writeFile(join(sandbox.root, "file.txt"), "promoted\n");
  await git(sandbox.root, ["add", "."]);
  await git(sandbox.root, ["commit", "-m", "promote me"]);

  const authorized: string[][] = [];
  const promotion = await manager.promote("sbx.3", async (paths) => {
    authorized.push(paths);
  });
  expect(promotion.lastKnownGood).toBe(base);
  expect(promotion.promoted).toBe(await manager.systemHead());
  expect(promotion.promoted).not.toBe(base);
  // The system slot now has the candidate's change.
  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("promoted\n");
  // The human approval step saw the changed paths.
  expect(authorized[0]).toContain("file.txt");
  expect(await manager.lastKnownGoodCommit()).toBe(base);
});

test("rollback returns the system slot to last-known-good", async () => {
  const root = await scratchRepo();
  const manager = new WorktreeSandboxManager(root);
  const sandbox = await manager.create("sbx.4");
  await writeFile(join(sandbox.root, "file.txt"), "promoted\n");
  await git(sandbox.root, ["add", "."]);
  await git(sandbox.root, ["commit", "-m", "promote me"]);
  await manager.merge("sbx.4", root);
  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("promoted\n");
  // A failed activation rolls back to last-known-good, addressed by the sandbox
  // whose promotion is being undone.
  const rollback = await manager.rollback("sbx.4");
  expect(rollback.restored).toBe(true);
  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("base\n");
});

test("promoting a candidate with no changes refuses", async () => {
  const root = await scratchRepo();
  const manager = new WorktreeSandboxManager(root);
  await manager.create("sbx.5");
  await expect(manager.merge("sbx.5", root)).rejects.toThrow(
    /has no changes to promote/u,
  );
});

test("a candidate that fails validation is refused promotion with its build output", async () => {
  const root = await scratchRepo();
  const manager = new WorktreeSandboxManager(root);
  const sandbox = await manager.create("sbx.6");
  await writeFile(join(sandbox.root, "file.txt"), "broken\n");
  await git(sandbox.root, ["add", "."]);
  await git(sandbox.root, ["commit", "-m", "broken candidate"]);
  // The build evidence gate: a candidate that does not pass validation must
  // not reach the system slot.
  await expect(
    manager.promoteWithValidation("sbx.6", {
      command: "test -f build-pass-marker",
    }),
  ).rejects.toThrow(/failed validation/u);
  // The system slot is untouched.
  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("base\n");
  // And a passing candidate promotes.
  const good = await manager.create("sbx.7");
  await writeFile(join(good.root, "file.txt"), "good\n");
  await git(good.root, ["add", "."]);
  await git(good.root, ["commit", "-m", "good candidate"]);
  await manager.promoteWithValidation("sbx.7", { command: "true" });
  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("good\n");
});

test("worktree sandbox sees files .gitignore hides but .nataliaignore allows", async () => {
  const root = await scratchRepo();
  await writeFile(join(root, ".gitignore"), "/plan/\n");
  await git(root, ["add", ".gitignore"]);
  await git(root, ["commit", "-m", "ignore plan"]);
  const manager = new WorktreeSandboxManager(root);
  const sandbox = await manager.create("sbx.ignored");
  await mkdir(join(sandbox.root, "plan"), { recursive: true });
  await writeFile(join(sandbox.root, "plan", "note.md"), "planned\n");
  const changes = await manager.previewMerge("sbx.ignored");
  expect(changes.map((change) => change.path)).toContain("plan/note.md");
  expect(changes.find((change) => change.path === "plan/note.md")?.kind).toBe(
    "add",
  );
  await manager.delete("sbx.ignored");
});

test("worktree sandbox still excludes paths ignored by .nataliaignore", async () => {
  const root = await scratchRepo();
  await writeFile(join(root, ".nataliaignore"), "ignored-output/\n");
  const manager = new WorktreeSandboxManager(root);
  const sandbox = await manager.create("sbx.nataliaignore");
  await mkdir(join(sandbox.root, "ignored-output"), { recursive: true });
  await writeFile(join(sandbox.root, "ignored-output", "data.txt"), "skip\n");
  const changes = await manager.previewMerge("sbx.nataliaignore");
  expect(changes.map((change) => change.path)).not.toContain(
    "ignored-output/data.txt",
  );
  await manager.delete("sbx.nataliaignore");
});

test("governance skips the human approval for a low-risk promotion", async () => {
  const root = await scratchRepo();
  const manager = new WorktreeSandboxManager(root);
  const sandbox = await manager.create("sbx.8");
  await mkdir(join(sandbox.root, "docs"), { recursive: true });
  await writeFile(join(sandbox.root, "docs/note.md"), "low risk\n");
  await git(sandbox.root, ["add", "."]);
  await git(sandbox.root, ["commit", "-m", "low risk edit"]);
  const authorized: string[][] = [];
  await manager.promoteWithValidation("sbx.8", {
    command: "true",
    requireApprovalTier: "medium",
    authorize: async (paths) => {
      authorized.push(paths);
    },
  });
  // A low-risk config/doc edit clears the medium gate without a human.
  expect(authorized).toEqual([]);
});

test("governance requires the human approval for a high-risk promotion", async () => {
  const root = await scratchRepo();
  const manager = new WorktreeSandboxManager(root);
  const sandbox = await manager.create("sbx.9");
  await mkdir(join(sandbox.root, "packages/core/tools/src"), {
    recursive: true,
  });
  await writeFile(
    join(sandbox.root, "packages/core/tools/src/types.ts"),
    "contract\n",
  );
  await git(sandbox.root, ["add", "."]);
  await git(sandbox.root, ["commit", "-m", "contract edit"]);
  const authorized: string[][] = [];
  await manager.promoteWithValidation("sbx.9", {
    command: "true",
    requireApprovalTier: "medium",
    authorize: async (paths) => {
      authorized.push(paths);
    },
  });
  // A contract change is high risk: the human approval ran.
  expect(authorized.length).toBe(1);
});
