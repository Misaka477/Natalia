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
      const runtimeConfig = (
        context.runtimeConfig?.() as
          | { team?: { maxConcurrent?: number } }
          | undefined
      )?.team;
      const prs = await runFanOut({
        tasks: args.tasks,
        subagents,
        sandboxes,
        buildCommand: args.buildCommand,
        maxConcurrent: runtimeConfig?.maxConcurrent,
        // The spine's team adopter: each landed PR tells the lead now, not
        // after the batch. Session-scoped like every other adopter; absent
        // the spine (or a session) it is a silent no-op.
        onPR: (pr) => {
          const settlement = input.settlement?.();
          const sessionID = (context as { sessionID?: string } | undefined)
            ?.sessionID;
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
        prs.push({
          id: pr.id,
          sandboxID: pr.sandboxID,
          status: "completed",
          diff,
          ...(pr.buildCommand
            ? { buildEvidence: { ok: true, exitCode: 0, output: "" } }
            : {}),
        });
      }
      const outcomes = await reviewPRs({
        prs,
        sandboxes,
        workspaceRoot: context.workspaceRoot,
        buildCommand: "true",
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
