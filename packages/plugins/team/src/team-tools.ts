/**
 * The agent-team tools — the user-facing entry to fan-out and review.
 *
 * These are host-registered tools (like the skill and mailbox tools): the main
 * agent calls `team_fanout` with the decomposed tasks and gets the PR queue,
 * then acts as the lead via `team_review` (approve merges into the workspace,
 * request-changes returns with a reason). The orchestrator prompt
 * (`ORCHESTRATOR_SYSTEM_PROMPT`) is what produces the disjoint tasks the main
 * agent hands to `team_fanout`.
 */
import {
  reviewPRs,
  runFanOut,
  validateOwnershipMap,
  type FanOutPR,
} from "./fan-out";
import {
  SETTLEMENT_SOURCE_KINDS,
  type SettlementService,
} from "@natalia/collaboration";
import { prSettlementReason } from "./fan-out";
import { requireObject } from "@anthelia/tools";
import type {
  RuntimeTool,
  SandboxToolService,
  SubagentToolService,
} from "@anthelia/tools";

export const TEAM_REVIEW_DECISIONS = ["approve", "request-changes"] as const;

export function createTeamFanoutTool(input: {
  subagents: () => SubagentToolService | undefined;
  sandboxes: () => SandboxToolService | undefined;
  /** The settlement bridge, resolved by the plugin's setup. */
  settlement?: () => SettlementService | undefined;
}): RuntimeTool {
  return {
    name: "team_fanout",
    description:
      "Spawn one sandboxed sub-agent per task in parallel (each in its own checked-out worktree, limited to its write domain) and return the PR queue. The sandbox runtime computes each candidate's diff; each PR carries that diff, result and build evidence. Each PR is reported to you as it lands (a settlement notice), so review the queue as it fills instead of waiting for the whole batch.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              prompt: { type: "string" },
              writePaths: { type: "array", items: { type: "string" } },
            },
            required: ["id", "prompt"],
          },
        },
        buildCommand: { type: "string" },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: {} },
      presentCall(args) {
        const tasks = (requireObject(args).tasks as unknown[]) ?? [];
        return {
          kind: "generic",
          title: "fan-out",
          summary: `${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
        };
      },
      presentationMeta(_args, value) {
        // The queue's counts, decoded once (R5).
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          // degrade, never throw
        }
        const prs = Array.isArray(parsed) ? parsed : [];
        return {
          total: prs.length,
          ready: prs.filter(
            (pr) =>
              Boolean(pr) &&
              typeof pr === "object" &&
              (pr as { status?: unknown }).status === "completed",
          ).length,
        };
      },
      presentResult(_args, value, meta) {
        const facts = (meta ?? {}) as { total?: number; ready?: number };
        const total = facts.total ?? 0;
        const done = facts.ready ?? 0;
        return {
          kind: "generic",
          title: "fan-out",
          summary: `${done}/${total} PR${total === 1 ? "" : "s"} ready`,
          meta: [["ready", String(done)]],
          body: value,
        };
      },
    },
    async execute(toolInput, context) {
      const args = toolInput as {
        tasks: Array<{
          id: string;
          prompt: string;
          writePaths?: string[];
        }>;
        buildCommand?: string;
      };
      if (!Array.isArray(args.tasks) || !args.tasks.length)
        throw new Error("tasks must be a non-empty array");
      const subagents = input.subagents();
      const sandboxes = input.sandboxes();
      if (!subagents) throw new Error("sub-agent runtime is unavailable");
      if (!sandboxes) throw new Error("sandbox manager is unavailable");
      const map = validateOwnershipMap({ tasks: args.tasks });
      if (!map.ok)
        return `ERROR: ownership map is invalid:\n${map.issues.join("\n")}`;
      // The spawning session, recorded on every candidate: the sub-agent
      // runtime resolves the parent execution from it and refuses a child
      // that has none ("subagent has no parent session"), so a fan-out that
      // spawned without it killed every candidate at init (T-14). Refuse here
      // instead: the failure names the missing session rather than leaving a
      // batch of dead sub-agents behind.
      const parentSessionID = context.sessionID;
      if (!parentSessionID)
        throw new Error(
          "team_fanout requires a calling session: the fan-out cannot name the parent session its sub-agents belong to",
        );
      const runtimeConfig = context.runtimeConfig?.() as
        | { team?: { maxConcurrent?: number } }
        | undefined;
      const prs = await runFanOut({
        tasks: args.tasks,
        subagents,
        sandboxes,
        buildCommand: args.buildCommand,
        maxConcurrent: runtimeConfig?.team?.maxConcurrent,
        parentSessionID,
        ...(context.parentAgentID
          ? { parentAgentID: context.parentAgentID }
          : {}),
        // The spine's team adopter: each landed PR tells the lead now, not
        // after the batch. Session-scoped like every other adopter; absent
        // the spine (or a session) it is a silent no-op.
        onPR: (pr) => {
          const settlement = input.settlement?.();
          const sessionID = context.sessionID;
          if (!settlement || !sessionID) return;
          settlement.deliverForSession(sessionID, {
            subject: pr.id,
            reason: prSettlementReason(pr),
            summary:
              `PR ${pr.id} is ready for review (${pr.status}` +
              `${pr.buildEvidence ? `, build ${pr.buildEvidence.ok ? "ok" : "failed"}` : ""})`,
            ...(pr.buildEvidence
              ? { detail: `build exit ${pr.buildEvidence.exitCode}` }
              : {}),
            sourceKind: SETTLEMENT_SOURCE_KINDS.teamPr,
          });
        },
      });
      return JSON.stringify(
        prs.map((pr) => ({
          id: pr.id,
          sandboxID: pr.sandboxID,
          status: pr.status,
          result: pr.result,
          buildEvidence: pr.buildEvidence,
          diff: pr.diff.map((change) => ({
            path: change.path,
            kind: change.kind,
            ...(change.oldPath ? { oldPath: change.oldPath } : {}),
            ...(change.mode ? { mode: change.mode } : {}),
            ...(change.patch ? { patch: change.patch } : {}),
            ...(change.before ? { before: change.before } : {}),
            ...(change.after ? { after: change.after } : {}),
            ...(change.additions !== undefined
              ? { additions: change.additions }
              : {}),
            ...(change.deletions !== undefined
              ? { deletions: change.deletions }
              : {}),
          })),
        })),
        null,
        2,
      );
    },
  };
}

export function createTeamReviewTool(input: {
  sandboxes: () => SandboxToolService | undefined;
}): RuntimeTool {
  return {
    name: "team_review",
    description:
      "Review the PR queue as the lead: approve merges a candidate into the workspace, request-changes returns it with a reason. Decide each PR against its file domain, the shared contract and its build evidence.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        prs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              sandboxID: { type: "string" },
              buildCommand: { type: "string" },
            },
            required: ["id", "sandboxID"],
          },
        },
        decisions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              decision: {
                type: "string",
                enum: [...TEAM_REVIEW_DECISIONS],
              },
              reason: { type: "string" },
            },
            required: ["id", "decision"],
          },
        },
      },
      required: ["prs", "decisions"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: {} },
      presentCall(args) {
        const decisions = (requireObject(args).decisions as unknown[]) ?? [];
        return {
          kind: "generic",
          title: "review",
          summary: `${decisions.length} decision${decisions.length === 1 ? "" : "s"}`,
        };
      },
      presentResult(_args, value) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          // degrade, never throw
        }
        const outcomes = Array.isArray(parsed) ? parsed : [];
        const approved = outcomes.filter(
          (outcome) =>
            Boolean(outcome) &&
            typeof outcome === "object" &&
            (outcome as { decision?: unknown }).decision === "approve",
        ).length;
        return {
          kind: "generic",
          title: "review",
          summary: `${approved}/${outcomes.length} approved`,
          meta: [["approved", String(approved)]],
          body: value,
        };
      },
    },
    async execute(toolInput, context) {
      const args = toolInput as {
        prs: Array<{
          id: string;
          sandboxID: string;
          buildCommand?: string;
        }>;
        decisions: Array<{
          id: string;
          decision: "approve" | "request-changes";
          reason?: string;
        }>;
      };
      const sandboxes = input.sandboxes();
      if (!sandboxes) throw new Error("sandbox manager is unavailable");
      const decisions = new Map(
        args.decisions.map((decision) => [decision.id, decision]),
      );
      const prs: FanOutPR[] = [];
      for (const pr of args.prs) {
        const diff = await sandboxes.previewMerge(pr.sandboxID).catch(() => []);
        // The queue the lead reviews is rebuilt here from the live sandboxes,
        // so the diff is re-previewed and the build evidence is whatever the
        // fan-out actually recorded for this PR. Inventing
        // `{ok: true, exitCode: 0}` because the caller merely MENTIONED a
        // buildCommand claimed a validation that never ran — and the approve
        // gate then merged on evidence nobody produced.
        prs.push({
          id: pr.id,
          sandboxID: pr.sandboxID,
          status: "completed",
          diff,
          ...(pr.buildCommand ? { buildCommand: pr.buildCommand } : {}),
        });
      }
      const outcomes = await reviewPRs({
        prs,
        sandboxes,
        workspaceRoot: context.workspaceRoot,
        decide: async (pr) => {
          const decision = decisions.get(pr.id);
          if (!decision)
            return {
              id: pr.id,
              decision: "request-changes",
              reason: "no decision supplied",
            };
          return decision;
        },
      });
      return JSON.stringify(
        outcomes.map((outcome) => ({
          id: outcome.id,
          decision: outcome.decision,
          reason: outcome.reason,
          merged: outcome.merged?.map((change) => change.path),
        })),
        null,
        2,
      );
    },
  };
}
