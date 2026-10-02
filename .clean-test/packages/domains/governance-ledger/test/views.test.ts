import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { governanceViews } from "../src/views";

/**
 * The CST3 read face's fold (constitution/decision ledger plan §5): the
 * workspace-tier instance store folded into the same projections the
 * runtime's faces serve — one fold, one home. History stays complete:
 * a disabled rule is reversible, a removed rule is a durable tombstone,
 * and both remain explainable after the fact.
 */

let root = "";
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function store(events: unknown[]): string {
  root = mkdtempSync(join(tmpdir(), "governance-views-"));
  const governance = join(root, ".natalia", "governance");
  mkdirSync(governance, { recursive: true });
  writeFileSync(
    join(governance, "constitution.jsonl"),
    events
      .filter((event) =>
        String((event as { type: string }).type).startsWith("constitution."),
      )
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  writeFileSync(
    join(governance, "decisions.jsonl"),
    events
      .filter(
        (event) =>
          !String((event as { type: string }).type).startsWith("constitution."),
      )
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  return root;
}

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
});

test("the instance store folds to rules, decisions, overrides and tombstones", () => {
  const workspace = store([
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
      reason: "one-off host write for the release",
      approvedBy: "user",
      paths: ["src/parser.ts"],
      expiresAt: "2026-10-01T00:00:00.000Z",
    },
    {
      type: "decision.recorded",
      id: "D-017",
      decision: "Composition is declarative data",
      rationale: ["generation completeness", "diffable"],
      alternatives: [
        { option: "code-driven wiring", rejectedReason: "not switchable" },
      ],
      consequences: ["the CLI face is nearly free"],
      status: "accepted",
    },
  ]);

  const views = governanceViews(workspace);
  expect(views.degraded).toBe(false);
  // The effective set: added and not disabled/removed.
  expect(views.rules.map((entry) => entry.ruleID)).toEqual(["C-006"]);
  // Disabled is reversible and stays explainable.
  expect(views.disabled.map((entry) => entry.ruleID)).toEqual(["C-010"]);
  // Removed is the durable tombstone — history is not erased.
  expect(views.removed).toEqual([
    {
      ruleID: "C-013",
      at: "2026-09-24T00:00:00.000Z",
      removedBy: "user",
    },
  ]);
  expect(views.overrides.map((entry) => entry.ruleID)).toEqual(["C-006"]);
  expect(views.overrides[0]?.paths).toEqual(["src/parser.ts"]);
  expect(views.decisions.map((entry) => entry.id)).toEqual(["D-017"]);
  expect(views.decisions[0]?.decision).toBe("Composition is declarative data");
});

test("an absent or unreadable store answers unknown, not empty", () => {
  const empty = mkdtempSync(join(tmpdir(), "governance-views-empty-"));
  try {
    const views = governanceViews(empty);
    expect(views.degraded).toBe(false);
    expect(views.rules).toEqual([]);
    expect(views.decisions).toEqual([]);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  // No workspace root at all (the CLI invoked outside one).
  expect(governanceViews(undefined).rules).toEqual([]);
});
