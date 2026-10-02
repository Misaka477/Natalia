import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  checkContractAgainstConstitution,
  constitutionDenyAnchoredRules,
} from "../src/contract-constitution-check";

type RuleAdded = Extract<RuntimeEvent, { type: "constitution.rule_added" }>;

function denyRule(
  ruleID: string,
  paths?: string[],
  extra?: Partial<RuleAdded>,
): RuleAdded {
  return {
    type: "constitution.rule_added",
    id: `constitution:rule:${ruleID}`,
    ruleID,
    statement: `deny ${paths?.join(",") ?? "tools-only"}`,
    scope: "project",
    priority: "high",
    source: "user",
    enforcement: "deny",
    overridePolicy: "forbidden",
    ...(paths ? { appliesTo: { paths } } : {}),
    ...extra,
  };
}

test("a scope entry naming a deny-covered path is a conflict", () => {
  const conflicts = checkContractAgainstConstitution({
    entries: [
      "rotate the .env credentials",
      "refactor packages/framework/client",
    ],
    rules: [denyRule("C-ENV-001", ["**/.env"])],
  });
  expect(conflicts).toEqual([
    {
      ruleID: "C-ENV-001",
      entry: "rotate the .env credentials",
      path: ".env",
    },
  ]);
});

test("a directory-glob deny rule matches a path named under it", () => {
  const conflicts = checkContractAgainstConstitution({
    entries: ["rewrite src/legacy/old.ts"],
    rules: [denyRule("C-LEG-001", ["src/legacy/**"])],
  });
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]).toMatchObject({
    ruleID: "C-LEG-001",
    path: "src/legacy/old.ts",
  });
});

test("a deny rule that does not cover the named path is silent", () => {
  const conflicts = checkContractAgainstConstitution({
    entries: ["refactor packages/framework/client/src"],
    rules: [denyRule("C-ENV-001", ["**/.env"])],
  });
  expect(conflicts).toEqual([]);
});

test("prose entries with no path tokens stay silent", () => {
  const conflicts = checkContractAgainstConstitution({
    entries: ["no new runtime dependency", "delete the old evaluator"],
    rules: [denyRule("C-ANY-001", ["**/*"])],
  });
  expect(conflicts).toEqual([]);
});

test("only deny rules conflict — warn and approval hits do not", () => {
  const conflicts = checkContractAgainstConstitution({
    entries: ["edit src/x.ts"],
    rules: [
      denyRule("C-WARN-001", ["src/**"], { enforcement: "warn" }),
      denyRule("C-APPR-001", ["src/**"], { enforcement: "approval" }),
    ],
  });
  expect(conflicts).toEqual([]);
});

test("a deny rule without a paths anchor (tools-only) stays silent", () => {
  const conflicts = checkContractAgainstConstitution({
    entries: ["edit src/x.ts"],
    rules: [
      denyRule("C-TOOL-001", undefined, {
        appliesTo: { tools: ["file_write"] },
      }),
    ],
  });
  expect(conflicts).toEqual([]);
});

test("a broad glob token conflicts when a deny pattern lives under it", () => {
  const conflicts = checkContractAgainstConstitution({
    entries: ["migrate everything under src/**", "audit src/"],
    rules: [denyRule("C-LEG-001", ["src/legacy/**"])],
  });
  expect(conflicts.map((conflict) => conflict.path)).toEqual([
    "src/**",
    "src/",
  ]);
});

test("backticks and quotes around a token are stripped", () => {
  const conflicts = checkContractAgainstConstitution({
    entries: ['edit `.env` and "secrets/key.pem" (then stop)'],
    rules: [
      denyRule("C-ENV-001", ["**/.env"]),
      denyRule("C-KEY-001", ["secrets/**"]),
    ],
  });
  expect(conflicts.map((conflict) => conflict.path).sort()).toEqual([
    ".env",
    "secrets/key.pem",
  ]);
});

test("one conflict per rule/entry/token, even when repeated", () => {
  const conflicts = checkContractAgainstConstitution({
    entries: [".env and .env again"],
    rules: [denyRule("C-ENV-001", ["**/.env", ".env"])],
  });
  expect(conflicts).toHaveLength(1);
});

test("no deny rules means no work and no conflicts", () => {
  const conflicts = checkContractAgainstConstitution({
    entries: ["edit src/x.ts"],
    rules: [denyRule("C-WARN-001", ["src/**"], { enforcement: "warn" })],
  });
  expect(conflicts).toEqual([]);
});

test("the consulted rule set is exactly the deny rules with path anchors", () => {
  // The proposal's gate states this set (ledger plan §5: the conflict-check
  // result is displayed), so its membership is part of the contract.
  const rule = (
    ruleID: string,
    enforcement: "deny" | "approval" | "warn",
    paths?: string[],
  ) => ({
    type: "constitution.rule_added" as const,
    id: `rule:${ruleID}`,
    ruleID,
    statement: ruleID,
    scope: "project" as const,
    priority: "critical" as const,
    source: "user" as const,
    enforcement,
    overridePolicy: "forbidden" as const,
    ...(paths ? { appliesTo: { paths } } : {}),
  });
  const rules = [
    rule("C-DENY-PATHS", "deny", ["secrets/**"]),
    rule("C-DENY-NOANCHOR", "deny"),
    rule("C-APPROVAL-PATHS", "approval", ["src/**"]),
    rule("C-WARN-PATHS", "warn", ["docs/**"]),
  ];
  expect(
    constitutionDenyAnchoredRules(rules).map((entry) => entry.ruleID),
  ).toEqual(["C-DENY-PATHS"]);
  // An empty set is honest: nothing was consulted, so nothing can conflict.
  expect(constitutionDenyAnchoredRules([])).toEqual([]);
});
