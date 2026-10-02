import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { countFullContentReads } from "../src/full-events-reads";
import { findFullReadInventoryViolations } from "../src/full-events-inventory";

/**
 * The study's acceptance #1, asserted four ways: the REAL tree matches
 * its inventory exactly (the table IS the truth); the counter's
 * taxonomy holds on synthetic lines; and every branch of the walker —
 * unclassified read, count drift, a count that fell to zero, vanished
 * source, clean — fires or stays silent exactly as the acceptance
 * demands.
 */

test("the repository matches its full-read inventory exactly", async () => {
  const root = resolve(import.meta.dir, "..", "..", "..", "..");
  const failures = await findFullReadInventoryViolations(root);
  expect(failures).toEqual([]);
});

test("the counter counts content reads and only content reads", () => {
  const counted = [
    "projectedDriftFindings(exec.session.events)", // argument-pass
    "const x = projectedX(owner.session.events)", // the owner alias
    "if (exec.session.events.some((e) => e.type === t))", // predicate
    "for (const event of exec.session.events) {}", // iteration
    "const first = exec.session.events[0];", // index
    "return [...exec.session.events];", // spread
    "const tail = exec.session.events.filter((e) => e.seq > n);", // filter
    // the alias spellings the live array takes in the tree: an identifier
    // alias (boundary's `target`), a Session-suffixed local (chat-prompt's
    // `chatSession`), optional chaining on the seam.
    "const rules = projectedX(target.session.events);",
    "const m = helpers(exec, chatSession.events);",
    "const n = projectedX(exec?.session.events);",
  ];
  for (const line of counted) expect(countFullContentReads(line)).toBe(1);
  expect(countFullContentReads(counted.join("\n"))).toBe(counted.length);

  const notCounted = [
    "const n = exec.session.events.length;", // metadata
    "exec.session.events = replacement;", // assignment to the array
    "const view = exec.session.events ?? [];", // empty-default reference
    "// projectedX(exec.session.events) in a comment", // comment line
    " * projectedX(exec.session.events) in a doc block", // doc line
    // the trailing-comment heuristic: the only mention lives in the
    // comment, the real read is metadata — the count stays put
    "const n = exec.session.events.length; // projectedX(exec.session.events)",
    // the belt spelling behind an empty default is not a content read
    "const belt = projectedX(exec?.session.events ?? []);",
    // the bare form is deliberately unmatched (SessionRecord params read
    // it legitimately); the live array keeps a spelling with `session` in it
    "const param = projectedX(session.events);",
  ];
  for (const line of notCounted) expect(countFullContentReads(line)).toBe(0);
});

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tmpTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "frei-"));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}

const READ = "const findings = projectedDriftFindings(exec.session.events);";

test("a read with no inventory entry is named and classified", async () => {
  const dir = tmpTree({ "packages/a/src/x.ts": READ });
  const failures = await findFullReadInventoryViolations(dir, {});
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("packages/a/src/x.ts");
  expect(failures[0]).toContain("classify it");
});

test("a count that moved is named with its remedy", async () => {
  const dir = tmpTree({ "packages/a/src/x.ts": READ });
  const failures = await findFullReadInventoryViolations(dir, {
    "packages/a/src/x.ts": {
      count: 5,
      cls: "state-first",
      note: "was five, now one",
    },
  });
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("inventory says 5");
});

test("a read matching its entry is silent", async () => {
  const dir = tmpTree({ "packages/a/src/x.ts": READ });
  const failures = await findFullReadInventoryViolations(dir, {
    "packages/a/src/x.ts": { count: 1, cls: "state-first", note: "as counted" },
  });
  expect(failures).toEqual([]);
});

test("an entry whose file no longer reads the array is red too", async () => {
  // The table tracks reality in both directions: a file that stopped
  // reading moved the surface as much as one that started.
  const dir = tmpTree({ "packages/a/src/x.ts": "export const clean = 1;" });
  const failures = await findFullReadInventoryViolations(dir, {
    "packages/a/src/x.ts": { count: 1, cls: "state-first", note: "was read" },
  });
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("0 content read(s), inventory says 1");
});

test("an entry with no source is named for pruning", async () => {
  const dir = tmpTree({ "packages/a/src/x.ts": "export const clean = 1;" });
  const failures = await findFullReadInventoryViolations(dir, {
    "packages/gone/src/y.ts": {
      count: 1,
      cls: "fold-direct",
      note: "its source was deleted",
    },
  });
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("packages/gone/src/y.ts");
  expect(failures[0]).toContain("prune the entry");
});
