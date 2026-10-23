/**
 * The self-iteration handoff's decisions, tested without a runtime.
 *
 * The refusal list is the whole safety model: the baseline is read-only to
 * the model, so the targets that would defeat that are named answers
 * rather than silent fallbacks. The copy is what makes an iteration
 * recoverable. The goal plan is what makes two sessions never pursue one
 * objective.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkBranchTarget,
  copyBaseline,
  iterateBranch,
  resolveBaseline,
  type IterateBranchHost,
  type IterateBranchRequest,
} from "../src/iterate-branch";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "natalia-branch-"));
  roots.push(root);
  return root;
}

test("the baseline itself is refused as a target", () => {
  const baseline = join(tmpdir(), "natalia-baseline");
  const check = checkBranchTarget(baseline, baseline, false);
  expect(check.ok).toBe(false);
  if (check.ok) throw new Error("unreachable");
  expect(check.reason).toContain("read-only");
  expect(check.reason).toContain("recoverable");
});

test("a target inside the baseline is refused", () => {
  const baseline = join(tmpdir(), "natalia-baseline");
  const check = checkBranchTarget(join(baseline, "copy"), baseline, false);
  expect(check.ok).toBe(false);
  if (check.ok) throw new Error("unreachable");
  expect(check.reason).toContain("INSIDE the baseline");
});

test("a non-empty target is refused unless resume is explicit", async () => {
  const root = await tree();
  const baseline = join(root, "source");
  const target = join(root, "work");
  await mkdir(baseline, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "keep.txt"), "work");
  const refused = checkBranchTarget(target, baseline, false);
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error("unreachable");
  expect(refused.reason).toContain("already holds files");
  expect(refused.reason).toContain("resume");
  // The explicit resume is the caller saying "I know, continue there".
  expect(checkBranchTarget(target, baseline, true).ok).toBe(true);
});

test("an empty target is accepted", async () => {
  const root = await tree();
  const baseline = join(root, "source");
  const target = join(root, "fresh");
  await mkdir(baseline, { recursive: true });
  await mkdir(target, { recursive: true });
  expect(checkBranchTarget(target, baseline, false).ok).toBe(true);
});

test("the copy carries the source and leaves the build output behind", async () => {
  const root = await tree();
  const baseline = join(root, "source");
  await mkdir(join(baseline, "packages", "core"), { recursive: true });
  await mkdir(join(baseline, "node_modules", "junk"), { recursive: true });
  await mkdir(join(baseline, "dist"), { recursive: true });
  await writeFile(join(baseline, "package.json"), "{}");
  await writeFile(join(baseline, "bun.lock"), "");
  await writeFile(join(baseline, "packages", "core", "index.ts"), "export {}");
  await writeFile(join(baseline, "node_modules", "junk", "big.bin"), "x".repeat(1024));
  await writeFile(join(baseline, "dist", "out.js"), "x");

  const target = join(root, "work");
  const files = await copyBaseline(baseline, target);
  // The tree travels; node_modules and dist are rebuilt, and copying them
  // would cost hundreds of megabytes for nothing.
  expect(existsSync(join(target, "package.json"))).toBe(true);
  expect(existsSync(join(target, "bun.lock"))).toBe(true);
  expect(existsSync(join(target, "packages", "core", "index.ts"))).toBe(true);
  expect(existsSync(join(target, "node_modules"))).toBe(false);
  expect(existsSync(join(target, "dist"))).toBe(false);
  expect(files).toBe(3);
});

test("the baseline resolves to the install's source when it is there", async () => {
  const root = await tree();
  const install = join(root, "install");
  const source = join(install, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "package.json"), "{}");
  expect(resolveBaseline(undefined, install)).toBe(source);
  // An explicit baseline always wins over the derivation.
  const explicit = join(root, "explicit");
  expect(resolveBaseline(explicit, install)).toBe(explicit);
});

test("the handoff seeds the child, arms the goal, and reports the move", async () => {
  const root = await tree();
  const baseline = join(root, "source");
  const target = join(root, "work");
  await mkdir(baseline, { recursive: true });
  await writeFile(join(baseline, "package.json"), "{}");

  const calls: string[] = [];
  const host: IterateBranchHost = {
    listWorkspaces: async () => {
      calls.push("listWorkspaces");
      return [];
    },
    addWorkspace: async (input) => {
      calls.push(`addWorkspace:${input.path}`);
      return { workspaceID: "ws_child", root: input.path, status: "active" };
    },
    clientFor: () => ({
      sessionSeed: async (input: { title?: string; events: unknown[] }) => {
        calls.push(`sessionSeed:${input.events.length}:${input.title ?? ""}`);
        return { sessionID: "ses_child", created: true, seeded: input.events.length };
      },
      goalControl: async (action: string, sessionID?: string) => {
        calls.push(`goalControl:${action}:${sessionID ?? ""}`);
        return { ok: true };
      },
    }),
    exportSession: async (sessionID: string) => {
      calls.push(`exportSession:${sessionID}`);
      return { events: [{ seq: 1, event: { type: "turn.submitted" } }] };
    },
  };

  const request: IterateBranchRequest = {
    path: target,
    prompt: "continue the work",
    parentSessionID: "ses_parent",
    parentGoal: {
      goalID: "g1",
      title: "接完自迭代",
      phase: "active",
      roundsStarted: 2,
      revision: 3,
    },
    goalContinuation: true,
    permissionMode: "auto",
  };
  const result = await iterateBranch(host, baseline, request);

  expect(result.sessionID).toBe("ses_child");
  expect(result.workspaceID).toBe("ws_child");
  expect(result.copiedFrom).toBe(baseline);
  expect(result.registered).toBe(true);
  expect(result.goal.kind).toBe("move");
  expect(result.goalArmed).toBe(true);
  expect(existsSync(join(target, "package.json"))).toBe(true);
  // The child was seeded with the parent's journal and then armed.
  expect(calls).toContain("exportSession:ses_parent");
  expect(calls).toContain("sessionSeed:1:");
  expect(calls).toContain("goalControl:resume:ses_child");
  // The notice names the tree change, which is the fact a same-workspace
  // fork does not need and a cross-workspace one cannot do without.
  expect(result.notice).toContain("DIFFERENT WORKSPACE");
  expect(result.notice).toContain("ARMED");
});

test("a handoff into an existing tree reuses its workspace", async () => {
  const root = await tree();
  const baseline = join(root, "source");
  const target = join(root, "work");
  await mkdir(baseline, { recursive: true });
  await writeFile(join(baseline, "package.json"), "{}");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "package.json"), "{}");

  const calls: string[] = [];
  const host: IterateBranchHost = {
    listWorkspaces: async () => {
      calls.push("listWorkspaces");
      return [{ workspaceID: "ws_existing", root: target }];
    },
    addWorkspace: async () => {
      calls.push("addWorkspace");
      return { workspaceID: "ws_new", root: target, status: "active" };
    },
    clientFor: () => ({
      sessionSeed: async () => ({ sessionID: "ses_child", created: true, seeded: 0 }),
    }),
    exportSession: async () => ({ events: [] }),
  };

  const result = await iterateBranch(host, baseline, {
    path: target,
    prompt: "keep going",
    parentSessionID: "ses_parent",
    goalContinuation: false,
    resume: true,
  });
  expect(result.workspaceID).toBe("ws_existing");
  expect(result.registered).toBe(false);
  expect(result.copiedFrom).toBeUndefined();
  // No goal moved, so nothing was armed and no notice claims otherwise.
  expect(result.goal.kind).toBe("none");
  expect(result.goalArmed).toBe(false);
  expect(result.notice).not.toContain("ARMED");
  expect(calls).not.toContain("addWorkspace");
});

test("a different task supersedes the goal instead of dragging it along", async () => {
  const root = await tree();
  const baseline = join(root, "source");
  const target = join(root, "work");
  await mkdir(baseline, { recursive: true });
  await writeFile(join(baseline, "package.json"), "{}");
  const calls: string[] = [];
  const host: IterateBranchHost = {
    listWorkspaces: async () => [],
    addWorkspace: async (input) => ({
      workspaceID: "ws_child",
      root: input.path,
      status: "active",
    }),
    clientFor: () => ({
      sessionSeed: async () => ({ sessionID: "ses_child", created: true, seeded: 0 }),
      goalControl: async (action: string) => {
        calls.push(`goalControl:${action}`);
        return { ok: true };
      },
    }),
    exportSession: async () => ({ events: [] }),
  };
  const result = await iterateBranch(host, baseline, {
    path: target,
    prompt: "something else entirely",
    parentSessionID: "ses_parent",
    parentGoal: {
      goalID: "g1",
      title: "原目标",
      phase: "active",
      roundsStarted: 1,
      revision: 1,
    },
    goalContinuation: false,
  });
  expect(result.goal.kind).toBe("supersede");
  expect(result.goalArmed).toBe(false);
  // The child is never armed when the goal did not move: it would pursue
  // an objective that is not its task.
  expect(calls).not.toContain("goalControl:resume");
  expect(result.notice).toContain("did NOT move here");
});
