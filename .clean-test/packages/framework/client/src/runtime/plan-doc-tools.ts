/**
 * Model-facing plan read tools — runtime/plan-doc-tools.ts.
 *
 * ADR D4/B3: the plan正文 is never injected into any system prompt. The main
 * agent (and subagents, via a plan_ptr pointer) read the plan file itself with
 * `read_file`, and these tools give the main agent the same plan-document
 * access Navi and Nia have: list the workspace plan documents and read one by
 * planID or path. A low-churn pointer (planID + path + version) can travel in
 * the runtime context; the正文 never does.
 */
import type { RuntimeTool } from "@anthelia/tools";
import { applyPlanDocTick } from "@natalia/work-ledger";
import type { RuntimeContext } from "@anthelia/substrate";

/** Lists the workspace plan documents with their stable planIDs and paths. */
export function createPlanDocListTool(ctx: RuntimeContext): RuntimeTool {
  return {
    name: "plan_doc_list",
    description:
      "List the workspace plan documents under .natalia/plans/. Each entry carries a stable planID, title, status and documentPath. Use plan_doc_read to read one.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      return JSON.stringify(await ctx.ports.planDocRuntime.planDocList());
    },
  };
}

/** Reads one plan document by planID or path. */
export function createPlanDocReadTool(ctx: RuntimeContext): RuntimeTool {
  return {
    name: "plan_doc_read",
    description:
      "Read a Markdown plan document by planID or path. Plan documents live under .natalia/plans/. This is how you read the active plan's full text — the plan is never injected into your context, so read it before acting on it.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        planID: {
          type: "string",
          description: "The planID from plan_doc_list.",
        },
        path: {
          type: "string",
          description: "The document path (alternative to planID).",
        },
      },
      additionalProperties: false,
    },
    async execute(parsed) {
      const args = parsed as { planID?: string; path?: string };
      if (!args.planID && !args.path)
        return "plan_doc_read requires planID or path; use plan_doc_list to find an available plan document";
      try {
        return JSON.stringify(
          await ctx.ports.planDocRuntime.planDocRead({
            ...(args.planID ? { planID: args.planID } : {}),
            ...(args.path ? { path: args.path } : {}),
          }),
        );
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    },
  };
}

/**
 * `plan_doc_tick` — the model's "declare this step done / retract it" action
 * (EI §4 Phase 4). It flips one checkbox's marker (tick / untick), or — when the
 * plan carries no matching checkbox — appends the step to a `## 落地日志`
 * landing-log section (created on first use). It never rewrites any existing
 * line's text, so the model can declare progress without editing the plan; the
 * runtime then cross-checks the declaration against recorded evidence.
 */
export function createPlanDocTickTool(ctx: RuntimeContext): RuntimeTool {
  return {
    name: "plan_doc_tick",
    description:
      "Declare a plan step done (tick) or retract it (untick). Reads the plan, flips the matching checkbox marker, and writes it back — only the marker changes, never the step text. For a plan with no checkboxes, it appends the step to a '## 落地日志' landing-log section. Use it as you complete each step; a ticked step with no recorded evidence reads as 'gap'.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        planID: {
          type: "string",
          description: "The planID from plan_doc_list.",
        },
        task: {
          type: "string",
          description:
            "The exact step label (the checkbox text). Read the plan first to copy it.",
        },
        done: {
          type: "boolean",
          description: "true = declare done (tick); false = retract (untick).",
        },
      },
      required: ["planID", "task", "done"],
      additionalProperties: false,
    },
    async execute(parsed) {
      const args = parsed as {
        planID?: string;
        task?: string;
        done?: boolean;
      };
      if (!args.planID?.trim()) return "plan_doc_tick requires planID";
      if (typeof args.task !== "string" || !args.task.trim())
        return "plan_doc_tick requires a non-empty task label";
      if (typeof args.done !== "boolean")
        return "plan_doc_tick requires done (boolean)";
      try {
        const doc = await ctx.ports.planDocRuntime.planDocRead({
          planID: args.planID,
        });
        const result = applyPlanDocTick(doc.content, {
          task: args.task,
          done: args.done,
        });
        if (!result.ok) return result.reason;
        if (result.action !== "unticked" || result.content !== doc.content) {
          await ctx.ports.planDocRuntime.planDocWrite({
            path: doc.documentPath,
            content: result.content,
            ...(doc.planID ? { planID: doc.planID } : {}),
          });
        }
        return JSON.stringify({
          ok: true,
          action: result.action,
          planID: doc.planID,
          documentPath: doc.documentPath,
        });
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    },
  };
}

/**
 * `plan_pause` (EI §3.5 correction: 暂停 plan). The user asks for a pause in the
 * Live Work Chat ("约束 / 改计划 / 暂停走 chat 对话流"), so the main agent owns the
 * action. Pausing sets the plan's lifecycle status to `paused` (resume returns
 * it to `executing`); the change is a durable `plan.doc.status` fact, so replay
 * and the plan panel stay consistent.
 */
export function createPlanPauseTool(ctx: RuntimeContext): RuntimeTool {
  return {
    name: "plan_pause",
    description:
      "Pause or resume a plan at the user's request (El §3.5). paused=true marks the plan 'paused' so it is no longer treated as actively executing; paused=false resumes it to 'executing'. Use it only when the user asks to pause or resume the plan in chat.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        planID: {
          type: "string",
          description: "The planID from plan_doc_list.",
        },
        paused: {
          type: "boolean",
          description: "true = pause; false = resume.",
        },
      },
      required: ["planID", "paused"],
      additionalProperties: false,
    },
    async execute(parsed, context) {
      const args = parsed as { planID?: string; paused?: boolean };
      if (!args.planID?.trim()) return "plan_pause requires planID";
      if (typeof args.paused !== "boolean")
        return "plan_pause requires paused (boolean)";
      const status = args.paused ? "paused" : "executing";
      try {
        const result = await ctx.ports.planDocRuntime.planDocUpdateStatus({
          planID: args.planID,
          status,
          ...(context.sessionID ? { sessionID: context.sessionID } : {}),
        });
        if (!result.updated)
          return JSON.stringify({
            ok: false,
            reason: `no marked plan ${args.planID}`,
          });
        return JSON.stringify({
          ok: true,
          planID: args.planID,
          status,
        });
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    },
  };
}
