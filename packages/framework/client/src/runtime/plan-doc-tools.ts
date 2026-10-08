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
import type { RuntimeTool, ToolOutputDefinition } from "@anthelia/tools";

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
    output: planListCard(),
    async execute() {
      return JSON.stringify(await ctx.ports.planDocRuntime.planDocList());
    },
  };
}

/** The plan-document read card (S4): the document is the page. */
function planReadCard(): ToolOutputDefinition {
  const facts = (value: string): Record<string, unknown> => {
    try {
      const decoded = JSON.parse(value) as unknown;
      return decoded && typeof decoded === "object" && !Array.isArray(decoded)
        ? (decoded as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };
  const text = (
    source: Record<string, unknown>,
    key: string,
  ): string | undefined =>
    typeof source[key] === "string" ? (source[key] as string) : undefined;
  return {
    schema: { type: "object", properties: {} },
    presentCall(args) {
      const parsed =
        args && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {};
      const path = text(parsed, "path");
      const planID = text(parsed, "planID");
      return {
        kind: "read",
        title: path ?? planID ?? "plan",
        summary: "read",
      };
    },
    presentationMeta(_args, value) {
      const record = facts(value);
      const content = text(record, "content") ?? "";
      return {
        ...(text(record, "planID") ? { planID: text(record, "planID") } : {}),
        ...(text(record, "title") ? { title: text(record, "title") } : {}),
        ...(text(record, "documentPath")
          ? { documentPath: text(record, "documentPath") }
          : {}),
        totalLines: content.split("\n").length,
      };
    },
    presentResult(args, value, meta) {
      const record = facts(value);
      const content = text(record, "content") ?? value;
      const parsed =
        args && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {};
      const planID = text(meta ?? {}, "planID") ?? text(record, "planID");
      const documentPath =
        text(meta ?? {}, "documentPath") ?? text(record, "documentPath");
      const title = text(meta ?? {}, "title") ?? text(record, "title");
      const numbered = content.split("\n").map((line, index) => ({
        number: index + 1,
        text: line,
      }));
      return {
        kind: "read",
        title: text(parsed, "path") ?? documentPath ?? title ?? "plan",
        summary: `${numbered.length} lines`,
        content,
        lines: numbered,
        totalLines: numbered.length,
        lang: "markdown",
        meta: [
          ...(planID ? [["planID", planID] as [string, string]] : []),
          ...(title ? [["title", title] as [string, string]] : []),
        ],
      };
    },
  };
}

/** The plan list card (S4): the list is the reading. */
function planListCard(): ToolOutputDefinition {
  return {
    schema: { type: "object", properties: {} },
    presentCall() {
      return { kind: "generic", title: "plans", summary: "list" };
    },
    presentationMeta(_args, value) {
      let rows: Array<Record<string, unknown>> = [];
      try {
        const decoded = JSON.parse(value) as unknown;
        if (Array.isArray(decoded))
          rows = decoded as Array<Record<string, unknown>>;
      } catch {
        // degrade, never throw
      }
      return { total: rows.length };
    },
    presentResult(_args, value, meta) {
      let rows: Array<Record<string, unknown>> = [];
      try {
        const decoded = JSON.parse(value) as unknown;
        if (Array.isArray(decoded))
          rows = decoded as Array<Record<string, unknown>>;
      } catch {
        // degrade, never throw
      }
      const lines = rows.map((row) => {
        const planID = typeof row.planID === "string" ? row.planID : "";
        const status = typeof row.status === "string" ? row.status : "";
        const documentPath =
          typeof row.documentPath === "string" ? row.documentPath : "";
        const head = planID || documentPath || "plan";
        return status ? `${head} · ${status}` : head;
      });
      const total = typeof meta?.total === "number" ? meta.total : rows.length;
      return {
        kind: "generic",
        title: "plans",
        summary: `${total} plan${total === 1 ? "" : "s"}`,
        ...(lines.length ? { body: lines.join("\n") } : {}),
        ...(total > 0
          ? { meta: [["total", String(total)] as [string, string]] }
          : {}),
      };
    },
  };
}
/**
 * The plan family's write card (S4): a plan write's answer is WHAT changed —
 * the plan's identity, the document path, the revision it reached, the
 * action taken. One line per fact; the raw envelope is what this replaced.
 */
function planWriteCard(input: {
  callSummary: string;
  titleKey?: string;
}): ToolOutputDefinition {
  const facts = (value: string): Record<string, unknown> => {
    try {
      const decoded = JSON.parse(value) as unknown;
      return decoded && typeof decoded === "object" && !Array.isArray(decoded)
        ? (decoded as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };
  const titleOf = (
    args: unknown,
    record: Record<string, unknown>,
    meta: Record<string, unknown> | undefined,
  ): string => {
    const parsed =
      args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const key = input.titleKey ? parsed[input.titleKey] : undefined;
    const fromArgs = typeof key === "string" && key ? key : undefined;
    const fromPath =
      typeof parsed.path === "string" && parsed.path ? parsed.path : undefined;
    const fromDoc =
      typeof (meta?.documentPath ?? record.documentPath) === "string"
        ? String(meta?.documentPath ?? record.documentPath)
        : undefined;
    return fromArgs ?? fromPath ?? fromDoc ?? "plan";
  };
  return {
    schema: { type: "object", properties: {} },
    presentCall(args) {
      return {
        kind: "generic",
        title: titleOf(args, {}, undefined),
        summary: input.callSummary,
      };
    },
    presentationMeta(_args, value) {
      const record = facts(value);
      const meta: Record<string, unknown> = {};
      for (const key of [
        "planID",
        "documentPath",
        "action",
        "status",
        "previousStatus",
        "revision",
        "marked",
        "deleted",
        "ok",
      ])
        if (record[key] !== undefined) meta[key] = record[key];
      return meta;
    },
    presentResult(args, value, meta) {
      const record = facts(value);
      const merged: Record<string, unknown> = { ...record, ...(meta ?? {}) };
      const lines: string[] = [];
      if (typeof merged.planID === "string")
        lines.push(`plan · ${merged.planID}`);
      if (typeof merged.documentPath === "string")
        lines.push(`path · ${merged.documentPath}`);
      if (typeof merged.action === "string")
        lines.push(`action · ${merged.action}`);
      if (typeof merged.status === "string")
        lines.push(`status · ${merged.status}`);
      if (typeof merged.previousStatus === "string")
        lines.push(`previous · ${merged.previousStatus}`);
      if (typeof merged.revision === "number")
        lines.push(`revision · ${merged.revision}`);
      const facets: Array<[string, string]> = [];
      if (typeof merged.ok === "boolean")
        facets.push(["ok", String(merged.ok)]);
      if (typeof merged.marked === "boolean")
        facets.push(["marked", String(merged.marked)]);
      return {
        kind: "generic",
        title: titleOf(args, record, meta),
        summary: lines[0] ?? input.callSummary,
        ...(lines.length ? { body: lines.join("\n") } : {}),
        ...(facets.length ? { meta: facets } : {}),
      };
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
    output: planReadCard(),
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
    output: planWriteCard({ callSummary: "tick", titleKey: "planID" }),
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
          return JSON.stringify({
            ok: true,
            action: result.action,
            planID: doc.planID,
            documentPath: doc.documentPath,
          });
        }
        // P0-4: an untick that changed nothing (the task has no checkbox in
        // this document) used to answer `ok:true, action:"unticked"` while
        // the document still carried the tick. The truth is that there was
        // nothing to retract — say so, and say what to do instead.
        return JSON.stringify({
          ok: false,
          reason:
            `nothing to retract: no checkbox for "${args.task.trim()}" in ` +
            `${doc.documentPath}. This plan document has no checkbox for that task; ` +
            `edit the document directly to change it.`,
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
      "Pause or resume a plan at the user's request (El §3.5). paused=true marks the plan 'paused' so it is no longer treated as actively executing; paused=false resumes it to 'executing'. Use it only when the user asks to pause or resume the plan in chat. A plan that is completed or handed_off (terminal) refuses both directions and says so — a finished plan stays finished.",
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
    output: planWriteCard({ callSummary: "pause", titleKey: "planID" }),
    async execute(parsed, context) {
      const args = parsed as { planID?: string; paused?: boolean };
      if (!args.planID?.trim()) return "plan_pause requires planID";
      if (typeof args.paused !== "boolean")
        return "plan_pause requires paused (boolean)";
      try {
        // P0-3: the pause keeps the plan's OWN status. The port records the
        // status the plan had before the pause and a resume returns it, so
        // `audit_gaps` round trips as `audit_gaps` — not as a hardcoded
        // `executing` (the 2026-10-08 audit's finding).
        const result = await ctx.ports.planDocRuntime.planDocPause({
          planID: args.planID,
          paused: args.paused,
          ...(context.sessionID ? { sessionID: context.sessionID } : {}),
        });
        if (!result.updated)
          return JSON.stringify({
            ok: false,
            reason: result.reason ?? `no marked plan ${args.planID}`,
          });
        return JSON.stringify({
          ok: true,
          planID: args.planID,
          status: result.status,
          ...(args.paused && result.previousStatus
            ? { previousStatus: result.previousStatus }
            : {}),
        });
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    },
  };
}
