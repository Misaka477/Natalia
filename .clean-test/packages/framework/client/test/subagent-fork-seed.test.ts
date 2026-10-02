import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ContextEntry } from "@anthelia/runtime";
import {
  forkSeedEntries,
  isSeedRole,
} from "../src/runtime/initialize/subagent-fork-seed";

function entry(
  id: string,
  role: ContextEntry["role"],
  extra: Partial<ContextEntry> = {},
): ContextEntry {
  return { id, role, content: id, ...extra };
}

const conversation: ContextEntry[] = [
  entry("system", "system"),
  entry("u1", "user"),
  entry("a1", "assistant"),
  entry("c1", "tool_call", { pairID: "p1" }),
  entry("r1", "tool_result", { pairID: "p1" }),
  entry("u2", "user"),
  entry("a2", "assistant"),
  entry("c2", "tool_call", { pairID: "p2" }),
  entry("r2", "tool_result", { pairID: "p2" }),
  entry("u3", "user"),
  entry("a3", "assistant"),
  entry("c3", "tool_call", { pairID: "p3" }),
];

test("the seed is everything before the parent's last user message", () => {
  // The last user message opens the turn the parent may still be inside, so the
  // in-flight work is excluded rather than shown to the child unanswered.
  expect(forkSeedEntries(conversation).map((e) => e.id)).toEqual([
    "fork:u1",
    "fork:a1",
    "fork:c1",
    "fork:r1",
    "fork:u2",
    "fork:a2",
    "fork:c2",
    "fork:r2",
  ]);
});

test("a trailing unpaired tool call is trimmed", () => {
  // Carrying it would ask the child to answer for work it never did.
  const seed = forkSeedEntries(conversation);
  expect(seed.at(-1)!.role).toBe("tool_result");
  expect(seed.some((e) => e.role === "tool_call" && !e.pairID)).toBe(false);
});

test("a leading orphaned tool result is trimmed", () => {
  const orphaned: ContextEntry[] = [
    entry("system", "system"),
    entry("r0", "tool_result", { pairID: "p0" }),
    entry("u1", "user"),
    entry("a1", "assistant"),
    entry("u2", "user"),
  ];

  // A provider rejects a conversation that opens with a tool result.
  expect(forkSeedEntries(orphaned).map((e) => e.id)).toEqual([
    "fork:u1",
    "fork:a1",
  ]);
});

test("the parent's system prompt never reaches the child", () => {
  const seed = forkSeedEntries(conversation);
  expect(seed.some((e) => e.role === "system")).toBe(false);
});

test("runtime notices and resources stay with the parent", () => {
  // What the parent was told is not what the child should be told.
  const withRuntime: ContextEntry[] = [
    entry("system", "system"),
    entry("u1", "user"),
    entry("settled:a1:0", "dynamic"),
    entry("res", "resource", { content: "a resource" }),
    entry("a1", "assistant"),
    entry("u2", "user"),
  ];
  const seed = forkSeedEntries(withRuntime);
  expect(seed.map((e) => e.id)).toEqual(["fork:u1", "fork:a1"]);
});

test("a compaction summary carries into the seed, because it is the history", () => {
  const compacted: ContextEntry[] = [
    entry("system", "system"),
    entry("summary", "summary"),
    entry("u1", "user"),
    entry("a1", "assistant"),
    entry("u2", "user"),
  ];
  expect(forkSeedEntries(compacted).map((e) => e.id)).toEqual([
    "fork:summary",
    "fork:u1",
    "fork:a1",
  ]);
});

test("seeded ids are re-keyed so they cannot collide with the child's own", () => {
  // The ledger rejects a duplicate id, and a fork that failed to seed would
  // silently start the child with nothing.
  const seed = forkSeedEntries(conversation);
  expect(seed.every((e) => e.id.startsWith("fork:"))).toBe(true);
  expect(seed.some((e) => e.id === "system" || e.id === "task")).toBe(false);
});

test("re-keying preserves tool pairing, which keys on pairID", () => {
  const seed = forkSeedEntries(conversation);
  const calls = seed.filter((e) => e.role === "tool_call");
  const results = seed.filter((e) => e.role === "tool_result");
  expect(calls).toHaveLength(2);
  expect(results).toHaveLength(2);
  for (const call of calls)
    expect(results.some((r) => r.pairID === call.pairID)).toBe(true);
});

test("a conversation with no completed turn seeds nothing", () => {
  expect(
    forkSeedEntries([entry("system", "system"), entry("u1", "user")]),
  ).toEqual([]);
  expect(
    forkSeedEntries([entry("system", "system"), entry("a1", "assistant")]),
  ).toEqual([]);
  expect(forkSeedEntries([])).toEqual([]);
});

test("only seed roles carry over", () => {
  expect(isSeedRole("user")).toBe(true);
  expect(isSeedRole("assistant")).toBe(true);
  expect(isSeedRole("tool_call")).toBe(true);
  expect(isSeedRole("tool_result")).toBe(true);
  expect(isSeedRole("summary")).toBe(true);
  expect(isSeedRole("system")).toBe(false);
  expect(isSeedRole("resource")).toBe(false);
  expect(isSeedRole("dynamic")).toBe(false);
});

test("a fork inherits the parent's LEDGER, not its truncated event tail", () => {
  // The gap this closes: a subagent forks from `exec.context.snapshot().entries`
  // — the parent's LIVE ledger — and a fast-attach exec holds only the post-epoch
  // tail in `exec.session.events`. Those are different quantities, and seeding
  // from the wrong one hands the child a conversation that starts mid-air, with
  // a tool result whose call was never carried. The ledger is the right source
  // because it is maintained incrementally as the turn runs and never depends on
  // the durable window.
  const full = [
    { id: "u1", role: "user" as const, content: "first question" },
    { id: "a1", role: "assistant" as const, content: "first answer" },
    { id: "u2", role: "user" as const, content: "second question" },
    { id: "a2", role: "assistant" as const, content: "second answer" },
  ];
  const seed = forkSeedEntries(full);
  // The completed turns, and nothing from the parent's runtime scaffolding.
  expect(seed.map((entry) => entry.id)).toEqual(["fork:u1", "fork:a1"]);
  // The seed's origin is a ledger snapshot, so it does not depend on how much of
  // the durable log the exec happens to be holding: a tail of two events and a
  // full log of the same conversation produce the same seed.
  const tail = full.slice(2);
  const seedFromTail = forkSeedEntries(tail);
  // A tail alone is NOT the whole conversation — the child would see only the
  // middle of it. That is precisely why the runner passes the ledger.
  expect(seedFromTail).not.toEqual(seed);
  expect(seedFromTail).toEqual([]);
});

test("the fork's seed is taken from the parent's ledger, not its event tail", () => {
  // The call site, pinned. A fast-attach exec holds only the post-epoch tail in
  // `exec.session.events`, while `exec.context` is the live ledger — maintained
  // incrementally as the turn runs, and rebuilt on restart from the durable
  // checkpoint plus the full event log. Seeding a fork from the tail instead
  // would hand the child a conversation that starts mid-air, and would do it
  // SILENTLY: the fork would appear to succeed, having inherited nothing.
  const source = readFileSync(
    new URL("../src/runtime/initialize/subagent-runner.ts", import.meta.url),
    "utf8",
  );
  // The seed's origin is the ledger's snapshot — at EVERY fork site, not just the
  // first: a second spawn path reading the tail while the first reads the ledger
  // is the same bug wearing a different line number.
  const sites = source.split("forkSeedEntries(").length - 1;
  expect(sites).toBeGreaterThan(0);
  expect(
    source.split("forkSeedEntries(exec.context.snapshot().entries)").length - 1,
  ).toBe(sites);
  expect(source).not.toContain("forkSeedEntries(exec.session.events");
  // And the ledger is what a restart rebuilds — from the durable checkpoint plus
  // the full log, never from the windowed tail.
  const ensureExecution = readFileSync(
    new URL("../src/runtime/session-execution/index.ts", import.meta.url),
    "utf8",
  );
  expect(ensureExecution).toContain("restoreDurableCheckpoint");
});
