import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorktreeSandboxManager } from "../src/worktree-sandbox";
import { rmSync } from "node:fs";

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

test("a candidate's .natalia data write shows in the diff like any other (user smoke 2026-10-07)", async () => {
  // The smoke run: sandbox_write wrote `.natalia/tool-smoke/from-sandbox.txt`,
  // sandbox_diff showed NO change, but sandbox_delete listed the same file as
  // a discardable pending change — three surfaces, three answers about one
  // write. The cause was the candidate's structural exclusion covering ALL of
  // `.natalia/`, so the write was never committed and the git-derived diff
  // never saw it. Only the sandbox's OWN stores are structural; a
  // `.natalia/tool-smoke/` file is user data.
  const root = await scratchRepo();
  const manager = new WorktreeSandboxManager(root);
  await manager.create("box");
  await manager.write(
    "box",
    ".natalia/tool-smoke/from-sandbox.txt",
    "from the sandbox\n",
  );
  const changes = await manager.previewMerge("box");
  expect(changes.map((change) => change.path)).toContain(
    ".natalia/tool-smoke/from-sandbox.txt",
  );
  // Visible, and honest about why it will not merge: the .nataliaignore bulk
  // rules exclude it, and the entry says so instead of vanishing.
  const entry = changes.find(
    (change) => change.path === ".natalia/tool-smoke/from-sandbox.txt",
  )!;
  expect(entry.ignored).toBe(true);
  expect(entry.ignoreReason).toContain("nataliaignore");
  // The sandbox's own stores stay excluded: committing them would recurse.
  await manager.write(
    "box",
    ".natalia/sandboxes/intruder.txt",
    "must not be a candidate change\n",
  );
  expect(
    (await manager.previewMerge("box")).map((change) => change.path),
  ).not.toContain(".natalia/sandboxes/intruder.txt");
  // A normal write still merges: nothing above changed the git path.
  await manager.write("box", "notes.txt", "mergeable\n");
  expect(
    (await manager.previewMerge("box")).some(
      (change) => change.path === "notes.txt" && !change.ignored,
    ),
  ).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("a worktree candidate links the host's dependencies and never commits them", async () => {
  // The dependency supply on the git backend: `git worktree add` checks out
  // only TRACKED files, so the host's installed node_modules is absent and
  // the promotion gate's command would fail before testing anything. The
  // link fixes the read side; the commit filter keeps the link out of the
  // candidate branch — git stores a symlink as a blob, so a `git add -f`
  // would carry it into the host's history and the merge would write it
  // into the host working tree.
  const root = await scratchRepo();
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  await git(root, ["add", ".gitignore"]);
  await git(root, ["commit", "-m", "ignore node_modules"]);
  await mkdir(join(root, "node_modules", "fixture"), { recursive: true });
  await writeFile(join(root, "node_modules", "fixture", "pkg.json"), "{}");

  const manager = new WorktreeSandboxManager(root, {
    dependencyRoots: ["node_modules"],
  });
  const sandbox = await manager.create("sbx.deps");
  // The link exists in the candidate: the gate's command can read through it.
  expect(
    existsSync(join(sandbox.root, "node_modules", "fixture", "pkg.json")),
  ).toBe(true);

  // A real change beside it is what the candidate branch carries — and the
  // link is not among the changes, at any surface.
  await writeFile(join(sandbox.root, "work.txt"), "done\n");
  const changes = await manager.previewMerge("sbx.deps");
  expect(changes.map((change) => change.path)).toContain("work.txt");
  expect(changes.map((change) => change.path)).not.toContain("node_modules");

  // Promoting lands the change, and the link is nowhere in the host's tree.
  await manager.merge("sbx.deps", root);
  const tracked = await git(root, ["ls-files"]);
  expect(tracked.split("\n")).not.toContain("node_modules");
  const committed = await git(root, [
    "log",
    "--name-only",
    "--format=",
    "HEAD",
  ]);
  expect(committed).not.toContain("node_modules");
  expect(existsSync(join(root, "node_modules", "fixture", "pkg.json"))).toBe(
    true,
  );
  await manager.delete("sbx.deps");
});

test("a refresh brings the candidate up to the host's newer commits", async () => {
  // T6-2: a candidate branch is cut from the head at creation time, so a
  // long-running subagent works against a snapshot that goes stale the
  // moment anything else lands — another candidate's promotion, the user's
  // own commit. Without a refresh it cannot SEE that work, and it promotes a
  // branch whose merge-base is promotions behind.
  const root = await scratchRepo();
  const manager = new WorktreeSandboxManager(root);
  const sandbox = await manager.create("sbx.refresh");
  // The host moves on while the candidate is open.
  await writeFile(join(root, "host-new.txt"), "from the host\n");
  await git(root, ["add", "host-new.txt"]);
  await git(root, ["commit", "-m", "host advances"]);

  const result = await manager.refresh("sbx.refresh");
  expect(result.conflicted).toBe(false);
  expect(result.refreshed).toBe(true);
  // The candidate now holds the host's newer file — and its own base has
  // moved with it, so a promotion is against the current head.
  expect(await readFile(join(sandbox.root, "host-new.txt"), "utf8")).toBe(
    "from the host\n",
  );
  expect(await manager.previewMerge("sbx.refresh")).toEqual([]);
  // The candidate's OWN work survives the refresh.
  await writeFile(join(sandbox.root, "agent.txt"), "agent work\n");
  await git(sandbox.root, ["add", "agent.txt"]);
  await git(sandbox.root, ["commit", "-m", "agent change"]);
  await writeFile(join(root, "host-two.txt"), "two\n");
  await git(root, ["add", "host-two.txt"]);
  await git(root, ["commit", "-m", "host advances again"]);
  const second = await manager.refresh("sbx.refresh");
  expect(second.conflicted).toBe(false);
  expect(await readFile(join(sandbox.root, "agent.txt"), "utf8")).toBe(
    "agent work\n",
  );
  expect(
    (await manager.previewMerge("sbx.refresh")).map((change) => change.path),
  ).toEqual(["agent.txt"]);
  await manager.delete("sbx.refresh");
});

test("a refresh conflict is a state to resolve, not a discarded error", async () => {
  // T6-3: the conflict used to be `git merge --abort` + rethrow, which threw
  // away MERGE_HEAD and the conflict markers — the only things that say WHAT
  // conflicted. The candidate is left mid-merge and the conflict is reported.
  const root = await scratchRepo();
  const manager = new WorktreeSandboxManager(root);
  const sandbox = await manager.create("sbx.conflict");
  // Both sides change the same line.
  await writeFile(join(sandbox.root, "file.txt"), "candidate side\n");
  await git(sandbox.root, ["add", "file.txt"]);
  await git(sandbox.root, ["commit", "-m", "candidate edit"]);
  await writeFile(join(root, "file.txt"), "host side\n");
  await git(root, ["add", "file.txt"]);
  await git(root, ["commit", "-m", "host edit"]);

  const conflicted = await manager.refresh("sbx.conflict");
  expect(conflicted.conflicted).toBe(true);
  expect(conflicted.paths).toEqual(["file.txt"]);
  // The worktree is still there, mid-merge, with the markers in place.
  expect(existsSync(join(sandbox.root, "file.txt"))).toBe(true);
  const marked = await readFile(join(sandbox.root, "file.txt"), "utf8");
  expect(marked).toContain("<<<<<<<");

  // Take the resolution: write the merged content and commit it.
  const resolved = await manager.resolveConflict("sbx.conflict", {
    kind: "resolve",
    contents: { "file.txt": "both sides reconciled\n" },
  });
  expect(resolved.conflicted).toBe(false);
  expect(resolved.refreshed).toBe(true);
  expect(await readFile(join(sandbox.root, "file.txt"), "utf8")).toBe(
    "both sides reconciled\n",
  );
  // And the candidate is on a clean commit, so a promotion is ordinary.
  const changes = await manager.previewMerge("sbx.conflict");
  expect(changes.map((change) => change.path)).toEqual(["file.txt"]);
  await manager.delete("sbx.conflict");
});

test("a conflict resolution must answer every conflicted path", async () => {
  // A partial resolution would commit a tree that still carries conflict
  // markers, and the next preview would promote them into the host.
  const root = await scratchRepo();
  const manager = new WorktreeSandboxManager(root);
  const sandbox = await manager.create("sbx.partial");
  await writeFile(join(sandbox.root, "file.txt"), "candidate side\n");
  await git(sandbox.root, ["add", "file.txt"]);
  await git(sandbox.root, ["commit", "-m", "candidate edit"]);
  await writeFile(join(root, "file.txt"), "host side\n");
  await git(root, ["add", "file.txt"]);
  await git(root, ["commit", "-m", "host edit"]);
  await manager.refresh("sbx.partial");

  await expect(
    manager.resolveConflict("sbx.partial", { kind: "resolve", contents: {} }),
  ).rejects.toThrow(/unresolved conflict at file\.txt/u);
  // A path that is not conflicted is refused too: the resolution answers the
  // conflict, it does not invent one.
  await expect(
    manager.resolveConflict("sbx.partial", {
      kind: "resolve",
      contents: { "file.txt": "ok\n", "other.txt": "nope\n" },
    }),
  ).rejects.toThrow(/not conflicted/u);
  // The candidate is still mid-merge, so a real resolution still works.
  const resolved = await manager.resolveConflict("sbx.partial", {
    kind: "resolve",
    contents: { "file.txt": "settled\n" },
  });
  expect(resolved.conflicted).toBe(false);
  await manager.delete("sbx.partial");
});

test("a retried sandbox reuses the candidate branch a restart left behind", async () => {
  // T6-6: a restart that retries a sandboxed subagent re-ran
  // `git worktree add -b candidate/<id>` unconditionally, and the branch —
  // and often the worktree — are still there from the attempt that died.
  // `-b` on an existing branch fails with "already exists", so the retry
  // could never come back.
  const root = await scratchRepo();
  const manager = new WorktreeSandboxManager(root);
  const first = await manager.create("sbx.retry");
  // The attempt that died: the agent committed something, then the process
  // went away without the sandbox being deleted.
  await writeFile(join(first.root, "file.txt"), "attempt one\n");
  await git(first.root, ["add", "file.txt"]);
  await git(first.root, ["commit", "-m", "attempt one"]);
  const survived = await git(root, ["rev-parse", "candidate/sbx.retry"]);

  // The retry: the same id, same repo, branch and worktree still present.
  const second = await manager.create("sbx.retry");
  expect(second.root).toBe(first.root);
  // The branch is the SAME one — not a new branch, and not a failure.
  expect(await git(root, ["rev-parse", "candidate/sbx.retry"])).toBe(survived);
  // And the work from the dead attempt is still there, so the retry resumes
  // from it rather than starting over.
  expect(await readFile(join(second.root, "file.txt"), "utf8")).toBe(
    "attempt one\n",
  );
  expect(
    (await manager.previewMerge("sbx.retry")).map((change) => change.path),
  ).toEqual(["file.txt"]);
  await manager.delete("sbx.retry");
});

test("a retried sandbox re-attaches a worktree whose directory was removed", async () => {
  // The other half of the same failure: the branch survives but the worktree
  // directory does not (a tmpdir reap, a manual `rm -rf`). The retry must
  // re-attach rather than fail on the existing branch.
  const root = await scratchRepo();
  const manager = new WorktreeSandboxManager(root);
  const first = await manager.create("sbx.reattach");
  await writeFile(join(first.root, "file.txt"), "kept\n");
  await git(first.root, ["add", "file.txt"]);
  await git(first.root, ["commit", "-m", "kept"]);
  // Remove the worktree directory (and its registration) but keep the branch.
  await git(root, ["worktree", "remove", "--force", first.root]);
  await rm(first.root, { recursive: true, force: true });
  expect(existsSync(first.root)).toBe(false);

  const again = await manager.create("sbx.reattach");
  expect(existsSync(again.root)).toBe(true);
  expect(await readFile(join(again.root, "file.txt"), "utf8")).toBe("kept\n");
  await manager.delete("sbx.reattach");
});
