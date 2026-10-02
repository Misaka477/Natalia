import type { SessionID } from "@anthelia/contracts";
import type { RuntimeContext } from "@anthelia/substrate";
import type { RuntimeTool } from "@anthelia/tools";
import { estimateTokens } from "@anthelia/runtime";
import { workspaceStoreID } from "@anthelia/platform";
import {
  buildContextPack,
  recallKnowledge,
  recallMemoryLanes,
  rinaMemory,
  rinaVault,
  type VaultPackRole,
  type VaultRecordType,
} from "@anthelia/rina";

/**
 * The RINA study's Agent Tools — five READ-ONLY faces over the vault
 * (they never touch the workspace: their power is exactly the query
 * surface, nothing else).
 *
 * THE ISOLATION DISCIPLINE, at every face: the session defaults to the
 * current turn's and an ARG naming another session is REFUSED — the
 * study's "禁止跨 session 查询" is an edge rule, not a convention, and
 * an Open Question (permission tiers for Navi/Nia) may widen it later
 * with the same face it is enforced at today.
 */

const AGENTS: readonly VaultPackRole[] = ["natalia", "navi", "nia"];
const RECORD_TYPES: readonly VaultRecordType[] = [
  "plan",
  "mailbox",
  "collab",
  "evidence",
  "tool_history",
  "decision",
];
const PACK_DEFAULT_BUDGET = 2000;
const PACK_MAX_BUDGET = 8000;
const PACK_CANDIDATE_CAP = 50;

type SessionAnswer = { sessionID: string } | { error: string; note?: string };

export function createRinaContextTools(ctx: RuntimeContext): RuntimeTool[] {
  const currentSession = (
    args: { sessionID?: unknown },
    context: { sessionID?: string },
  ): SessionAnswer => {
    const asked = args.sessionID;
    const current = (context.sessionID ?? ctx.ports.getSessionID()) as
      | SessionID
      | undefined;
    if (!current) return { error: "no_current_session" };
    if (typeof asked === "string" && asked && asked !== current)
      return {
        error: "cross_session_forbidden",
        note: `queries answer this session only (asked: ${asked}, current: ${current}) — the study's isolation rule`,
      };
    return { sessionID: current };
  };

  const timeWindow = (
    raw: unknown,
  ): { after?: string; before?: string } | { error: string } => {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== "object") return { error: "time_range_malformed" };
    const range = raw as { after?: unknown; before?: unknown };
    const iso = (value: unknown): string | undefined => {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
        return "invalid";
      return value;
    };
    const after = iso(range.after);
    const before = iso(range.before);
    if (after === "invalid" || before === "invalid")
      return { error: "time_range_malformed" };
    return {
      ...(after ? { after } : {}),
      ...(before ? { before } : {}),
    };
  };

  return [
    {
      name: "context_recall",
      description:
        "Read-only: recall knowledge in the study's priority order — the live session state, this workspace's durable memories, the global memories, then the session's cold vault (RINA Phase 7's memory). Never changes the workspace.",
      requiresApproval: false,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Optional terms for the vault's cold lane; without it the answer carries the live and memory lanes only.",
          },
          sessionID: {
            type: "string",
            description:
              "The session to recall for — must be this session (cross-session queries are forbidden).",
          },
          limit: {
            type: "number",
            description: "Per-lane bound (default 10, max 50).",
          },
        },
        additionalProperties: false,
      },
      async execute(parsed, context) {
        await ctx.ports.getReady();
        const args = parsed as {
          query?: unknown;
          limit?: unknown;
          sessionID?: unknown;
        };
        const session = currentSession(args, context);
        if ("error" in session) return JSON.stringify(session);
        const limit =
          typeof args.limit === "number" && Number.isInteger(args.limit)
            ? Math.max(1, Math.min(args.limit, 50))
            : 10;
        const vault = ctx.state.serviceDirectory.getOptional(rinaVault);
        const memory = ctx.state.serviceDirectory.getOptional(rinaMemory);
        if (!vault || !memory)
          return JSON.stringify({
            error: "knowledge_unavailable",
            note: "the vault and memory services are not provided",
          });
        // The workspace lane's scope: the workspace's STABLE IDENTITY —
        // the store's own derivation (the canonical path's id), not the
        // path itself, so a moved checkout keeps one scope.
        const workspaceID = workspaceStoreID(ctx.ports.getWorkspaceRoot());
        // Lane 1 (the live state), lanes 2-3 (the memories), lane 4 (the
        // vault) — the face orders them; each lane's own discipline
        // decides what it has to say.
        const recall = recallKnowledge({
          state: vault.state(session.sessionID),
          ...recallMemoryLanes(memory, workspaceID, limit),
          ...(typeof args.query === "string" && args.query.trim()
            ? {
                vaultHits: vault.recall(args.query, {
                  sessionID: session.sessionID,
                  limit,
                }),
              }
            : {}),
        });
        return JSON.stringify({
          order: recall.sections.map((section) => section.source),
          sections: recall.sections,
        });
      },
    },
    {
      name: "context_search",
      description:
        "Read-only: search this session's structured memory (RINA's cold vault) with FTS + recency/evidence/entity scoring. Returns records, never raw transcript bodies. Never changes the workspace.",
      requiresApproval: false,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Terms to search for." },
          sessionID: {
            type: "string",
            description:
              "The session to query — pass this session explicitly if you like; a DIFFERENT id is refused (cross-session queries are forbidden).",
          },
          recordType: {
            type: "string",
            enum: [...RECORD_TYPES],
            description: "Restrict to one record type.",
          },
          timeRange: {
            type: "object",
            properties: {
              after: {
                type: "string",
                description: "ISO lower bound on the record's own time.",
              },
              before: {
                type: "string",
                description: "ISO upper bound on the record's own time.",
              },
            },
            additionalProperties: false,
          },
          limit: {
            type: "number",
            description: "Records to return (1-200, default 20).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(parsed, context) {
        await ctx.ports.getReady();
        const args = parsed as {
          query?: unknown;
          recordType?: unknown;
          timeRange?: unknown;
          limit?: unknown;
          sessionID?: unknown;
        };
        const session = currentSession(args, context);
        if ("error" in session) return JSON.stringify(session);
        const vault = ctx.state.serviceDirectory.getOptional(rinaVault);
        if (!vault)
          return JSON.stringify({
            error: "vault_unavailable",
            note: "the context vault service is not provided",
          });
        if (typeof args.query !== "string" || !args.query.trim())
          return JSON.stringify({ error: "query_required" });
        const window = timeWindow(args.timeRange);
        if ("error" in window) return JSON.stringify(window);
        const recordType =
          typeof args.recordType === "string" &&
          (RECORD_TYPES as readonly string[]).includes(args.recordType)
            ? (args.recordType as VaultRecordType)
            : undefined;
        if (args.recordType !== undefined && recordType === undefined)
          return JSON.stringify({
            error: "unknown_record_type",
            note: `legal: ${RECORD_TYPES.join(" | ")}`,
          });
        const limit =
          typeof args.limit === "number" && Number.isFinite(args.limit)
            ? Math.min(200, Math.max(1, Math.floor(args.limit)))
            : undefined;
        const hits = vault.recall(args.query, {
          sessionID: session.sessionID,
          ...(recordType ? { recordType } : {}),
          ...(limit ? { limit } : {}),
          ...(window.after ? { createdAfter: window.after } : {}),
          ...(window.before ? { createdBefore: window.before } : {}),
        });
        // Phase 6's closure: the semantic lane's state rides the answer.
        // A `semantic: 0` in a hit's breakdown means two different
        // things — the lane is off, or it found no neighbour — and the
        // model reading the tool's answer must be able to tell them
        // apart (an absent lane read as an empty corpus is the kind of
        // quiet misreading this whole house exists to refuse).
        return JSON.stringify({
          data: hits,
          semanticLane: vault.semanticLane(),
        });
      },
    },
    {
      name: "context_read",
      description:
        "Read-only: fetch one memory record by id within this session. Never changes the workspace.",
      requiresApproval: false,
      parameters: {
        type: "object",
        properties: {
          sessionID: {
            type: "string",
            description:
              "The session this face answers — must be this session (cross-session queries are forbidden).",
          },
          recordID: {
            type: "string",
            description: "The record id from search/list.",
          },
        },
        required: ["recordID"],
        additionalProperties: false,
      },
      async execute(parsed, context) {
        await ctx.ports.getReady();
        const args = parsed as { recordID?: unknown; sessionID?: unknown };
        const session = currentSession(args, context);
        if ("error" in session) return JSON.stringify(session);
        if (typeof args.recordID !== "string" || !args.recordID)
          return JSON.stringify({ error: "record_id_required" });
        if (!args.recordID.startsWith(`${session.sessionID}:`))
          return JSON.stringify({
            error: "cross_session_forbidden",
            note: "record ids carry their session — a read cannot cross it",
          });
        const vault = ctx.state.serviceDirectory.getOptional(rinaVault);
        if (!vault)
          return JSON.stringify({
            error: "vault_unavailable",
            note: "the context vault service is not provided",
          });
        const hit = vault.get(args.recordID, { sessionID: session.sessionID });
        if (!hit) return JSON.stringify({ error: "not_found" });
        return JSON.stringify({ data: hit });
      },
    },
    {
      name: "context_list",
      description:
        "Read-only: list this session's memory records newest-first (structured read, no query). Never changes the workspace.",
      requiresApproval: false,
      parameters: {
        type: "object",
        properties: {
          sessionID: {
            type: "string",
            description:
              "The session to list — must be this session (cross-session queries are forbidden).",
          },
          recordType: {
            type: "string",
            enum: [...RECORD_TYPES],
            description: "Restrict to one record type.",
          },
          timeRange: {
            type: "object",
            properties: {
              after: { type: "string", description: "ISO lower bound." },
              before: { type: "string", description: "ISO upper bound." },
            },
            additionalProperties: false,
          },
          limit: {
            type: "number",
            description: "Records to return (1-500, default 50).",
          },
        },
        additionalProperties: false,
      },
      async execute(parsed, context) {
        await ctx.ports.getReady();
        const args = parsed as {
          recordType?: unknown;
          timeRange?: unknown;
          limit?: unknown;
          sessionID?: unknown;
        };
        const session = currentSession(args, context);
        if ("error" in session) return JSON.stringify(session);
        const vault = ctx.state.serviceDirectory.getOptional(rinaVault);
        if (!vault)
          return JSON.stringify({
            error: "vault_unavailable",
            note: "the context vault service is not provided",
          });
        const window = timeWindow(args.timeRange);
        if ("error" in window) return JSON.stringify(window);
        const recordType =
          typeof args.recordType === "string" &&
          (RECORD_TYPES as readonly string[]).includes(args.recordType)
            ? (args.recordType as VaultRecordType)
            : undefined;
        if (args.recordType !== undefined && recordType === undefined)
          return JSON.stringify({
            error: "unknown_record_type",
            note: `legal: ${RECORD_TYPES.join(" | ")}`,
          });
        const limit =
          typeof args.limit === "number" && Number.isFinite(args.limit)
            ? Math.min(500, Math.max(1, Math.floor(args.limit)))
            : undefined;
        const data = vault.list({
          sessionID: session.sessionID,
          ...(recordType ? { recordType } : {}),
          ...(limit ? { limit } : {}),
          ...(window.after ? { createdAfter: window.after } : {}),
          ...(window.before ? { createdBefore: window.before } : {}),
        });
        return JSON.stringify({ data });
      },
    },
    {
      name: "context_history",
      description:
        "Read-only: the recorded lifecycle actions on one memory record (insert/accessed/evict/rebuild). Never changes the workspace.",
      requiresApproval: false,
      parameters: {
        type: "object",
        properties: {
          recordID: { type: "string", description: "The record id." },
          sessionID: {
            type: "string",
            description:
              "The session to query — must be this session (cross-session queries are forbidden).",
          },
        },
        required: ["recordID"],
        additionalProperties: false,
      },
      async execute(parsed, context) {
        await ctx.ports.getReady();
        const args = parsed as { recordID?: unknown; sessionID?: unknown };
        const session = currentSession(args, context);
        if ("error" in session) return JSON.stringify(session);
        if (typeof args.recordID !== "string" || !args.recordID)
          return JSON.stringify({ error: "record_id_required" });
        if (!args.recordID.startsWith(`${session.sessionID}:`))
          return JSON.stringify({
            error: "cross_session_forbidden",
            note: "record ids carry their session — a history cannot cross it",
          });
        const vault = ctx.state.serviceDirectory.getOptional(rinaVault);
        if (!vault)
          return JSON.stringify({
            error: "vault_unavailable",
            note: "the context vault service is not provided",
          });
        const data = vault.history(args.recordID, {
          sessionID: session.sessionID,
        });
        return JSON.stringify({ data });
      },
    },
    {
      name: "context_pack",
      description:
        "Read-only: assemble a budgeted context pack of this session's recent records for an agent role (type picks, dedupe, token budget — RINA's ContextPack). Never changes the workspace.",
      requiresApproval: false,
      parameters: {
        type: "object",
        properties: {
          agentID: {
            type: "string",
            enum: [...AGENTS],
            description: "Whose role picks the record types.",
          },
          sessionID: {
            type: "string",
            description:
              "The session to pack — must be this session (cross-session queries are forbidden).",
          },
          budget: {
            type: "number",
            description: `Token budget (default ${PACK_DEFAULT_BUDGET}, max ${PACK_MAX_BUDGET}).`,
          },
        },
        required: ["agentID"],
        additionalProperties: false,
      },
      async execute(parsed, context) {
        await ctx.ports.getReady();
        const args = parsed as {
          agentID?: unknown;
          budget?: unknown;
          sessionID?: unknown;
        };
        const session = currentSession(args, context);
        if ("error" in session) return JSON.stringify(session);
        if (
          typeof args.agentID !== "string" ||
          !(AGENTS as readonly string[]).includes(args.agentID)
        )
          return JSON.stringify({
            error: "unknown_agent",
            note: `legal: ${AGENTS.join(" | ")}`,
          });
        const vault = ctx.state.serviceDirectory.getOptional(rinaVault);
        if (!vault)
          return JSON.stringify({
            error: "vault_unavailable",
            note: "the context vault service is not provided",
          });
        const budget =
          typeof args.budget === "number" &&
          Number.isFinite(args.budget) &&
          args.budget > 0
            ? Math.min(PACK_MAX_BUDGET, Math.floor(args.budget))
            : PACK_DEFAULT_BUDGET;
        const recent = vault.list({
          sessionID: session.sessionID,
          limit: PACK_CANDIDATE_CAP,
        });
        const pack = buildContextPack(recent, {
          role: args.agentID as VaultPackRole,
          budgetTokens: budget,
          estimate: estimateTokens,
        });
        return JSON.stringify({ data: pack });
      },
    },
  ] satisfies RuntimeTool[];
}
