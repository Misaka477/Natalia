/**
 * A long tool call says what it is doing, on the same row, while it does it.
 *
 * Measured defect the user named: `record_validation` running a nine-minute
 * suite was a black box — the row said "running" and nothing else, so a reader
 * could not tell a slow suite from a hung one, and the only remedy offered was
 * "go read the log file". Telling a user to leave the product is not an answer.
 *
 * The tool now reports its own progress line through the execution context, the
 * runtime republishes it on the same row, and this test drives a real runtime to
 * prove the row receives it.
 */
import { expect, test } from "bun:test";
import { createRealRuntimeClient } from "../src";
import { createScriptedProvider } from "./e2e-harness";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";
import type { RuntimeEvent } from "@anthelia/contracts";

const slowCommand = process.platform === "win32" ? "Start-Sleep 4" : "sleep 4";

test("a running validation publishes its progress line on the same row", async () => {
  const root = await officialPluginWorkspace("tool-progress");
  useWorkspaceCleanup();
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_tool_progress",
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [
        {
          tool: {
            id: "call_validation",
            name: "record_validation",
            arguments: {
              taskID: "tool-progress",
              objective: "prove the row reports progress",
              command: slowCommand,
            },
          },
        },
        { text: "done" },
      ],
    }),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("run the slow validation");
  const running = events.filter(
    (event) =>
      event.type === "tool.update" &&
      (event as { callID?: string }).callID === "call_validation" &&
      (event as { status?: string }).status === "running",
  ) as Array<{ summary?: string }>;
  // The first update is the call itself; the progress line arrives while the
  // command runs, and it names the command plus elapsed seconds.
  expect(running.length).toBeGreaterThan(1);
  const progress = running
    .map((event) => event.summary ?? "")
    .filter((summary) => /elapsed/u.test(summary));
  expect(progress.length).toBeGreaterThan(0);
  expect(progress[0]).toContain(slowCommand);

  // The settled row is the run's answer, not a dangling "running".
  const settled = events.find(
    (event) =>
      event.type === "tool.update" &&
      (event as { callID?: string }).callID === "call_validation" &&
      (event as { status?: string }).status === "succeeded",
  ) as { summary?: string } | undefined;
  expect(settled?.summary).toBeDefined();
}, 120_000);
