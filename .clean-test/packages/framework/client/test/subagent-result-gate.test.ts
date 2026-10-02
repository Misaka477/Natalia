import { expect, test } from "bun:test";
import { ContextLedger } from "@anthelia/runtime";
import {
  ensureUsableResult,
  resultNeedsExpansion,
  RESULT_TOO_BRIEF_PROMPT,
} from "../src/runtime/initialize/subagent-result-gate";

test("resultNeedsExpansion is exact at the threshold", () => {
  // `>=` not `>`: an answer of exactly the minimum length is acceptable.
  expect(resultNeedsExpansion("x".repeat(199), 200)).toBe(true);
  expect(resultNeedsExpansion("x".repeat(200), 200)).toBe(false);
});

test("resultNeedsExpansion counts trimmed length", () => {
  // Padding is not content.
  expect(resultNeedsExpansion(`\n\n   ${"x".repeat(50)}   \n`, 200)).toBe(true);
});

test("a gate of zero or less is disabled", () => {
  expect(resultNeedsExpansion("Done.", 0)).toBe(false);
  expect(resultNeedsExpansion("Done.", -1)).toBe(false);
});

test("an empty answer is short enough to need expansion", () => {
  // No special case: an empty final answer after real work is as useless as a
  // one-word one.
  expect(resultNeedsExpansion("", 200)).toBe(true);
  expect(resultNeedsExpansion("   \n  ", 200)).toBe(true);
});

test("the gate asks once and keeps the longer answer", async () => {
  const ledger = new ContextLedger();
  let asked: number | undefined;
  const expanded = `Read three files (${"detail ".repeat(40)})and updated two.`;
  const result = await ensureUsableResult({
    ledger,
    setStatus: () => {},
    step: 3,
    output: "Done.",
    minChars: 200,
    runStep: async (step) => {
      asked = step;
      return { output: expanded, calls: [] };
    },
  });

  expect(result).toBe(expanded);
  expect(asked).toBe(4);
});

test("the ask reaches the model as a ledger turn, naming what is missing", async () => {
  const ledger = new ContextLedger();
  await ensureUsableResult({
    ledger,
    setStatus: () => {},
    step: 1,
    output: "ok",
    minChars: 200,
    runStep: async () => ({ output: "a longer answer than before", calls: [] }),
  });

  const entries = ledger.snapshot().entries;
  expect(entries).toHaveLength(1);
  expect(entries[0]!.role).toBe("user");
  expect(entries[0]!.content).toBe(RESULT_TOO_BRIEF_PROMPT);
  // It names the missing detail rather than asking for "more", which a model
  // answers by restating the same sentence at greater length.
  expect(entries[0]!.content).toContain("technical details");
  expect(entries[0]!.content).toContain("findings and analysis");
});

test("a second one-liner is not an improvement, so the original stands", async () => {
  // The replacement has to clear the same bar, not merely beat the original: a
  // padded version of the same nothing would hide the failure instead of
  // reporting it.
  const ledger = new ContextLedger();
  const result = await ensureUsableResult({
    ledger,
    setStatus: () => {},
    step: 1,
    output: "Done.",
    minChars: 200,
    runStep: async () => ({ output: "ok done, slightly longer", calls: [] }),
  });

  expect(result).toBe("Done.");
});

test("the gate asks at most once, however short the follow-up is", async () => {
  // A subagent that answers briefly twice is not going to answer well on the
  // third try, and each turn costs the budget.
  let turns = 0;
  const result = await ensureUsableResult({
    ledger: new ContextLedger(),
    setStatus: () => {},
    step: 1,
    output: "Done.",
    minChars: 200,
    runStep: async () => {
      turns += 1;
      return { output: "still brief", calls: [] };
    },
  });

  expect(turns).toBe(1);
  expect(result).toBe("Done.");
});

test("an answer already long enough is returned untouched, with no extra turn", async () => {
  const ledger = new ContextLedger();
  let turns = 0;
  const output = "x".repeat(500);
  const result = await ensureUsableResult({
    ledger,
    setStatus: () => {},
    step: 1,
    output,
    minChars: 200,
    runStep: async () => {
      turns += 1;
      return { output: "unused", calls: [] };
    },
  });

  expect(result).toBe(output);
  expect(turns).toBe(0);
  expect(ledger.snapshot().entries).toHaveLength(0);
});
