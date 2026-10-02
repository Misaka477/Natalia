import { API_VERSION } from "@anthelia/contracts";
import type { RuntimeClient, RuntimeEvent } from "@anthelia/contracts";
import type { ServerWebSocket } from "bun";
import { handleRPCMessage } from "./rpc";
import type { RuntimeAuthorizationContext } from "./rpc";
import { resolveAuthorization } from "./http";
import { credentialSessions } from "./rpc";
import type { RuntimeAuthorizationPolicy } from "./http";
import type { RPCRequest } from "./rpc-client";

export type RuntimeWsServerOptions = {
  client: RuntimeClient;
  hostname?: string;
  port?: number;
  /** Shorthand for a single full-write credential, as in the HTTP server. */
  token?: string;
  authorization?: RuntimeAuthorizationPolicy;
};

export type RuntimeWsServer = {
  url: string;
  stop(closeActiveConnections?: boolean): void;
};

function eventPayload(id: number, event: RuntimeEvent): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "event",
    params: { id, event },
  });
}

type WsClientData = {
  session?: string;
  authorization?: RuntimeAuthorizationContext;
};

type WsClient = WsClientData & { ws: ServerWebSocket<WsClientData> };

export function createRuntimeWsServer(
  options: RuntimeWsServerOptions,
): RuntimeWsServer {
  const clients = new Set<WsClient>();
  const eventBuffer: Array<{ id: number; event: RuntimeEvent }> = [];
  let nextEventID = 1;

  options.client.start((event) => {
    const id = nextEventID++;
    eventBuffer.push({ id, event });
    if (eventBuffer.length > 500) eventBuffer.shift();
    for (const { ws, session } of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const own = (event as { sessionID?: unknown }).sessionID;
      if (typeof own === "string" && session !== undefined && own !== session)
        continue;
      ws.send(eventPayload(id, event));
    }
  });

  const server = Bun.serve<WsClientData>({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz")
        return Response.json({ ok: true, apiVersion: API_VERSION });
      const authorization = resolveAuthorization(
        req,
        options.authorization,
        options.token,
      );
      if (authorization === "denied")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      if (url.pathname === "/ws") {
        const requestedSession = url.searchParams.get("session") ?? undefined;
        const allowedSessions = credentialSessions(authorization);
        if (
          requestedSession &&
          allowedSessions &&
          !allowedSessions.has(requestedSession)
        )
          return Response.json({ error: "forbidden" }, { status: 403 });
        const upgraded = server.upgrade(req, {
          data: {
            session: requestedSession,
            authorization,
          } as WsClientData,
        });
        if (upgraded) return undefined;
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
    websocket: {
      open(ws) {
        const client: WsClient = { ws, ...ws.data };
        clients.add(client);
        for (const { id, event } of eventBuffer) {
          const own = (event as { sessionID?: unknown }).sessionID;
          if (
            typeof own === "string" &&
            client.session !== undefined &&
            own !== client.session
          )
            continue;
          ws.send(eventPayload(id, event));
        }
      },
      async message(ws, raw) {
        let body: RPCRequest;
        try {
          body = JSON.parse(raw.toString());
        } catch {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            }),
          );
          return;
        }
        const result = await handleRPCMessage(
          body,
          options.client,
          undefined,
          ws.data.authorization,
        );
        ws.send(JSON.stringify(result));
      },
      close(ws) {
        for (const client of clients)
          if (client.ws === ws) clients.delete(client);
      },
      drain(_ws) {
        /* Bun manages backpressure internally */
      },
    },
  });

  return {
    url: `ws://${server.hostname}:${server.port}`,
    stop(closeConnections) {
      if (closeConnections) {
        for (const client of clients) {
          client.ws.close(1001, "Server shutting down");
        }
        clients.clear();
      }
      server.stop();
    },
  };
}
