import type { RuntimeTool } from "@anthelia/tools";
import { sessionStoreController } from "@anthelia/session-store";
import type { SessionID } from "@anthelia/contracts";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionStoreController } from "@anthelia/session-store";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;

/**
 * Model-facing transcript paging.
 *
 * The store's `messages` query pages from the SQLite message index (falling back
 * to the session record), so a model can walk arbitrarily far back through the
 * session without the runtime materialising the whole journal. The response
 * carries `cursor.previous` (older rows) and `cursor.next` (newer rows); passing
 * a cursor back is how the model "turns the page".
 */
export function createSessionHistoryTool(ctx: RuntimeContext): RuntimeTool {
  return {
    name: "session_history",
    description:
      "Read the session transcript as a JSON page of projected turn/message rows. Your own context is a recent window, not the whole session, so use this to retrieve concrete earlier details. The response carries cursor.previous (the page of older rows) and cursor.next (the page of newer rows); pass one of those opaque strings back as `cursor` to turn the page. Keep paging until you find what you need or cursor.previous is absent (you reached the start).",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          description:
            "Opaque cursor string from a previous session_history response: use cursor.previous for older rows, cursor.next for newer.",
        },
        limit: {
          type: "number",
          description: "Rows per page (1-200, default 40).",
        },
        order: {
          type: "string",
          enum: ["asc", "desc"],
          description:
            "Page order; omit when passing a cursor (the cursor carries it).",
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: {} },
      presentCall(args) {
        const cursor = (args as { cursor?: unknown }).cursor;
        return {
          kind: "search",
          title: "session history",
          summary:
            typeof cursor === "string" && cursor ? "page" : "recent window",
        };
      },
      presentationMeta(_args, value) {
        // ONE decode (S3): the page's rows and its paging truth.
        let parsed: Record<string, unknown> | undefined;
        try {
          const decoded = JSON.parse(value) as unknown;
          if (decoded && typeof decoded === "object" && !Array.isArray(decoded))
            parsed = decoded as Record<string, unknown>;
        } catch {
          // degrade, never throw
        }
        const rows = Array.isArray(parsed?.data) ? parsed!.data! : [];
        const cursor =
          parsed?.cursor && typeof parsed.cursor === "object"
            ? (parsed.cursor as Record<string, unknown>)
            : {};
        return {
          total: rows.length,
          older: typeof cursor.previous === "string" && cursor.previous,
          newer: typeof cursor.next === "string" && cursor.next,
        };
      },
      presentResult(_args, value, meta) {
        // The page's rows ARE the reading: one line per row, the role and
        // the row's first line, with the paging truth as facets. The card
        // used to carry the whole page envelope as one text block.
        let parsed: Record<string, unknown> | undefined;
        try {
          const decoded = JSON.parse(value) as unknown;
          if (decoded && typeof decoded === "object" && !Array.isArray(decoded))
            parsed = decoded as Record<string, unknown>;
        } catch {
          // degrade, never throw
        }
        const rows = Array.isArray(parsed?.data)
          ? (parsed!.data as Array<Record<string, unknown>>)
          : [];
        const lines = rows.map((row) => {
          const role = typeof row.role === "string" ? row.role : "row";
          const kind = typeof row.kind === "string" ? row.kind : "message";
          const text = typeof row.text === "string" ? row.text : "";
          const head = text.split("\n", 1)[0] ?? "";
          // A tool row names the tool; a thinking row is not a message at
          // all. The prefix is the row's own kind.
          const tool =
            row.tool && typeof row.tool === "object"
              ? (row.tool as Record<string, unknown>)
              : undefined;
          const toolName = tool?.name;
          const label =
            kind === "tool" && typeof toolName === "string"
              ? `tool · ${toolName}`
              : kind;
          return `${label}: ${head}`;
        });
        const facets: Array<[string, string]> = [];
        const older = meta === undefined ? undefined : meta.older;
        const newer = meta === undefined ? undefined : meta.newer;
        if (older === true) facets.push(["older", "yes"]);
        if (newer === true) facets.push(["newer", "yes"]);
        return {
          kind: "search",
          title: "session history",
          summary: `${rows.length} row${rows.length === 1 ? "" : "s"}`,
          ...(facets.length ? { meta: facets } : {}),
          // The reading is the page's own rows.
          body: lines.join("\n"),
        };
      },
    },
    async execute(parsed, context) {
      await ctx.ports.getReady();
      const sessionID = (context.sessionID ?? ctx.ports.getSessionID()) as
        | SessionID
        | undefined;
      if (!sessionID) return JSON.stringify({ data: [], cursor: {} });
      const exec = ctx.ports.getExecutionBySession().get(sessionID);
      const attached = ctx.ports.getSession();
      const session =
        exec?.session ?? (attached?.id === sessionID ? attached : undefined);
      const store = ctx.state.serviceDirectory.getOptional(
        sessionStoreController,
      );
      if (!store || !session)
        return JSON.stringify({
          data: [],
          cursor: {},
          error: "session_unavailable",
        });
      const args = parsed as {
        cursor?: unknown;
        limit?: unknown;
        order?: unknown;
      };
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(args.limit)))
          : DEFAULT_LIMIT;
      const page = await store.messages(sessionID, session, {
        limit,
        ...(typeof args.cursor === "string" && args.cursor
          ? { cursor: args.cursor }
          : {}),
        ...(args.order === "asc" || args.order === "desc"
          ? { order: args.order }
          : {}),
      });
      return JSON.stringify(page);
    },
  };
}
