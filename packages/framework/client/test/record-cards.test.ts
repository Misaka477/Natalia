/**
 * The record cards say what happened, not which id was minted.
 *
 * Measured defects these pin (both were the user's own screenshot):
 *
 *  - `record_validation` drew `$ fourier-contour-video` — its `taskID` behind a
 *    shell prompt — while the command it actually ran appeared nowhere; the
 *    run's output summary, its duration and the evidence classes it satisfied
 *    were all dropped because the shared card factory's meta filter did not name
 *    them.
 *  - `record_completion` drew `completion · completion:mvcd0wau:3` and nothing
 *    else: no task, no claim, and — the whole point of the card — no verdict.
 *    `judgeable` and `missing` live inside the `card` object the tool returns,
 *    which the shared factory never looked into.
 */
import { expect, test } from "bun:test";
import {
  completionVerdictCard,
  reAssayVerdict,
  validationRunCard,
} from "../src/runtime/record-tools";

test("a validation run's card is the command, its result and its evidence", () => {
  const card = validationRunCard();
  const call = card.presentCall?.({
    taskID: "fourier-contour-video",
    objective: "prove the contour parser round-trips",
    command: "bun test packages/contour",
  });
  expect(call).toMatchObject({
    kind: "terminal",
    title: "bun test packages/contour",
    summary: "prove the contour parser round-trips",
  });
  const value = JSON.stringify({
    recorded: true,
    evidenceID: "evidence:mvcd5egt:5",
    taskID: "fourier-contour-video",
    result: "passed",
    safeSummary: "42 pass, 0 fail",
    satisfies: ["validation:any", "validation:test"],
    durationMs: 12400,
    artifactRef: ".natalia/artifacts/validation_x.log",
  });
  const meta = card.presentationMeta?.(
    { command: "bun test packages/contour" },
    value,
  );
  const result = card.presentResult?.(
    { command: "bun test packages/contour" },
    value,
    meta,
  );
  expect(result).toMatchObject({ kind: "terminal", summary: "passed" });
  // The command, never the taskID, is the title (and so the `$` line).
  expect(result?.title).toBe("bun test packages/contour");
  expect(result?.meta).toEqual(
    expect.arrayContaining([
      ["result", "passed"],
      ["task", "fourier-contour-video"],
      ["evidence", "evidence:mvcd5egt:5"],
      ["took", "12.4s"],
    ]),
  );
  expect(result?.body).toContain("42 pass, 0 fail");
  expect(result?.body).toContain("satisfies · validation:any, validation:test");
  expect(result?.body).toContain("full output · .natalia/artifacts/");
});

test("a failing validation is a failed run, not a passing one", () => {
  const card = validationRunCard();
  const value = JSON.stringify({
    evidenceID: "evidence:1:1",
    taskID: "t",
    result: "failed",
    safeSummary: "3 fail",
    satisfies: [],
  });
  const result = card.presentResult?.(
    { command: "bun test" },
    value,
    card.presentationMeta?.({ command: "bun test" }, value),
  );
  expect(result?.summary).toBe("failed");
  expect(result?.meta).toContainEqual(["result", "failed"]);
});

test("a completion's card carries the verdict and the claim", () => {
  const card = completionVerdictCard();
  const args = {
    taskID: "fourier-contour-video",
    objective: "ship the contour parser",
    changeSummary: "added the parser and its tests",
    validations: [{ command: "bun test", result: "passed", safeSummary: "ok" }],
    knownGaps: ["no fuzz corpus yet"],
    rollbackState: "clean",
    evidenceIDs: ["evidence:1:1"],
  };
  expect(card.presentCall?.(args)).toMatchObject({
    kind: "generic",
    title: "fourier-contour-video",
  });
  const value = JSON.stringify({
    recorded: true,
    taskID: "fourier-contour-video",
    completionID: "completion:mvcd0wau:3",
    card: {
      kind: "source",
      judgeable: false,
      missing: ["validation:test"],
      note: "the cited evidence satisfies nothing",
    },
    whyMissing: "evidence:1:1 resolved to nothing",
  });
  const meta = card.presentationMeta?.(args, value);
  const result = card.presentResult?.(args, value, meta);
  expect(result?.title).toBe("fourier-contour-video");
  expect(result?.summary).toBe("缺证据 · validation:test");
  expect(result?.meta).toContainEqual(["judgeable", "no"]);
  expect(result?.body).toContain("objective · ship the contour parser");
  expect(result?.body).toContain("changed · added the parser and its tests");
  expect(result?.body).toContain("validation · passed · bun test");
  expect(result?.body).toContain("gap · no fuzz corpus yet");
  expect(result?.body).toContain("rollback · clean");
  expect(result?.body).toContain("missing evidence · validation:test");
  expect(result?.body).toContain("evidence:1:1 resolved to nothing");
  expect(result?.body).toContain("completion · completion:mvcd0wau:3");
});

test("a judge-able completion says so, and an unclassified one says which", () => {
  const card = completionVerdictCard();
  const judgeable = card.presentResult?.(
    { taskID: "t", objective: "o", changeSummary: "c" },
    JSON.stringify({
      taskID: "t",
      completionID: "completion:1:1",
      card: { kind: "docs", judgeable: true, missing: [] },
    }),
    undefined,
  );
  expect(judgeable?.summary).toBe("judgeable");
  expect(judgeable?.meta).toContainEqual(["judgeable", "yes"]);
  // A result with no verdict at all (an old event, a prose answer) must not
  // read as judge-able.
  const unknown = card.presentResult?.(
    { taskID: "t" },
    "no session",
    undefined,
  );
  expect(unknown?.summary).toBe("缺证据 · unclassified");
});

test("a re-assay reports whether the verdict moved, and says which way", () => {
  // The first ruler in code: a green that nobody can re-check is a claim. The
  // comparison is pure, so the wording and the verdict are pinned here rather
  // than inferred from a live run.
  expect(reAssayVerdict("passed", "passed")).toEqual({
    changed: false,
    note: "the verdict still holds: passed",
  });
  expect(reAssayVerdict("passed", "failed")).toEqual({
    changed: true,
    note: "the verdict changed: passed then failed",
  });
  // A record with no previous verdict cannot "change" — it has nothing to differ
  // from, and saying so is the honest answer.
  expect(reAssayVerdict(undefined, "failed")).toEqual({
    changed: false,
    note: "no previous verdict; this run says failed",
  });
  // A timeout is its own verdict, not a flavour of failure.
  expect(reAssayVerdict("passed", "timed_out").changed).toBe(true);
});
