import { expect, test } from "bun:test";
import {
  DEFAULT_SETTLED_NOTICE_BUDGET,
  settledNoticeAllowed,
  settledNoticeEntryID,
  subagentSettledNoticeContent,
} from "../src/runtime/initialize/subagent-settled-notice";

test("the notice is attributed to the runtime, not the subagent", () => {
  const content = subagentSettledNoticeContent({
    agentId: "a1",
    status: "completed",
    continuation: 0,
  });

  // The one distinction that matters: a transcript that merged the two would
  // credit the child with words it never wrote.
  expect(content).toContain('source="subagent_settled"');
  expect(content).toContain('trust="runtime"');
  expect(content).toContain(
    "This is the runtime reporting the outcome, not the subagent's own account",
  );
});

test("the notice states the terminal status and the stop reason when there is one", () => {
  const clean = subagentSettledNoticeContent({
    agentId: "a1",
    status: "completed",
    continuation: 0,
  });
  const stopped = subagentSettledNoticeContent({
    agentId: "a2",
    status: "stopped",
    continuation: 0,
    stopReason: "wall-clock budget of 900000ms exceeded",
  });

  expect(clean).toContain("a1 has finished: completed.");
  expect(stopped).toContain(
    "a2 has finished: stopped (wall-clock budget of 900000ms exceeded).",
  );
});

test("the notice quotes the final result, bounded", () => {
  const short = subagentSettledNoticeContent({
    agentId: "a1",
    status: "completed",
    continuation: 0,
    finalResult: "read two files",
  });
  const longer = subagentSettledNoticeContent({
    agentId: "a1",
    status: "completed",
    continuation: 0,
    finalResult: "x".repeat(9_000),
  });

  expect(short).toContain("Its final result: read two files");
  // Bounded: the quote is capped rather than truncated by whatever the notice
  // happens to fit in, and the notice stops growing once the cap is reached —
  // an unbounded quote would put the subagent's whole transcript into the
  // parent's ledger and blow the prefix it is trying to preserve.
  expect(longer).toContain("Its final result: " + "x".repeat(400) + "…");
  expect(
    subagentSettledNoticeContent({
      agentId: "a1",
      status: "completed",
      continuation: 0,
      finalResult: "x".repeat(90_000),
    }).length,
  ).toBe(longer.length);
});

test("a notice with no final result quotes nothing", () => {
  const content = subagentSettledNoticeContent({
    agentId: "a1",
    status: "failed",
    continuation: 0,
  });

  expect(content).not.toContain("Its final result");
  expect(content).toContain("has finished: failed.");
});

test("the entry id is stable per subagent and continuation", () => {
  // Stable so a re-emitted settle for the same continuation overwrites rather
  // than stacking duplicates in the ledger.
  expect(settledNoticeEntryID("a1", 0)).toBe("subagent_settled:a1:0");
  expect(settledNoticeEntryID("a1", 0)).toBe(settledNoticeEntryID("a1", 0));
  expect(settledNoticeEntryID("a1", 1)).not.toBe(settledNoticeEntryID("a1", 0));
});

test("the budget admits notices until it is spent, then stops", () => {
  expect(settledNoticeAllowed(0, 3)).toBe(true);
  expect(settledNoticeAllowed(2, 3)).toBe(true);
  expect(settledNoticeAllowed(3, 3)).toBe(false);
  expect(settledNoticeAllowed(99, 3)).toBe(false);
});

test("a budget of zero disables the notices entirely", () => {
  expect(settledNoticeAllowed(0, 0)).toBe(false);
});

test("an unbounded budget admits every notice", () => {
  expect(settledNoticeAllowed(0, Infinity)).toBe(true);
  expect(settledNoticeAllowed(10_000, Infinity)).toBe(true);
});

test("the default budget is a real finite number", () => {
  expect(DEFAULT_SETTLED_NOTICE_BUDGET).toBeGreaterThan(0);
  expect(Number.isFinite(DEFAULT_SETTLED_NOTICE_BUDGET)).toBe(true);
});
