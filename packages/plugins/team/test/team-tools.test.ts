import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SnapshotSandboxTestManager as SnapshotSandboxManager } from "@natalia/testing";
import type { SandboxToolService } from "@anthelia/tools";
import { SubagentRegistry } from "@anthelia/subagents";
import { createTeamFanoutTool, createTeamReviewTool } from "../src/index";

test("team_fanout + team_review drive a fan-out from a tool context", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-team-tools-"));
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
  const fanout = createTeamFanoutTool({
    subagents: () => registry,
    sandboxes: () => sandboxes,
  });
  const review = createTeamReviewTool({ sandboxes: () => sandboxes });
  const context = { workspaceRoot: root, sessionID: "ses_team" } as never;

  const prs = JSON.parse(
    await fanout.execute(
      { tasks: [{ id: "battle", prompt: "battle task" }] },
      context,
    ),
  ) as Array<{ id: string; sandboxID: string }>;
  expect(prs).toHaveLength(1);
  expect(prs[0]!.id).toBe("battle");

  const outcomes = JSON.parse(
    await review.execute(
      {
        prs: [
          {
            id: "battle",
            sandboxID: prs[0]!.sandboxID,
            // The lead names the command this PR's merge is validated with;
            // the workspace has no marker to detect one from.
            buildCommand: "test -f output.txt",
          },
        ],
        decisions: [{ id: "battle", decision: "approve" }],
      },
      context,
    ),
  ) as Array<{ id: string; decision: string; merged?: string[] }>;
  expect(outcomes[0]!.decision).toBe("approve");
  // The approved candidate's change was promoted into the host workspace.
  expect(outcomes[0]!.merged).toContain("output.txt");
  expect(await readFile(join(root, "output.txt"), "utf8")).toBe(
    "from battle task",
  );
});

test("team_fanout rejects an invalid ownership map before spawning", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-team-tools-map-"));
  const sandboxes = new SnapshotSandboxManager(root);
  await sandboxes.initialize();
  const registry = new SubagentRegistry({
    workDir: join(root, ".natalia", "subagents"),
    runner: async (_task, context) => context.log("unused"),
  });
  const fanout = createTeamFanoutTool({
    subagents: () => registry,
    sandboxes: () => sandboxes,
  });
  const result = await fanout.execute(
    {
      tasks: [
        { id: "systems", prompt: "systems", writePaths: ["systems"] },
        { id: "battle", prompt: "battle", writePaths: ["systems/battle"] },
      ],
    },
    { workspaceRoot: root, sessionID: "ses_team_map" } as never,
  );
  expect(result).toContain("ownership map is invalid");
  expect(result).toContain("overlapping domains");
});

test("team_fanout records the calling session on every candidate", async () => {
  // The sub-agent runtime resolves each child's parent execution from the
  // record's parentSessionID and refuses a child that has none ("subagent has
  // no parent session", subagent-runner.ts). A fan-out that omitted it spawned
  // a batch that died at init (T-14); this pins the field end to end.
  const root = await mkdtemp(join(tmpdir(), "natalia-team-tools-parent-"));
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
  const fanout = createTeamFanoutTool({
    subagents: () => registry,
    sandboxes: () => sandboxes,
  });
  await fanout.execute({ tasks: [{ id: "battle", prompt: "battle task" }] }, {
    workspaceRoot: root,
    sessionID: "ses_fanout_parent",
  } as never);
  const records = registry.list();
  expect(records).toHaveLength(1);
  expect(records[0]!.parentSessionID).toBe("ses_fanout_parent");
});

test("team_fanout without a calling session refuses instead of spawning dead candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-team-tools-nosession-"));
  const sandboxes = new SnapshotSandboxManager(root);
  await sandboxes.initialize();
  const registry = new SubagentRegistry({
    workDir: join(root, ".natalia", "subagents"),
    runner: async (_task, context) => context.log("unused"),
  });
  const fanout = createTeamFanoutTool({
    subagents: () => registry,
    sandboxes: () => sandboxes,
  });
  await expect(
    fanout.execute({ tasks: [{ id: "battle", prompt: "battle task" }] }, {
      workspaceRoot: root,
    } as never),
  ).rejects.toThrow(/requires a calling session/u);
  // Nothing was spawned: the refusal lands before the batch, not as a
  // diagnostic after a batch of candidates that all die at init.
  expect(registry.list()).toHaveLength(0);
});

test("team_review validates with the PR's own command and refuses when none exists", async () => {
  // The review tool used to hardcode `true` as the promotion's validation
  // command — a stand-in that exits 0 without testing anything, so every
  // approve looked validated — and it fabricated build evidence whenever the
  // caller merely mentioned a buildCommand. Both are gone: the PR's command
  // is carried through to the promotion, and a PR with no command anywhere
  // is refused by name without the promotion running.
  const root = await mkdtemp(join(tmpdir(), "natalia-team-review-command-"));
  await writeFile(join(root, "base.txt"), "base\n");
  const sandboxes = new SnapshotSandboxManager(root);
  await sandboxes.initialize();
  const commands: string[] = [];
  const tracking = new Proxy(sandboxes, {
    get(target, prop) {
      if (prop === "promoteWithValidation")
        return async (
          id: string,
          input: { command: string; hostRoot?: string },
        ) => {
          commands.push(input.command);
          return await target.promoteWithValidation(id, input);
        };
      return (target as unknown as Record<string, unknown>)[prop as string];
    },
  }) as unknown as SnapshotSandboxManager;
  const review = createTeamReviewTool({
    sandboxes: () => tracking as unknown as SandboxToolService,
  });
  const context = {
    workspaceRoot: root,
    sessionID: "ses_team_review_command",
  } as never;

  // A real candidate with a real diff, in a workspace with no project
  // marker: nothing can validate this merge, so the approve is refused and
  // no promotion runs.
  const manifest = await sandboxes.create("sb_real");
  await writeFile(join(manifest.root, "output.txt"), "from battle");
  const refused = JSON.parse(
    await review.execute(
      {
        prs: [{ id: "battle", sandboxID: "sb_real" }],
        decisions: [{ id: "battle", decision: "approve" }],
      },
      context,
    ),
  ) as Array<{ decision: string; reason?: string }>;
  expect(refused[0]!.decision).toBe("request-changes");
  expect(refused[0]!.reason).toMatch(/no build command configured/u);
  expect(commands).toEqual([]);

  // The same candidate, now with the PR's own command: the promotion runs
  // and validates with exactly that command.
  const approved = JSON.parse(
    await review.execute(
      {
        prs: [
          {
            id: "battle",
            sandboxID: "sb_real",
            buildCommand: "test -f output.txt",
          },
        ],
        decisions: [{ id: "battle", decision: "approve" }],
      },
      context,
    ),
  ) as Array<{ decision: string; merged?: string[] }>;
  expect(approved[0]!.decision).toBe("approve");
  expect(approved[0]!.merged).toContain("output.txt");
  expect(commands).toEqual(["test -f output.txt"]);
  expect(await readFile(join(root, "output.txt"), "utf8")).toBe("from battle");
});
