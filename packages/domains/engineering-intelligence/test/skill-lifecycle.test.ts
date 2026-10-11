import { expect, test } from "bun:test";
import {
  SKILL_COLD_START_MS,
  skillGcReport,
  skillScore,
  type SkillLifecycleEntry,
} from "../src/skill-lifecycle";

/**
 * W6: the catalog's garbage collector. A self-evolving system that can only
 * ADD skills is a system that fills up.
 */

const NOW = 1_800_000_000_000;
const entry = (input: Partial<SkillLifecycleEntry>): SkillLifecycleEntry => ({
  name: "s",
  uses: 0,
  successes: 0,
  bytes: 1_000,
  createdAt: NOW - 30 * 24 * 60 * 60 * 1000,
  ...input,
});

test("a used-and-working skill outranks an unused one; a protected one is never listed", () => {
  const report = skillGcReport(
    [
      entry({
        name: "worker",
        uses: 20,
        successes: 19,
        lastUsedAt: NOW - 1000,
      }),
      entry({
        name: "dead",
        uses: 4,
        successes: 0,
        lastUsedAt: NOW - 20 * 24 * 60 * 60 * 1000,
      }),
      entry({ name: "pinned", uses: 0, protected: true }),
    ],
    NOW,
  );
  expect(report.evict.map((row) => row.name)).toEqual(["dead"]);
  expect(report.keep.find((row) => row.name === "worker")!.reason).toContain(
    "score",
  );
  expect(report.keep.find((row) => row.name === "pinned")!.reason).toBe(
    "protected by the user",
  );
});

test("a new skill is untouchable until it has gathered usage history", () => {
  const report = skillGcReport(
    [
      entry({ name: "fresh", uses: 1, successes: 0, createdAt: NOW - 1000 }),
      entry({ name: "old", uses: 10, successes: 10, lastUsedAt: NOW - 1000 }),
    ],
    NOW,
  );
  expect(report.evict.map((row) => row.name)).not.toContain("fresh");
  expect(report.keep.find((row) => row.name === "fresh")!.reason).toContain(
    "cold-start",
  );
});

test("with no usage facts nothing is evictable — absence of evidence is not evidence", () => {
  // The honest core: this system journals no skill-usage fact, so a gc
  // that cannot see usage refuses to guess rather than deleting on zeros.
  const report = skillGcReport(
    [entry({ name: "a", bytes: 10 }), entry({ name: "b", bytes: 20 })],
    NOW,
  );
  expect(report.evict).toEqual([]);
  expect(report.reclaimableBytes).toBe(0);
  expect(
    report.keep.every((row) => row.reason.includes("no usage facts")),
  ).toBe(true);
});

test("the score rewards success and recency and charges for size", () => {
  const good = skillScore(
    entry({ uses: 10, successes: 10, lastUsedAt: NOW, bytes: 100 }),
    NOW,
    { maxBytes: 100_000 },
  );
  const stale = skillScore(
    entry({
      uses: 10,
      successes: 10,
      lastUsedAt: NOW - 60 * 24 * 60 * 60 * 1000,
      bytes: 100,
    }),
    NOW,
    { maxBytes: 100_000 },
  );
  const heavy = skillScore(
    entry({ uses: 10, successes: 10, lastUsedAt: NOW, bytes: 100_000 }),
    NOW,
    { maxBytes: 100_000 },
  );
  expect(good).toBeGreaterThan(stale);
  expect(good).toBeGreaterThan(heavy);
});

test("the cold-start window is a week", () => {
  expect(SKILL_COLD_START_MS).toBe(7 * 24 * 60 * 60 * 1000);
});
