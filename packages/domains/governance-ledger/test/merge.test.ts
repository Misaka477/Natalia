import { expect, test } from "bun:test";
import { mergeGovernanceEvents } from "../src/merge";
import type { RuntimeEvent } from "@anthelia/contracts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * One logical journal, two physical copies, ONE merge. Every reader used to
 * hand-roll `[...instance.events, ...session.events]`, which assumes the two
 * stores are disjoint, that concatenation is chronological, and that each
 * event appears once. All three are false, and the third is what resurrected
 * a deleted rule: the fold saw `add → removed → add`.
 */

const add = (id: string): RuntimeEvent =>
  ({
    type: "constitution.rule_added",
    id,
    ruleID: "P-AGENT-x",
    statement: "sandbox_merge must be gated by explicit human approval",
    scope: "project",
    priority: "high",
    source: "agent_proposed",
    enforcement: "approval",
    overridePolicy: "user_explicit",
    proposedBy: "agent",
  }) as unknown as RuntimeEvent;

const removed = (id: string, ruleID: string): RuntimeEvent =>
  ({
    type: "constitution.rule_removed",
    id,
    ruleID,
    removedAt: "2026-10-12T09:19:41.052Z",
    removedBy: "user",
  }) as unknown as RuntimeEvent;

test("the same event in both stores folds ONCE", () => {
  // The add is written to both (T-21: otherwise later sessions are blind to
  // it). Two copies of one event are one event.
  const merged = mergeGovernanceEvents([add("a")], [add("a")]);
  expect(merged).toHaveLength(1);
  expect((merged[0] as { id: string }).id).toBe("a");
});

test("a removal in the instance store beats the session's duplicate add", () => {
  // THE BUG: the concatenation put the session's copy of the add last, so the
  // fold saw add → removed → add and the rule came back from the dead.
  const merged = mergeGovernanceEvents(
    [add("a"), removed("r", "P-AGENT-x")],
    [add("a")],
  );
  expect(merged.map((e) => e.type)).toEqual([
    "constitution.rule_added",
    "constitution.rule_removed",
  ]);
});

test("a removal that lives ONLY in the session still beats the add", () => {
  // The mirror is new; a rule deleted before it exists has its tombstone in
  // one place only. Law 2 puts the session's contribution after the
  // instance's, so the removal lands after the add either way.
  const merged = mergeGovernanceEvents(
    [add("a")],
    [add("a"), removed("r", "P-AGENT-x")],
  );
  expect(merged.map((e) => e.type)).toEqual([
    "constitution.rule_added",
    "constitution.rule_removed",
  ]);
});

test("a session-only event is kept, in the session's own order", () => {
  // The instance store is authoritative but not complete: a session's own
  // recent events are not in it yet.
  const merged = mergeGovernanceEvents(
    [add("a")],
    [add("a"), removed("r", "P-AGENT-x"), add("b")],
  );
  expect(merged.map((e) => (e as { id: string }).id)).toEqual(["a", "r", "b"]);
});

test("no reader hand-rolls the concatenation any more", () => {
  // The merge owns the knowledge; a reader that concatenates by hand is a
  // reader that has not read it — and the next one written would resurrect a
  // deleted rule exactly the way this one did.
  // The repo root is four levels up from this test file.
  const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
  const roots = [join(repoRoot, "packages"), join(repoRoot, "apps")];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist") continue;
      const path = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(path);
      // The merge's own module quotes the old pattern in its doc comment on
      // purpose (it is what this file exists to replace), so it is excluded —
      // otherwise the guard reads a comment instead of the code.
      else if (
        entry.endsWith(".ts") &&
        !entry.endsWith(".test.ts") &&
        entry !== "merge.ts"
      )
        if (readFileSync(path, "utf8").includes("...instance.events, ..."))
          offenders.push(path);
    }
  };
  for (const root of roots) walk(root);
  expect(offenders).toEqual([]);
});
