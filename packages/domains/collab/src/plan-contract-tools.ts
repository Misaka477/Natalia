/**
 * Model-facing WorkContract tools — runtime/plan-contract-tools.ts.
 *
 * `plan_propose` is the proposal half of EI §8.4: the model drafts the
 * scope/verification/constraints it extracted from the plan document it just
 * wrote (grounding, not invention), the runtime validates the draft, and the
 * user approves it once through the plan-acceptance gate. The gate is the only
 * user-tier confirmation point that matters for drift: without it, "偏移" has
 * no reference frame.
 *
 * `work_contract_read` is the read half (§8.4): the three-state view (current /
 * draft / none) projected from the journal, plus the stale marker a plan
 * document change raises on an unapproved draft.
 */
import {
  projectedConstitutionRules,
  projectedDriftFindings,
  projectedWorkContracts,
  sessionFactConstitutionRules,
  sessionFactWorkContracts,
} from "@anthelia/session";
import { ensureCompleteSessionFactState } from "@anthelia/substrate";
import { targetDriftAbsorbedByScope } from "@natalia/work-ledger";
import { collabOutput } from "./collab-presenters";
import {
  checkContractAgainstConstitution,
  constitutionDenyAnchoredRules,
} from "./contract-constitution-check";
import {} from "@anthelia/runtime-services";
import { workLedgerController } from "@natalia/work-ledger";
import {
  appendInstanceEvent,
  governanceLedgerController,
  governanceViews,
  resolveGovernanceRoot,
} from "@natalia/governance-ledger";
import { providerModelController } from "@anthelia/provider-model";
import type { RuntimeTool } from "@anthelia/substrate";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import type { ProviderModelController } from "@anthelia/provider-model";
import type { GovernanceLedgerController } from "@natalia/governance-ledger";
import type { WorkLedgerController } from "@natalia/work-ledger";

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
): WorkLedgerController | undefined {
  return ctx.state.serviceDirectory.getOptional(workLedgerController);
}

/**
 * The effective constitution rules for a session (EI Open Question: 契约
 * handoff 撞 constitution). Read from the complete fact state when available
 * so rules added before a fast-attach window are not missed, falling back to
 * the projected hot events.
 */
async function sessionConstitutionRules(
  ctx: RuntimeContext,
  exec: SessionExecutionState,
) {
  await ensureCompleteSessionFactState(ctx, exec);
  return exec.factState
    ? sessionFactConstitutionRules(exec.factState)
    : projectedConstitutionRules(exec.session.events);
}

/**
 * EI §3.4 auto-correction: when a contract revision is accepted (plan_propose
 * or a detour's v+1), any open target_drift finding whose flagged paths are now
 * inside the revised scope loses its premise — the reference frame moved to
 * meet the work, exactly like an approved detour. Close it as `corrected` so it
 * cannot stay open against a scope that now covers it.
 */
function correctAbsorbedDrift(
  ctx: RuntimeContext,
  ledger: WorkLedgerController,
  exec: SessionExecutionState,
  planID: string,
  scope: readonly string[],
) {
  for (const finding of projectedDriftFindings(exec.session.events)) {
    if (finding.status !== "open") continue;
    if (!targetDriftAbsorbedByScope({ finding, planID, scope })) continue;
    ctx.ports.publishForSession(
      exec,
      ledger.buildDriftFindingUpdate({
        id: `drift:corrected:${finding.findingID}`,
        findingID: finding.findingID,
        status: "corrected",
        rationale:
          "the accepted contract revision absorbs this path into its scope",
      }),
    );
  }
}

/**
 * The proposal tool: validate → draft → user gate → accept (EI §8.4).
 *
 * Repeatable: a rejected draft leaves the draft in the journal and returns the
 * rejection as feedback, so the model can re-propose with the user's notes
 * folded in. The acceptance is written once per approval — a plan document
 * change invalidates the *draft* (the projection marks it stale), never a
 * user-approved contract.
 */
export function createPlanProposeTool(
  ctx: RuntimeContext,
  input?: {
    /**
     * What to do once the proposal is accepted. Only a surface that HOLDS
     * `mailbox_send` may name it: the 2026-10-10 sweep found the main agent
     * being told to hand off with a tool it does not have (F6), and Nia's
     * prompt naming five context tools her surface never received. An agent
     * sees its own surface, and nothing else.
     */
    handoff?: string;
  },
): RuntimeTool {
  const handoff =
    input?.handoff ??
    // The default is the surface-agnostic form: the plan is accepted and the
    // runtime routes it. A caller that holds the mailbox tool passes the
    // mailbox sentence instead.
    "When accepted, the runtime routes the accepted plan to Natalia — you are done with this plan.";
  // The accepted answer's hint obeys the same rule as the description.
  const handoffHint =
    input?.handoff === undefined
      ? "the accepted plan is routed to Natalia by the runtime"
      : "hand the plan off with mailbox_send next_plan_handoff with this relatedPlanID";
  return {
    name: "plan_propose",
    description: `Propose the WorkContract (scope/verification/constraints) for a marked plan document and request the user's approval. Extract the fields from the plan you just wrote — grounding, not invention. Placeholder entries (single characters or pure generic words like all/everything/相关) are rejected; an all-empty proposal is accepted as unverifiable (advisory-only). A scope entry that names a path a deny constitution rule covers is also rejected before the gate — re-propose within the rule. This tool blocks until the user Allow / Reject; on Reject you get the feedback and can re-propose. ${handoff}`,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        planID: {
          type: "string",
          description:
            "The marked plan's planID (from plan_doc_list or plan_create).",
        },
        scope: {
          type: "array",
          items: { type: "string" },
          description:
            "What the plan covers, extracted from the plan document (concrete entries only).",
        },
        verification: {
          type: "array",
          items: { type: "string" },
          description:
            "How the work will be verified, extracted from the plan document (concrete entries only).",
        },
        constraints: {
          type: "array",
          items: { type: "string" },
          description:
            "Constraints the work must respect, extracted from the plan document (concrete entries only).",
        },
      },
      required: ["planID"],
      additionalProperties: false,
    },
    output: collabOutput({
      callTitle: "contract",
      callSummary: "propose",
      resultTitle: "contract",
      resultSummary: "proposed",
    }),
    async execute(parsed, context) {
      const args = parsed as {
        planID?: string;
        scope?: string[];
        verification?: string[];
        constraints?: string[];
      };
      const exec = resolveExec(ctx, context.sessionID);
      if (!exec) return "no session";
      const planID = args.planID?.trim();
      if (!planID)
        return "plan_propose requires planID; use plan_doc_list to find an available plan document";
      const plan = ctx.ports.planDocRuntime.planDocByID(planID);
      if (!plan)
        return `no marked plan ${planID}; use plan_doc_list to find an available plan document`;
      const ledger = requireWorkLedger(ctx);
      if (!ledger) return "work ledger unavailable";
      const interactive = ctx.ports.getInteractive();
      const fields = {
        ...(args.scope ? { scope: args.scope } : {}),
        ...(args.verification ? { verification: args.verification } : {}),
        ...(args.constraints ? { constraints: args.constraints } : {}),
      };
      // EI §8.2 runtime validation: placeholders are rejected, not guessed.
      const problems = ledger.validateWorkContractFields(fields);
      if (problems.length)
        return JSON.stringify({
          accepted: false,
          problems,
          reason:
            "the draft carried placeholder or empty entries; re-propose with concrete entries extracted from the plan document",
        });
      // EI Open Question "契约 handoff 撞 constitution" — decided: 拦在 propose
      // (事前). A scope entry naming a path a deny rule covers is a contract
      // the runtime will never allow to execute; refuse it here, inside the
      // existing re-propose loop, so the user gate never fires for a contract
      // that cannot be carried out (and the handoff never dead-ends on it).
      const constitutionRules = await sessionConstitutionRules(ctx, exec);
      const constitutionConflicts = checkContractAgainstConstitution({
        entries: fields.scope ?? [],
        rules: constitutionRules,
      });
      if (constitutionConflicts.length)
        return JSON.stringify({
          accepted: false,
          problems: constitutionConflicts.map(
            (conflict) =>
              `scope entry "${conflict.entry.slice(0, 60)}" names ${conflict.path}, which the deny constitution rule ${conflict.ruleID} covers`,
          ),
          reason:
            "the scope conflicts with a deny constitution rule; re-propose within the rule, or ask the user to change the rule first",
        });
      // A draft with no extractable fields is still proposeable — it lands as
      // an unverifiable acceptance (advisory-only judgment).
      const unverifiable =
        !(fields.scope?.length ?? false) &&
        !(fields.verification?.length ?? false) &&
        !(fields.constraints?.length ?? false);
      const now = new Date().toISOString();
      // EI §3.4: the draft binds to the plan document's real revision (its
      // planVersion). A later plan-document edit bumps the revision and
      // publishes `plan.doc.updated`, which marks this draft stale until it is
      // re-proposed against the newer revision.
      const planVersion = plan.revision ?? 1;
      ctx.ports.publishForSession(
        exec,
        ledger.buildWorkContractDrafted({
          id: `${planID}:work-contract:${ctx.ports.nextPlanSequence()}`,
          planID,
          planVersion,
          ...fields,
          draftedAt: now,
        }),
      );
      // Ledger plan §5: the proposal displays its conflict-check result at
      // the user's decision point — the rules it was checked against, and
      // the verdict (a conflict never reaches here: it refuses above).
      const denyAnchored = constitutionDenyAnchoredRules(constitutionRules);
      const constitutionLine = denyAnchored.length
        ? `constitution: checked against ${denyAnchored.length} deny rule(s) with path anchors — no conflict`
        : "constitution: no deny rules with path anchors to check against";
      const previewLines = [
        `scope: ${(fields.scope ?? []).join("; ") || "(unverifiable)"}`,
        `verification: ${(fields.verification ?? []).join("; ") || "(unverifiable)"}`,
        `constraints: ${(fields.constraints ?? []).join("; ") || "(unverifiable)"}`,
        constitutionLine,
      ];
      // R3 (EI §8.8): the gate is always available for a mid-run contract
      // extension — an already-accepted plan can add committed verification
      // through the same single user confirmation, producing a new accepted
      // contract rather than silently replacing the current one.
      const response = await interactive.requirePlanAcceptance({
        approvalID: `work_contract:${planID}:${ctx.ports.nextPlanSequence()}`,
        planID,
        title: `Approve the work contract for ${planID}`,
        preview: previewLines.join("\n"),
        detail: `${plan.title}\n\n${previewLines.join("\n")}`,
        scope: "work_contract",
        sessionID: exec.session.id,
        signal: context.signal,
      });
      if (!response || response.decision === "reject")
        return JSON.stringify({
          accepted: false,
          reason: `rejected${response?.feedback ? `: ${response.feedback}` : ""}`,
          feedback: response?.feedback,
          hint: "the draft stays on the journal; re-propose with the feedback folded in",
        });
      ctx.ports.publishForSession(
        exec,
        ledger.buildWorkContractAccepted({
          id: `${planID}:work-contract-accepted:${ctx.ports.nextPlanSequence()}`,
          planID,
          planVersion,
          ...fields,
          acceptedAt: new Date().toISOString(),
          ...(unverifiable ? { unverifiable: true } : {}),
        }),
      );
      correctAbsorbedDrift(ctx, ledger, exec, planID, fields.scope ?? []);
      return JSON.stringify({
        accepted: true,
        planID,
        contract: {
          planID,
          version: planVersion,
          ...(fields.scope ? { scope: fields.scope } : {}),
          ...(fields.verification ? { verification: fields.verification } : {}),
          ...(fields.constraints ? { constraints: fields.constraints } : {}),
          ...(unverifiable ? { unverifiable: true } : {}),
        },
        ...(unverifiable ? { unverifiable: true } : {}),
        hint: handoffHint,
      });
    },
  };
}

/**
 * The read half (EI §8.4): the session's projected WorkContract for a plan —
 * `current` (user-approved, the R drift is judged against), `draft` (with the
 * stale marker a plan document change raises), or `none`.
 */
export function createWorkContractReadTool(ctx: RuntimeContext): RuntimeTool {
  return {
    name: "work_contract_read",
    description:
      "Read the session's WorkContract for a plan: the user-approved contract (current), the latest draft (with a stale marker when the plan document changed after it), or none. Use it to check what the user committed to before judging drift or handing off.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        planID: {
          type: "string",
          description: "The planID to read the contract for.",
        },
      },
      required: ["planID"],
      additionalProperties: false,
    },
    output: collabOutput({
      callTitle: "contract",
      callSummary: "read",
      resultTitle: "contract",
      resultSummary: "read",
    }),
    async execute(parsed, context) {
      const args = parsed as { planID?: string };
      const exec = resolveExec(ctx, context.sessionID);
      if (!exec) return "no session";
      const planID = args.planID?.trim();
      if (!planID) return "work_contract_read requires planID";
      // EI §3.4 / Phase 1: read the complete fact state, not the live
      // window. A fast-attach exec holds only a tail, so a contract drafted
      // outside the current window (and its stale marker) would be missed;
      // completing the fact state folds the whole durable history first.
      await ensureCompleteSessionFactState(ctx, exec);
      const contract = (
        exec.factState
          ? sessionFactWorkContracts(exec.factState)
          : projectedWorkContracts(exec.session.events)
      ).find((candidate) => candidate.planID === planID);
      // An unknown planID is an error, not the legitimate "none" (plan exists
      // but has no proposed contract yet) — EI §3.9.
      if (!ctx.ports.planDocRuntime.planDocByID(planID))
        return `unknown planID: ${planID}`;
      if (!contract) return JSON.stringify({ planID, status: "none" });
      return JSON.stringify({
        planID,
        status: contract.status,
        version: contract.version,
        ...(contract.scope ? { scope: contract.scope } : {}),
        ...(contract.verification
          ? { verification: contract.verification }
          : {}),
        ...(contract.constraints ? { constraints: contract.constraints } : {}),
        ...(contract.stale ? { stale: true } : {}),
        ...(contract.unverifiable ? { unverifiable: true } : {}),
        ...(contract.acceptedAt ? { acceptedAt: contract.acceptedAt } : {}),
      });
    },
  };
}

/**
 * `detour_declare` (EI §3.4): the model asks to work outside the accepted
 * WorkContract's scope. This is the legitimate way to touch committed scope
 * the plan did not anticipate — an undeclared move past the scope is a
 * target_drift warning, a declared one is gated and, on user approval, becomes
 * a new accepted contract (v+1). The declaration is validated (non-empty,
 * scopeDelta does not overlap the accepted scope), recorded durably as
 * `detour.requested`, and Nia is woken to review it asynchronously; the gate
 * fires immediately (it does not wait for Nia), and Nia's opinion is always a
 * reference — the approval right stays with the user.
 */
export function createDetourDeclareTool(ctx: RuntimeContext): RuntimeTool {
  return {
    name: "detour_declare",
    description:
      "Declare a detour: work outside the accepted WorkContract's scope, with the scope/verification/constraint increments you need. currentVersion is the accepted contract version (optimistic lock). The scopeDelta must not overlap the committed scope, and a scopeDelta entry naming a path a deny constitution rule covers is rejected before the gate — re-declare within the rule. This blocks until the user Allow/Reject; on Allow a new accepted contract (v+1) absorbs the deltas, on Reject you get feedback. Nia reviews it asynchronously but the approval is always the user's.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        planID: { type: "string", description: "The plan's planID." },
        currentVersion: {
          type: "number",
          description:
            "The accepted contract version you are detouring from (optimistic lock).",
        },
        reason: {
          type: "string",
          description: "Why the work needs to go outside the committed scope.",
        },
        scopeDelta: {
          type: "array",
          items: { type: "string" },
          description:
            "New scope paths to add (must not overlap the committed scope).",
        },
        verificationDelta: {
          type: "array",
          items: { type: "string" },
          description: "New verification steps to add.",
        },
        constraintDelta: {
          type: "array",
          items: { type: "string" },
          description: "New constraints to add.",
        },
      },
      required: ["planID", "currentVersion", "reason", "scopeDelta"],
      additionalProperties: false,
    },
    output: collabOutput({
      callTitle: "detour",
      callSummary: "declare",
      resultTitle: "detour",
      resultSummary: "requested",
    }),
    async execute(parsed, context) {
      const args = parsed as {
        planID?: string;
        currentVersion?: number;
        reason?: string;
        scopeDelta?: string[];
        verificationDelta?: string[];
        constraintDelta?: string[];
      };
      const exec = resolveExec(ctx, context.sessionID);
      if (!exec) return "no session";
      const planID = args.planID?.trim();
      if (!planID) return "detour_declare requires planID";
      const ledger = requireWorkLedger(ctx);
      if (!ledger) return "work ledger unavailable";
      // Read the accepted contract from the complete fact state (a detour may
      // be declared long after the contract was accepted, outside the window).
      await ensureCompleteSessionFactState(ctx, exec);
      const contract = (
        exec.factState
          ? sessionFactWorkContracts(exec.factState)
          : projectedWorkContracts(exec.session.events)
      ).find(
        (candidate) =>
          candidate.planID === planID && candidate.status === "current",
      );
      if (!contract)
        return JSON.stringify({
          accepted: false,
          reason: `no accepted WorkContract for ${planID}; propose one with plan_propose first`,
        });
      // Optimistic lock: the detour is declared against a specific version.
      if (args.currentVersion !== contract.version)
        return JSON.stringify({
          accepted: false,
          reason: `stale currentVersion ${args.currentVersion}; the accepted contract is v${contract.version}; re-read it with work_contract_read`,
        });
      const problems = ledger.validateDetour({
        reason: args.reason ?? "",
        scopeDelta: args.scopeDelta ?? [],
        ...(args.verificationDelta
          ? { verificationDelta: args.verificationDelta }
          : {}),
        ...(args.constraintDelta
          ? { constraintDelta: args.constraintDelta }
          : {}),
        currentScope: contract.scope ?? [],
      });
      if (problems.length)
        return JSON.stringify({
          accepted: false,
          problems,
          reason:
            "the detour failed validation; fix the problems and re-declare",
        });
      // EI Open Question "契约 handoff 撞 constitution" — same 事前 check as
      // plan_propose: a scopeDelta naming a path a deny rule covers would
      // dead-end the detour after the user approved it, so refuse it before
      // the gate fires.
      const constitutionConflicts = checkContractAgainstConstitution({
        entries: args.scopeDelta ?? [],
        rules: await sessionConstitutionRules(ctx, exec),
      });
      if (constitutionConflicts.length)
        return JSON.stringify({
          accepted: false,
          problems: constitutionConflicts.map(
            (conflict) =>
              `scopeDelta entry "${conflict.entry.slice(0, 60)}" names ${conflict.path}, which the deny constitution rule ${conflict.ruleID} covers`,
          ),
          reason:
            "the detour scope conflicts with a deny constitution rule; re-declare within the rule, or ask the user to change the rule first",
        });
      const now = new Date().toISOString();
      const detourID = `${planID}:detour:${ctx.ports.nextPlanSequence()}`;
      ctx.ports.publishForSession(
        exec,
        ledger.buildDetourRequested({
          id: detourID,
          detourID,
          planID,
          currentVersion: contract.version,
          reason: args.reason!,
          scopeDelta: args.scopeDelta!,
          ...(args.verificationDelta
            ? { verificationDelta: args.verificationDelta }
            : {}),
          ...(args.constraintDelta
            ? { constraintDelta: args.constraintDelta }
            : {}),
          requestedAt: now,
        }),
      );
      // EI §3.4: wake Nia to review the detour — an explicit, detour-specific
      // trigger (not the per-turn audit wake, which would ask her to audit the
      // plan). Her verdict is a reference for the user; the gate does not wait
      // for her, and a failed/unavailable review is recorded at resolution.
      const providerController = ctx.state.serviceDirectory.getOptional(
        providerModelController,
      );
      if (providerController)
        void providerController
          .runNiaChatTurn({
            sessionID: exec.session.id,
            text: "",
            responseMessageID: `chat:${Date.now().toString(36)}:${ctx.ports.nextChatSequence()}`,
            internal: true,
            detourReview: { detourID, planID, reason: args.reason! },
          })
          .catch(() => {
            // A failed review wake is non-fatal: the gate proceeds and the
            // resolution records the opinion as unavailable.
          });
      const previewLines = [
        `reason: ${args.reason}`,
        `scope +: ${(args.scopeDelta ?? []).join("; ")}`,
        ...(args.verificationDelta?.length
          ? [`verification +: ${args.verificationDelta.join("; ")}`]
          : []),
        ...(args.constraintDelta?.length
          ? [`constraints +: ${args.constraintDelta.join("; ")}`]
          : []),
        `→ new contract v${contract.version + 1}`,
        // EI Open Question "Nia 绕路 gate 留痕提示": the gate fires the moment
        // Nia is woken, so her opinion is asynchronous. Tell the user at the
        // decision point that approving now may land without her review, and
        // that a no-opinion approval is recorded as such on the journal
        // (detour.reviewed: unavailable) — the 事后 record already exists,
        // this is the 事前知情 line.
        "Nia 异步独立审核中（仅参考，批准权在你）；若你决定前她的看法未到达，本次批准将记录为无看法批准",
      ];
      const response = await ctx.ports.getInteractive().requirePlanAcceptance({
        approvalID: `detour:${detourID}`,
        planID,
        title: `Approve detour for ${planID}`,
        preview: previewLines.join("\n"),
        detail: `${args.reason}\n\n${previewLines.join("\n")}`,
        scope: "detour",
        sessionID: exec.session.id,
        signal: context.signal,
      });
      // EI §3.4: the gate fires immediately and Nia reviews asynchronously, so
      // by the time the user decides Nia may not have weighed in. Record that
      // her opinion was unavailable — the gate proceeded without it. Nia's
      // verdict is always a reference; the approval right is the user's.
      if (
        !exec.session.events.some(
          (event) =>
            event.type === "detour.reviewed" && event.detourID === detourID,
        )
      )
        ctx.ports.publishForSession(
          exec,
          ledger.buildDetourReviewed({
            id: `detour:unavailable:${detourID}`,
            detourID,
            planID,
            verdict: "unavailable",
            reviewedBy: "nia",
            reviewedAt: new Date().toISOString(),
            rationale: "Nia did not review before the user decided",
          }),
        );
      if (!response || response.decision === "reject")
        return JSON.stringify({
          accepted: false,
          detourID,
          reason: `rejected${response?.feedback ? `: ${response.feedback}` : ""}`,
          hint: "the detour stays on the journal as requested; do not touch the out-of-scope work",
        });
      // User approval absorbs the deltas into a new accepted contract (v+1).
      const merged = ledger.mergeDetourIntoContract(
        {
          ...(contract.scope ? { scope: contract.scope } : {}),
          ...(contract.verification
            ? { verification: contract.verification }
            : {}),
          ...(contract.constraints
            ? { constraints: contract.constraints }
            : {}),
        },
        {
          scopeDelta: args.scopeDelta!,
          ...(args.verificationDelta
            ? { verificationDelta: args.verificationDelta }
            : {}),
          ...(args.constraintDelta
            ? { constraintDelta: args.constraintDelta }
            : {}),
        },
      );
      ctx.ports.publishForSession(
        exec,
        ledger.buildWorkContractAccepted({
          id: `${planID}:work-contract-accepted:${ctx.ports.nextPlanSequence()}`,
          planID,
          planVersion: contract.version + 1,
          ...merged,
          acceptedAt: new Date().toISOString(),
        }),
      );
      correctAbsorbedDrift(ctx, ledger, exec, planID, merged.scope ?? []);
      return JSON.stringify({
        accepted: true,
        detourID,
        planID,
        version: contract.version + 1,
        hint: "the detour is now part of the accepted contract; proceed with the work",
      });
    },
  };
}

/**
 * `constitution_propose_rule` (EI §3.8 P-1.c / §8.5): the model proposes a
 * rule that tightens itself. The proposal is validated (deny/approval require
 * a non-empty appliesTo anchor; release scope is rejected — runtime
 * self-protection is not a model's to touch), and the user approves it once
 * through the gate before it lands as `constitution.rule_added(source:
 * "agent_proposed")`. A model never edits, disables or deletes an existing
 * rule — those are user actions.
 */
export function createConstitutionProposeTool(
  ctx: RuntimeContext,
): import("@anthelia/tools").RuntimeTool {
  return {
    name: "constitution_propose_rule",
    description:
      "Propose a new constitution rule that tightens the runtime for this workspace. deny/approval rules require a structured appliesTo anchor (tools, paths or commandPattern); release scope cannot be proposed. The proposal waits for the user's approval; on Allow it lands as an agent_proposed rule, on Reject you get the feedback and can re-propose.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        statement: {
          type: "string",
          description: "The rule statement (what must always/never happen).",
        },
        enforcement: {
          type: "string",
          enum: ["deny", "approval", "warn"],
          description: "deny blocks, approval gates, warn records.",
        },
        appliesTo: {
          type: "object",
          properties: {
            tools: { type: "array", items: { type: "string" } },
            paths: { type: "array", items: { type: "string" } },
            commandPattern: { type: "string" },
          },
          additionalProperties: false,
          description:
            "Required for deny/approval — the structured anchor the matcher executes against.",
        },
        priority: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
        },
        scope: {
          type: "string",
          enum: ["project", "package"],
          description: "Only project or package scope can be proposed.",
        },
      },
      required: ["statement", "enforcement"],
      additionalProperties: false,
    },
    output: collabOutput({
      callTitle: "rule",
      callSummary: "propose",
      resultTitle: "rule",
      resultSummary: "proposed",
    }),
    async execute(parsed, context) {
      const args = parsed as {
        statement?: string;
        enforcement?: "deny" | "approval" | "warn";
        appliesTo?: {
          tools?: string[];
          paths?: string[];
          commandPattern?: string;
        };
        priority?: "critical" | "high" | "medium" | "low";
        scope?: string;
      };
      const exec = resolveExec(ctx, context.sessionID);
      if (!exec) return "no session";
      const governanceLedger = ctx.state.serviceDirectory.getOptional(
        governanceLedgerController,
      );
      if (!governanceLedger) return "governance ledger unavailable";
      if (!args.statement?.trim() || !args.enforcement)
        return "constitution_propose_rule requires statement and enforcement";
      const problems = governanceLedger.validateConstitutionRuleProposal({
        statement: args.statement,
        enforcement: args.enforcement,
        ...(args.appliesTo ? { appliesTo: args.appliesTo } : {}),
        ...(args.priority ? { priority: args.priority } : {}),
        ...(args.scope ? { scope: args.scope } : {}),
      });
      if (problems.length)
        return JSON.stringify({
          status: "invalid",
          problems,
          reason:
            "the proposal failed validation; fix the problems and re-propose",
        });
      const interactive = ctx.ports.getInteractive();
      const response = await interactive.requirePlanAcceptance({
        approvalID: `constitution_rule:${Date.now().toString(36)}:${ctx.ports.nextDecisionSequence()}`,
        planID: "constitution_rule",
        title: `Approve the proposed rule: ${args.statement.slice(0, 80)}`,
        preview: `${args.enforcement} · ${JSON.stringify(args.appliesTo ?? {})}`,
        detail: args.statement,
        scope: "constitution_rule",
        sessionID: exec.session.id,
        signal: context.signal,
        // EI §3.7.1/§3.7.2: a rule change is confirmed per item by the human —
        // never auto-granted in `auto` mode and never session-approved, or a
        // model could tighten/replace the workspace's rules without consent.
        requireExplicit: true,
      });
      if (!response || response.decision === "reject")
        return JSON.stringify({
          status: "rejected",
          reason: `rejected${response?.feedback ? `: ${response.feedback}` : ""}`,
          feedback: response?.feedback,
        });
      const ruleID = `P-AGENT-${Date.now().toString(36)}`;
      const event = governanceLedger.buildProposedConstitutionRule({
        id: `constitution:rule:${Date.now().toString(36)}:${ctx.ports.nextDecisionSequence()}`,
        ruleID,
        proposal: {
          statement: args.statement,
          enforcement: args.enforcement,
          ...(args.appliesTo ? { appliesTo: args.appliesTo } : {}),
          ...(args.scope ? { scope: args.scope } : {}),
        },
        ...(args.priority ? { priority: args.priority } : {}),
      });
      ctx.ports.publishForSession(exec, event);
      // The rule is workspace-tier by nature (scope project/package), so the
      // durable instance store gets the same fact the session journal just
      // recorded — otherwise an approved rule is invisible to the CLI face
      // and to every later session's rule_read (T-21).
      appendInstanceEvent(
        resolveGovernanceRoot(ctx.ports.getWorkspaceRoot()),
        "constitution.jsonl",
        event,
      );
      return JSON.stringify({
        status: "active",
        ruleID,
        rule: {
          statement: event.statement,
          enforcement: event.enforcement,
          scope: event.scope,
          priority: event.priority,
          source: event.source,
          proposedBy: event.proposedBy,
          approvedBy: event.approvedBy,
          ...(event.appliesTo ? { appliesTo: event.appliesTo } : {}),
        },
      });
    },
  };
}

/**
 * `detour_review` (EI §3.4): Nia's independent opinion on a requested detour.
 * Nia reads the detour (and the contract / work graph) and records a
 * `detour.reviewed` fact. Her verdict is always a reference — the approval
 * right stays with the user, who decides through the detour gate. Nia never
 * approves or mutates the contract herself.
 */
export function createDetourReviewTool(ctx: RuntimeContext): RuntimeTool {
  return {
    name: "detour_review",
    description:
      "Record Nia's independent review of a requested detour: approve or reject, with an optional rationale. Your verdict is a reference for the user, who makes the final decision through the detour gate. Read the detour and the accepted contract first.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        detourID: {
          type: "string",
          description: "The detourID from the detour.requested fact.",
        },
        verdict: {
          type: "string",
          enum: ["approve", "reject"],
          description: "Nia's opinion on the detour.",
        },
        rationale: {
          type: "string",
          description: "Why Nia approves or rejects (safe prose).",
        },
      },
      required: ["detourID", "verdict"],
      additionalProperties: false,
    },
    output: collabOutput({
      callTitle: "detour",
      callSummary: "review",
      resultTitle: "detour",
      resultSummary: "reviewed",
    }),
    async execute(parsed, context) {
      const args = parsed as {
        detourID?: string;
        verdict?: "approve" | "reject";
        rationale?: string;
      };
      const exec = resolveExec(ctx, context.sessionID);
      if (!exec) return "no session";
      const detourID = args.detourID?.trim();
      if (!detourID) return "detour_review requires detourID";
      if (args.verdict !== "approve" && args.verdict !== "reject")
        return "detour_review requires verdict approve|reject";
      const ledger = requireWorkLedger(ctx);
      if (!ledger) return "work ledger unavailable";
      // Find the requested detour to attribute the review to its plan.
      await ensureCompleteSessionFactState(ctx, exec);
      const requested = exec.session.events.find(
        (event): event is Extract<typeof event, { type: "detour.requested" }> =>
          event.type === "detour.requested" && event.detourID === detourID,
      );
      if (!requested)
        return `no requested detour ${detourID}; read the session's detour.requested facts first`;
      ctx.ports.publishForSession(
        exec,
        ledger.buildDetourReviewed({
          id: `detour:reviewed:${detourID}:${ctx.ports.nextPlanSequence()}`,
          detourID,
          planID: requested.planID,
          verdict: args.verdict,
          reviewedBy: "nia",
          reviewedAt: new Date().toISOString(),
          ...(args.rationale ? { rationale: args.rationale } : {}),
        }),
      );
      return JSON.stringify({
        reviewed: true,
        detourID,
        verdict: args.verdict,
      });
    },
  };
}

/**
 * `constitution_rule_read` (T-21): the read half of the proposal lifecycle.
 *
 * The proposal tool used to answer `{proposed: true, ruleID}` and leave the
 * model unable to ask the obvious follow-up — "is that rule actually in the
 * check chain?" This tool answers from the same fold the check chain reads
 * (the session fact state) plus the durable instance store's tombstones, so a
 * rule revoked in an earlier session still answers `removed` rather than
 * `unknown`.
 *
 * Statuses: `active` (in the effective set the checks execute against),
 * `disabled` (a reversible `rule_updated(enabled:false)` hides it), `removed`
 * (the tombstone), `unknown` (no such rule in this workspace's ledger).
 */
export function createConstitutionRuleReadTool(
  ctx: RuntimeContext,
): RuntimeTool {
  return {
    name: "constitution_rule_read",
    description:
      "Read one constitution rule by its ruleID and report its lifecycle status: active (the checks execute against it), disabled (reversibly hidden), removed (revoked; the journal keeps the tombstone), or unknown. The rule's statement, enforcement, scope, priority and provenance (source / proposedBy / approvedBy) ride along.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        ruleID: {
          type: "string",
          description:
            "The ruleID from constitution_propose_rule or the rules list.",
        },
      },
      required: ["ruleID"],
      additionalProperties: false,
    },
    output: collabOutput({
      callTitle: "rule",
      callSummary: "read",
      resultTitle: "rule",
      resultSummary: "read",
    }),
    async execute(parsed, context) {
      const args = parsed as { ruleID?: string };
      const ruleID = args.ruleID?.trim();
      if (!ruleID) return "constitution_rule_read requires ruleID";
      const exec = resolveExec(ctx, context.sessionID);
      if (!exec) return "no session";
      // The workspace-tier fold, not only this session's. A rule proposed and
      // approved in an EARLIER session (or by the CLI face) lives in the
      // instance store, so reading only the session fold answered `unknown`
      // for a rule that exists — the 2026-10-08 audit's P1-1, measured on
      // `C-TERM-001` (real) and `C-NOPE-999` (fabricated) answering alike.
      const views = governanceViews(ctx.ports.getWorkspaceRoot());
      const sessionRules = await sessionConstitutionRules(ctx, exec);
      const active =
        sessionRules.find((rule) => rule.ruleID === ruleID) ??
        views.rules.find((rule) => rule.ruleID === ruleID);
      if (active)
        return JSON.stringify({
          status: "active",
          rule: {
            ruleID: active.ruleID,
            statement: active.statement,
            enforcement: active.enforcement,
            scope: active.scope,
            priority: active.priority,
            source: active.source,
            proposedBy: active.proposedBy,
            approvedBy: active.approvedBy,
            ...(active.appliesTo ? { appliesTo: active.appliesTo } : {}),
          },
        });
      // The disabled face is not in the effective projection, so the folds'
      // own state is consulted directly — the instance fold first, because a
      // rule disabled in another session is disabled here too.
      const disabled =
        views.disabled.find((rule) => rule.ruleID === ruleID) ??
        (exec.factState?.constitution.disabled.has(ruleID)
          ? exec.factState.constitution.rules.get(ruleID)
          : undefined);
      if (disabled)
        return JSON.stringify({
          status: "disabled",
          rule: {
            ruleID,
            statement: disabled.statement,
            enforcement: disabled.enforcement,
            scope: disabled.scope,
            priority: disabled.priority,
            source: disabled.source,
            ...(disabled.proposedBy === undefined
              ? {}
              : { proposedBy: disabled.proposedBy }),
            ...(disabled.approvedBy === undefined
              ? {}
              : { approvedBy: disabled.approvedBy }),
          },
        });
      const removed = views.removed.find((entry) => entry.ruleID === ruleID);
      if (removed)
        return JSON.stringify({
          status: "removed",
          ruleID,
          removedAt: removed.at,
          removedBy: removed.removedBy,
        });
      // An unreadable store is not an absent rule. Saying `unknown` for both
      // is what made the audit's two probes indistinguishable.
      if (views.degraded)
        return JSON.stringify({
          status: "unreadable",
          ruleID,
          reason:
            "the workspace constitution store could not be read — this is a read failure, not an absent rule",
        });
      return JSON.stringify({ status: "unknown", ruleID });
    },
  };
}

/**
 * `constitution_rule_revoke` (T-21): the model proposes removing a rule it
 * proposed (or the user asks it to); the human confirms through the same
 * explicit gate a proposal uses, and only then does the tombstone land.
 *
 * The model never removes a rule on its own — the ledger's own invariant
 * ("a critical/high rule marked forbidden may not be removed") is checked
 * BEFORE the gate, so a protected rule is refused by name rather than
 * asked about. `removedBy` on the tombstone is `user` by the builder's
 * contract: the human is the remover; this tool only carries the request.
 */
export function createConstitutionRuleRevokeTool(
  ctx: RuntimeContext,
): RuntimeTool {
  return {
    name: "constitution_rule_revoke",
    description:
      "Propose revoking an existing constitution rule. The user confirms through the same explicit gate a proposal uses; on Allow the rule leaves the effective set with a durable tombstone (revocable rules only — a critical/high rule marked forbidden is refused by name, and a rule already removed answers removed).",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        ruleID: {
          type: "string",
          description: "The ruleID to revoke.",
        },
        reason: {
          type: "string",
          description:
            "Why the rule should be revoked — shown in the approval request.",
        },
      },
      required: ["ruleID"],
      additionalProperties: false,
    },
    output: collabOutput({
      callTitle: "rule",
      callSummary: "revoke",
      resultTitle: "rule",
      resultSummary: "revoked",
    }),
    async execute(parsed, context) {
      const args = parsed as { ruleID?: string; reason?: string };
      const ruleID = args.ruleID?.trim();
      if (!ruleID) return "constitution_rule_revoke requires ruleID";
      const exec = resolveExec(ctx, context.sessionID);
      if (!exec) return "no session";
      const governanceLedger = ctx.state.serviceDirectory.getOptional(
        governanceLedgerController,
      );
      if (!governanceLedger) return "governance ledger unavailable";
      const rules = await sessionConstitutionRules(ctx, exec);
      const rule = rules.find((candidate) => candidate.ruleID === ruleID);
      if (!rule) {
        const views = governanceViews(ctx.ports.getWorkspaceRoot());
        if (views.removed.some((entry) => entry.ruleID === ruleID))
          return JSON.stringify({ status: "removed", ruleID });
        return JSON.stringify({
          status: "unknown",
          ruleID,
          reason: "no rule with that ruleID is in the effective set",
        });
      }
      // The ledger's non-rollback invariant, checked before the gate: asking
      // a human to approve a removal the ledger itself must refuse would be
      // a question with no correct answer.
      if (
        (rule.priority === "critical" || rule.priority === "high") &&
        rule.overridePolicy === "forbidden"
      )
        return JSON.stringify({
          status: "refused",
          ruleID,
          reason:
            `rule ${ruleID} is ${rule.priority}/forbidden: the constitution's ` +
            `non-rollback rule forbids its removal, so it cannot be revoked`,
        });
      const interactive = ctx.ports.getInteractive();
      const response = await interactive.requirePlanAcceptance({
        approvalID: `constitution_rule_revoke:${Date.now().toString(36)}:${ctx.ports.nextDecisionSequence()}`,
        planID: "constitution_rule_revoke",
        title: `Approve revoking rule ${ruleID}`,
        preview: `${rule.enforcement} · ${rule.statement.slice(0, 80)}`,
        detail: args.reason
          ? `${args.reason}\n\n${rule.statement}`
          : rule.statement,
        scope: "constitution_rule_revoke",
        sessionID: exec.session.id,
        signal: context.signal,
        // The same EI §3.7.1/§3.7.2 discipline as a proposal: a rule change
        // is confirmed per item by the human, never auto-granted.
        requireExplicit: true,
      });
      if (!response || response.decision === "reject")
        return JSON.stringify({
          status: "rejected",
          ruleID,
          feedback: response?.feedback,
        });
      const removedAt = new Date().toISOString();
      const event = governanceLedger.buildConstitutionRuleRemoved({
        id: `constitution:rule:removed:${Date.now().toString(36)}:${ctx.ports.nextDecisionSequence()}`,
        ruleID,
        removedAt,
      });
      ctx.ports.publishForSession(exec, event);
      // The tombstone is workspace-tier too: the durable store is what makes
      // "removed" answerable in a later session's rule_read.
      appendInstanceEvent(
        resolveGovernanceRoot(ctx.ports.getWorkspaceRoot()),
        "constitution.jsonl",
        event,
      );
      return JSON.stringify({ status: "removed", ruleID, removedAt });
    },
  };
}
