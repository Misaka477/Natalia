/**
 * Model-facing journal record tools — runtime/record-tools.ts.
 *
 * EI §8.4: thin model-facing wrappers around the existing intelligence
 * surface writes (`record_decision`, `record_validation`, `record_completion`).
 * They exist so the model can put durable facts into the journal through the
 * same pure builders the surfaces use — the event vocabulary stays the
 * journal-face one and no prompt ever carries the正文.
 */
import { workLedgerController } from "@natalia/work-ledger";
import { governanceLedgerController } from "@natalia/governance-ledger";
import {
  sessionFactDriftFindings,
  projectedDriftFindings,
} from "@anthelia/session";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requestAuditAfterCompletion } from "@natalia/engineering-intelligence";
import type {
  GovernanceLedgerController,
  WorkLedgerController,
} from "@natalia/collab";
import { redactToolOutput } from "@natalia/engineering-intelligence";
import { runValidationCommand } from "@natalia/engineering-intelligence";
import { captureRepositoryEvidenceFields } from "@anthelia/substrate";
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
    description:
      "Run a validation command (test runner, typechecker, linter) in the workspace and record the result as durable evidence. Use it after implementing a step so the work has evidence, not claims. Returns passed/failed and a bounded safe summary. The command runs with the same approval boundary as run_shell.",
    requiresApproval: true,
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
        knownGaps: {
          type: "array",
          items: { type: "string" },
          description: "Known gaps or caveats about this validation.",
        },
      },
      required: ["taskID", "objective", "command"],
      additionalProperties: false,
    },
    async execute(parsed, context) {
      const args = parsed as {
        taskID?: string;
        objective?: string;
        command?: string;
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
      let result: "passed" | "failed" | "skipped" = "failed";
      let safeSummary = "validation command did not run";
      let artifactRef: string | undefined;
      try {
        const run = await runValidationCommand(
          args.command,
          ctx.ports.getWorkspaceRoot(),
          120,
        );
        result = run.exitCode === 0 ? "passed" : "failed";
        safeSummary = run.safeSummary;
        // EI E2 artifact refs: a run whose output exceeds the summary is
        // persisted (redacted + bounded) so the evidence can reference it.
        if (run.fullOutput.length > run.safeSummary.length) {
          const name = `validation:${Date.now().toString(36)}:${ctx.ports.nextEvidenceSequence()}`;
          const relative = `.natalia/artifacts/${name.replace(/[^a-zA-Z0-9:_-]/gu, "_")}.log`;
          try {
            const absolute = join(ctx.ports.getWorkspaceRoot(), relative);
            await mkdir(
              join(ctx.ports.getWorkspaceRoot(), ".natalia", "artifacts"),
              {
                recursive: true,
              },
            );
            await writeFile(absolute, run.fullOutput, "utf8");
            artifactRef = relative;
          } catch {
            // A failed artifact write must not fail the validation record.
            artifactRef = undefined;
          }
        }
      } catch (error) {
        safeSummary = `validation runner failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      const outcome = ledger.boundValidationOutcome({
        command: redactToolOutput(args.command, true),
        result,
        safeSummary,
        ...(artifactRef ? { artifactRef } : {}),
        durationMs: performance.now() - startedAt,
      });
      const repoRefs = await captureRepositoryEvidenceFields(
        ctx.ports.getWorkspaceRoot(),
      );
      ctx.ports.publishForSession(
        exec,
        ledger.buildEvidenceRecorded({
          id: `evidence:${Date.now().toString(36)}:${ctx.ports.nextEvidenceSequence()}`,
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
      return JSON.stringify({
        recorded: true,
        result,
        safeSummary: outcome.safeSummary,
      });
    },
  };
}

/**
 * `record_completion` — writes the completion card (EI P2 E4): the fixed
 * report structure that answers "is it really done, what evidence is
 * missing". Safe prose only — never a diff or file content.
 */
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
      },
      required: ["taskID", "objective", "changeSummary"],
      additionalProperties: false,
    },
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
      await requestAuditAfterCompletion(ctx, exec, completionEvent);
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
      const card = requireWorkLedger(ctx)!.evaluateCompletionCard({
        objective: args.objective.trim(),
        ...(args.changePaths?.length ? { changes: args.changePaths } : {}),
        evidenceRefs: args.evidenceIDs ?? [],
        validations: args.validations ?? [],
      });
      return JSON.stringify({
        recorded: true,
        completionID,
        card,
        ...(card.missing.length
          ? {
              missingEvidence: card.missing,
              hint: `${card.note}; record the missing validation with record_validation before claiming done`,
            }
          : {}),
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
