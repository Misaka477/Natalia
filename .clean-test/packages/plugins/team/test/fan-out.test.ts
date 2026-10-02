import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SandboxToolService, SubagentToolService } from "@anthelia/tools";
import { SnapshotSandboxTestManager as SnapshotSandboxManager } from "@natalia/testing";
import { SubagentRegistry } from "@anthelia/subagents";
import {
  prSettlementReason,
  reviewPRs,
  runFanOut,
  validateOwnershipMap,
  type FanOutPR,
} from "../src/index";

test("a PR's settlement reason is its own table, pure", () => {
  const base: FanOutPR = {
    id: "task",
    sandboxID: "a1",
    status: "completed",
    diff: [],
    result: "",
  };
  // A completed PR is ready …
  expect(prSettlementReason(base)).toBe("ready");
  // … unless the build gate failed it (the output rides on the notice).
  expect(
    prSettlementReason({
      ...base,
      buildEvidence: { ok: false, exitCode: 2, output: "nope" },
    }),
  ).toBe("failed");
  expect(
    prSettlementReason({
      ...base,
      buildEvidence: { ok: true, exitCode: 0, output: "ok" },
    }),
  ).toBe("ready");
  expect(prSettlementReason({ ...base, status: "failed" })).toBe("failed");
  expect(prSettlementReason({ ...base, status: "stopped" })).toBe("stopped");
  // A live PR is not coerced into a terminal reason.
  expect(prSettlementReason({ ...base, status: "running" })).toBe("unknown");
});

test("runFanOut spawns sandboxed sub-agents in parallel and produces one PR each", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-fanout-"));
  await writeFile(join(root, "CONTRACT.md"), "shared contract\n");
  const sandboxes = new SnapshotSandboxManager(root);
  await sandboxes.initialize();

  // A runner that simulates a sandboxed sub-agent: it creates its own worktree
  // and writes a file in it, exactly what the host's sandboxed runner does.
  const registry = new SubagentRegistry({
    workDir: join(root, ".natalia", "subagents"),
    runner: async (task, context) => {
      const manifest = await sandboxes.create(context.agentId);
      expect(await readFile(join(manifest.root, "CONTRACT.md"), "utf8")).toBe(
        "shared contract\n",
      );
      await writeFile(join(manifest.root, "output.txt"), `made by ${task}`);
      context.log("complete");
      context.setStatus("running");
    },
  });

  const prs = await runFanOut({
    tasks: [
      { id: "battle", prompt: "battle system" },
      { id: "inventory", prompt: "inventory system" },
    ],
    subagents: registry,
    sandboxes,
    timeoutMs: 10_000,
  });

  expect(prs).toHaveLength(2);
  for (const pr of prs) {
    expect(pr.status).toBe("completed");
    expect(pr.result).toContain("complete");
    // Each PR carries the candidate's own worktree diff for the lead to review.
    expect(pr.diff.map((change) => change.path)).toContain("output.txt");
  }
  // Each sub-agent worked in its own sandbox, disjoint by construction.
  expect(prs[0]!.sandboxID).not.toBe(prs[1]!.sandboxID);
});

test("runFanOut gates each PR with build evidence from the candidate worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-fanout-evidence-"));
  const sandboxes = new SnapshotSandboxManager(root);
  await sandboxes.initialize();
  const registry = new SubagentRegistry({
    workDir: join(root, ".natalia", "subagents"),
    runner: async (task, context) => {
      const manifest = await sandboxes.create(context.agentId);
      // The "build" marker decides pass/fail per task.
      const pass = task.includes("pass");
      if (pass) await writeFile(join(manifest.root, "build-pass"), "1");
      context.log(pass ? "ok" : "broken");
      context.setStatus("running");
    },
  });

  const prs = await runFanOut({
    tasks: [
      { id: "pass-task", prompt: "pass task" },
      { id: "fail-task", prompt: "fail task" },
    ],
    subagents: registry,
    sandboxes,
    timeoutMs: 10_000,
    buildCommand: "test -f build-pass",
  });

  const passPR = prs.find((pr) => pr.id === "pass-task")!;
  const failPR = prs.find((pr) => pr.id === "fail-task")!;
  // The gate ran in each candidate's own worktree: pass builds, fail ones are
  // reported with the failing evidence for the lead to reject or fix.
  expect(passPR.buildEvidence?.ok).toBe(true);
  expect(failPR.buildEvidence?.ok).toBe(false);
  expect(failPR.buildEvidence?.exitCode).not.toBe(0);
});

test("validateOwnershipMap rejects overlapping domains (T-3 close)", () => {
  const disjoint = validateOwnershipMap({
    tasks: [
      { id: "battle", prompt: "battle", writePaths: ["systems/battle"] },
      {
        id: "inventory",
        prompt: "inventory",
        writePaths: ["systems/inventory"],
      },
    ],
  });
  expect(disjoint.ok).toBe(true);

  const prefix = validateOwnershipMap({
    tasks: [
      { id: "systems", prompt: "systems", writePaths: ["systems"] },
      { id: "battle", prompt: "battle", writePaths: ["systems/battle"] },
    ],
  });
  expect(prefix.ok).toBe(false);
  expect(prefix.issues.join("\n")).toContain("overlapping domains");
});

test("reviewPRs promotes approved PRs into the system slot and sends back the rest (T-4)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-review-"));
  await writeFile(join(root, "base.txt"), "base\n");
  const sandboxes = new SnapshotSandboxManager(root);
  await sandboxes.initialize();
  const registry = new SubagentRegistry({
    workDir: join(root, ".natalia", "subagents"),
    runner: async (task, context) => {
      const manifest = await sandboxes.create(context.agentId);
      await writeFile(join(manifest.root, "output.txt"), `from ${task}`);
      context.log("ok");
      context.setStatus("running");
    },
  });

  const prs = await runFanOut({
    tasks: [
      { id: "approved", prompt: "approved task" },
      { id: "rejected", prompt: "rejected task" },
    ],
    subagents: registry,
    sandboxes,
    timeoutMs: 10_000,
  });

  // The lead: approve the first PR, send back the second.
  const outcomes = await reviewPRs({
    prs,
    sandboxes,
    workspaceRoot: root,
    decide: (pr) =>
      pr.id === "approved"
        ? { id: pr.id, decision: "approve" as const }
        : { id: pr.id, decision: "request-changes" as const, reason: "redo" },
  });

  const approved = outcomes.find((outcome) => outcome.id === "approved")!;
  const rejected = outcomes.find((outcome) => outcome.id === "rejected")!;
  expect(approved.decision).toBe("approve");
  expect(approved.merged?.map((change) => change.path)).toContain("output.txt");
  // The approved candidate's change landed in the host workspace.
  expect(await readFile(join(root, "output.txt"), "utf8")).toBe(
    "from approved task",
  );
  expect(rejected.decision).toBe("request-changes");
  expect(rejected.reason).toBe("redo");
  // The rejected candidate was not promoted into the host.
  expect(existsSync(join(root, "output.txt"))).toBe(true); // only the approved one
});

import {
  LEAD_REVIEWER_SYSTEM_PROMPT,
  ORCHESTRATOR_SYSTEM_PROMPT,
  sandboxedSubagentSystemPrompt,
} from "../src/index";

test("agent-team prompts carry the contract each role must follow", () => {
  // The orchestrator: disjoint ownership + validation are load-bearing.
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("ownership map");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("never overlap");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("validateOwnershipMap");
  // The sandboxed sub-agent: its file domain is enforced by the prompt.
  expect(sandboxedSubagentSystemPrompt()).toContain("isolated workspace");
  expect(sandboxedSubagentSystemPrompt()).toContain(
    "already checked out the repository base",
  );
  expect(sandboxedSubagentSystemPrompt()).toContain(
    "Do not create or switch worktrees",
  );
  expect(sandboxedSubagentSystemPrompt(["systems/battle"])).toContain(
    "systems/battle",
  );
  expect(sandboxedSubagentSystemPrompt(["systems/battle"])).toContain(
    "write files ONLY under these paths",
  );
  // The lead reviewer: one PR at a time, against domain + contract + evidence.
  expect(LEAD_REVIEWER_SYSTEM_PROMPT).toContain("one at a time");
  expect(LEAD_REVIEWER_SYSTEM_PROMPT).toContain("build evidence");
  expect(LEAD_REVIEWER_SYSTEM_PROMPT).toContain("outside its domain");
});

test("runFanOut caps concurrent spawns with maxConcurrent", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-fanout-cap-"));
  await mkdir(join(root, ".natalia", "subagents"), { recursive: true });
  const sandboxes = new SnapshotSandboxManager(root);
  await sandboxes.initialize();
  const registry = new SubagentRegistry({
    workDir: join(root, ".natalia", "subagents"),
    runner: async (task, context) => {
      const manifest = await sandboxes.create(context.agentId);
      await writeFile(join(manifest.root, "out.txt"), task);
      context.log("ok");
      context.setStatus("running");
    },
  });
  // Count in-flight spawn calls: maxConcurrent caps the spawn burst.
  const originalSpawn = registry.spawn.bind(registry);
  let inFlight = 0;
  let peakSpawn = 0;
  const counting = new Proxy(registry, {
    get(target, prop) {
      if (prop === "spawn")
        return async (...args: Parameters<typeof originalSpawn>) => {
          inFlight++;
          peakSpawn = Math.max(peakSpawn, inFlight);
          const result = await originalSpawn(...args);
          inFlight--;
          return result;
        };
      return (target as unknown as Record<string, unknown>)[prop as string];
    },
  });
  const prs = await runFanOut({
    tasks: [
      { id: "a", prompt: "a" },
      { id: "b", prompt: "b" },
      { id: "c", prompt: "c" },
    ],
    subagents: counting as SubagentToolService,
    sandboxes,
    maxConcurrent: 2,
    timeoutMs: 10_000,
  });
  expect(prs).toHaveLength(3);
  // Never more than 2 spawn calls were in flight at once.
  expect(peakSpawn).toBeLessThanOrEqual(2);
});

test("a promotion that fails is reported for that PR without stopping the batch", async () => {
  // Throwing on the first failure abandoned every PR after it, and left the ones
  // already promoted reported nowhere.
  const root = await mkdtemp(join(tmpdir(), "natalia-review-fail-"));
  await mkdir(join(root, ".natalia", "subagents"), { recursive: true });
  const sandboxes = new SnapshotSandboxManager(root);
  await sandboxes.initialize();
  const prs: FanOutPR[] = [
    {
      id: "bad",
      sandboxID: "sb_does_not_exist",
      status: "completed",
      diff: [],
    },
    { id: "good", sandboxID: "sb_also_missing", status: "completed", diff: [] },
  ];
  const decisions: string[] = [];

  const outcomes = await reviewPRs({
    prs,
    sandboxes,
    workspaceRoot: root,
    decide: (pr) => {
      decisions.push(pr.id);
      return { id: pr.id, decision: "approve" };
    },
  });

  // Both were decided: the second is not skipped because the first could not land.
  expect(decisions).toEqual(["bad", "good"]);
  expect(outcomes).toHaveLength(2);
  for (const outcome of outcomes) {
    expect(outcome.decision).toBe("request-changes");
    expect(outcome.promotionError).toBeTruthy();
  }
});

test("an approved PR releases its candidate sandbox", async () => {
  // The work is in the host after promotion, so the candidate is redundant —
  // and nothing else ever comes back for it. This asserts the release on the
  // approve path, which is the only path that has one.
  const root = await mkdtemp(join(tmpdir(), "natalia-review-cleanup-"));
  await writeFile(join(root, "base.txt"), "base\n");
  const sandboxes = new SnapshotSandboxManager(root);
  await sandboxes.initialize();
  const registry = new SubagentRegistry({
    workDir: join(root, ".natalia", "subagents"),
    runner: async (task, context) => {
      const manifest = await sandboxes.create(context.agentId);
      await writeFile(join(manifest.root, "output.txt"), `from ${task}`);
      context.log("ok");
      context.setStatus("running");
    },
  });
  const prs = await runFanOut({
    tasks: [{ id: "released", prompt: "released task" }],
    subagents: registry,
    sandboxes,
    timeoutMs: 10_000,
  });
  const deleted: string[] = [];
  const tracking = new Proxy(sandboxes, {
    get(target, prop) {
      if (prop === "delete")
        return async (id: string) => {
          deleted.push(id);
          return await target.delete(id);
        };
      return (target as unknown as Record<string, unknown>)[prop as string];
    },
  });

  const outcomes = await reviewPRs({
    prs,
    sandboxes: tracking as unknown as SandboxToolService,
    workspaceRoot: root,
    decide: (pr) => ({ id: pr.id, decision: "approve" as const }),
  });

  expect(outcomes[0]?.decision).toBe("approve");
  // The promotion landed, and its candidate was released.
  expect(await readFile(join(root, "output.txt"), "utf8")).toBe(
    "from released task",
  );
  expect(deleted).toEqual([prs[0]!.sandboxID]);
});

test("a PR sent back for changes keeps its candidate for the sub-agent to redo", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-review-keep-"));
  await writeFile(join(root, "base.txt"), "base\n");
  const sandboxes = new SnapshotSandboxManager(root);
  await sandboxes.initialize();
  const registry = new SubagentRegistry({
    workDir: join(root, ".natalia", "subagents"),
    runner: async (task, context) => {
      const manifest = await sandboxes.create(context.agentId);
      await writeFile(join(manifest.root, "output.txt"), `from ${task}`);
      context.log("ok");
      context.setStatus("running");
    },
  });
  const prs = await runFanOut({
    tasks: [{ id: "kept", prompt: "kept task" }],
    subagents: registry,
    sandboxes,
    timeoutMs: 10_000,
  });
  const deleted: string[] = [];
  const tracking = new Proxy(sandboxes, {
    get(target, prop) {
      if (prop === "delete")
        return async (id: string) => {
          deleted.push(id);
          return await target.delete(id);
        };
      return (target as unknown as Record<string, unknown>)[prop as string];
    },
  });

  const outcomes = await reviewPRs({
    prs,
    sandboxes: tracking as unknown as SandboxToolService,
    workspaceRoot: root,
    decide: (pr) => ({
      id: pr.id,
      decision: "request-changes" as const,
      reason: "redo",
    }),
  });

  expect(outcomes[0]?.decision).toBe("request-changes");
  // Nothing was promoted, so nothing may be released.
  expect(deleted).toEqual([]);
});

test("the drain builds each PR as its candidate lands (not after the batch)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-fanout-drain-"));
  const sandboxes = new SnapshotSandboxManager(root);
  await sandboxes.initialize();
  const registry = new SubagentRegistry({
    workDir: join(root, ".natalia", "subagents"),
    runner: async (task, context) => {
      const manifest = await sandboxes.create(context.agentId);
      await writeFile(join(manifest.root, "output.txt"), `made by ${task}`);
      // The first candidate lands immediately; the second takes a while —
      // the old batch wait would hold the first PR hostage.
      if (task.includes("slow"))
        await new Promise((resolve) => setTimeout(resolve, 600));
      context.log("done");
    },
  });
  const landed: Array<{ id: string; at: number }> = [];
  const started = Date.now();
  const prs = await runFanOut({
    tasks: [
      { id: "fast", prompt: "fast task" },
      { id: "slow", prompt: "slow task" },
    ],
    subagents: registry,
    sandboxes,
    timeoutMs: 10_000,
    onPR: (pr) => landed.push({ id: pr.id, at: Date.now() - started }),
  });
  // Both PRs are in the queue (the contract is unchanged) …
  expect(prs).toHaveLength(2);
  expect(prs.map((pr) => pr.id)).toEqual(["fast", "slow"]);
  expect(prs.every((pr) => pr.status === "completed")).toBe(true);
  // … and the first landed long before the slow candidate finished: the
  // drain, not the batch wait.
  expect(landed).toHaveLength(2);
  const fast = landed.find((entry) => entry.id === "fast")!;
  const slow = landed.find((entry) => entry.id === "slow")!;
  expect(fast.at).toBeLessThan(slow.at);
  expect(fast.at).toBeLessThan(500);
});

test("a straggler past the deadline is reported running, never coerced", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-fanout-straggler-"));
  const sandboxes = new SnapshotSandboxManager(root);
  await sandboxes.initialize();
  const registry = new SubagentRegistry({
    workDir: join(root, ".natalia", "subagents"),
    runner: async (task, context) => {
      const manifest = await sandboxes.create(context.agentId);
      await writeFile(join(manifest.root, "output.txt"), `made by ${task}`);
      if (task.includes("slow"))
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      context.log("done");
    },
  });
  const prs = await runFanOut({
    tasks: [
      { id: "quick", prompt: "quick task" },
      { id: "slow", prompt: "slow task" },
    ],
    subagents: registry,
    sandboxes,
    timeoutMs: 800,
  });
  const quick = prs.find((pr) => pr.id === "quick")!;
  const slow = prs.find((pr) => pr.id === "slow")!;
  expect(quick.status).toBe("completed");
  // The live candidate is reported as it is, and its diff is empty rather
  // than a guess.
  expect(slow.status).toBe("running");
  expect(slow.diff).toEqual([]);
});
