import { expect, test } from "bun:test";
import {
  SUPERSESSION_MARGIN,
  supersessionSuggestion,
} from "../src/supersession";

/**
 * W7: same-domain supersession. The necessity gate only refuses a
 * restatement; this says "better than, same ground" — and it only ever
 * SUGGESTS. A loop that could retire its own skills without a human in the
 * middle would be the failure this design exists to prevent.
 */

const candidate = {
  name: "rollback-verify",
  description: "record the rollback step before running a destructive command",
  holdoutScore: 0.55,
};
const existing = [
  {
    name: "verify-before-destructive",
    description: "verify before running a destructive command",
    holdoutScore: 0.4,
  },
];

test("a same-domain candidate beaten by the margin suggests a replacement", () => {
  const out = supersessionSuggestion({ candidate, existing });
  expect("suggestion" in out).toBe(true);
  if (!("suggestion" in out)) return;
  expect(out.suggestion.replace).toBe("verify-before-destructive");
  expect(out.suggestion.with).toBe("rollback-verify");
  expect(out.suggestion.margin).toBeCloseTo(0.15, 6);
});

test("a different domain does not suggest", () => {
  const out = supersessionSuggestion({
    candidate,
    existing: [
      {
        name: "naming-conventions",
        description: "use lower camel case for local variables in typescript",
        holdoutScore: 0.2,
      },
    ],
  });
  expect("none" in out).toBe(true);
});

test("a margin too small does not suggest", () => {
  const out = supersessionSuggestion({
    candidate,
    existing: [
      { ...existing[0]!, holdoutScore: 0.55 - SUPERSESSION_MARGIN + 0.01 },
    ],
  });
  expect("none" in out).toBe(true);
});

test("a skill with no holdout score has nothing to be beaten on", () => {
  // An unmeasured margin is not a margin.
  const out = supersessionSuggestion({
    candidate,
    existing: [{ ...existing[0]!, holdoutScore: undefined }],
  });
  expect("none" in out).toBe(true);
});
