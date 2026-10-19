/**
 * The assay report: the run page, on a tool row.
 *
 * The user's ruling (2026-10-18): the evidence should read like a CI page, and
 * it belongs on the tool card that already exists where the work happened — not
 * on a new tab. Before this, `assayRunFor`/`assayRuns` projected exactly that
 * shape and nothing read it: the projection existed only inside its own test, so
 * "what did this run establish, and what did it NOT" had no answer a person
 * could see without reading the journal.
 *
 * These tests pin the three things the card owes a reader:
 *   1. a line per check, with verdict, duration and WHO RAN IT (the second
 *      ruler is worthless if the page does not show the roles);
 *   2. what is open, and WHERE THE OPENNESS CAME FROM — the completion's own
 *      card or the project's declared checks — because "nothing is open" is the
 *      sentence a reader most needs to be able to distrust;
 *   3. the comparison with the previous run in words, never a boolean.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRealRuntimeClient } from "../src";
import { assayReportCard } from "../src/runtime/record-tools";
import { createScriptedProvider } from "./e2e-harness";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";
import type { RuntimeEvent } from "@anthelia/contracts";

useWorkspaceCleanup();

const card = assayReportCard();

const runEnvelope = JSON.stringify({
  found: true,
  taskID: "contour-parser",
  objective: "prove the contour parser round-trips",
  warrant: "unwarranted",
  note: "still open: validation:typecheck; declared and not run: bun run typecheck",
  checked: ["validation:any", "validation:test"],
  notChecked: ["validation:typecheck"],
  openSource: "the project's declared checks",
  environments: ["win32/x64"],
  portability: "single environment — portability not established",
  checksChosenBy: "the project's declaration (.natalia/assay.json)",
  totalDurationMs: 1240,
  steps: [
    {
      command: "bun test packages/domains/assay",
      result: "passed",
      role: "self-reported",
      durationMs: 1240,
      summary: "162 pass, 0 fail",
    },
    {
      command: "bun run typecheck",
      result: "not_run",
      summary: "declared by the project, not run in this session",
      declared: true,
    },
  ],
});

test("a run's card names every check, its verdict, its duration and its role", () => {
  const result = card.presentResult?.(
    { taskID: "contour-parser" },
    runEnvelope,
  );
  expect(result?.kind).toBe("generic");
  expect(result?.title).toBe("contour-parser");
  // The whole verdict, in one line: warrant, how many passed, what is open and
  // how much was declared and never run.
  expect(result?.summary).toBe(
    "unwarranted · 1/2 passed · 1 open · 1 declared, not run",
  );
  const body = result?.body ?? "";
  expect(body).toContain("objective · prove the contour parser round-trips");
  // The second ruler, visible: the step that ran says who ran it.
  expect(body).toContain(
    "step · passed · bun test packages/domains/assay · 1.2s · self-reported",
  );
  // The declared-and-not-run check keeps its own line — the grey row of the CI
  // page, with the project's own command in it.
  expect(body).toContain(
    "step · not_run · bun run typecheck · declared, not run",
  );
  // Openness and where it came from.
  expect(body).toContain("checked · validation:any, validation:test");
  expect(body).toContain("open · validation:typecheck");
  expect(body).toContain("open came from · the project's declared checks");
  expect(body).toContain("note · still open: validation:typecheck");
  // WHERE it was measured, HOW FAR that reaches, and WHO chose the checks: the
  // three facts CI's page cannot state (it knows its environment but not that a
  // claim's scope ends there, and it never shows who picked the checks).
  expect(body).toContain("environment · win32/x64");
  expect(body).toContain("portability · single environment");
  expect(body).toContain("checks chosen by · the project's declaration");
});

test("a comparison arrives as a sentence, not a boolean", () => {
  const value = JSON.stringify({
    ...(JSON.parse(runEnvelope) as Record<string, unknown>),
    comparison: {
      comparable: false,
      why: "not comparable: the later run no longer runs bun run typecheck",
    },
  });
  const result = card.presentResult?.({ taskID: "contour-parser" }, value);
  expect(result?.body).toContain(
    "compare · not comparable: the later run no longer runs bun run typecheck",
  );
});

test("a task with no evidence answers with its reason, and the row says so", () => {
  const result = card.presentResult?.(
    { taskID: "never-run" },
    JSON.stringify({
      found: false,
      taskID: "never-run",
      reason: "no evidence recorded for never-run in this session",
    }),
  );
  expect(result?.summary).toBe("no run · nothing recorded for this task");
  expect(result?.title).toBe("never-run");
  expect(result?.body).toContain(
    "reason · no evidence recorded for never-run in this session",
  );
});

test("a declaration that could not be read is shown, never swallowed", () => {
  const value = JSON.stringify({
    ...(JSON.parse(runEnvelope) as Record<string, unknown>),
    declarationError:
      "assay declaration .natalia/assay.json is not valid JSON: Unexpected token",
  });
  const result = card.presentResult?.({ taskID: "contour-parser" }, value);
  expect(result?.body).toContain("declaration · assay declaration");
});

test("the runs list reads like the CI runs page: one line per job, steps under it", () => {
  const single = JSON.parse(runEnvelope) as Record<string, unknown>;
  const value = JSON.stringify({
    total: 2,
    runs: [
      single,
      { ...single, taskID: "docs", warrant: "warranted", notChecked: [] },
    ],
  });
  const result = card.presentResult?.({}, value);
  expect(result?.title).toBe("assay runs");
  expect(result?.summary).toBe("2 tasks · 1 unwarranted · 1 open");
  const body = result?.body ?? "";
  expect(body).toContain("run · contour-parser · unwarranted · 2 steps");
  expect(body).toContain("run · docs · warranted");
});

test("the pending row is the ask; the settled row is the state", () => {
  expect(card.presentCall?.({ taskID: "contour-parser" })).toMatchObject({
    kind: "generic",
    title: "contour-parser",
  });
  expect(card.presentCall?.({})).toMatchObject({ title: "assay" });
});

test("an answer that did not decode still says what was asked for", () => {
  const result = card.presentResult?.(
    { taskID: "contour-parser" },
    "not json at all",
  );
  expect(result?.summary).toBe("the run could not be read");
  expect(result?.body).toContain("asked for · contour-parser");
});

describe("assay_report through the runtime", () => {
  test("the tool answers with the run, its declared gaps and its warrant", async () => {
    useWorkspaceCleanup();
    const root = await officialPluginWorkspace("assay-report");
    // The project's own declaration: two checks, one of which nothing runs.
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, ".natalia", "assay.json"),
      JSON.stringify({
        version: 1,
        checks: [
          {
            id: "always",
            command: "exit 0",
            covers: ["validation:any"],
            note: "a no-op check, so the run page has something real to read",
          },
          {
            id: "types",
            command: "bun run typecheck",
            covers: ["validation:typecheck"],
            note: "the compiler, never run in this session",
          },
        ],
      }),
      "utf8",
    );
    const events: RuntimeEvent[] = [];
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: "ses_assay_report",
      permissionMode: "auto",
      provider: createScriptedProvider({
        main: [
          {
            tool: {
              id: "call_record",
              name: "record_validation",
              arguments: {
                taskID: "assay-report-task",
                objective: "record one real check",
                command: "exit 0",
              },
            },
          },
          {
            tool: {
              id: "call_report",
              name: "assay_report",
              arguments: { taskID: "assay-report-task" },
            },
          },
          { text: "reported" },
        ],
      }),
    });
    client.start((event) => events.push(event));
    await client.submitAndWait!("record the check, then read the run");
    const settled = events.find(
      (event) =>
        event.type === "tool.update" &&
        (event as { callID?: string }).callID === "call_report" &&
        (event as { status?: string }).status === "succeeded",
    ) as { result?: string } | undefined;
    expect(settled).toBeDefined();
    const report = JSON.parse(String(settled!.result)) as {
      found: boolean;
      taskID: string;
      warrant: string;
      checked: string[];
      notChecked: string[];
      steps: Array<{ command: string; result: string; declared?: boolean }>;
      openSource?: string;
      declarationWarnings?: string[];
    };
    expect(report.found).toBe(true);
    expect(report.taskID).toBe("assay-report-task");
    // The recorded check and the declared one that never ran are both on the
    // page, and the one that ran earned its class from its own command text.
    expect(
      report.steps.map((step) => [step.command, step.result, step.declared]),
    ).toEqual([
      ["exit 0", "passed", undefined],
      ["bun run typecheck", "not_run", true],
    ]);
    expect(report.checked).toContain("validation:any");
    expect(report.notChecked).toContain("validation:typecheck");
    // No independent re-run exists, so the warrant is unwarranted — the second
    // ruler applied to the whole run.
    expect(report.warrant).toBe("unwarranted");
    expect(report.openSource).toContain("the project's declared checks");
    // A declaration the platform understood reports no warnings — the key is
    // only present when there is something to warn about.
    expect(report.declarationWarnings ?? []).toEqual([]);
  }, 120_000);
});
