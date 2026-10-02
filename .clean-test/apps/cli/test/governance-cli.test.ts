import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  governanceListLines,
  governanceShow,
  governanceShowLines,
  governanceWhy,
  governanceWhyLines,
} from "../src/governance-cli";

/**
 * The CST3 command face's presentation (constitution/decision ledger plan
 * §5). The fold is the ledger's; these pin the human answers: list shows
 * the effective set and counts, show explains a rule in every state
 * (active / disabled / removed / unknown), why gives the decision's
 * reasons rather than its text.
 */

let workspace = "";
afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

function fixture(): string {
  workspace = mkdtempSync(join(tmpdir(), "governance-cli-"));
  const governance = join(workspace, ".natalia", "governance");
  mkdirSync(governance, { recursive: true });
  const rule = (ruleID: string, statement: string) => ({
    type: "constitution.rule_added",
    id: `rule:${ruleID}`,
    ruleID,
    statement,
    scope: "project",
    priority: "high",
    source: "user",
    enforcement: "approval",
    overridePolicy: "user_scoped",
    evidenceRefs: ["master-plan#20"],
  });
  writeFileSync(
    join(governance, "constitution.jsonl"),
    [
      rule("C-006", "Default project changes must happen in a sandbox"),
      rule("C-010", "Never commit without approval"),
      {
        type: "constitution.rule_updated",
        id: "rule:C-010:disabled",
        ruleID: "C-010",
        enabled: false,
      },
      rule("C-013", "A retired rule"),
      {
        type: "constitution.rule_removed",
        id: "rule:C-013:removed",
        ruleID: "C-013",
        removedAt: "2026-09-24T00:00:00.000Z",
        removedBy: "user",
      },
      {
        type: "constitution.override_granted",
        id: "override:C-006:1",
        ruleID: "C-006",
        reason: "one-off host write for the parser fix",
        approvedBy: "user",
        paths: ["src/parser.ts"],
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  writeFileSync(
    join(governance, "decisions.jsonl"),
    JSON.stringify({
      type: "decision.recorded",
      id: "D-017",
      decision: "Composition is declarative data",
      rationale: ["generation completeness is a hard requirement"],
      alternatives: [
        { option: "code-driven wiring", rejectedReason: "not switchable" },
      ],
      consequences: ["the CLI face is nearly free"],
      status: "accepted",
    }),
  );
  return workspace;
}

test("list shows the effective set with its counts and the override ledger", () => {
  const lines = governanceListLines(fixture());
  const text = lines.join("\n");
  expect(text).toContain(
    "Constitution rules: 1 active · 1 disabled · 1 removed",
  );
  // The active rule's line carries the judgement-relevant fields.
  expect(text).toContain("C-006 [high/approval]");
  expect(text).toContain("Decisions: 1");
  expect(text).toContain("D-017 [accepted]");
  expect(text).toContain("Scoped overrides granted: 1");
  expect(text).toContain("one-off host write for the parser fix");
});

test("show explains an active rule with its overrides", () => {
  const ws = fixture();
  expect(governanceShow(ws, "C-006")).toMatchObject({
    found: true,
    state: "active",
  });
  const lines = governanceShowLines(ws, "C-006").join("\n");
  expect(lines).toContain("C-006 — active");
  expect(lines).toContain("scope: project · priority: high");
  expect(lines).toContain("override policy: user_scoped");
  expect(lines).toContain("evidence: master-plan#20");
  expect(lines).toContain("one-off host write for the parser fix");
  expect(lines).toContain("(paths: src/parser.ts)");
});

test("show explains a disabled rule as reversible and a removed one as history", () => {
  const ws = fixture();
  expect(governanceShow(ws, "C-010").state).toBe("disabled");
  expect(governanceShowLines(ws, "C-010").join("\n")).toContain(
    "disabled (reversible, still in the journal)",
  );
  // The tombstone keeps the removed rule explainable — history is not erased.
  expect(governanceShow(ws, "C-013").state).toBe("removed");
  expect(governanceShowLines(ws, "C-013").join("\n")).toContain(
    "C-013 was removed at 2026-09-24T00:00:00.000Z",
  );
  // An unknown id says so and points at the list.
  expect(governanceShow(ws, "C-999").found).toBe(false);
  expect(governanceShowLines(ws, "C-999").join("\n")).toContain(
    "no constitution rule C-999",
  );
});

test("why gives the decision's reasons, not just its text", () => {
  const ws = fixture();
  expect(governanceWhy(ws, "D-017").found).toBe(true);
  const lines = governanceWhyLines(ws, "D-017").join("\n");
  expect(lines).toContain("D-017 — accepted");
  expect(lines).toContain("decision: Composition is declarative data");
  expect(lines).toContain("generation completeness is a hard requirement");
  expect(lines).toContain("code-driven wiring — rejected: not switchable");
  expect(lines).toContain("the CLI face is nearly free");
  expect(governanceWhy(ws, "D-999").found).toBe(false);
  expect(governanceWhyLines(ws, "D-999").join("\n")).toContain(
    "no decision D-999",
  );
});
