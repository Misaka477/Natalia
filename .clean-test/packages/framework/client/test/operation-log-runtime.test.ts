import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";
import { createScriptedProvider } from "./e2e-harness";
import { createRealRuntimeClient } from "../src/runtime/main";

/**
 * The operation log wired through the runtime (interface spec §4.5): a
 * real turn lands records in the configured directory, and — the point of
 * record-side injection — a turn-scoped record carries sessionID+turnID
 * that NO call site passed.
 */

useWorkspaceCleanup();

let scratch = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "operation-log-runtime-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("a real turn writes correlated records to the configured log", async () => {
  const root = await officialPluginWorkspace("operation-log-runtime");
  const logDir = join(scratch, "logs");
  const events: RuntimeEvent[] = [];
  const sessionID = "ses_oplog_runtime" as never;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    operationLogsDir: logDir,
    provider: createScriptedProvider({ main: [{ text: "ok" }] }),
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!(sessionID);
  await client.submitAndWait!("hello runtime");
  await client.dispose?.(); // dispose drains the log (close -> flush)

  const path = join(logDir, "operations.jsonl");
  expect(existsSync(path)).toBe(true);
  const records = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          level: string;
          component: string;
          message: string;
          corr?: { sessionID?: string; turnID?: string };
        },
    );
  expect(records.length).toBeGreaterThan(0);
  // Every record is schema-shaped (the journal's discipline, ported).
  for (const record of records) {
    expect(typeof record.level).toBe("string");
    expect(typeof record.component).toBe("string");
    expect(typeof record.message).toBe("string");
  }
  // §4.5's acceptance: the turn scope injected session AND turn on a
  // record whose call site never mentioned either.
  const correlated = records.filter(
    (record) => record.corr?.sessionID && record.corr?.turnID,
  );
  expect(correlated.length).toBeGreaterThan(0);
  expect(correlated[0]!.corr!.sessionID).toBe("ses_oplog_runtime");
  expect(correlated[0]!.corr!.turnID).toMatch(/^turn_/u);
}, 60_000);
