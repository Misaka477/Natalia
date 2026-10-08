/**
 * Model-facing Work Graph query tool — runtime/work-graph-tools.ts.
 *
 * The minimal read surface (EI §8.4): query the session's work graph by
 * planID (or a plan document path, resolved to its planID) with cursor
 * pagination. The full version (filter by kind/direction/depth, checkpoint
 * provenance) lands with the B7 graph batch; this slice gives the model the
 * basic "what has this plan touched" read with bounded output.
 */

import {
  projectedWorkGraphNodes,
  projectedWorkGraphEdges,
} from "@anthelia/session";
import type { WorkGraphEdge, WorkGraphNode } from "@anthelia/contracts";
import { activePlanForExec } from "@natalia/collab";
import type { RuntimeContext } from "@anthelia/substrate";

const WORK_GRAPH_PAGE_LIMIT = 50;

function resolveExec(
  ctx: RuntimeContext,
  sessionID?: string,
): import("@anthelia/substrate").SessionExecutionState | undefined {
  const exec = sessionID
    ? ctx.ports
        .getExecutionBySession()
        .get(sessionID as import("@anthelia/contracts").SessionID)
    : undefined;
  return exec ?? ctx.ports.getActiveExec();
}

export function createWorkGraphQueryTool(
  ctx: RuntimeContext,
): import("@anthelia/tools").RuntimeTool {
  return {
    name: "work_graph_query",
    description:
      "Query the session's Work Graph — the recorded fact graph of goals, plans, decisions, tool calls, approvals, checkpoints, validations and workspace changes. " +
      "Decision tree: leaving everything empty returns the ACTIVE plan's whole chain (or the whole session graph when no plan is active); fill exactly one precise query — `path` (a file/plan-document causal chain) or `findingID` (a drift finding's context); " +
      "narrow with the range filters planID / goalID / checkpointID / nodeKind. " +
      "Pagination: `limit` (default 50, max 200) and `cursor`; when the result is over the limit the response carries `truncated: true` and a `nextCursor` — pass that cursor back until `truncated` is false. " +
      "An empty result is `{ nodes: [], truncated: false }` (no matching chain, not an error).",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Precise query: a plan-document path (resolved to its planID) or a workspace file path (the nodes that reference it — the file's causal chain). A .natalia/plans/ path that names no plan document is an error; a file path with no referencing node is an empty chain, not an error. Mutually exclusive with findingID.",
        },
        findingID: {
          type: "string",
          description:
            "Precise query: a drift findingID — returns the nodes in that finding's context. Mutually exclusive with path.",
        },
        planID: {
          type: "string",
          description: "Range filter: only nodes belonging to this plan.",
        },
        goalID: {
          type: "string",
          description: "Range filter: only nodes belonging to this goal.",
        },
        checkpointID: {
          type: "string",
          description: "Range filter: only nodes belonging to this checkpoint.",
        },
        nodeKind: {
          type: "string",
          enum: [
            "goal",
            "constraint",
            "decision",
            "plan",
            "plan_step",
            "agent_action",
            "tool_call",
            "approval",
            "checkpoint",
            "validation",
            "workspace_change",
          ],
          description: "Range filter: only nodes of this kind.",
        },
        cursor: {
          type: "string",
          description:
            "Opaque pagination cursor from a previous work_graph_query result.",
        },
        limit: {
          type: "number",
          description: `Maximum nodes per page (default ${WORK_GRAPH_PAGE_LIMIT}, max 200).`,
        },
        direction: {
          type: "string",
          enum: ["out", "in", "both"],
          description:
            "Which edge direction to traverse from the matched nodes (default both).",
        },
        depth: {
          type: "number",
          description:
            "How many edge hops to expand from the matched nodes (default 1, 0 = no traversal).",
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: {} },
      presentCall(args) {
        const parsed =
          args && typeof args === "object"
            ? (args as Record<string, unknown>)
            : {};
        const path = typeof parsed.path === "string" ? parsed.path : undefined;
        const findingID =
          typeof parsed.findingID === "string" ? parsed.findingID : undefined;
        const planID =
          typeof parsed.planID === "string" ? parsed.planID : undefined;
        const title = path ?? findingID ?? planID ?? "work graph";
        return { kind: "generic", title, summary: "query" };
      },
      presentationMeta(_args, value) {
        // ONE decode (S3): the page's nodes and its paging truth.
        let parsed: Record<string, unknown> = {};
        try {
          const decoded = JSON.parse(value) as unknown;
          if (decoded && typeof decoded === "object" && !Array.isArray(decoded))
            parsed = decoded as Record<string, unknown>;
        } catch {
          // degrade, never throw
        }
        return {
          total: typeof parsed.total === "number" ? parsed.total : 0,
          truncated: parsed.truncated === true,
          nodes: Array.isArray(parsed.nodes) ? parsed.nodes.length : 0,
          edges: Array.isArray(parsed.edges) ? parsed.edges.length : 0,
        };
      },
      presentResult(args, value, meta) {
        let parsed: Record<string, unknown> = {};
        try {
          const decoded = JSON.parse(value) as unknown;
          if (decoded && typeof decoded === "object" && !Array.isArray(decoded))
            parsed = decoded as Record<string, unknown>;
        } catch {
          // degrade, never throw
        }
        const nodes = Array.isArray(parsed.nodes)
          ? (parsed.nodes as Array<Record<string, unknown>>)
          : [];
        // The reading is the node list: `<kind> · <summary>` one per line.
        const lines = nodes.map((node) => {
          const kind = typeof node.kind === "string" ? node.kind : "node";
          const summary = typeof node.summary === "string" ? node.summary : "";
          return summary ? `${kind} · ${summary}` : kind;
        });
        const parsedArgs =
          args && typeof args === "object"
            ? (args as Record<string, unknown>)
            : {};
        const path =
          typeof parsedArgs.path === "string" ? parsedArgs.path : undefined;
        const findingID =
          typeof parsedArgs.findingID === "string"
            ? parsedArgs.findingID
            : undefined;
        const planID =
          typeof parsedArgs.planID === "string" ? parsedArgs.planID : undefined;
        const total =
          typeof meta?.total === "number" ? meta.total : nodes.length;
        const facets: Array<[string, string]> = [["total", String(total)]];
        if (meta?.truncated === true) facets.push(["truncated", "true"]);
        return {
          kind: "generic",
          title: path ?? findingID ?? planID ?? "work graph",
          summary: `${nodes.length} node${nodes.length === 1 ? "" : "s"}`,
          ...(lines.length ? { body: lines.join("\n") } : {}),
          meta: facets,
        };
      },
    },
    async execute(parsed, context) {
      const args = parsed as {
        path?: string;
        findingID?: string;
        planID?: string;
        goalID?: string;
        checkpointID?: string;
        nodeKind?: string;
        cursor?: string;
        limit?: number;
        direction?: "out" | "in" | "both";
        depth?: number;
      };
      const exec = resolveExec(ctx, context.sessionID);
      if (!exec) return "no session";
      const path = args.path?.trim();
      const findingID = args.findingID?.trim();
      // Exactly one precise query (path / findingID); the range filters are
      // optional narrowers, not precise queries.
      if (path && findingID)
        return "fill exactly one precise query: path or findingID, not both";
      let planID = args.planID?.trim();
      // A path that resolved to no plan is a FILE path unless it is shaped
      // like a plan document: `.natalia/plans/...` names the plan directory
      // and nothing else. Treating every unmatched path as an unknown planID
      // answered "the causal chain of src/foo.ts" with "unknown planID:
      // src/foo.ts" — wrong in both halves (T-19).
      let filePath: string | undefined;
      if (path) {
        const plans = ctx.ports.planDocRuntime.planDocSnapshot();
        const normalized = path.replace(/^\.?\/?natalia\/plans\//u, "");
        const match = plans.find(
          (plan) =>
            plan.documentPath === normalized ||
            plan.documentPath.endsWith(normalized) ||
            plan.planID === normalized,
        );
        if (match) {
          planID = match.planID;
        } else if (/^\.?\/?natalia\/plans\//u.test(path)) {
          return (
            `unknown_plan_or_path: ${path} — no plan document matches that ` +
            `path. A .natalia/plans/ path must name an existing plan document; ` +
            `pass a workspace file path (the nodes that reference it), or omit ` +
            `path for the active plan's chain.`
          );
        } else {
          // A workspace file path: the causal chain is the nodes that
          // reference it (a workspace_change records the path in `target`).
          // No match is an empty chain, which this tool documents as an
          // empty result rather than an error.
          filePath = normalized.replace(/^\.?\/+/u, "");
        }
      }
      // EI §3.9: an unfiltered query means the ACTIVE plan's whole chain, not
      // every node in the session. A precise query or an explicit range filter
      // overrides that; with no active plan the whole session graph is returned
      // (there is no plan to default to, and the model may still be navigating).
      const precise = Boolean(path || findingID);
      const narrowed = Boolean(
        args.planID?.trim() ||
          args.goalID?.trim() ||
          args.checkpointID?.trim() ||
          args.nodeKind,
      );
      if (!precise && !narrowed) {
        const active = activePlanForExec(ctx, exec);
        if (active) planID = active.planID;
      }
      const nodes = projectedWorkGraphNodes(exec.session.events);
      const edges = projectedWorkGraphEdges(exec.session.events);
      // A node matches an id filter when it carries the id, or its target /
      // summary references it (the graph predates structured id tracking, so
      // provenance is sometimes only implicit).
      const matchesID = (node: (typeof nodes)[number], id: string): boolean =>
        node.planID === id ||
        node.target === id ||
        node.target?.includes(id) === true ||
        node.summary.includes(id);
      let filtered = nodes;
      if (findingID)
        filtered = filtered.filter((node) => matchesID(node, findingID));
      if (filePath)
        // A file path matches a node that records it: `target` is the
        // workspace-relative path (a workspace_change node). The segment
        // boundary keeps "oo.ts" from matching "foo.ts".
        filtered = filtered.filter(
          (node) =>
            node.target === filePath ||
            node.target?.endsWith(`/${filePath}`) === true,
        );
      if (planID) filtered = filtered.filter((node) => matchesID(node, planID));
      if (args.goalID?.trim())
        filtered = filtered.filter((node) =>
          matchesID(node, args.goalID!.trim()),
        );
      if (args.checkpointID?.trim())
        filtered = filtered.filter((node) =>
          matchesID(node, args.checkpointID!.trim()),
        );
      if (args.nodeKind)
        filtered = filtered.filter((node) => node.kind === args.nodeKind);
      const limit = Math.min(
        Math.max(args.limit ?? WORK_GRAPH_PAGE_LIMIT, 1),
        200,
      );
      const offset = Number(args.cursor ?? "0");
      if (!Number.isFinite(offset) || offset < 0)
        return "invalid cursor; re-query without cursor";
      // Optional edge traversal (direction + depth) expands the matched set
      // through the graph before pagination, so "what does this plan touch" can
      // reach the checkpoints, validations and changes behind it.
      const direction = args.direction ?? "both";
      const depth = Math.max(Math.min(args.depth ?? 1, 5), 0);
      let expanded = filtered;
      if (depth > 0) {
        const adjacency = new Map<string, Array<{ to: string }>>();
        for (const edge of edges) {
          if (direction !== "in")
            (
              adjacency.get(edge.sourceID) ??
              adjacency.set(edge.sourceID, []).get(edge.sourceID)!
            ).push({ to: edge.targetID });
          if (direction !== "out")
            (
              adjacency.get(edge.targetID) ??
              adjacency.set(edge.targetID, []).get(edge.targetID)!
            ).push({ to: edge.sourceID });
        }
        const reached = new Set(filtered.map((node) => node.id));
        let frontier = [...reached];
        for (let hop = 0; hop < depth; hop += 1) {
          const next: string[] = [];
          for (const id of frontier)
            for (const link of adjacency.get(id) ?? [])
              if (!reached.has(link.to)) {
                reached.add(link.to);
                next.push(link.to);
              }
          if (!next.length) break;
          frontier = next;
        }
        expanded = nodes.filter((node) => reached.has(node.id));
      }
      const page = expanded.slice(offset, offset + limit);
      const nodeIDs = new Set(page.map((node) => node.id));
      const pageEdges = edges.filter(
        (edge) => nodeIDs.has(edge.sourceID) && nodeIDs.has(edge.targetID),
      );
      const hasMore = offset + limit < expanded.length;
      return JSON.stringify({
        ...(planID ? { planID } : {}),
        ...(findingID ? { findingID } : {}),
        ...(filePath ? { path: filePath } : {}),
        total: expanded.length,
        truncated: hasMore,
        nodes: page,
        edges: pageEdges,
        ...(hasMore ? { nextCursor: String(offset + limit) } : {}),
      } satisfies {
        planID?: string;
        findingID?: string;
        path?: string;
        total: number;
        truncated: boolean;
        nodes: WorkGraphNode[];
        edges: WorkGraphEdge[];
        nextCursor?: string;
      });
    },
  };
}
