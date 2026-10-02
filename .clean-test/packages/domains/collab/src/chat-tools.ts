/**
 * Live Work Chat tools — runtime/collaboration/chat-tools.ts.
 *
 * Builds the tool surface the Chat runtime exposes: read-only main-agent tools
 * plus the collaboration/mailbox/plan drafting tools. Reads live state through
 * `RuntimeContext` at call time.
 */
import { readWorkspaceFile } from "@anthelia/workspace";
import {
  projectedMailboxMessages,
  sessionFactMailboxMessages,
  type ProjectedMailboxMessage,
} from "@anthelia/session";
import {
  globWorkspaceFilesBounded,
  grepWorkspaceFilesBounded,
  requireObject,
  requireString,
  type RuntimeTool,
} from "@anthelia/tools";
import { niaShellPolicyDenial } from "./nia-shell-policy";
import type { SessionID } from "@anthelia/contracts";
import { governanceLedgerController } from "@natalia/governance-ledger";
import {
  COLLABORATION_SERVICE,
  type CollaborationService,
} from "@natalia/collaboration";
import { chatToolSummary } from "./chat-summary";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";
import { ensureCompleteSessionFactState } from "@anthelia/substrate";
import { captureRepositoryEvidenceFields } from "@anthelia/substrate";
import { createDetourReviewTool } from "./plan-contract-tools";
import { logOf } from "@anthelia/operation-log";

const CHAT_READ_ONLY_TOOLS = new Set([
  "read_file",
  "glob",
  "grep",
  "web_fetch",
  "web_search",
  // Model-facing transcript paging: the cursor lets Navi/Nia read older
  // history on demand instead of the runtime pre-loading the journal.
  "session_history",
]);

/**
 * EI §3.9: the chain-visibility tools are shared read surfaces for Navi, Nia
 * and the Main Agent. Navi additionally owns `plan_propose` (the drafting half
 * of the WorkContract gate), while Nia keeps only the read half — it never
 * approves or mutates a contract.
 */
const CHAT_SHARED_INTELLIGENCE_TOOLS = new Set([
  "work_contract_read",
  "work_graph_query",
]);
const NAVI_EXTRA_TOOLS = new Set(["plan_propose", "run_shell"]);

/** Nia may run shell commands for verification, but the prompt forbids mutating
 * commands; the tool itself is the existing run_shell implementation. */
const NIA_EXTRA_TOOLS = new Set(["run_shell"]);

export const CHAT_SUGGESTION_PRIORITIES = ["normal", "high"] as const;
export const MAILBOX_PRIORITIES = ["normal", "high", "urgent"] as const;
export const MAILBOX_DELIVERY_POLICIES = [
  "next_safe_boundary",
  "before_next_tool",
  "before_next_side_effect",
  "immediate_control",
] as const;
export const AUDIT_VERDICTS = ["passed", "gaps"] as const;
export const DIFF_TARGETS = [
  "last_audit",
  "baseline",
  "rounds",
  "current",
] as const;
export const DIFF_FORMATS = ["unified", "summary", "files"] as const;

const MAILBOX_PAGE_LIMIT = 8;
const MAILBOX_BYTE_BUDGET = 40 * 1024;

/**
 * ADR D8: the tool set and its order are part of the cacheable provider
 * prefix. Sorting by name keeps the order deterministic across turns even when
 * the underlying registry's insertion order shifts (plugin load/unload).
 */
function stableToolOrder(tools: RuntimeTool[]): RuntimeTool[] {
  return [...tools].sort((left, right) => left.name.localeCompare(right.name));
}

function mailboxPage(
  messages: ProjectedMailboxMessage[],
  parsed: unknown,
): Record<string, unknown> {
  const args = parsed as { cursor?: unknown };
  let end = messages.length;
  if (typeof args.cursor === "string" && args.cursor) {
    const index = messages.findIndex(
      (message) => message.messageID === args.cursor,
    );
    if (index < 0)
      return {
        messages: [],
        returned: 0,
        total: messages.length,
        truncated: false,
        error: "cursor_not_found",
      };
    end = index;
  }
  const page: Array<Record<string, unknown>> = [];
  for (
    let index = end - 1;
    index >= 0 && page.length < MAILBOX_PAGE_LIMIT;
    index -= 1
  ) {
    const entry = mailboxEntry(messages[index]!);
    const candidate = [entry, ...page];
    if (
      page.length > 0 &&
      utf8Bytes(JSON.stringify({ messages: candidate })) > MAILBOX_BYTE_BUDGET
    )
      break;
    page.unshift(entry);
  }
  const start = end - page.length;
  return {
    messages: page,
    returned: page.length,
    total: messages.length,
    truncated: start > 0,
    ...(start > 0 ? { nextCursor: messages[start]!.messageID } : {}),
  };
}

function mailboxEntry(
  message: ProjectedMailboxMessage,
): Record<string, unknown> {
  return {
    messageID: message.messageID,
    source: message.source,
    priority: message.priority,
    intent: message.intent,
    text: message.text,
    safeSummary: message.safeSummary,
    ...(message.relatedPlanID ? { relatedPlanID: message.relatedPlanID } : {}),
    deliveryPolicy: message.deliveryPolicy,
    status: message.status,
    createdAt: message.createdAt,
    ...(message.reason ? { reason: message.reason } : {}),
  };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * The mailbox projection used by `mailbox_status`. When the execution's
 * incremental hot state is complete it already holds the whole mailbox
 * lifecycle, so a status page never forces the full journal; only a fast-attach
 * tail falls back to the explicit full load (which also completes the state).
 */
export async function mailboxMessagesForStatus(
  ctx: RuntimeContext,
  exec: SessionExecutionState,
): Promise<ProjectedMailboxMessage[]> {
  if (exec.factStateComplete === true && exec.factState)
    return sessionFactMailboxMessages(exec.factState);
  await ensureCompleteSessionFactState(ctx, exec);
  return exec.factStateComplete === true && exec.factState
    ? sessionFactMailboxMessages(exec.factState)
    : projectedMailboxMessages(exec.session.events);
}

export function planDocWriteTool(
  ctx: RuntimeContext,
  description: string,
  createdBy?: "user" | "live_chat" | "main_agent",
): RuntimeTool {
  return {
    name: "plan_doc_write",
    description,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        title: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute(parsed) {
      const args = parsed as {
        path?: string;
        content?: string;
        title?: string;
      };
      if (typeof args.path !== "string" || typeof args.content !== "string")
        return "plan_doc_write requires path and content";
      try {
        return JSON.stringify(
          await ctx.ports.planDocRuntime.planDocWrite({
            path: args.path,
            content: args.content,
            ...(args.title ? { title: args.title } : {}),
            ...(createdBy ? { createdBy } : {}),
          }),
        );
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    },
  };
}

export function planDocMarkTool(
  ctx: RuntimeContext,
  createdBy?: "user" | "live_chat" | "main_agent",
): RuntimeTool {
  return {
    name: "plan_doc_mark",
    description:
      "Mark a Markdown plan document as a formal Plan. It returns a stable planID used for handoff and audit routing.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        title: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(parsed) {
      const args = parsed as { path?: string; title?: string };
      if (typeof args.path !== "string") return "plan_doc_mark requires path";
      try {
        return JSON.stringify(
          await ctx.ports.planDocRuntime.planDocMark({
            path: args.path,
            ...(args.title ? { title: args.title } : {}),
            ...(createdBy ? { createdBy } : {}),
          }),
        );
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    },
  };
}

export function createChatTools(ctx: RuntimeContext) {
  return {
    naviChatTools,
    niaChatTools,
    chatToolSummary,
  };

  function naviChatTools(
    exec: SessionExecutionState | undefined = ctx.ports.getActiveExec(),
  ): RuntimeTool[] {
    const {
      getExecutionBySession,
      redactToolOutput,
      currentSessionSnapshot,
      wakeMainForCollaboration,
      createCollabChatTool,
      enqueueMailboxMessage,
      cancelMailboxMessage,
    } = ctx.ports;
    const { tools } = ctx.state;
    const visible: RuntimeTool[] = [];
    for (const tool of tools.values())
      if (
        CHAT_READ_ONLY_TOOLS.has(tool.name) ||
        CHAT_SHARED_INTELLIGENCE_TOOLS.has(tool.name) ||
        NAVI_EXTRA_TOOLS.has(tool.name)
      )
        visible.push(
          tool.name === "run_shell"
            ? withCollaboratorShellPolicy(tool, "Navi")
            : tool,
        );
    visible.push(
      {
        name: "session_snapshot",
        description:
          "Read the main agent's current live status: agent status, current step, active tool, changed/unvalidated file counts, PTY and sandbox state. Call it when the user asks what the main agent is doing now or whether it finished something — the injected context can be a moment stale.",
        requiresApproval: false,
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute() {
          if (!exec) return JSON.stringify({ agentStatus: "unknown" });
          await ensureCompleteSessionFactState(ctx, exec);
          return JSON.stringify(
            currentSessionSnapshot(exec, `snapshot:live:${exec.session.id}`),
          );
        },
      },
      {
        name: "mailbox_status",
        description:
          "Read the Live Work Chat mailbox as a JSON page: every intent with its priority, delivery policy and current status (queued/delivered/acknowledged). The response includes returned, total, truncated, and nextCursor; pass nextCursor back to read older pages.",
        requiresApproval: false,
        parameters: {
          type: "object",
          properties: {
            cursor: {
              type: "string",
              description:
                "Opaque cursor from a previous mailbox_status response; returns older messages before it.",
            },
          },
          additionalProperties: false,
        },
        async execute(parsed) {
          if (!exec)
            return JSON.stringify({
              messages: [],
              returned: 0,
              total: 0,
              truncated: false,
            });
          return JSON.stringify(
            mailboxPage(await mailboxMessagesForStatus(ctx, exec), parsed),
          );
        },
      },
      {
        name: "collab_suggest",
        description:
          "Send a suggestion to the main agent (Natalia) — a collaborator's view the user has not necessarily decided on. Natalia sees it in her next turn's context and may adopt, reject or defer it. Use sparingly, only when the suggestion is genuinely useful and grounded in the shared context.",
        requiresApproval: false,
        parameters: {
          type: "object",
          properties: {
            suggestion: { type: "string" },
            rationale: { type: "string" },
            priority: {
              type: "string",
              enum: [...CHAT_SUGGESTION_PRIORITIES],
            },
          },
          required: ["suggestion"],
          additionalProperties: false,
        },
        async execute(parsed, context) {
          const args = parsed as {
            suggestion?: string;
            rationale?: string;
            priority?: string;
          };
          if (typeof args.suggestion !== "string" || !args.suggestion.trim())
            return "collab_suggest requires a non-empty suggestion";
          if (!exec) return "no session";
          const service = ctx.ports.resolveService<CollaborationService>(
            COLLABORATION_SERVICE,
          );
          if (!service) return "collaboration service unavailable";
          let sent;
          try {
            ({ message: sent } = await service.send({
              sessionID: exec.session.id as SessionID,
              kind: "suggestion",
              from: "live_chat",
              text: redactToolOutput(args.suggestion, true),
              ...(args.rationale
                ? { rationale: redactToolOutput(args.rationale, true) }
                : {}),
              priority: args.priority === "high" ? "high" : "normal",
            }));
          } catch (error) {
            return `collab_suggest: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
          const message = sent;
          // Symmetric round-robin: if the main agent is idle, wake it to see
          // the suggestion; if it is working, the suggestion reaches its next
          // turn through <navi_collaborations>.
          wakeMainForCollaboration(exec, message.id, "suggestion", "Navi");
          return JSON.stringify({ sent: true });
        },
      },
      {
        name: "collab_answer",
        description:
          "Answer a question the main agent (Natalia) asked you through the collaboration channel. Include the question's exact message ID from the context's natalia_collaborations block, and answer based on the shared context.",
        requiresApproval: false,
        parameters: {
          type: "object",
          properties: {
            questionID: { type: "string" },
            answer: { type: "string" },
            declined: {
              type: "boolean",
              description:
                "Set when you decline to advise: the question is outside your technical remit and you are not the right source. The answer text must say why. Declining is a legitimate outcome, not a failure — use it only for out-of-remit questions, never for hard ones.",
            },
          },
          required: ["questionID", "answer"],
          additionalProperties: false,
        },
        async execute(parsed, context) {
          const args = parsed as {
            questionID?: string;
            answer?: string;
            declined?: boolean;
          };
          if (
            typeof args.questionID !== "string" ||
            typeof args.answer !== "string"
          )
            return "collab_answer requires questionID and answer; questionID comes from the <natalia_collaborations> context block";
          const owner = context.sessionID
            ? getExecutionBySession().get(context.sessionID as SessionID)
            : undefined;
          if (!owner) return "no session";
          const service = ctx.ports.resolveService<CollaborationService>(
            COLLABORATION_SERVICE,
          );
          if (!service) return "collaboration service unavailable";
          let message;
          try {
            ({ message } = await service.send({
              sessionID: owner.session.id as SessionID,
              kind: "answer",
              from: "live_chat",
              replyToID: args.questionID,
              text: redactToolOutput(args.answer, true),
              ...(args.declined ? { advisorOutcome: "declined" as const } : {}),
            }));
          } catch (error) {
            return `collab_answer: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
          wakeMainForCollaboration(owner, message.id, "answer", "Navi");
          return JSON.stringify({ answered: true });
        },
      },
      createCollabChatTool("live_chat", exec),
      {
        name: "mailbox_send",
        description:
          "Send a durable intent to the main agent as a tagged ordinary message before the next model step. Ordinary intents (constraint, pause, request_report, …) send immediately. next_plan_handoff requires relatedPlanID of a user-accepted plan — propose the draft first and wait for Accept. intent is one of clarification, constraint, reprioritize, pause, cancel, request_report, proposed_change, next_plan_handoff.",
        requiresApproval: false,
        parameters: {
          type: "object",
          properties: {
            intent: { type: "string" },
            text: { type: "string" },
            priority: {
              type: "string",
              enum: [...MAILBOX_PRIORITIES],
            },
            deliveryPolicy: {
              type: "string",
              enum: [...MAILBOX_DELIVERY_POLICIES],
            },
            relatedPlanID: { type: "string" },
          },
          required: ["intent", "text"],
          additionalProperties: false,
        },
        async execute(parsed) {
          const args = parsed as {
            intent?: string;
            text?: string;
            priority?: string;
            deliveryPolicy?: string;
            relatedPlanID?: string;
          };
          if (typeof args.intent !== "string" || typeof args.text !== "string")
            return "mailbox_send requires intent and text; intent must be one of clarification, constraint, reprioritize, pause, cancel, request_report, proposed_change, next_plan_handoff";
          return JSON.stringify(
            await enqueueMailboxMessage(
              {
                intent: args.intent,
                text: args.text,
                ...(args.priority ? { priority: args.priority as never } : {}),
                ...(args.deliveryPolicy
                  ? { deliveryPolicy: args.deliveryPolicy as never }
                  : {}),
                ...(args.relatedPlanID
                  ? { relatedPlanID: args.relatedPlanID }
                  : {}),
              },
              exec,
            ),
          );
        },
      },
      {
        name: "mailbox_cancel",
        description:
          "Cancel a queued or delivered mailbox message that should not reach or remain with the main agent. Use the exact messageID from mailbox_send or the pending mailbox list.",
        requiresApproval: false,
        parameters: {
          type: "object",
          properties: {
            messageID: { type: "string" },
            reason: { type: "string" },
          },
          required: ["messageID"],
          additionalProperties: false,
        },
        async execute(parsed) {
          const args = parsed as { messageID?: string; reason?: string };
          if (typeof args.messageID !== "string")
            return "mailbox_cancel requires messageID; use the exact messageID returned by mailbox_send or shown in the pending mailbox list";
          return JSON.stringify(
            await cancelMailboxMessage(args.messageID, args.reason, exec),
          );
        },
      },
    );
    if (!visible.some((tool) => tool.name === "read_file")) {
      visible.push({
        name: "read_file",
        description:
          "Read a text file inside the workspace. Use it when the user asks about project files or asks you to read a local document.",
        requiresApproval: false,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            offset: { type: "number" },
            limit: { type: "number" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        async execute(parsed) {
          const args = parsed as {
            path?: string;
            offset?: number;
            limit?: number;
          };
          if (typeof args.path !== "string") return "read_file requires path";
          try {
            const result = await readWorkspaceFile({
              workspaceRoot: ctx.ports.getWorkspaceRoot(),
              path: args.path,
              ...(args.offset ? { offset: args.offset } : {}),
              ...(args.limit ? { limit: args.limit } : {}),
            });
            return result.content;
          } catch (cause) {
            return cause instanceof Error ? cause.message : String(cause);
          }
        },
      });
    }
    if (!visible.some((tool) => tool.name === "glob")) {
      visible.push({
        name: "glob",
        description:
          "List files under a workspace directory matching a glob pattern. Use it to find md, source, config or test files. Results are paginated; if the response contains nextCursor, call glob again with the same pattern/path and that cursor until no nextCursor is returned.",
        requiresApproval: false,
        timeoutSec: 20,
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string" },
            limit: { type: "number" },
            cursor: { type: "string" },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
        async execute(parsed, context) {
          const args = parsed as {
            pattern?: string;
            path?: string;
            limit?: number;
            cursor?: string;
          };
          if (typeof args.pattern !== "string") return "glob requires pattern";
          try {
            return JSON.stringify(
              await globWorkspaceFilesBounded({
                workspaceRoot: ctx.ports.getWorkspaceRoot(),
                pattern: args.pattern,
                ...(args.path ? { path: args.path } : {}),
                ...(args.limit !== undefined ? { limit: args.limit } : {}),
                ...(args.cursor ? { cursor: args.cursor } : {}),
                signal: context.signal,
                authorize: async (authorizeInput) =>
                  await context.workspaceReadAuthorize?.(authorizeInput),
              }),
            );
          } catch (cause) {
            return cause instanceof Error ? cause.message : String(cause);
          }
        },
      });
    }
    if (!visible.some((tool) => tool.name === "grep")) {
      visible.push({
        name: "grep",
        description:
          "Search file contents in the workspace with a regular expression. Results are paginated; if the response contains nextCursor, call grep again with the same pattern/path/include and that cursor until no nextCursor is returned.",
        requiresApproval: false,
        timeoutSec: 20,
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string" },
            include: { type: "string" },
            limit: { type: "number" },
            cursor: { type: "string" },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
        async execute(parsed, context) {
          const args = parsed as {
            pattern?: string;
            path?: string;
            include?: string;
            limit?: number;
            cursor?: string;
          };
          if (typeof args.pattern !== "string") return "grep requires pattern";
          try {
            return JSON.stringify(
              await grepWorkspaceFilesBounded({
                workspaceRoot: ctx.ports.getWorkspaceRoot(),
                pattern: args.pattern,
                ...(args.path ? { path: args.path } : {}),
                ...(args.include ? { include: args.include } : {}),
                ...(args.limit !== undefined ? { limit: args.limit } : {}),
                ...(args.cursor ? { cursor: args.cursor } : {}),
                signal: context.signal,
                authorize: async (authorizeInput) =>
                  await context.workspaceReadAuthorize?.(authorizeInput),
              }),
            );
          } catch (cause) {
            return cause instanceof Error ? cause.message : String(cause);
          }
        },
      });
    }
    if (!visible.some((tool) => tool.name === "plan_doc_list")) {
      visible.push({
        name: "plan_doc_list",
        description:
          "List the workspace plan documents. Marked plan documents carry a stable planID and documentPath.",
        requiresApproval: false,
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute() {
          return JSON.stringify(await ctx.ports.planDocRuntime.planDocList());
        },
      });
    }
    if (!visible.some((tool) => tool.name === "plan_doc_read")) {
      visible.push({
        name: "plan_doc_read",
        description:
          "Read a Markdown plan document by planID or path. Plan documents live under .natalia/plans/.",
        requiresApproval: false,
        parameters: {
          type: "object",
          properties: {
            planID: { type: "string" },
            path: { type: "string" },
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
      });
    }
    if (!visible.some((tool) => tool.name === "plan_doc_write")) {
      visible.push(
        planDocWriteTool(
          ctx,
          "Write or update a Markdown plan document under .natalia/plans/. Use it when the user asks to draft or revise a plan document. Never write project source with this tool.",
          "live_chat",
        ),
      );
    }
    if (!visible.some((tool) => tool.name === "plan_doc_mark")) {
      // EI §8.1: provenance follows the caller — Navi is the Live Work Chat.
      visible.push(planDocMarkTool(ctx, "live_chat"));
    }
    // ADR D8: tool schemas and order are part of the cacheable prefix. The set
    // is already fixed, but registry insertion order can shift with plugin
    // load/unload; sort by name so the set and order stay stable across turns.
    return stableToolOrder(visible);
  }

  function withCollaboratorShellPolicy(
    tool: RuntimeTool,
    who: "Nia" | "Navi",
  ): RuntimeTool {
    return {
      ...tool,
      description: `${tool.description} ${who} may only run read-only inspection and verification commands.`,
      async execute(input, context) {
        const args = requireObject(input);
        const command = requireString(args.command, "command");
        const denial = await niaShellPolicyDenial(command, who);
        if (denial) throw new Error(denial);
        return tool.execute(input, context);
      },
    };
  }

  function niaChatTools(
    exec: SessionExecutionState | undefined = ctx.ports.getActiveExec(),
  ): RuntimeTool[] {
    const { currentSessionSnapshot } = ctx.ports;
    const visible = [...ctx.state.tools.values()]
      .filter(
        (tool) =>
          CHAT_READ_ONLY_TOOLS.has(tool.name) ||
          CHAT_SHARED_INTELLIGENCE_TOOLS.has(tool.name) ||
          NIA_EXTRA_TOOLS.has(tool.name),
      )
      .map((tool) =>
        tool.name === "run_shell"
          ? withCollaboratorShellPolicy(tool, "Nia")
          : tool,
      );
    visible.push(
      {
        name: "session_snapshot",
        description: "Read Natalia's current live session status.",
        requiresApproval: false,
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute() {
          if (!exec) return JSON.stringify({ agentStatus: "unknown" });
          await ensureCompleteSessionFactState(ctx, exec);
          return JSON.stringify(
            currentSessionSnapshot(exec, `snapshot:nia:${exec.session.id}`),
          );
        },
      },
      {
        name: "mailbox_status",
        description:
          "Read Natalia's pending mailbox intents as a JSON page. Pass nextCursor back to read older pages.",
        requiresApproval: false,
        parameters: {
          type: "object",
          properties: {
            cursor: {
              type: "string",
              description:
                "Opaque cursor from a previous mailbox_status response; returns older messages before it.",
            },
          },
          additionalProperties: false,
        },
        async execute(parsed) {
          if (!exec)
            return JSON.stringify({
              messages: [],
              returned: 0,
              total: 0,
              truncated: false,
            });
          return JSON.stringify(
            mailboxPage(await mailboxMessagesForStatus(ctx, exec), parsed),
          );
        },
      },
      {
        name: "plan_doc_list",
        description: "List the workspace plan documents.",
        requiresApproval: false,
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute() {
          return JSON.stringify(await ctx.ports.planDocRuntime.planDocList());
        },
      },
      {
        name: "plan_doc_read",
        description: "Read a plan document by planID or path.",
        requiresApproval: false,
        parameters: {
          type: "object",
          properties: {
            planID: { type: "string" },
            path: { type: "string" },
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
      },
      planDocWriteTool(
        ctx,
        "Update the Markdown content of the plan document being audited. Use this after an audit to record concrete gaps, fixes, verification notes, or status updates in the document itself. Only .natalia/plans/ paths are accepted; never write project source.",
      ),
    );
    visible.push(ctx.ports.createCollabChatTool("nia", exec));
    if (!visible.some((tool) => tool.name === "audit_report")) {
      visible.push({
        name: "audit_report",
        description:
          "Submit the audit outcome for an active plan. Use passed when every plan item is verified and no gaps remain; use gaps when the audit found missing evidence, incomplete implementation, or mismatches. The runtime will mark the plan completed or audit_gaps and route the result back to Natalia.",
        requiresApproval: false,
        parameters: {
          type: "object",
          properties: {
            planID: {
              type: "string",
              description: "The exact planID being audited.",
            },
            verdict: {
              type: "string",
              enum: [...AUDIT_VERDICTS],
              description:
                "passed when the plan is fully verified; gaps when there are open audit findings.",
            },
            gaps: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional concrete gap descriptions when verdict is gaps.",
            },
          },
          required: ["planID", "verdict"],
          additionalProperties: false,
        },
        async execute(parsed, context) {
          const args = parsed as {
            planID?: string;
            verdict?: string;
            gaps?: string[];
          };
          if (
            typeof args.planID !== "string" ||
            (args.verdict !== "passed" && args.verdict !== "gaps")
          )
            return "audit_report requires planID and verdict passed|gaps";
          const status = args.verdict === "passed" ? "completed" : "audit_gaps";
          logOf(ctx.state.serviceDirectory).info(
            "nia-audit-report",
            "submitting",
            {
              planID: args.planID,
              verdict: args.verdict,
              status,
              sessionID: (context as { sessionID?: string } | undefined)
                ?.sessionID,
            },
          );
          let result;
          try {
            result = await ctx.ports.planDocRuntime.planDocUpdateStatus({
              planID: args.planID,
              status,
              ...((context as { sessionID?: string } | undefined)?.sessionID
                ? { sessionID: (context as { sessionID: string }).sessionID }
                : {}),
            });
          } catch (error) {
            return `audit_report: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }

          let round = 0;
          let roundCheckpointID: string | undefined;
          let evidenceID: string | undefined;
          try {
            const sessionID = (context as { sessionID?: string } | undefined)
              ?.sessionID as
              | import("@anthelia/contracts").SessionID
              | undefined;
            const owner = sessionID
              ? ctx.ports.getExecutionBySession().get(sessionID)
              : exec;
            if (owner) {
              const checkpointController =
                await ctx.ports.initializeCheckpointController(owner);
              const rounds =
                (await checkpointController?.listAuditRounds?.(args.planID)) ??
                [];
              round = (rounds.at(-1)?.round ?? 0) + 1;
              const record =
                await checkpointController?.createAuditRoundCheckpoint?.({
                  planID: args.planID,
                  round,
                  verdict: args.verdict as "gaps" | "passed",
                  context: owner.context,
                  step: owner.context.journalStatus().messageCount,
                  sessionID: owner.session
                    .id as import("@anthelia/contracts").SessionID,
                  turnID: (context as { turnID?: string } | undefined)?.turnID,
                });
              roundCheckpointID = record?.id;
              // EI §8.1: every audit round is evidence — the drift R and the
              // completion card read it. A passed round is a validated audit;
              // a gaps round records the open gaps as its known gaps.
              const governanceLedger = ctx.ports.resolveService<{
                buildEvidenceRecorded: (input: {
                  id: string;
                  taskID: string;
                  objective: string;
                  status: string;
                  validations?: unknown[];
                  knownGaps?: string[];
                  recordedAt: string;
                  repositoryVersion?: string;
                  commit?: string;
                  manifestRef?: string;
                }) => import("@anthelia/contracts").RuntimeEvent;
              }>(governanceLedgerController.id);
              if (governanceLedger) {
                const now = new Date().toISOString();
                evidenceID = `evidence:${args.planID}:audit:${round}`;
                // EI E2: an audit round is evidence like any other — stamp the
                // same repository refs as every other evidence writer.
                const repoRefs = await captureRepositoryEvidenceFields(
                  ctx.ports.getWorkspaceRoot(),
                );
                ctx.ports.publishForSession(
                  owner,
                  governanceLedger.buildEvidenceRecorded({
                    id: evidenceID,
                    taskID: args.planID,
                    objective: `Nia audit round ${round} of plan ${args.planID}`,
                    status: args.verdict === "passed" ? "validated" : "failed",
                    validations: [
                      {
                        command: `audit round ${round}`,
                        result: args.verdict === "passed" ? "passed" : "failed",
                        safeSummary:
                          args.verdict === "passed"
                            ? `Nia audit round ${round} passed`
                            : `Nia audit round ${round} found ${(args.gaps ?? []).length} gap(s)`,
                      },
                    ],
                    ...(args.gaps?.length ? { knownGaps: args.gaps } : {}),
                    recordedAt: now,
                    ...repoRefs,
                  }),
                );
              }
            }
          } catch (error) {
            logOf(ctx.state.serviceDirectory).warn(
              "nia-audit-report",
              "round checkpoint failed",
              {
                planID: args.planID,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }

          return JSON.stringify({
            reported: true,
            planID: args.planID,
            verdict: args.verdict,
            status,
            gaps: args.gaps ?? [],
            updated: result.updated,
            ...(round ? { round } : {}),
            ...(roundCheckpointID ? { roundCheckpointID } : {}),
            ...(evidenceID ? { evidenceID } : {}),
            ...(args.verdict === "passed" ? { noWakeNatalia: true } : {}),
          });
        },
      });
    }
    visible.push({
      name: "diff_workspace",
      description:
        "Compare workspace state against audit round checkpoints without using Git. " +
        "Use target=last_audit to see changes since the previous audit, target=baseline for the full plan diff, " +
        "or target=rounds to compare two specific audit rounds. Restrict paths to avoid a huge diff.",
      requiresApproval: false,
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: [...DIFF_TARGETS],
          },
          planID: { type: "string" },
          fromRound: { type: "number" },
          toRound: { type: "number" },
          paths: { type: "array", items: { type: "string" } },
          format: {
            type: "string",
            enum: [...DIFF_FORMATS],
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
      async execute(parsed, context) {
        const args = parsed as {
          target?: string;
          planID?: string;
          fromRound?: number;
          toRound?: number;
          paths?: string[];
          format?: string;
        };
        if (!args.target) return "diff_workspace requires target";
        const sessionID = (context as { sessionID?: string } | undefined)
          ?.sessionID as import("@anthelia/contracts").SessionID | undefined;
        const checkpoint = ctx.ports.getCheckpointRuntime();
        const paths = Array.isArray(args.paths)
          ? args.paths.filter(
              (value): value is string => typeof value === "string",
            )
          : undefined;
        const from =
          args.target === "last_audit"
            ? ({ kind: "last_audit", planID: args.planID } as const)
            : args.target === "baseline"
              ? ({ kind: "baseline" } as const)
              : args.target === "rounds"
                ? {
                    kind: "round",
                    planID: args.planID ?? "",
                    round: Number(args.fromRound ?? 0),
                  }
                : args.target === "current"
                  ? {
                      kind: "round",
                      planID: args.planID ?? "",
                      round: Number(args.toRound ?? 0),
                    }
                  : undefined;
        if (!from) return "diff_workspace: unsupported target";
        const to =
          args.target === "last_audit" || args.target === "baseline"
            ? ({ kind: "current" } as const)
            : args.target === "rounds"
              ? {
                  kind: "round",
                  planID: args.planID ?? "",
                  round: Number(args.toRound ?? 0),
                }
              : ({ kind: "current" } as const);
        try {
          if (!checkpoint.roundDiff)
            return "diff_workspace: round diff unavailable";
          const changes = await checkpoint.roundDiff({
            from: from as import("@anthelia/contracts").CheckpointRef,
            to: to as import("@anthelia/contracts").CheckpointRef,
            paths,
            includePatch: args.format !== "summary" && args.format !== "files",
            includeContent: false,
          });
          const additions = changes.reduce(
            (sum, change) => sum + change.additions,
            0,
          );
          const deletions = changes.reduce(
            (sum, change) => sum + change.deletions,
            0,
          );
          const rows =
            args.format === "files"
              ? changes.map((change) => ({
                  path: change.path,
                  operation: change.operation,
                  additions: change.additions,
                  deletions: change.deletions,
                }))
              : changes.map((change) => ({
                  path: change.path,
                  operation: change.operation,
                  additions: change.additions,
                  deletions: change.deletions,
                  ...(change.patch ? { patch: change.patch } : {}),
                }));
          return JSON.stringify({
            from,
            to,
            files: changes.length,
            additions,
            deletions,
            changes: rows,
          });
        } catch (error) {
          return `diff_workspace: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      },
    });
    // EI §3.4: Nia reviews requested detours; her verdict is a reference for
    // the user, who decides through the detour gate. Nia-only (not the main
    // agent, which declares detours but never reviews its own).
    if (!visible.some((tool) => tool.name === "detour_review"))
      visible.push(createDetourReviewTool(ctx));
    // ADR D8: stable order across turns (see naviChatTools).
    return stableToolOrder(visible);
  }
}
