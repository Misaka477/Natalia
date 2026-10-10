import type { RuntimeTool } from "@anthelia/tools";
import { sessionStoreController } from "@anthelia/session-store";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionStoreController } from "@anthelia/session-store";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;
/** One row's text ceiling: enough to read a finding, small enough to page. */
const ROW_TEXT_MAX_CHARS = 2_000;

/** A row as the answering surface returns it: identity, kind, bounded text. */
type SessionHistoryRow = {
  id: string;
  turnID: string;
  kind: string;
  text: string;
};

/**
 * The row's own text, capped.
 *
 * The row carries its EVENT, and an event carries the whole payload — a tool
 * result's complete body, a content delta's full text. The projection keeps
 * the head and says how much was cut, so a model can tell "this row is long"
 * from "this row is short" instead of receiving a megabyte it cannot use.
 */
export function capRowText(row: { kind: string; event: RuntimeEvent }): string {
  const raw = rowEventText(row.event);
  if (raw.length <= ROW_TEXT_MAX_CHARS) return raw;
  return `${raw.slice(0, ROW_TEXT_MAX_CHARS)}\n… [${raw.length - ROW_TEXT_MAX_CHARS} more chars truncated]`;
}

/** Exported for the guard: the row ceiling the answering surface applies. */
export const SESSION_HISTORY_ROW_TEXT_MAX_CHARS = ROW_TEXT_MAX_CHARS;

/** The text an event contributes to its row, by the row's kind. */
function rowEventText(event: RuntimeEvent): string {
  if ("text" in event && typeof event.text === "string") return event.text;
  if ("result" in event && typeof event.result === "string")
    return event.result;
  if ("content" in event && typeof event.content === "string")
    return event.content;
  if ("message" in event && typeof event.message === "string")
    return event.message;
  return "";
}

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
      // F4 (2026-10-10 sweep): the page carried `thinking` rows verbatim —
      // the model's private reasoning, returned to a tool answer that is
      // injected into context and logged. The sweep measured reasoning text
      // arriving at `limit=5`, which both floods the context and contradicts
      // the no-private-reasoning rule the prompt states. The transcript page
      // is a record of what was SAID; the thinking rows are dropped here, at
      // the surface that answers, so the projection the UI draws is unchanged.
      //
      // The limit also bounds the ROWS, not only the turns it was asked of.
      // `limit` reaches the store as a TURN count, and each turn expands into
      // as many rows as its events produced — so `limit=2` returned 13 pages /
      // 1.2 MB whenever those two turns carried long tool results. Truncating
      // after the expansion is what the sweep named; the rows are the unit the
      // model reads, so they are the unit the limit bounds.
      const rows: SessionHistoryRow[] = [];
      for (const message of page.data) {
        for (const row of message.rows) {
          if (row.kind === "thinking") continue;
          rows.push({
            id: row.id,
            turnID: row.turnID,
            kind: row.kind,
            // A compact projection, not the raw event: the event carries the
            // whole payload (a tool result's full body, a delta's text), and
            // echoing it is what made one row cost a page.
            text: capRowText(row),
          });
        }
      }
      const kept = rows.slice(0, limit);
      return JSON.stringify({
        data: page.data.map((message) => ({
          id: message.id,
          turnID: message.turnID,
          submitted: message.submitted,
          ...(message.stopReason ? { stopReason: message.stopReason } : {}),
          rows: kept.filter((row) => row.turnID === message.turnID),
        })),
        cursor: page.cursor,
        // The truncation is visible: a model that asked for 40 rows and got
        // 40 of 300 must be able to tell that it is looking at a page.
        ...(kept.length < rows.length
          ? {
              truncated: true,
              returnedRows: kept.length,
              totalRows: rows.length,
            }
          : {}),
      });
    },
  };
}
