import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";
import { appendInstanceEvent } from "@natalia/governance-ledger";
import { createConstitutionRuleReadTool } from "../src/plan-contract-tools";
import type { RuntimeContext } from "@anthelia/substrate";

/**
 * `constitution_rule_read` (the 2026-10-08 audit's P1-1).
 *
 * The audit measured a REAL rule (`C-TERM-001`) and a fabricated one
 * (`C-NOPE-999`) answering alike — `{"status":"unknown"}` — with none of the
 * promised statement/enforcement/provenance. The read consulted only THIS
 * session's fold, while a workspace-tier rule approved in an earlier session
 * lives in the instance store.
 */

const ADDED: RuntimeEvent = {
  type: "constitution.rule_added",
  id: "constitution:c-probe-001",
  ruleID: "C-PROBE-001",
  statement: "probe rules are readable from any session",
  enforcement: "warn",
  scope: "release",
  priority: "high",
  source: "policy",
  proposedBy: "main_agent",
  approvedBy: "user",
  at: "2026-10-10T00:00:00.000Z",
} as unknown as RuntimeEvent;

async function readTool(ruleID: string) {
  const root = await mkdtemp(join(tmpdir(), "natalia-rule-read-"));
  // The rule was approved in an EARLIER session: it is in the instance store
  // and nowhere in this session's events.
  appendInstanceEvent(
    join(root, ".natalia", "governance"),
    "constitution.jsonl",
    ADDED,
  );
  // A session whose fold has NO constitution events at all: the rule lives
  // only in the instance store, which is the shape the audit measured.
  const exec = {
    session: { id: "ses_rule_read", events: [] },
    factState: undefined,
    // The fold is already complete: nothing to reseed, no store to ask.
    factStateComplete: true,
    fullEventsLoaded: true,
  };
  const ctx = {
    ports: {
      getReady: () => Promise.resolve(),
      getWorkspaceRoot: () => root,
      getSessionID: () => "ses_rule_read",
      getExecutionBySession: () => new Map([["ses_rule_read", exec]]),
      getActiveExec: () => exec,
      ensureExecution: async () => exec,
    },
  } as unknown as RuntimeContext;
  const tool = createConstitutionRuleReadTool(ctx);
  return await tool.execute({ ruleID }, {
    sessionID: "ses_rule_read",
    workspaceRoot: root,
  } as never);
}

test("a rule approved in an earlier session reads as active, with its facts", async () => {
  const answer = JSON.parse(await readTool("C-PROBE-001"));
  expect(answer.status).toBe("active");
  // The promised fields actually arrive.
  expect(answer.rule).toMatchObject({
    ruleID: "C-PROBE-001",
    statement: "probe rules are readable from any session",
    enforcement: "warn",
    scope: "release",
    priority: "high",
    source: "policy",
    proposedBy: "main_agent",
    approvedBy: "user",
  });
});

test("a fabricated rule reads as unknown — and is distinguishable from a real one", async () => {
  const answer = JSON.parse(await readTool("C-NOPE-999"));
  expect(answer.status).toBe("unknown");
  // The two probes the audit ran now answer DIFFERENTLY.
  expect(answer.status).not.toBe(
    JSON.parse(await readTool("C-PROBE-001")).status,
  );
});
