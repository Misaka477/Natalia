/**
 * Model-facing journal record tools — runtime/record-tools.ts.
 *
 * EI §8.4: thin model-facing wrappers around the existing intelligence
 * surface writes (`record_decision`, `record_validation`, `record_completion`).
 * They exist so the model can put durable facts into the journal through the
 * same pure builders the surfaces use — the event vocabulary stays the
 * journal-face one and no prompt ever carries the正文.
 */
import { genericToolCard, type ToolOutputDefinition } from "@anthelia/tools";
import {
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
import { join } from "node:path";
import { requestAuditAfterCompletion } from "@natalia/engineering-intelligence";
import type {
  GovernanceLedgerController,
  WorkLedgerController,
} from "@natalia/collab";
import { redactToolOutput } from "@natalia/engineering-intelligence";
import { runValidationCommand } from "@natalia/engineering-intelligence";
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
    description:
      "Run a validation command (test runner, typechecker, linter) in the workspace and record the result as durable evidence. Use it after implementing a step so the work has evidence, not claims. Returns passed/failed, a bounded safe summary, and the evidenceID — pass that evidenceID to record_completion's evidenceIDs so the completion card is judge-able. The command runs with the same approval boundary as run_shell.",
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
    output: evidenceRecordCard({
      family: "evidence",
      callSummary: "validate",
      titleKey: "taskID",
    }),
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
      // The evidence identity is minted BEFORE the run and returned with the
      // result: `record_completion`'s evidenceIDs ask for exactly this string,
      // and a validation whose id the caller cannot learn leaves the
      // completion card permanently judgeable:false / missing
      // validation:test (T-02).
      const evidenceID = `evidence:${Date.now().toString(36)}:${ctx.ports.nextEvidenceSequence()}`;
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
      const satisfies = validationClassesFor(args.command, result === "passed");
      return JSON.stringify({
        recorded: true,
        evidenceID,
        taskID: args.taskID.trim(),
        result,
        safeSummary: outcome.safeSummary,
        satisfies,
        ...(artifactRef ? { artifactRef } : {}),
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
    output: evidenceRecordCard({
      family: "completion",
      callSummary: "record",
      titleKey: "taskID",
    }),
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
      }> = [];
      for (const evidenceID of args.evidenceIDs ?? []) {
        const record = evidenceRecords.find((entry) => entry.id === evidenceID);
        if (!record) {
          citedResolved.push({
            evidenceID,
            resolved: "unknown-id",
            satisfies: [],
          });
          continue;
        }
        if (record.status !== "validated" || !record.validations?.length) {
          citedResolved.push({
            evidenceID,
            resolved: "not-a-validation",
            satisfies: [],
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
        });
      }
      const card = requireWorkLedger(ctx)!.evaluateCompletionCard({
        objective: args.objective.trim(),
        ...(args.changePaths?.length ? { changes: args.changePaths } : {}),
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
        return `${card.note} Requirements still open: ${card.missing.join(", ")}.${detail ? ` Cited evidence: ${detail}.` : ""} The completion changed no files, so the requirement comes from the objective's task kind, not from a path class.`;
      })();
      return JSON.stringify({
        recorded: true,
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
