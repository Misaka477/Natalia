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

test("record_validation returns the evidenceID a completion card can cite (T-02)", async () => {
  // The tool used to return only {recorded, result, safeSummary} while
  // recording an `id: evidence:...` the caller could never see — so the
  // completion card's evidenceIDs had nothing to cite and every completion
  // judged itself judgeable:false / missing validation:test. The returned
  // id must be the SAME string the evidence record carries.
  const root = await officialPluginWorkspace("evidence-id-return");
  const sessionID = "ses_evidence_id" as SessionID;
  const results: string[] = [];
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
              taskID: "task_cited",
              objective: "prove the id round-trips",
              command: "true",
            },
          }),
        },
        { text: "validation recorded" },
      ],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start((event) => {
    if (event.type === "tool.update")
      console.log(
        "TOOLUPDATE:",
        event.name,
        event.status,
        String((event as { result?: string }).result ?? "").slice(0, 200),
      );
    if (event.type === "tool.update" && event.status === "succeeded")
      results.push(
        JSON.stringify({
          name: event.name,
          result: String((event as { result?: string }).result ?? ""),
        }),
      );
  });
  await client.sessionAttach!(sessionID);
  await client.submitAndWait!("record the validation");

  expect(results).toHaveLength(1);
  const answer = JSON.parse(
    (JSON.parse(results[0]!) as { result: string }).result,
  ) as {
    recorded: boolean;
    evidenceID?: string;
    taskID?: string;
  };
  expect(answer.recorded).toBe(true);
  expect(answer.evidenceID).toBeString();
  expect(answer.evidenceID!.startsWith("evidence:")).toBe(true);
  expect(answer.taskID).toBe("task_cited");
  // The same id is the durable record's identity.
  const page = await client.evidenceRecords!({ sessionID });
  console.log(
    "PAGE ITEMS:",
    JSON.stringify(
      page.items.map((r) => ({ id: r.id, taskID: r.taskID })),
    ).slice(0, 500),
  );
  const record = page.items.find((r) => r.id === answer.evidenceID);
  expect(record).toBeDefined();
  expect(record!.taskID).toBe("task_cited");
  await client.dispose?.();
}, 30_000);

test("a completion citing a recorded evidenceID stops reporting the validation missing (T-02)", async () => {
  // The payoff half of T-02: the id record_validation returns must COUNT
  // when cited. Before the bridge, the card judged its matrix against the
  // caller-declared validations only, so a model that recorded a validation
  // and cited its evidenceID still got judgeable:false / missing
  // validation:test — the id was decorative.
  const root = await officialPluginWorkspace("evidence-bridge");
  const sessionID = "ses_evidence_bridge" as SessionID;
  const results: string[] = [];
  let evidenceID = "";
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
              taskID: "task_bridge",
              objective: "run the bridge validation",
              // The classifier reads the command text; the run itself is
              // trivial and passes.
              command: "echo 'bun test placeholder'",
            },
          }),
        },
        {
          tool: (context) => {
            evidenceID = (
              JSON.parse(context.latestToolResult!.content) as {
                evidenceID: string;
              }
            ).evidenceID;
            return {
              name: "record_completion",
              arguments: {
                taskID: "task_bridge",
                objective: "close the test gap for the bridge",
                changeSummary: "wired the evidence bridge",
                changePaths: ["src/bridge.test.ts"],
                // The model cites the id INSTEAD of re-declaring the
                // validation — that is the flow the missing evidenceID broke.
                evidenceIDs: [evidenceID],
              },
            };
          },
        },
        { text: "completion recorded" },
      ],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start((event) => {
    if (event.type === "tool.update" && event.status === "succeeded")
      results.push(
        JSON.stringify({
          name: event.name,
          result: String((event as { result?: string }).result ?? ""),
        }),
      );
  });
  await client.sessionAttach!(sessionID);
  await client.submitAndWait!("validate then complete");

  expect(evidenceID).toStartWith("evidence:");
  // The completion card: the cited evidence satisfied the matrix.
  const update = results.find(
    (entry) =>
      (JSON.parse(entry) as { name: string }).name === "record_completion",
  );
  expect(update).toBeDefined();
  const answer = JSON.parse(
    (JSON.parse(update!) as { result: string }).result,
  ) as {
    recorded: boolean;
    card: { judgeable: boolean; missing: string[] };
    citedEvidence?: string[];
  };
  expect(answer.recorded).toBe(true);
  expect(answer.citedEvidence).toEqual([evidenceID]);
  expect(answer.card.missing).toEqual([]);
  expect(answer.card.judgeable).toBe(true);
  await client.dispose?.();
}, 30_000);
