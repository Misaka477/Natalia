import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionID } from "@anthelia/contracts";
import { createRealRuntimeClient } from "../src";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();
import { createScriptedProvider } from "./e2e-harness";

/**
 * EI E2: an evidence record carries a timestamp, and a validation whose output
 * exceeds the bounded safe summary persists the (redacted) output as an
 * artifact the evidence can reference.
 */
test("record_validation records recordedAt and an artifactRef for a large output", async () => {
  const root = await officialPluginWorkspace("evidence-artifact-ref");
  const sessionID = "ses_evidence_artifact" as SessionID;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [
        {
          tool: () => ({
            name: "record_validation",
            arguments: {
              taskID: "task_big",
              objective: "run a chatty validation",
              command: "seq 1 3000",
            },
          }),
        },
        { text: "validation recorded" },
      ],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start(() => undefined);
  await client.sessionAttach!(sessionID);
  await client.submitAndWait!("record the validation");

  const page = await client.evidenceRecords!({ sessionID });
  const record = page.items.find((r) => r.taskID === "task_big")!;
  expect(record).toBeDefined();
  expect(record.recordedAt).toBeString();
  expect(record.environment).toContain("/");
  const validation = record.validations[0]!;
  expect(validation.artifactRef).toBeString();
  expect(validation.artifactRef).toContain(".natalia/artifacts/");
  // The referenced (redacted, bounded) output is on disk.
  const artifact = await readFile(join(root, validation.artifactRef!), "utf8");
  expect(artifact.length).toBeGreaterThan(validation.safeSummary.length);
  await client.dispose?.();
}, 30_000);
