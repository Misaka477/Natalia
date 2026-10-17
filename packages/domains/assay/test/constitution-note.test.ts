import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConstitutionDocument } from "../src/constitution-doc";

/**
 * Block ③'s constitution note (the Laya calibration discipline + block ②'s
 * class policy), written into the workspace's `.natalia/constitution.md` in
 * the parser's shape — this test proves the note PARSES as the rules it
 * claims to be (a note the parser cannot read would be a comment, not a
 * constitution).
 */

// The note is a committed fixture: it used to be read from the repo's own
// .natalia/ — machine-local runtime state no clone has, so on a fresh
// checkout (CI) the test failed with ENOENT. The fixture is the real
// note, committed verbatim, and the parser is proven against it exactly
// as before.
const NOTE = readFileSync(
  join(import.meta.dir, "fixtures/constitution.md"),
  "utf8",
);

test("the note parses into its rules: the title prose plus the two policy sections", () => {
  const rules = parseConstitutionDocument(NOTE, "constitution");
  // Every section is a warn rule (the doc carries no enforcement
  // annotations — the policy is advisory to the agent, and the class
  // policy's floors are the faces' own).
  expect(rules).toHaveLength(3);
  for (const rule of rules) expect(rule.enforcement).toBe("warn");
  // The statement is the section's BODY (the heading rides `section`);
  // assert on the body's own words, and the heading separately.
  expect(rules[1]!.section).toContain("默认不自授权");
  expect(rules[1]!.statement).toContain("Growth proposals are recorded");
  expect(rules[2]!.statement).toContain("ORDERS decisions");
});

test("the note carries the study's class policy verbatim and the calibration discipline", () => {
  expect(NOTE).toContain("新增技能");
  expect(NOTE).toContain("改策略行");
  expect(NOTE).toContain("改内核世代");
  expect(NOTE).toContain("Confidence ORDERS decisions; it does not ESTABLISH");
  expect(NOTE).toContain("fitted per question type");
});
