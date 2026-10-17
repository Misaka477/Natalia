/**
 * Model-facing journal record tools — runtime/record-tools.ts.
 *
 * EI §8.4: thin model-facing wrappers around the existing intelligence
 * surface writes (`record_decision`, `record_validation`, `record_completion`).
 * They exist so the model can put durable facts into the journal through the
 * same pure builders the surfaces use — the event vocabulary stays the
 * journal-face one and no prompt ever carries the正文.
 */
import { optionalString, type ToolOutputDefinition } from "@anthelia/tools";
import {
  resolveValidationClasses,
  validationClassesFor,
  workLedgerController,
} from "@natalia/work-ledger";
import { governanceLedgerController } from "@natalia/governance-ledger";
import {
  sessionFactDriftFindings,
  sessionFactEvidenceRecords,
  projectedDriftFindings,
} from "@anthelia/session";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { requestAuditAfterCompletion } from "@natalia/engineering-intelligence";
import type {
  GovernanceLedgerController,
  WorkLedgerController,
} from "@natalia/collab";
import { redactToolOutput } from "@natalia/engineering-intelligence";
// The budget constants live with the runner, so the tool and the
// runtime-recorded path cannot disagree about a default.
import {
  DEFAULT_VALIDATION_TIMEOUT_SEC,
  MAX_VALIDATION_TIMEOUT_SEC,
  runValidationCommand,
  validationRunToJUnitXml,
  type ValidationOutcome,
} from "@natalia/engineering-intelligence";
import { captureRepositoryEvidenceFields } from "@anthelia/substrate";
import { ensureCompleteSessionFactState } from "@anthelia/substrate";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";

function resolveExec(
  ctx: RuntimeContext,
  sessionID?: string,
): SessionExecutionState | undefined {
  const exec = sessionID
    ? ctx.ports
        .getExecutionBySession()
        .get(sessionID as import("@anthelia/contracts").SessionID)
    : undefined;
  return exec ?? ctx.ports.getActiveExec();
}

function requireWorkLedger(
  ctx: RuntimeContext,
): import("@natalia/collab").WorkLedgerController | undefined {
  return ctx.state.serviceDirectory.getOptional(
    workLedgerController,
  ) as unknown as import("@natalia/collab").WorkLedgerController | undefined;
}

function requireGovernanceLedger(
  ctx: RuntimeContext,
): GovernanceLedgerController | undefined {
  return ctx.state.serviceDirectory.getOptional(governanceLedgerController);
}

/**
 * `record_validation` — runs a validation command in the workspace and writes
 * an `evidence.recorded` event (EI §3.5: validation is a first-class, cheap,
 * recordable action; evidence is how a claim earns judge-ability).
 */
export function createRecordValidationTool(
  ctx: RuntimeContext,
): import("@anthelia/tools").RuntimeTool {
  return {
    name: "record_validation",
    // Declared as a PAIR so the runtime's own deadline guard reads them
    // (`timeoutSec` alone would be taken as a fixed budget the model cannot
    // move). The command runs under the shell seam, which terminates the whole
    // process tree at this budget.
    timeoutSec: DEFAULT_VALIDATION_TIMEOUT_SEC,
    maxTimeoutSec: MAX_VALIDATION_TIMEOUT_SEC,
    parameters: {
      type: "object",
      properties: {
        taskID: {
          type: "string",
          description: "The task or plan step this validation covers.",
        },
        objective: {
          type: "string",
          description: "What the validation is meant to establish.",
        },
        command: {
          type: "string",
          description:
            "The command to run in the workspace (for example `bun test packages/framework/runtime`).",
        },
        timeoutSec: {
          type: "number",
          description: `Optional budget in seconds for this run. Defaults to ${DEFAULT_VALIDATION_TIMEOUT_SEC}; values above ${MAX_VALIDATION_TIMEOUT_SEC} are clamped. A run killed at its budget is recorded timed_out — never passed.`,
        },
        assayRole: {
          type: "string",
          enum: ["self-reported", "authoritative"],
          description:
            "Who is running this check. `authoritative` means an independent re-run on the submitted tree — use re_assay for that; `self-reported` means the author checking its own work. Defaults to authoritative when the caller is the main agent.",
        },
        covers: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "validation:any",
              "validation:install",
              "validation:typecheck",
              "validation:test",
              "validation:parser",
            ],
          },
          description:
            "What this run establishes, when the command name does not say it (for example a project whose tests run `make check`). The platform cross-checks a declaration against a command it recognises and refuses a contradiction; an unrecognised command is accepted as declared.",
        },
        knownGaps: {
          type: "array",
          items: { type: "string" },
          description: "Known gaps or caveats about this validation.",
        },
      },
      required: ["taskID", "objective", "command"],
      additionalProperties: false,
    },
    description:
      "Run a validation command (test runner, typechecker, linter) in the workspace and record the result as durable evidence. Use it after implementing a step so the work has evidence, not claims. Returns passed/failed, a bounded safe summary, and the evidenceID — pass that evidenceID to record_completion's evidenceIDs so the completion card is judge-able. The command runs with the same approval boundary as run_shell.",
    requiresApproval: true,
    output: validationRunCard(),
    async execute(parsed, context) {
      const args = parsed as {
        taskID?: string;
        objective?: string;
        command?: string;
        timeoutSec?: number;
        covers?: string[];
        assayRole?: "self-reported" | "authoritative";
        knownGaps?: string[];
      };
      const exec = resolveExec(ctx, context.sessionID);
      const ledger = requireGovernanceLedger(ctx);
      if (!exec) return "no session";
      if (!ledger) return "governance ledger unavailable";
      if (
        !args.taskID?.trim() ||
        !args.objective?.trim() ||
        !args.command?.trim()
      )
        return "record_validation requires taskID, objective and command";
      const startedAt = performance.now();
      const recordedAt = new Date().toISOString();
      // The evidence identity is minted BEFORE the run and returned with the
      // result: `record_completion`'s evidenceIDs ask for exactly this string,
      // and a validation whose id the caller cannot learn leaves the
      // completion card permanently judgeable:false / missing
      // validation:test (T-02).
      const evidenceID = `evidence:${Date.now().toString(36)}:${ctx.ports.nextEvidenceSequence()}`;
      // The vocabulary the record uses for how the run ended. `timed_out` and
      // `not_run` are first-class: a run killed at its budget established
      // nothing, so it may not be recorded as `failed` (the check ran and said
      // no) — and the old code recorded it as `passed`, because a killed process
      // reports no exit code and `exitCode ?? 0` read that as zero.
      type RunResult = "passed" | "failed" | "timed_out" | "not_run";
      let result: RunResult = "not_run";
      let runOutcome: ValidationOutcome | undefined;
      let runExitCode: number | undefined;
      let safeSummary = "validation command did not run";
      let artifactRef: string | undefined;
      try {
        const run = await runValidationCommand(
          args.command,
          ctx.ports.getWorkspaceRoot(),
          context.timeoutSec ??
            ctx.ports.getTsRuntimeConfig?.()?.runtime.tools
              .validationTimeoutSec ??
            DEFAULT_VALIDATION_TIMEOUT_SEC,
          context.signal,
        );
        runOutcome = run.outcome;
        if (run.exitCode !== undefined) runExitCode = run.exitCode;
        result =
          run.outcome === "exited"
            ? run.exitCode === 0
              ? "passed"
              : "failed"
            : run.outcome === "timed_out"
              ? "timed_out"
              : "not_run";
        safeSummary = run.safeSummary;

        // The artifact is the run's COMPLETE stream, written by the seam as it
        // ran — not a copy of the bounded tail. A copied tail is a file that
        // looks complete and is not, which is the one thing a re-assay cannot
        // recover from.
        if (run.completeOutputPath)
          artifactRef = relative(
            ctx.ports.getWorkspaceRoot(),
            run.completeOutputPath,
          )
            .split(sep)
            .join("/");
        else if (run.artifactText.length > run.safeSummary.length) {
          const name = `validation:${Date.now().toString(36)}:${ctx.ports.nextEvidenceSequence()}`;
          // The name is an ID, not a path component: the colons that
          // separate its parts are legal in a POSIX file name but are
          // RESERVED on Windows, where a colon introduces an alternate
          // data stream and the write fails (measured: ENOENT) — so the
          // artifact was never persisted there and the evidence could
          // never reference it. Everything outside the portable set is
          // folded to an underscore.
          const relative = `.natalia/artifacts/${name.replace(/[^a-zA-Z0-9_-]/gu, "_")}.log`;
          try {
            const absolute = join(ctx.ports.getWorkspaceRoot(), relative);
            await mkdir(
              join(ctx.ports.getWorkspaceRoot(), ".natalia", "artifacts"),
              {
                recursive: true,
              },
            );
            await writeFile(absolute, run.artifactText, "utf8");
            artifactRef = relative;
          } catch {
            // A failed artifact write must not fail the validation record.
            artifactRef = undefined;
          }
        }
      } catch (error) {
        safeSummary = `validation runner failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      // The run also leaves the format CI already parses, beside its artifact: a
      // reader outside this product should not need our vocabulary, and a
      // re-assay can diff two documents. `timed_out` maps to <error> there, so a
      // slow suite never exports as a red one.
      let junitRef: string | undefined;
      if (runOutcome) {
        try {
          const xml = validationRunToJUnitXml({
            suite: args.taskID.trim(),
            cases: [
              {
                name: args.command.trim(),
                outcome: runOutcome,
                ...(runExitCode === undefined ? {} : { exitCode: runExitCode }),
                durationMs: Math.round(performance.now() - startedAt),
                summary: safeSummary,
              },
            ],
          });
          const relativeJunit = `.natalia/artifacts/${`junit_${Date.now().toString(36)}_${ctx.ports.nextEvidenceSequence()}`.replace(/[^a-zA-Z0-9_-]/gu, "_")}.xml`;
          await mkdir(
            join(ctx.ports.getWorkspaceRoot(), ".natalia", "artifacts"),
            {
              recursive: true,
            },
          );
          await writeFile(
            join(ctx.ports.getWorkspaceRoot(), relativeJunit),
            xml,
            "utf8",
          );
          junitRef = relativeJunit;
        } catch {
          // An export that cannot be written must not fail the validation record.
          junitRef = undefined;
        }
      }
      // Who is speaking, recorded rather than assumed: a green from the author is
      // a statement about intent, a green from an independent re-run is a
      // measurement, and an auditor must be able to tell them apart.
      const assayRole: "self-reported" | "authoritative" =
        args.assayRole === "self-reported" ? "self-reported" : "authoritative";
      const outcome = ledger.boundValidationOutcome({
        command: redactToolOutput(args.command, true),
        result,
        safeSummary,
        ...(artifactRef ? { artifactRef } : {}),
        ...(assayRole ? { assayRole } : {}),
        durationMs: performance.now() - startedAt,
      });
      const repoRefs = await captureRepositoryEvidenceFields(
        ctx.ports.getWorkspaceRoot(),
      );
      ctx.ports.publishForSession(
        exec,
        ledger.buildEvidenceRecorded({
          id: evidenceID,
          taskID: args.taskID.trim(),
          objective: args.objective.trim(),
          status: result === "passed" ? "validated" : "failed",
          validations: [outcome],
          ...(args.knownGaps ? { knownGaps: args.knownGaps } : {}),
          recordedAt,
          environment: `${process.platform}/${process.arch}`,
          ...repoRefs,
        }),
      );
      // The work-graph node the evidence never had (the 2026-10-07 gap
      // pass): evidence lived only as a governance-ledger record, so
      // work_graph_query could not reach it. The schema's `validation`
      // kind IS this fact; the turn's agent-action node is its parent, so
      // the traversal from the action reaches the evidence.
      const workLedger = requireWorkLedger(ctx);
      if (workLedger) {
        ctx.ports.publishForSession(
          exec,
          workLedger.validationNode({
            evidenceID,
            objective: args.objective.trim(),
            sessionID: exec.session.id,
            taskID: args.taskID.trim(),
            ...(exec.activeTurnID ? { turnID: exec.activeTurnID } : {}),
          }),
        );
        if (exec.activeTurnID)
          ctx.ports.publishForSession(
            exec,
            workLedger.validationCausedEdge({
              evidenceID,
              turnID: exec.activeTurnID,
            }),
          );
      }
      // The classes citing this evidence satisfies (the user's 2026-10-07
      // ask): a completion card resolves cited evidenceIDs into evidence
      // classes, and the caller could not tell what its validation bought
      // until the card came back `missing` with no explanation. Now the
      // record says which classes it carries.
      const resolved = resolveValidationClasses({
        command: args.command,
        passed: result === "passed",
        ...(args.covers ? { declared: args.covers } : {}),
      });
      const satisfies = resolved.classes;
      return JSON.stringify({
        recorded: true,
        evidenceID,
        taskID: args.taskID.trim(),
        result,
        safeSummary: outcome.safeSummary,
        satisfies,
        // WHO decided the classes: a run classified only by its own command text
        // is a guess about a name, not a statement about intent.
        satisfiesSource: resolved.source,
        assayRole,
        ...(resolved.refused ? { satisfiesRefused: resolved.refused } : {}),
        durationMs: Math.round(performance.now() - startedAt),
        ...(artifactRef ? { artifactRef } : {}),
        ...(junitRef ? { junitRef } : {}),
      });
    },
  };
}

/**
 * `record_completion` — writes the completion card (EI P2 E4): the fixed
 * report structure that answers "is it really done, what evidence is
 * missing". Safe prose only — never a diff or file content.
 */
/** Whether a re-run changes what the record claimed. Pure, so it is testable. */
export function reAssayVerdict(
  before: string | undefined,
  after: "passed" | "failed" | "timed_out" | "not_run",
): { changed: boolean; note: string } {
  if (before === after)
    return { changed: false, note: `the verdict still holds: ${after}` };
  if (before === undefined)
    return {
      changed: false,
      note: `no previous verdict; this run says ${after}`,
    };
  return {
    changed: true,
    note: `the verdict changed: ${before} then ${after}`,
  };
}

/**
 * `re_assay` — run a recorded validation again and report whether its verdict
 * still holds.
 *
 * This is the entry point behind the first ruler: evidence that cannot be
 * re-run is a claim. The record already carries what is needed — the command,
 * the verdict, the duration and (since the seam spills) the complete output — so
 * re-running it is the one operation that turns "we ran a check once" into "this
 * is checkable by anyone".
 */
export function createReAssayTool(
  ctx: RuntimeContext,
): import("@anthelia/tools").RuntimeTool {
  return {
    name: "re_assay",
    description:
      "Run a recorded validation again and report whether its verdict still holds. Use it when a green is being relied on later — after a rebase, after an environment change, or when a completion cites an old evidenceID. Returns the command, the previous verdict, the new verdict, whether they differ, and the new bounded summary.",
    requiresApproval: true,
    timeoutSec: DEFAULT_VALIDATION_TIMEOUT_SEC,
    maxTimeoutSec: MAX_VALIDATION_TIMEOUT_SEC,
    parameters: {
      type: "object",
      properties: {
        evidenceID: {
          type: "string",
          description:
            "The evidenceID a previous record_validation returned (also the id a completion cites).",
        },
        timeoutSec: {
          type: "number",
          description: `Optional budget in seconds for this re-run. Defaults to ${DEFAULT_VALIDATION_TIMEOUT_SEC}; values above ${MAX_VALIDATION_TIMEOUT_SEC} are clamped.`,
        },
      },
      required: ["evidenceID"],
      additionalProperties: false,
    },
    output: validationRunCard(),
    async execute(parsed, context) {
      const args = parsed as { evidenceID?: string; timeoutSec?: number };
      const exec = resolveExec(ctx, context.sessionID);
      if (!exec) return "no session";
      if (!args.evidenceID?.trim())
        return "re_assay requires the evidenceID a validation returned";
      await ensureCompleteSessionFactState(ctx, exec);
      const records = exec.factState
        ? sessionFactEvidenceRecords(exec.factState)
        : [];
      const record = records.find((entry) => entry.id === args.evidenceID);
      if (!record)
        return `no evidence record ${args.evidenceID} in this session; re-run the check with record_validation instead`;
      const original = record.validations?.[0];
      if (!original)
        return `evidence ${args.evidenceID} carries no validation command to re-run`;
      const startedAt = performance.now();
      const run = await runValidationCommand(
        original.command,
        ctx.ports.getWorkspaceRoot(),
        context.timeoutSec ??
          ctx.ports.getTsRuntimeConfig?.()?.runtime.tools
            .validationTimeoutSec ??
          DEFAULT_VALIDATION_TIMEOUT_SEC,
        context.signal,
      );
      const after: "passed" | "failed" | "timed_out" | "not_run" =
        run.outcome === "exited"
          ? run.exitCode === 0
            ? "passed"
            : "failed"
          : run.outcome === "timed_out"
            ? "timed_out"
            : "not_run";
      const verdict = reAssayVerdict(original.result, after);
      return JSON.stringify({
        evidenceID: record.id,
        command: original.command,
        before: original.result,
        after,
        ...verdict,
        durationMs: Math.round(performance.now() - startedAt),
        safeSummary: run.safeSummary,
        ...(run.completeOutputPath
          ? {
              completeOutputPath: relative(
                ctx.ports.getWorkspaceRoot(),
                run.completeOutputPath,
              )
                .split(sep)
                .join("/"),
            }
          : {}),
      });
    },
  };
}

export function createRecordCompletionTool(
  ctx: RuntimeContext,
): import("@anthelia/tools").RuntimeTool {
  return {
    name: "record_completion",
    description:
      "Record a completion card for a finished task: what changed (a summary, never a diff), behavior impact, the validations that back it, known gaps, rollback state, and the evidence IDs it relies on. Use it when a task is done and the claim needs a judge-able record.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        taskID: { type: "string" },
        objective: { type: "string" },
        changeSummary: {
          type: "string",
          description:
            "A summary of what changed (never a diff or file content).",
        },
        behaviorImpact: { type: "string" },
        validations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              command: { type: "string" },
              result: {
                type: "string",
                enum: ["passed", "failed", "skipped"],
              },
              safeSummary: { type: "string" },
            },
            required: ["command", "result", "safeSummary"],
            additionalProperties: false,
          },
        },
        humanValidation: { type: "string" },
        knownGaps: { type: "array", items: { type: "string" } },
        externalSideEffects: { type: "array", items: { type: "string" } },
        rollbackState: {
          type: "string",
          enum: ["clean", "available", "none", "needs_promotion"],
        },
        evidenceIDs: { type: "array", items: { type: "string" } },
        changePaths: { type: "array", items: { type: "string" } },
        // P1-15: what kind of task this is, declared by the caller. Without
        // it a task that changed no files is classified `code` by default and
        // is then required to show `validation:test` — which a docs, config
        // or dependency task cannot honestly produce, so its completion card
        // came back judgeable:false with no way to say otherwise (the
        // 2026-10-08 audit measured exactly that).
        taskKind: {
          type: "string",
          enum: ["dependency", "parser", "test", "docs", "config", "code"],
          description:
            "What kind of task this was. Omit it and the card classifies from the changed paths, then from the objective's text; declare it when neither says the truth (a task that changed no files, for instance).",
        },
      },
      required: ["taskID", "objective", "changeSummary"],
      additionalProperties: false,
    },
    output: completionVerdictCard(),
    async execute(parsed, context) {
      const args = parsed as {
        taskID?: string;
        objective?: string;
        changeSummary?: string;
        behaviorImpact?: string;
        validations?: Array<{
          command: string;
          result: "passed" | "failed" | "skipped";
          safeSummary: string;
        }>;
        humanValidation?: string;
        knownGaps?: string[];
        externalSideEffects?: string[];
        rollbackState?: "clean" | "available" | "none" | "needs_promotion";
        evidenceIDs?: string[];
        changePaths?: string[];
        taskKind?: string;
      };
      const exec = resolveExec(ctx, context.sessionID);
      const ledger = requireGovernanceLedger(ctx);
      if (!exec) return "no session";
      if (!ledger) return "governance ledger unavailable";
      if (
        !args.taskID?.trim() ||
        !args.objective?.trim() ||
        !args.changeSummary?.trim()
      )
        return "record_completion requires taskID, objective and changeSummary";
      const recordedAt = new Date().toISOString();
      const completionID = `completion:${Date.now().toString(36)}:${ctx.ports.nextCompletionSequence()}`;
      // THE GATE, and its shape is the point: a claim may be unwarranted as long
      // as it SAYS SO. A completion whose evidence matrix is unsatisfied is
      // refused when it also acknowledges nothing — that is the silent claim, the
      // one a reader cannot tell from a verified one. Declaring the gap
      // (`knownGaps`) or a human validation is the honest path and passes.
      //
      // The gate is on the STATEMENT, never on the fact: refusing because a
      // check failed would deadlock a model that cannot fix the check.
      await ensureCompleteSessionFactState(ctx, exec);
      const preflightEvidence = exec.factState
        ? sessionFactEvidenceRecords(exec.factState)
        : [];
      const preflightCard = requireWorkLedger(ctx)!.evaluateCompletionCard({
        objective: args.objective.trim(),
        ...(args.changePaths?.length ? { changes: args.changePaths } : {}),
        ...(args.taskKind
          ? {
              taskKind:
                args.taskKind as import("@natalia/work-ledger").TaskKind,
            }
          : {}),
        evidenceRefs: args.evidenceIDs ?? [],
        resolvedEvidenceClasses: (args.evidenceIDs ?? []).flatMap(
          (evidenceID) => {
            const record = preflightEvidence.find(
              (entry) => entry.id === evidenceID,
            );
            if (
              !record ||
              record.status !== "validated" ||
              !record.validations?.length
            )
              return [];
            return record.validations.flatMap((validation) =>
              validationClassesFor(
                validation.command,
                validation.result === "passed",
              ),
            );
          },
        ),
        validations: args.validations ?? [],
      });
      const acknowledges =
        (args.knownGaps?.length ?? 0) > 0 ||
        Boolean(args.humanValidation?.trim());
      if (preflightCard.missing.length > 0 && !acknowledges)
        return JSON.stringify({
          recorded: false,
          refusal:
            "this completion claims a finished task without the evidence its task kind requires, and says nothing about the gap — that is the one claim a reader cannot tell from a verified one",
          kind: preflightCard.kind,
          classifiedBy: preflightCard.classifiedBy,
          missingEvidence: preflightCard.missing,
          note: preflightCard.note,
          hint: `record the missing validation with record_validation and cite its evidenceID, or declare the gap in knownGaps (or humanValidation) so the claim states what it does not cover`,
        });
      const completionEvent = ledger.buildCompletionRecorded({
        id: completionID,
        taskID: args.taskID.trim(),
        objective: args.objective.trim(),
        changeSummary: redactToolOutput(args.changeSummary, true),
        ...(args.behaviorImpact
          ? { behaviorImpact: redactToolOutput(args.behaviorImpact, true) }
          : {}),
        validations: (args.validations ?? []).map((validation) =>
          ledger.boundValidationOutcome({
            command: redactToolOutput(validation.command, true),
            result: validation.result,
            safeSummary: validation.safeSummary,
          }),
        ),
        ...(args.humanValidation
          ? { humanValidation: redactToolOutput(args.humanValidation, true) }
          : {}),
        ...(args.knownGaps ? { knownGaps: args.knownGaps } : {}),
        ...(args.externalSideEffects
          ? { externalSideEffects: args.externalSideEffects }
          : {}),
        ...(args.rollbackState ? { rollbackState: args.rollbackState } : {}),
        ...(args.evidenceIDs ? { evidenceIDs: args.evidenceIDs } : {}),
        recordedAt,
      });
      ctx.ports.publishForSession(exec, completionEvent);
      // A refused audit is information, not silence: the completion still stands
      // on its own claim, and the caller is told why no reviewer was woken.
      const audit = await requestAuditAfterCompletion(
        ctx,
        exec,
        completionEvent,
      );
      const workLedger = requireWorkLedger(ctx);
      if (workLedger) {
        // E4: the completion is itself a validation-class node; the
        // validated_by edges connect the changed files to it. Without the
        // node first, the edge would point at an absent graph target.
        ctx.ports.publishForSession(
          exec,
          workLedger.completionNode({
            completionID,
            taskID: args.taskID.trim(),
            sessionID: exec.session.id,
            ...(exec.activeTurnID ? { turnID: exec.activeTurnID } : {}),
          }),
        );
        for (const path of args.changePaths ?? [])
          ctx.ports.publishForSession(
            exec,
            workLedger.completionValidationEdge({
              changeID: args.taskID.trim(),
              path,
              completionID,
            }),
          );
      }
      // EI §8.8: the completion card judges the claim against the task-kind
      // evidence matrix — the missing-evidence answer travels back with the
      // record so the model can close the gaps instead of claiming done.
      //
      // The cited evidenceIDs are resolved HERE, against the completed fact
      // fold (state-first: no events read, so the full-read inventory is
      // untouched), into the classes their records' validations satisfy. A
      // cited id that resolves to nothing contributes nothing — the matrix
      // still reports the class missing (T-02).
      await ensureCompleteSessionFactState(ctx, exec);
      const evidenceRecords = exec.factState
        ? sessionFactEvidenceRecords(exec.factState)
        : [];
      const cited = new Set(args.evidenceIDs ?? []);
      const resolvedClasses: string[] = [];
      // What each cited id resolved to, so the missing answer can explain
      // WHY a cited validation does not close the requirement (the user's
      // 2026-10-07 ask: "证据 ID 已指向 passed validation 时，应说明为什么
      // 它不满足要求"). A cited id that resolves to nothing (unknown id,
      // not a validation, not a passed one) is reported as such instead of
      // silently contributing nothing.
      const citedResolved: Array<{
        evidenceID: string;
        resolved: "passed-validation" | "not-a-validation" | "unknown-id";
        satisfies: string[];
        /**
         * True when every validation behind this id was SELF-REPORTED — the
         * author checking its own work. The ruler is recorded, not assumed: a
         * reader weighing this green is told who ran it.
         */
        selfReportedOnly: boolean;
      }> = [];
      for (const evidenceID of args.evidenceIDs ?? []) {
        const record = evidenceRecords.find((entry) => entry.id === evidenceID);
        if (!record) {
          citedResolved.push({
            evidenceID,
            resolved: "unknown-id",
            satisfies: [],
            selfReportedOnly: false,
          });
          continue;
        }
        if (record.status !== "validated" || !record.validations?.length) {
          citedResolved.push({
            evidenceID,
            resolved: "not-a-validation",
            satisfies: [],
            selfReportedOnly: false,
          });
          continue;
        }
        const classes: string[] = [];
        for (const validation of record.validations)
          for (const cls of validationClassesFor(
            validation.command,
            validation.result === "passed",
          ))
            classes.push(cls);
        for (const cls of classes) resolvedClasses.push(cls);
        citedResolved.push({
          evidenceID,
          resolved: "passed-validation",
          satisfies: classes,
          selfReportedOnly: record.validations.every(
            (validation) => validation.assayRole === "self-reported",
          ),
        });
      }
      const card = requireWorkLedger(ctx)!.evaluateCompletionCard({
        objective: args.objective.trim(),
        ...(args.changePaths?.length ? { changes: args.changePaths } : {}),
        // P1-15: the caller's declaration wins over both classifiers.
        ...(args.taskKind
          ? {
              taskKind:
                args.taskKind as import("@natalia/work-ledger").TaskKind,
            }
          : {}),
        evidenceRefs: args.evidenceIDs ?? [],
        resolvedEvidenceClasses: resolvedClasses,
        validations: args.validations ?? [],
      });
      const whyMissing = (() => {
        if (!card.missing.length) return undefined;
        const detail = citedResolved
          .map((entry) =>
            entry.resolved === "passed-validation"
              ? `${entry.evidenceID} satisfies ${entry.satisfies.join(", ") || "nothing"}`
              : entry.resolved === "unknown-id"
                ? `${entry.evidenceID} resolved to nothing (no such evidence record in this session)`
                : `${entry.evidenceID} is not a passed validation record`,
          )
          .join("; ");
        // P1-15: when the caller DECLARED the kind, say so — the requirement
        // is then the caller's own statement, not a guess from the text.
        const declared =
          card.classifiedBy === "declared"
            ? `The completion declared this a ${card.kind} task.`
            : `The completion changed no files, so the requirement comes from the objective's task kind, not from a path class.`;
        return `${card.note} Requirements still open: ${card.missing.join(", ")}.${detail ? ` Cited evidence: ${detail}.` : ""} ${declared}`;
      })();
      return JSON.stringify({
        recorded: true,
        taskID: args.taskID.trim(),
        completionID,
        card,
        ...(args.evidenceIDs?.length
          ? { citedEvidenceResolved: citedResolved }
          : {}),
        ...(card.missing.length
          ? {
              missingEvidence: card.missing,
              whyMissing,
              hint: `${card.note}; record the missing validation with record_validation (then cite its evidenceID) before claiming done`,
            }
          : {}),
        ...(args.evidenceIDs?.length
          ? { citedEvidence: args.evidenceIDs }
          : {}),
        audit,
      });
    },
  };
}

/**
 * `record_decision` — writes a `decision.recorded` event: the durable fact of
 * a choice with its rationale, alternatives and consequences. Safe prose only;
 * never tool output, file content or secrets.
 */
export function createRecordDecisionTool(
  ctx: RuntimeContext,
): import("@anthelia/tools").RuntimeTool {
  return {
    name: "record_decision",
    description:
      "Record a durable engineering decision: the choice, why it was made, what alternatives were rejected and why, and the consequences. Use it when the session made (or should remember) a non-obvious choice — future drift judgment and audits read this record.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        decision: { type: "string" },
        rationale: { type: "array", items: { type: "string" } },
        alternatives: {
          type: "array",
          items: {
            type: "object",
            properties: {
              option: { type: "string" },
              rejectedReason: { type: "string" },
            },
            required: ["option"],
            additionalProperties: false,
          },
        },
        consequences: { type: "array", items: { type: "string" } },
        linkedPlans: { type: "array", items: { type: "string" } },
        linkedConstraints: { type: "array", items: { type: "string" } },
      },
      required: ["decision"],
      additionalProperties: false,
    },
    output: evidenceRecordCard({
      family: "decision",
      callSummary: "record",
      titleKey: "decision",
    }),
    async execute(parsed, context) {
      const args = parsed as {
        decision?: string;
        rationale?: string[];
        alternatives?: { option: string; rejectedReason?: string }[];
        consequences?: string[];
        linkedPlans?: string[];
        linkedConstraints?: string[];
      };
      const exec = resolveExec(ctx, context.sessionID);
      const ledger = requireGovernanceLedger(ctx);
      if (!exec) return "no session";
      if (!ledger) return "governance ledger unavailable";
      if (!args.decision?.trim()) return "record_decision requires decision";
      const decisionEvent = ledger.recordDecision({
        id: `decision:${Date.now().toString(36)}:${ctx.ports.nextDecisionSequence()}`,
        decision: redactToolOutput(args.decision, true),
        ...(args.rationale
          ? {
              rationale: args.rationale.map((entry) =>
                redactToolOutput(entry, true),
              ),
            }
          : {}),
        ...(args.alternatives ? { alternatives: args.alternatives } : {}),
        ...(args.consequences
          ? {
              consequences: args.consequences.map((entry) =>
                redactToolOutput(entry, true),
              ),
            }
          : {}),
        ...(args.linkedPlans ? { linkedPlans: args.linkedPlans } : {}),
        ...(args.linkedConstraints
          ? { linkedConstraints: args.linkedConstraints }
          : {}),
      });
      ctx.ports.publishForSession(exec, decisionEvent);
      // CST4: a decision is a durable node in the Work Graph so
      // `work_graph_query` can answer "why was this chosen" from the
      // decision identity, not only from the journal row.
      const workLedger = requireWorkLedger(ctx);
      if (workLedger && decisionEvent.type === "decision.recorded")
        ctx.ports.publishForSession(
          exec,
          workLedger.decisionNode({
            decisionID: decisionEvent.id,
            decision: decisionEvent.decision,
            sessionID: exec.session.id,
          }),
        );
      return JSON.stringify({ recorded: true });
    },
  };
}

/**
 * `record_validation`'s card — a validation RUN, drawn the way a CI run reads.
 *
 * The command is the object, so it is the title (a `terminal` card, which is
 * also the only kind the kit prefixes with `$`). The state is the result the
 * run reached, the facets are the identities it minted, and the body is the
 * run's own output summary plus what the evidence satisfies.
 *
 * What this replaces: one shared factory whose title was the `taskID` and whose
 * summary was the literal "validate", so the row read
 * `record_validation · task … · fourier-contour-video` with `$ fourier-contour-video`
 * drawn under its own taskID — the command that actually ran appeared nowhere,
 * and the run's output, its duration and its evidence classes were all dropped
 * because the shared meta filter did not name them.
 */
export function validationRunCard(): ToolOutputDefinition {
  const factsOf = (value: string): Record<string, unknown> => {
    try {
      const decoded = JSON.parse(value) as unknown;
      return decoded && typeof decoded === "object" && !Array.isArray(decoded)
        ? (decoded as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };
  const commandOf = (args: unknown): string | undefined =>
    args && typeof args === "object"
      ? (optionalString((args as Record<string, unknown>).command) ?? undefined)
      : undefined;
  return {
    schema: { type: "object", properties: {} },
    presentCall(args) {
      const parsed =
        args && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {};
      return {
        kind: "terminal",
        title: commandOf(args) ?? "validation",
        summary: optionalString(parsed.objective) ?? "validate",
      };
    },
    presentationMeta(_args, value) {
      const facts = factsOf(value);
      const picked: Record<string, unknown> = {};
      for (const key of [
        "result",
        "taskID",
        "evidenceID",
        "durationMs",
        "safeSummary",
        "artifactRef",
        "satisfiesSource",
      ])
        if (facts[key] !== undefined) picked[key] = facts[key];
      if (Array.isArray(facts.satisfies)) picked.satisfies = facts.satisfies;
      return picked;
    },
    presentResult(args, value, meta) {
      const facts = meta ?? factsOf(value);
      const result =
        typeof facts.result === "string" ? facts.result : "recorded";
      const satisfies = Array.isArray(facts.satisfies)
        ? (facts.satisfies as unknown[]).filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [];
      const lines: string[] = [];
      if (typeof facts.safeSummary === "string" && facts.safeSummary)
        lines.push(facts.safeSummary);
      if (satisfies.length > 0)
        lines.push(`satisfies · ${satisfies.join(", ")}`);
      if (typeof facts.artifactRef === "string")
        lines.push(`full output · ${facts.artifactRef}`);
      const facets: Array<[string, string]> = [["result", result]];
      if (typeof facts.taskID === "string") facets.push(["task", facts.taskID]);
      if (typeof facts.evidenceID === "string")
        facets.push(["evidence", facts.evidenceID]);
      if (typeof facts.durationMs === "number")
        facets.push(["took", `${(facts.durationMs / 1000).toFixed(1)}s`]);
      return {
        kind: "terminal",
        title: commandOf(args) ?? "validation",
        summary: result,
        ...(lines.length > 0 ? { body: lines.join("\n") } : {}),
        meta: facets,
      };
    },
  };
}

/**
 * `record_completion`'s card — the VERDICT, not the id.
 *
 * Title is the task, the summary is whether the claim is judge-able (and what
 * is missing when it is not), and the body is the claim itself (objective,
 * change summary, validations, gaps, rollback state) followed by the verdict's
 * own explanation. `judgeable` and `missing` are the whole point of the
 * completion card and this row used to show neither — it showed
 * `completion · completion:mvcd0wau:3` and nothing else, because the shared
 * factory's meta filter never looked inside the `card` the tool returns.
 */
export function completionVerdictCard(): ToolOutputDefinition {
  const argsRecord = (args: unknown): Record<string, unknown> =>
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const factsOf = (value: string): Record<string, unknown> => {
    try {
      const decoded = JSON.parse(value) as unknown;
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
        return {};
      const record = decoded as Record<string, unknown>;
      const card =
        record.card && typeof record.card === "object"
          ? (record.card as Record<string, unknown>)
          : {};
      return {
        ...(record.taskID === undefined ? {} : { taskID: record.taskID }),
        ...(record.completionID === undefined
          ? {}
          : { completionID: record.completionID }),
        ...(card.judgeable === undefined ? {} : { judgeable: card.judgeable }),
        ...(Array.isArray(card.missing) ? { missing: card.missing } : {}),
        ...(typeof card.kind === "string" ? { taskKind: card.kind } : {}),
        ...(typeof record.whyMissing === "string"
          ? { whyMissing: record.whyMissing }
          : {}),
      };
    } catch {
      return {};
    }
  };
  const titleOf = (args: unknown, facts: Record<string, unknown>): string =>
    (typeof facts.taskID === "string" ? facts.taskID : undefined) ??
    optionalString(argsRecord(args).taskID) ??
    "completion";
  return {
    schema: { type: "object", properties: {} },
    presentCall(args) {
      return {
        kind: "generic",
        title: titleOf(args, {}),
        summary: "record completion",
      };
    },
    presentationMeta(_args, value) {
      return factsOf(value);
    },
    presentResult(args, value, meta) {
      const facts = meta ?? factsOf(value);
      const parsed = argsRecord(args);
      const missing = Array.isArray(facts.missing)
        ? (facts.missing as unknown[]).filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [];
      const judgeable = facts.judgeable === true;
      const lines: string[] = [];
      if (typeof parsed.objective === "string" && parsed.objective)
        lines.push(`objective · ${parsed.objective}`);
      if (typeof parsed.changeSummary === "string" && parsed.changeSummary)
        lines.push(`changed · ${parsed.changeSummary}`);
      for (const validation of Array.isArray(parsed.validations)
        ? (parsed.validations as Array<Record<string, unknown>>)
        : []) {
        const command =
          typeof validation.command === "string" ? validation.command : "check";
        const result =
          typeof validation.result === "string" ? validation.result : "unknown";
        lines.push(`validation · ${result} · ${command}`);
      }
      for (const gap of Array.isArray(parsed.knownGaps)
        ? (parsed.knownGaps as unknown[])
        : [])
        if (typeof gap === "string") lines.push(`gap · ${gap}`);
      if (typeof parsed.rollbackState === "string")
        lines.push(`rollback · ${parsed.rollbackState}`);
      if (missing.length > 0)
        lines.push(`missing evidence · ${missing.join(", ")}`);
      if (typeof facts.whyMissing === "string" && facts.whyMissing)
        lines.push(facts.whyMissing);
      if (typeof facts.completionID === "string")
        lines.push(`completion · ${facts.completionID}`);
      const facets: Array<[string, string]> = [
        ["judgeable", judgeable ? "yes" : "no"],
      ];
      if (typeof facts.taskKind === "string")
        facets.push(["kind", facts.taskKind]);
      return {
        kind: "generic",
        title: titleOf(args, facts),
        summary: judgeable
          ? "judgeable"
          : `缺证据 · ${missing.join(", ") || "unclassified"}`,
        ...(lines.length > 0 ? { body: lines.join("\n") } : {}),
        meta: facets,
      };
    },
  };
}

/**
 * The evidence-family card (S3/S4): an evidence record's answer is WHAT was
 * written — the ids it minted and the state it reached — not the raw
 * envelope. One line per fact, the ids as facets.
 */
function evidenceRecordCard(input: {
  family: string;
  callSummary: string;
  titleKey?: string;
}): ToolOutputDefinition {
  return {
    schema: { type: "object", properties: {} },
    presentCall(args) {
      const parsed =
        args && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {};
      const key = input.titleKey ? parsed[input.titleKey] : undefined;
      return {
        kind: "generic",
        title: typeof key === "string" && key ? key : input.family,
        summary: input.callSummary,
      };
    },
    presentationMeta(_args, value) {
      let parsed: Record<string, unknown> = {};
      try {
        const decoded = JSON.parse(value) as unknown;
        if (decoded && typeof decoded === "object" && !Array.isArray(decoded))
          parsed = decoded as Record<string, unknown>;
      } catch {
        // A prose answer carries no facts.
      }
      const facts: Record<string, unknown> = {};
      for (const key of [
        "evidenceID",
        "completionID",
        "taskID",
        "result",
        "satisfies",
        "judgeable",
        "acknowledged",
        "status",
      ]) {
        if (parsed[key] !== undefined) facts[key] = parsed[key];
      }
      return facts;
    },
    presentResult(args, value, meta) {
      const parsed =
        args && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {};
      const key = input.titleKey ? parsed[input.titleKey] : undefined;
      const title = typeof key === "string" && key ? key : input.family;
      const facts = meta ?? {};
      // The reading: the minted identity and the state reached, one per line.
      const lines: string[] = [];
      if (typeof facts.taskID === "string")
        lines.push(`task · ${facts.taskID}`);
      if (typeof facts.evidenceID === "string")
        lines.push(`evidence · ${facts.evidenceID}`);
      if (typeof facts.completionID === "string")
        lines.push(`completion · ${facts.completionID}`);
      if (typeof facts.result === "string")
        lines.push(`result · ${facts.result}`);
      if (typeof facts.satisfies === "string")
        lines.push(`satisfies · ${facts.satisfies}`);
      if (typeof facts.status === "string")
        lines.push(`status · ${facts.status}`);
      const facets: Array<[string, string]> = [];
      if (typeof facts.judgeable === "boolean")
        facets.push(["judgeable", String(facts.judgeable)]);
      if (typeof facts.acknowledged === "boolean")
        facets.push(["acknowledged", String(facts.acknowledged)]);
      return {
        kind: "generic",
        title,
        summary: lines.length > 0 ? lines[0]! : input.callSummary,
        body: lines.length > 0 ? lines.join("\n") : undefined,
        ...(facets.length ? { meta: facets } : {}),
      };
    },
  };
}

/**
 * `drift_acknowledge` — the model's side of the status matrix (EI §8.6): the
 * Main Agent acknowledges an open drift finding with a rationale (explained),
 * disputes it (disputed), or declares a sanctioned detour
 * (detour_declared). Only an open finding can transition; the rationale is
 * safe prose, redacted before the journal.
 */
export function createDriftAcknowledgeTool(
  ctx: RuntimeContext,
): import("@anthelia/tools").RuntimeTool {
  return {
    name: "drift_acknowledge",
    description:
      "Acknowledge an open drift finding: explain it with a rationale (explained), disagree with the finding (disputed), or declare a sanctioned detour the user should know about (detour_declared). Use it when a drift finding fires and you have a real answer — a finding left open keeps escalating.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        findingID: {
          type: "string",
          description: "The exact findingID from the drift finding.",
        },
        status: {
          type: "string",
          enum: ["explained", "disputed", "detour_declared"],
          description:
            "explained: the finding is understood and addressed; disputed: you disagree; detour_declared: a sanctioned detour.",
        },
        rationale: {
          type: "string",
          description: "Why — safe prose, never content or commands.",
        },
      },
      required: ["findingID", "status"],
      additionalProperties: false,
    },
    output: evidenceRecordCard({
      family: "drift",
      callSummary: "acknowledge",
    }),
    async execute(parsed, context) {
      const args = parsed as {
        findingID?: string;
        status?: "explained" | "disputed" | "detour_declared";
        rationale?: string;
      };
      const exec = resolveExec(ctx, context.sessionID);
      if (!exec) return "no session";
      if (!args.findingID?.trim() || !args.status)
        return "drift_acknowledge requires findingID and status";
      const governanceLedger = requireGovernanceLedger(ctx);
      if (!governanceLedger) return "governance ledger unavailable";
      // Only an open finding transitions; the projection is the authority.
      // State-first like every sanctioned reader (the boundary's shape):
      // the completed fact fold answers a fast-attach tail correctly,
      // the resident projection stays the emergency belt.
      const openFindings = (
        exec.factStateComplete === true && exec.factState
          ? sessionFactDriftFindings(exec.factState)
          : projectedDriftFindings(exec.session.events)
      ).filter((finding) => finding.findingID === args.findingID!.trim());
      const finding = openFindings.at(-1);
      if (!finding) return `no open drift finding ${args.findingID}`;
      if (finding.status !== "open")
        return `drift finding ${args.findingID} is ${finding.status}, not open`;
      ctx.ports.publishForSession(
        exec,
        requireWorkLedger(ctx)!.buildDriftFindingUpdate({
          id: `drift:${Date.now().toString(36)}:${args.findingID}`,
          findingID: args.findingID,
          status: args.status,
          rationale: args.rationale,
        }),
      );
      return JSON.stringify({ acknowledged: true, status: args.status });
    },
  };
}
