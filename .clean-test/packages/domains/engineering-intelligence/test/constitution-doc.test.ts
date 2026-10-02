import { expect, test } from "bun:test";
import {
  applyConstitutionDocEdit,
  parseConstitutionDocument,
  splitConstitutionSections,
} from "@natalia/engineering-intelligence";

test("prose sections without annotations are warn-level soft rules", () => {
  const rules = parseConstitutionDocument(
    [
      "# Team conventions",
      "",
      "Prefer small, reviewable pull requests.",
      "",
      "## Testing",
      "",
      "Every source change ships with a test.",
    ].join("\n"),
    "agents",
  );
  expect(rules).toHaveLength(2);
  expect(rules[0]).toMatchObject({
    source: "agents",
    section: "Team conventions",
    statement: "Prefer small, reviewable pull requests.",
    enforcement: "warn",
    annotated: false,
  });
  expect(rules[0]!.appliesTo).toBeUndefined();
  expect(rules[1]).toMatchObject({
    section: "Testing",
    statement: "Every source change ships with a test.",
    enforcement: "warn",
    annotated: false,
  });
});

test("an enforcement annotation promotes a section to a hard rule", () => {
  const rules = parseConstitutionDocument(
    [
      "## Never force-push",
      "",
      "Force-pushing rewrites shared history.",
      "",
      "<!-- enforcement: deny -->",
      '<!-- appliesTo: { commandPattern: "git push --force" } -->',
    ].join("\n"),
    "constitution",
  );
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({
    source: "constitution",
    section: "Never force-push",
    enforcement: "deny",
    annotated: true,
    appliesTo: { commandPattern: "git push --force" },
  });
  // The annotation comments are stripped from the statement.
  expect(rules[0]!.statement).toBe("Force-pushing rewrites shared history.");
});

test("appliesTo tools and paths lists are parsed leniently", () => {
  const rules = parseConstitutionDocument(
    [
      "## Guard destructive commands",
      "",
      "<!-- enforcement: approval -->",
      '<!-- appliesTo: { tools: ["shell", "fs-write"], paths: [".github/"] } -->',
    ].join("\n"),
    "constitution",
  );
  expect(rules[0]).toMatchObject({
    enforcement: "approval",
    annotated: true,
    appliesTo: { tools: ["shell", "fs-write"], paths: [".github/"] },
  });
});

test("an empty appliesTo anchor is dropped, keeping the rule warn-anchored", () => {
  const rules = parseConstitutionDocument(
    [
      "## Advisory",
      "",
      "<!-- enforcement: warn -->",
      "<!-- appliesTo: {} -->",
    ].join("\n"),
    "constitution",
  );
  expect(rules[0]).toMatchObject({ enforcement: "warn", annotated: true });
  expect(rules[0]!.appliesTo).toBeUndefined();
});

test("an annotation-only section (no prose) still yields a rule", () => {
  const rules = parseConstitutionDocument(
    [
      "## Blocked",
      "<!-- enforcement: deny -->",
      '<!-- appliesTo: { tools: ["shell"] } -->',
    ].join("\n"),
    "constitution",
  );
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({
    enforcement: "deny",
    annotated: true,
    appliesTo: { tools: ["shell"] },
  });
  // With no prose the heading text stands in as the statement.
  expect(rules[0]!.statement).toBe("Blocked");
});

test("empty sections are skipped and ids are stable per heading+ordinal", () => {
  const doc = ["# Title", "", "## Real", "", "A rule.", "", "##   ", ""].join(
    "\n",
  );
  const rules = parseConstitutionDocument(doc, "constitution");
  // The prose-less "# Title" and the empty "##" heading are skipped; only the
  // section with prose survives.
  expect(rules.map((rule) => rule.section)).toEqual(["Real"]);
  // Re-parsing the same document yields the same ids.
  const again = parseConstitutionDocument(doc, "constitution");
  expect(again.map((rule) => rule.id)).toEqual(rules.map((rule) => rule.id));
});

test("CRLF line endings and inline annotations are handled", () => {
  const rules = parseConstitutionDocument(
    "## Rule\r\nprose line\r\n<!-- enforcement: approval -->\r\n",
    "agents",
  );
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({
    enforcement: "approval",
    annotated: true,
    statement: "prose line",
  });
});

test("splitConstitutionSections tracks each section's heading and line range", () => {
  const doc = ["# Title", "", "intro prose", "## Rule A", "", "body a"].join(
    "\n",
  );
  const sections = splitConstitutionSections(doc);
  // The pre-heading content is its own (headingless) section.
  expect(sections.map((s) => s.heading)).toEqual(["", "Title", "Rule A"]);
  const ruleA = sections.find((s) => s.heading === "Rule A")!;
  expect(ruleA.startLine).toBe(3);
  // "body a" is the last line; the section ends there.
  expect(doc.split("\n")[ruleA.endLine]).toBe("body a");
});

test("editing a prose rule rewrites its statement and keeps other rules stable", () => {
  const doc = [
    "# Conventions",
    "",
    "Prefer small PRs.",
    "",
    "## Testing",
    "",
    "Every change ships a test.",
  ].join("\n");
  const before = parseConstitutionDocument(doc, "agents");
  const testing = before.find((r) => r.section === "Testing")!;
  const result = applyConstitutionDocEdit(doc, "agents", testing.id, {
    statement:
      "Every source change ships a unit test and an E2E where it touches a boundary.",
    enforcement: "warn",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const after = parseConstitutionDocument(result.content, "agents");
  // The edited section reflects the new prose...
  expect(after.find((r) => r.section === "Testing")!.statement).toBe(
    "Every source change ships a unit test and an E2E where it touches a boundary.",
  );
  // ...the untouched section is unchanged, and ids stay stable.
  expect(after.find((r) => r.section === "Conventions")!.statement).toBe(
    "Prefer small PRs.",
  );
  expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
});

test("editing can annotate a prose section into a hard deny rule with an anchor", () => {
  const doc = [
    "## Never force-push",
    "",
    "Force-pushing rewrites shared history.",
  ].join("\n");
  const rule = parseConstitutionDocument(doc, "constitution")[0]!;
  expect(rule.enforcement).toBe("warn");
  const result = applyConstitutionDocEdit(doc, "constitution", rule.id, {
    statement: "Force-pushing rewrites shared history.",
    enforcement: "deny",
    appliesTo: { commandPattern: "git push --force" },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // The document now carries the annotations the parser reads back as hard.
  expect(result.content).toContain("<!-- enforcement: deny -->");
  expect(result.content).toContain('commandPattern: "git push --force"');
  const after = parseConstitutionDocument(result.content, "constitution")[0]!;
  expect(after).toMatchObject({
    enforcement: "deny",
    annotated: true,
    appliesTo: { commandPattern: "git push --force" },
    statement: "Force-pushing rewrites shared history.",
  });
});

test("editing a hard rule syncs its appliesTo anchor and can downgrade it back to prose", () => {
  const doc = [
    "## Guard shell",
    "",
    "Destructive shell needs approval.",
    "",
    "<!-- enforcement: approval -->",
    '<!-- appliesTo: { tools: ["shell"] } -->',
  ].join("\n");
  const rule = parseConstitutionDocument(doc, "constitution")[0]!;

  // Tighten the anchor: add a path.
  const tightened = applyConstitutionDocEdit(doc, "constitution", rule.id, {
    statement: "Destructive shell needs approval.",
    enforcement: "approval",
    appliesTo: { tools: ["shell"], paths: [".github/"] },
  });
  expect(tightened.ok).toBe(true);
  if (!tightened.ok) return;
  expect(
    parseConstitutionDocument(tightened.content, "constitution")[0]!.appliesTo,
  ).toEqual({ tools: ["shell"], paths: [".github/"] });

  // Downgrade to a warn prose rule: the annotations are removed entirely.
  const downgraded = applyConstitutionDocEdit(
    tightened.content,
    "constitution",
    rule.id,
    { statement: "Destructive shell needs approval.", enforcement: "warn" },
  );
  expect(downgraded.ok).toBe(true);
  if (!downgraded.ok) return;
  expect(downgraded.content).not.toContain("<!--");
  const after = parseConstitutionDocument(
    downgraded.content,
    "constitution",
  )[0]!;
  expect(after).toMatchObject({ enforcement: "warn", annotated: false });
  expect(after.appliesTo).toBeUndefined();
});

test("a deny/approval edit without an anchor is refused, not written", () => {
  const doc = ["## Blocked", "", "Do not do this."].join("\n");
  const rule = parseConstitutionDocument(doc, "constitution")[0]!;
  const result = applyConstitutionDocEdit(doc, "constitution", rule.id, {
    statement: "Do not do this.",
    enforcement: "deny",
  });
  expect(result).toEqual({
    ok: false,
    reason: "a deny/approval rule requires a non-empty appliesTo anchor",
  });
});

test("editing an unknown rule id is reported, and the document is untouched", () => {
  const doc = ["## Real", "", "A rule."].join("\n");
  const result = applyConstitutionDocEdit(
    doc,
    "constitution",
    "constitution:nope:9",
    {
      statement: "x",
      enforcement: "warn",
    },
  );
  expect(result).toEqual({ ok: false, reason: "unknown document rule id" });
});
