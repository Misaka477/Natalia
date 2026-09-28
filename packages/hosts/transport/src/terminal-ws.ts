import type { RuntimeClient } from "@anthelia/contracts";

type TerminalHostClient = RuntimeClient & {
  subscribeTerminalOutput?(
    id: string,
    listener: (chunk: string) => void,
  ): () => void;
};
import type { ServerWebSocket } from "bun";
import { credentialSessions, type RuntimeAuthorizationContext } from "./rpc";

export type TerminalWsMessage =
  | { type: "input"; data: string }
  | { type: "resize"; rows: number; cols: number }
  | { type: "close" };

export type TerminalWsServerMessage =
  | { type: "ready"; id: string; rows?: number; cols?: number }
  | { type: "restore"; id: string; text: string }
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

function failOpen(ws: ServerWebSocket<TerminalSocketData>, message: string) {
  console.error("[terminal-ws]", message);
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
        if (typeof client.subscribeTerminalOutput === "function") {
          ws.data.unsubscribe = client.subscribeTerminalOutput(
            session.id,
            (chunk) => {
              send(ws, { type: "output", data: chunk });
            },
          );
        } else {
          console.error(
            "[terminal-ws] subscribeTerminalOutput is missing; live output will not stream",
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
