import type { RuntimeClient } from "@anthelia/contracts";

type TerminalHostClient = RuntimeClient & {
  subscribeTerminalOutput?(
    id: string,
    listener: (chunk: string) => void,
  ): () => void;
};
import type { ServerWebSocket } from "bun";
import { getLogger } from "@anthelia/logging";
import { credentialSessions, type RuntimeAuthorizationContext } from "./rpc";

export type TerminalWsMessage =
  | { type: "input"; data: string }
  | { type: "resize"; rows: number; cols: number }
  | { type: "close" };

export type TerminalWsServerMessage =
  | { type: "ready"; id: string; rows?: number; cols?: number }
  | {
      type: "restore";
      id: string;
      text: string;
      /** The pane's cursor, when the host reported it: a reconnect that
       *  replays the buffer but drops the caret repaints it at the origin. */
      cursorX?: number;
      cursorY?: number;
    }
  | { type: "output"; data: string }
  | { type: "exit"; id: string }
  | { type: "error"; message: string; fatal?: boolean };

type TerminalSocketData = {
  sessionID: string;
  terminalID: string;
  command?: string;
  authorization?: RuntimeAuthorizationContext;
  unsubscribe?: () => void;
};

const TERMINAL_PATH = /^\/terminal\/([^/]+)\/([^/]+)$/u;

export function matchTerminalPath(pathname: string) {
  const match = pathname.match(TERMINAL_PATH);
  if (!match) return undefined;
  return {
    sessionID: decodeURIComponent(match[1]!),
    terminalID: decodeURIComponent(match[2]!),
  };
}

export function authorizeTerminalSession(
  sessionID: string,
  authorization: RuntimeAuthorizationContext | undefined,
) {
  const allowed = credentialSessions(authorization);
  if (!allowed) return true;
  return allowed.has(sessionID);
}

function send(
  ws: ServerWebSocket<TerminalSocketData>,
  message: TerminalWsServerMessage,
) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

/** This subsystem's logger. The name is the `NATALIA_LOG` threshold key. */
const log = getLogger("terminal-ws");

function failOpen(ws: ServerWebSocket<TerminalSocketData>, message: string) {
  // error is on by default: a terminal that cannot serve must never be silent.
  log.error("%s", message);
  send(ws, { type: "error", message, fatal: true });
  ws.close(1011, "terminal unavailable");
}

export function terminalWebsocketHandlers(client: TerminalHostClient) {
  return {
    async open(ws: ServerWebSocket<TerminalSocketData>) {
      const { sessionID, terminalID } = ws.data;
      try {
        if (typeof client.nativeTerminalStart !== "function") {
          failOpen(
            ws,
            "no active workspace: open or activate a workspace before using the terminal",
          );
          return;
        }
        const listed = await client.nativeTerminalList?.();
        let session = listed?.find((item) => item.id === terminalID);
        if (session?.sessionID && session.sessionID !== sessionID) {
          failOpen(
            ws,
            `terminal ${terminalID} belongs to session ${session.sessionID}`,
          );
          return;
        }
        if (!session) {
          session = await client.nativeTerminalStart({
            command: ws.data.command || process.env.SHELL || "bash",
            id: terminalID,
            sessionID,
          });
        }
        if (!session) {
          failOpen(ws, "native terminal start returned no session");
          return;
        }
        if (session.sessionID && session.sessionID !== sessionID) {
          failOpen(
            ws,
            `terminal ${session.id} belongs to session ${session.sessionID}`,
          );
          return;
        }
        // A pane opened from the UI is the human's: claim input ownership so the
        // frame-settler does not wake the model on every prompt the shell prints
        // (the model's settle is for terminals IT started, where the output is
        // the answer to what it asked). A terminal the model already handed to
        // the human is already claimed, and this is a no-op for it.
        if (typeof client.nativeTerminalClaimHumanInput === "function") {
          await client.nativeTerminalClaimHumanInput(session.id, sessionID);
        }
        // Replay the pane's current screen before any live output. This is the
        // equivalent of VSCode's process reconnection: a reconnected terminal
        // gets the serialized buffer first, then the stream continues. Without
        // it a pane that already has history (a reattach, a panel reopen, a
        // browser reload) starts blank and the human's scrollback diverges from
        // the model's, which can read the same pane via `read`.
        try {
          const snapshot = await client.nativeTerminalRead?.(
            session.id,
            sessionID,
          );
          // Sent UNCONDITIONALLY, empty text included. The client's restore
          // handler clears the screen before writing, so an absent restore leaves
          // whatever the previous connection had on screen — the old session's
          // content presented as this one's. An empty pane is exactly the case
          // where that matters most (a shell that just started, or one that
          // exited and was respawned), and it is the case a `if (text)` guard
          // silently skips.
          //
          // AND the cursor rides along when the host reported it: a reconnect
          // that replays the buffer but drops the cursor repaints the caret at
          // the origin, which for a shell mid-line-editor is a lie about where
          // typing will land. The fields are spread only when present, so a
          // host that cannot report one (or an empty pane) keeps the exact
          // two-field frame it always sent — null would be a second spelling
          // of "absent" on the wire.
          send(ws, {
            type: "restore",
            id: session.id,
            text: snapshot?.text ?? "",
            ...(snapshot?.cursorX != null && snapshot?.cursorY != null
              ? { cursorX: snapshot.cursorX, cursorY: snapshot.cursorY }
              : {}),
          });
        } catch (error) {
          // A failed replay must not cost the pane its live stream: the socket
          // stays open and new output still arrives.
          send(ws, {
            type: "error",
            message: `screen replay failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        if (typeof client.subscribeTerminalOutput === "function") {
          ws.data.unsubscribe = client.subscribeTerminalOutput(
            session.id,
            (chunk) => {
              send(ws, { type: "output", data: chunk });
            },
          );
        } else {
          // A missing port means the client cannot stream output; say so in
          // words the operator can act on, not a bare warn nobody greps.
          log.error(
            "subscribeTerminalOutput is missing; live output will not stream",
          );
        }
        send(ws, {
          type: "ready",
          id: session.id,
          rows: session.rows,
          cols: session.cols,
        });
      } catch (error) {
        failOpen(ws, error instanceof Error ? error.message : String(error));
      }
    },
    async message(
      ws: ServerWebSocket<TerminalSocketData>,
      raw: string | Buffer,
    ) {
      let body: TerminalWsMessage;
      try {
        body = JSON.parse(raw.toString()) as TerminalWsMessage;
      } catch {
        send(ws, { type: "error", message: "invalid terminal message" });
        return;
      }
      const { terminalID } = ws.data;
      try {
        if (body.type === "input") {
          if (typeof body.data !== "string") {
            send(ws, { type: "error", message: "input data must be a string" });
            return;
          }
          await client.nativeTerminalWrite?.({
            id: terminalID,
            input: body.data,
            sessionID: ws.data.sessionID,
            actor: "human",
          });
          return;
        }
        if (body.type === "resize") {
          if (!Number.isInteger(body.rows) || !Number.isInteger(body.cols)) {
            send(ws, {
              type: "error",
              message: "resize requires integer rows and cols",
            });
            return;
          }
          await client.nativeTerminalResize?.({
            id: terminalID,
            rows: body.rows,
            cols: body.cols,
            sessionID: ws.data.sessionID,
          });
          return;
        }
        if (body.type === "close") {
          await client.nativeTerminalStop?.(terminalID, ws.data.sessionID);
          ws.data.unsubscribe?.();
          send(ws, { type: "exit", id: terminalID });
          ws.close(1000, "closed");
        }
      } catch (error) {
        send(ws, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    close(ws: ServerWebSocket<TerminalSocketData>) {
      ws.data.unsubscribe?.();
    },
  };
}

export function upgradeTerminalSocket(
  request: Request,
  server: {
    upgrade(request: Request, options: { data: TerminalSocketData }): boolean;
  },
  authorization: RuntimeAuthorizationContext | undefined,
) {
  const url = new URL(request.url);
  const match = matchTerminalPath(url.pathname);
  if (!match) return undefined;
  if (!authorizeTerminalSession(match.sessionID, authorization)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const command = url.searchParams.get("command") || undefined;
  const upgraded = server.upgrade(request, {
    data: {
      sessionID: match.sessionID,
      terminalID: match.terminalID,
      command,
      authorization,
    },
  });
  if (upgraded) return null;
  return Response.json({ error: "upgrade failed" }, { status: 400 });
}

export type { TerminalSocketData };
