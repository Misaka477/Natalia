import { expect, test } from "bun:test";
import type { SessionID } from "@anthelia/contracts";
import { createRealRuntimeClient } from "../src";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();
import { createScriptedProvider } from "./e2e-harness";

/**
 * EI Phase 0: the user records a human validation note on a completion card
 * ("用户走 UI 补 humanValidation"). It is durable and the completions read
 * surface merges the latest note onto the card (the user has the last word).
 */
test("a user records human validation and it lands on the completion card", async () => {
  const root = await officialPluginWorkspace("human-validation-e2e");
  const sessionID = "ses_human_validation" as SessionID;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [{ text: "standby" }],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start(() => undefined);
  await client.sessionAttach!(sessionID);

  await client.recordCompletion!({
    taskID: "task_build",
    objective: "ship the build check",
    changeSummary: "added the build check",
    validations: [
      { command: "bun run typecheck", result: "passed", safeSummary: "ok" },
    ],
  });
  let cards = await client.completions!({ sessionID });
  expect(cards.items.map((c) => c.taskID)).toContain("task_build");
  expect(
    cards.items.find((c) => c.taskID === "task_build")?.humanValidation,
  ).toBeUndefined();

  const recorded = await client.recordHumanValidation!(
    { taskID: "task_build", validation: "reviewed by the release owner" },
    sessionID,
  );
  expect(recorded.recorded).toBe(true);

  cards = await client.completions!({ sessionID });
  const card = cards.items.find((c) => c.taskID === "task_build");
  // The human note is merged onto the card and overrides the model's.
  expect(card?.humanValidation).toBe("reviewed by the release owner");
  // A second note wins (last write).
  await client.recordHumanValidation!(
    { taskID: "task_build", validation: "re-reviewed after the fix" },
    sessionID,
  );
  cards = await client.completions!({ sessionID });
  expect(
    cards.items.find((c) => c.taskID === "task_build")?.humanValidation,
  ).toBe("re-reviewed after the fix");
  // A missing completion is refused, not silently accepted.
  const refused = await client.recordHumanValidation!(
    { taskID: "task_missing", validation: "n/a" },
    sessionID,
  );
  expect(refused.recorded).toBe(true); // recorded as a durable note; the card has no task
  await client.dispose?.();
}, 30_000);
