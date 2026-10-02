import { expect, test } from "bun:test";
import {
  HARD_PROTECTED_CONSTITUTION_RULE_IDS,
  isHardProtectedConstitutionRule,
} from "../src/constitution";

test("only the hard-coded self-protection rules are protected", () => {
  // The tool-execution SELF_PROTECTION_PATTERNS back exactly these three; a
  // journal edit cannot remove their guarantee.
  expect([...HARD_PROTECTED_CONSTITUTION_RULE_IDS].sort()).toEqual([
    "C-TERM-001",
    "C-TERM-002",
    "C-TERM-003",
  ]);
  for (const ruleID of HARD_PROTECTED_CONSTITUTION_RULE_IDS)
    expect(isHardProtectedConstitutionRule(ruleID)).toBe(true);
});

test("release-scope runtime-policy and user rules are not protected", () => {
  // C-REL-* are release scope but journal-enforced, so the user may edit/delete.
  expect(isHardProtectedConstitutionRule("C-REL-001")).toBe(false);
  expect(isHardProtectedConstitutionRule("C-REL-002")).toBe(false);
  expect(isHardProtectedConstitutionRule("P-USER-abc")).toBe(false);
  expect(isHardProtectedConstitutionRule("")).toBe(false);
});
