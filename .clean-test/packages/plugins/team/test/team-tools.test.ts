import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SnapshotSandboxTestManager as SnapshotSandboxManager } from "@natalia/testing";
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
  const context = { workspaceRoot: root } as never;

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
        prs: [{ id: "battle", sandboxID: prs[0]!.sandboxID }],
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
    { workspaceRoot: root } as never,
  );
  expect(result).toContain("ownership map is invalid");
  expect(result).toContain("overlapping domains");
});
