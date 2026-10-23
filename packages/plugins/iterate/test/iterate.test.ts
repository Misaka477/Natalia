/**
 * The iterate plugin's surface.
 *
 * The handoff itself is tested in the substrate (the refusal list, the
 * copy, the goal plan); what is tested HERE is the contract between the
 * model and the host: the tool asks before it acts, it refuses honestly
 * when the host has no workspace manager, and its answer names the
 * boundary the caller must respect — that the work now belongs to another
 * session and continuing it here would be wrong.
 */
import { expect, test } from "bun:test";
import { createPluginRegistry } from "@anthelia/plugin";
import { createToolRegistry } from "@anthelia/tools";
import {
  createIteratePlugin,
  createIterateToolFamily,
  iterateTools,
  ITERATE_PLUGIN_ID,
} from "../src";

test("the family describes the tool it ships", () => {
  const family = createIterateToolFamily();
  expect(family.id).toBe("iterate");
  expect(family.scope).toBe("session");
  expect(family.tools).toEqual(iterateTools);
  expect(iterateTools.map((tool) => tool.name)).toEqual(["iterate_branch"]);
});

test("the tool asks before it acts", () => {
  // The handoff copies the product's own source, moves a goal and starts
  // an autonomous session: that is a human decision, not a tool the model
  // fires on its own.
  const tool = iterateTools[0]!;
  expect(tool.requiresApproval).toBe(true);
  // A copy of the source plus a build plus a test run is minutes, not
  // seconds; the timeout has to admit that.
  expect(tool.timeoutSec).toBeGreaterThanOrEqual(120);
});

test("the description says what it is NOT for", () => {
  // The failure this prevents: the model reaches for the handoff to work
  // in another project, where the semantics were never designed. The
  // description is the contract, so the boundary is in the words.
  const tool = iterateTools[0]!;
  expect(tool.description).toContain("sandbox_create");
  expect(tool.description).toContain("another project");
});

test("a host without a workspace manager gets a named refusal", async () => {
  const tool = iterateTools[0]!;
  const error = await tool
    .execute(
      { path: "/tmp/x", prompt: "go" },
      { workspaceRoot: process.cwd() } as never,
    )
    .then(
      () => null,
      (cause: unknown) => cause as Error,
    );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("unavailable in this host");
  // The refusal names where it WOULD work, so the human can act on it.
  expect((error as Error).message).toContain("natalia serve");
});

test("the answer states the boundary and what moved", async () => {
  const seen: Array<unknown> = [];
  const tool = iterateTools[0]!;
  const result = await tool.execute(
    { path: "/tmp/work", prompt: "finish the job", title: "iter 1" },
    {
      workspaceRoot: process.cwd(),
      sessionID: "ses_parent",
      iterateBranch: async (baseline: unknown, request: unknown) => {
        seen.push({ baseline, request });
        return {
          sessionID: "ses_child",
          workspaceID: "ws_child",
          workspaceRoot: "/tmp/work",
          registered: true,
          copiedFrom: "/install/source",
          goal: { kind: "move", goal: {}, parentReason: "handed_off" },
          goalArmed: true,
          notice: "<fork-notice>…</fork-notice>",
        };
      },
    } as never,
  );
  const answer = JSON.parse(String(result)) as {
    ok: boolean;
    sessionID: string;
    goal: string;
    goalArmed: boolean;
    boundary: string;
    notice: string;
    copiedFrom: string;
  };
  expect(answer.ok).toBe(true);
  expect(answer.sessionID).toBe("ses_child");
  expect(answer.goal).toBe("move");
  expect(answer.goalArmed).toBe(true);
  expect(answer.copiedFrom).toBe("/install/source");
  // The boundary is the fact that stops the caller from continuing the
  // work in the wrong tree.
  expect(answer.boundary).toContain("ses_child");
  expect(answer.boundary).toContain("do not continue the work here");
  // The baseline is resolved by the host, not chosen by the tool.
  expect(seen[0]).toMatchObject({
    baseline: undefined,
    request: {
      path: "/tmp/work",
      prompt: "finish the job",
      title: "iter 1",
      parentSessionID: "ses_parent",
      goalContinuation: true,
    },
  });
});

test("the plugin owns its tool and unloads cleanly", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  await registry.load(createIteratePlugin());
  expect(registry.list()[0]).toMatchObject({
    id: ITERATE_PLUGIN_ID,
    scope: "session",
  });
  expect(tools.has("iterate_branch")).toBe(true);
  await registry.unload(ITERATE_PLUGIN_ID);
  expect(tools.has("iterate_branch")).toBe(false);
});

test("setup touches no native library", async () => {
  // The plugin loads everywhere; the handoff is injected by the host and
  // the tool refuses when it is absent, so a platform without the
  // workspace manager still loads the tool set.
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  await registry.load(createIteratePlugin());
  await registry.unload(ITERATE_PLUGIN_ID);
});
