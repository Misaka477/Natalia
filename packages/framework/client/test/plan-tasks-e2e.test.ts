import { expect, test } from "bun:test";
import type { SessionID } from "@anthelia/contracts";
import { createRealRuntimeClient } from "../src";
import { createPlanDocTickTool } from "../src/runtime/plan-doc-tools";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();
import { createScriptedProvider } from "./e2e-harness";

const SESSION = "ses_e2e_plan_tasks" as SessionID;

test("Phase 4 E2E: plan checkboxes project to evidence-first task states", async () => {
  const root = await officialPluginWorkspace("plan-tasks-e2e");
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [{ text: "standby" }],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start(() => undefined);
  await client.sessionAttach!(SESSION);

  await client.planDocWrite!({
    path: "plans/e2e-tasks.md",
    content: [
      "# E2E tasks",
      "",
      "- [x] add the parser",
      "- [x] wire the runtime client",
      "- [ ] ship the docs",
      "- [ ] refactor the tokenizer",
      "- [~] legacy cleanup",
    ].join("\n"),
    title: "E2E tasks",
  });
  const marked = await client.planDocMark!({
    path: "plans/e2e-tasks.md",
    title: "E2E tasks",
  });
  const planID = marked.planID;
  await client.planDocActivate!(planID);

  // Record a completion whose objective references "add the parser" — the fact
  // source that backs that one checked task.
  await client.recordCompletion!(
    {
      taskID: "plan:e2e:tasks",
      objective: "add the parser tests",
      changeSummary: "added parser unit tests",
      validations: [
        { command: "bun test", result: "passed", safeSummary: "green" },
      ],
      knownGaps: [],
      rollbackState: "clean",
    },
    SESSION,
  );
  // A second completion backs an OPEN task — work has started but is not
  // declared done.
  await client.recordCompletion!(
    {
      taskID: "plan:e2e:tasks",
      objective: "refactor the tokenizer",
      changeSummary: "started the tokenizer refactor",
      validations: [
        { command: "bun test", result: "passed", safeSummary: "green" },
      ],
      knownGaps: [],
      rollbackState: "clean",
    },
    SESSION,
  );

  const states = await client.planTaskStates!({ planID }, SESSION);
  const byText = new Map(states.map((task) => [task.text, task.state]));
  // Checked + evidence -> verified.
  expect(byText.get("add the parser")).toBe("verified");
  // Checked + no evidence -> gap (never verified without backing).
  expect(byText.get("wire the runtime client")).toBe("gap");
  // Open + no evidence -> pending.
  expect(byText.get("ship the docs")).toBe("pending");
  // Open + evidence -> in_progress (work started, not declared done).
  expect(byText.get("refactor the tokenizer")).toBe("in_progress");
  // Skipped stays visible.
  expect(byText.get("legacy cleanup")).toBe("skipped");
  await client.dispose?.();
}, 30_000);

test("Phase 4 E2E: the main agent's plan_doc_tick declares a step done and can retract it", async () => {
  const root = await officialPluginWorkspace("plan-tick-e2e");
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
    permissionMode: "auto",
    provider: createScriptedProvider({
      // The planID is minted by planDocMark, so the scripted tool calls read it
      // from a closure set after the plan is marked.
      main: [
        {
          tool: () => ({
            name: "plan_doc_tick",
            arguments: { planID: planID!, task: "add the parser", done: true },
          }),
        },
        {
          tool: () => ({
            name: "plan_doc_tick",
            arguments: { planID: planID!, task: "add the parser", done: false },
          }),
        },
        { text: "ticked then retracted" },
      ],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start(() => undefined);
  await client.sessionAttach!(SESSION);

  let planID: string | undefined;
  await client.planDocWrite!({
    path: "plans/tick-e2e.md",
    content: [
      "# Tick E2E",
      "",
      "- [ ] add the parser",
      "- [ ] ship the docs",
    ].join("\n"),
    title: "Tick E2E",
  });
  const marked = await client.planDocMark!({
    path: "plans/tick-e2e.md",
    title: "Tick E2E",
  });
  planID = marked.planID;

  // The main agent's turn ticks then retracts the step via plan_doc_tick.
  await client.submitAndWait!("mark the parser step done, then retract");

  const doc = await client.planDocRead!({ planID });
  // After tick-then-retract the marker is back to open, and the label is intact.
  expect(doc.content).toContain("- [ ] add the parser");
  expect(doc.content).toContain("- [ ] ship the docs");
  // No fabricated lines, no landing log (this plan has checkboxes).
  expect(doc.content).not.toContain("落地日志");

  await client.dispose?.();
}, 30_000);

test("Phase 4 E2E: plan_doc_tick appends a 落地日志 section to a checkbox-less plan", async () => {
  const root = await officialPluginWorkspace("plan-tick-log-e2e");
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [
        {
          tool: () => ({
            name: "plan_doc_tick",
            arguments: {
              planID: planID!,
              task: "wired the parser",
              done: true,
            },
          }),
        },
        { text: "logged the step" },
      ],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start(() => undefined);
  await client.sessionAttach!(SESSION);

  let planID: string | undefined;
  await client.planDocWrite!({
    path: "plans/log-e2e.md",
    content: [
      "# Prose plan",
      "",
      "A design note with no checkboxes at all.",
      "",
    ].join("\n"),
    title: "Prose plan",
  });
  const marked = await client.planDocMark!({
    path: "plans/log-e2e.md",
    title: "Prose plan",
  });
  planID = marked.planID;

  await client.submitAndWait!("record that the parser is wired");

  const doc = await client.planDocRead!({ planID });
  expect(doc.content).toContain("## 落地日志");
  expect(doc.content).toContain("- [x] wired the parser");
  // The original prose is preserved.
  expect(doc.content).toContain("A design note with no checkboxes at all.");

  await client.dispose?.();
}, 30_000);

/**
 * Drive `plan_doc_tick` the way the runtime does: the same factory the
 * services wire, executed against the live workspace.
 */
async function tick(
  root: string,
  planID: string,
  task: string,
  done: boolean,
): Promise<string> {
  const tool = createPlanDocTickTool({
    ports: {
      getReady: () => Promise.resolve(),
      getWorkspaceRoot: () => root,
      getSessionID: () => SESSION,
      planDocRuntime: {
        planDocRead: async (input: { planID: string }) => {
          const index = JSON.parse(
            await readFile(
              join(root, ".natalia", "plans", "index.json"),
              "utf8",
            ),
          ) as Record<string, { documentPath: string }>;
          const record = index[input.planID];
          if (!record) throw new Error("unknown plan");
          const content = await readFile(
            join(root, ".natalia", "plans", record.documentPath),
            "utf8",
          );
          return {
            planID: input.planID,
            documentPath: record.documentPath,
            content,
          };
        },
        planDocWrite: async (input: { path: string; content: string }) => {
          await writeFile(
            join(root, ".natalia", "plans", input.path),
            input.content,
            "utf8",
          );
          return { written: true };
        },
      },
    },
  } as unknown as Parameters<typeof createPlanDocTickTool>[0]);
  return await tool.execute({ planID, task, done }, {
    sessionID: SESSION,
    workspaceRoot: root,
  } as unknown as Parameters<typeof tool.execute>[1]);
}

test("an untick that changes nothing is a refusal, not ok:true (P0-4)", async () => {
  // The 2026-10-08 audit's P0-4: plan_doc_tick(done:false) answered
  // {ok:true, action:"unticked"} while the document still carried the tick.
  const root = await officialPluginWorkspace("plan-tick-noop");
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [{ text: "standby" }],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start(() => undefined);
  await client.sessionAttach!(SESSION);
  await client.planDocWrite!({
    path: "plans/tick-noop.md",
    content: [
      "# Tick noop",
      "",
      "## 落地日志",
      "",
      "- [x] AUDIT-PROBE-TEMP-DO-NOT-SHIP",
      "",
    ].join("\n"),
    title: "Tick noop",
  });
  const marked = await client.planDocMark!({
    path: "plans/tick-noop.md",
    title: "Tick noop",
  });
  // The landing-log entry IS the checkbox, so this one really retracts.
  const retracted = await tick(
    root,
    marked.planID,
    "AUDIT-PROBE-TEMP-DO-NOT-SHIP",
    false,
  );
  expect(JSON.parse(String(retracted))).toMatchObject({
    ok: true,
    action: "unticked",
  });
  const doc = await client.planDocRead!({ planID: marked.planID });
  expect(doc.content).toContain("- [ ] AUDIT-PROBE-TEMP-DO-NOT-SHIP");
  expect(doc.content).not.toContain("- [x] AUDIT-PROBE-TEMP-DO-NOT-SHIP");
  // A second untick changes nothing: the answer says so instead of lying.
  const again = await tick(
    root,
    marked.planID,
    "AUDIT-PROBE-TEMP-DO-NOT-SHIP",
    false,
  );
  expect(JSON.parse(String(again))).toMatchObject({
    ok: false,
    reason: expect.stringContaining("nothing to retract"),
  });
});
