import { expect, test } from "bun:test";
import {
  boundVerboseOutput,
  VERBOSE_OUTPUT_MAX_CHARS,
} from "../src/format-output";

test("a log that fits is returned whole", () => {
  expect(boundVerboseOutput(["a", "b", "c"], 100)).toBe("a\nb\nc");
});

test("an oversized log keeps the tail and says how much was dropped", () => {
  // The tail is what the parent acts on, and hiding the drop would make a
  // truncated log read as a subagent that finished early.
  const bounded = boundVerboseOutput(["old-1", "old-2", "new-1", "new-2"], 14);

  expect(bounded).toContain("new-1");
  expect(bounded).toContain("new-2");
  expect(bounded).not.toContain("old-1");
  expect(bounded).toContain("2 earlier steps omitted, 4 total");
});

test("the drop note is singular for one omitted step", () => {
  // A budget that fits only the newest line, so exactly one is dropped.
  expect(boundVerboseOutput(["a", "b"], 2)).toContain("1 earlier step omitted");
});

test("a budget of zero or less disables the bound", () => {
  // The escape hatch, matching how `0` means unlimited elsewhere in the repo.
  expect(boundVerboseOutput(["a", "b"], 0)).toBe("a\nb");
  expect(boundVerboseOutput(["a", "b"], -1)).toBe("a\nb");
});

test("at least the newest line is always kept, even alone over budget", () => {
  // A bound that could return nothing would hide the subagent's final answer,
  // which is the one line the parent needs.
  expect(boundVerboseOutput(["tiny", "x".repeat(500)], 10)).toContain(
    "x".repeat(500),
  );
});

test("the bound does not grow with the input", () => {
  // The property that matters: a subagent with more history must not hand the
  // parent a proportionally larger log.
  const few = boundVerboseOutput(
    ["y".repeat(50), "z"],
    VERBOSE_OUTPUT_MAX_CHARS,
  );
  const many = boundVerboseOutput(
    Array.from({ length: 400 }, () => "y".repeat(200)),
    VERBOSE_OUTPUT_MAX_CHARS,
  );

  expect(many.length).toBeLessThan(VERBOSE_OUTPUT_MAX_CHARS + 200);
  expect(few.length).toBeLessThan(many.length);
});
