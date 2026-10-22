/**
 * Local bridge server between Natalia runtime and the browser extension.
 *
 * The Chrome/Edge extension connects to ws://127.0.0.1:<port> and processes
 * browser_* commands. Natalia tools call HTTP POST /browser/<action> on the
 * same server; the server forwards to the extension and relays the result.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type BrowserBridgeServerOptions = {
  host?: string;
  port?: number;
  onConnection?: (kind: "extension" | "tool") => void;
  onCommand?: (action: string, payload: Record<string, unknown>) => void;
};

export type BrowserBridgeServer = {
  url: string;
  close(): Promise<void>;
};

type ExtensionConnection = {
  id: string;
  send(payload: unknown): void;
  close(): void;
};

const DEFAULT_PORT = 18765;

export function createBrowserBridgeServer(
  options: BrowserBridgeServerOptions = {},
): BrowserBridgeServer {
  const host = options.host ?? "127.0.0.1";
  const port =
    options.port ??
    Number(process.env.NATALIA_BROWSER_BRIDGE_PORT ?? DEFAULT_PORT);
  const extensionConnections = new Map<string, ExtensionConnection>();
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const BROWSER_ACTIONS = new Set([
    "open",
    "close",
    "tabs",
    "navigate",
    "read",
    "scan",
    "execute_js",
    "click",
    "input",
    "screenshot",
  ]);
  /**
   * The per-socket data: the extension flag the upgrade sets, plus the
   * connection id the open handler stores so the close handler can name
   * exactly the connection that closed.
   */
  type BridgeSocketData = { extension: boolean; connectionId?: string };

  let server: ReturnType<typeof Bun.serve<BridgeSocketData>> | undefined;
  let connectionCounter = 0;

  function sendToExtension(message: unknown) {
    for (const connection of extensionConnections.values())
      connection.send(message);
  }
  const serverInstance = Bun.serve<BridgeSocketData>({
    hostname: host,
    port,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (server.upgrade(request, { data: { extension: true } }))
          return undefined;
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        return Response.json({
          ok: true,
          extensions: extensionConnections.size,
        });
      }
      if (url.pathname.startsWith("/browser/") && request.method === "POST") {
        const action = url.pathname.slice("/browser/".length);
        let payload: Record<string, unknown> = {};
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          // empty body
        }
        options.onCommand?.(action, payload);
        if (!BROWSER_ACTIONS.has(action)) {
          return Response.json(
            { error: `unknown browser action: ${action}` },
            { status: 404 },
          );
        }
        if (extensionConnections.size === 0) {
          return Response.json(
            {
              error:
                "browser extension is not connected; install/load Natalia Browser Bridge in Chrome/Edge",
            },
            { status: 503 },
          );
        }
        const id = randomUUID();
        const result = new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`browser command timed out: ${action}`));
          }, 30_000);
          pending.set(id, { resolve, reject, timer });
        });
        sendToExtension({ id, action, payload });
        try {
          const value = await result;
          return Response.json(value);
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          );
        }
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const connectionId = `ext_${++connectionCounter}_${Date.now()}`;
        // The id rides the socket itself: the close handler receives the
        // same ws, and a ServerWebSocket exposes no id of its own. A close
        // that cannot name its connection removes the wrong one — or, when
        // it removes nothing, leaves a dead socket in the map that every
        // later command is sent to.
        ws.data = { extension: true, connectionId };
        const connection: ExtensionConnection = {
          id: connectionId,
          send(payload) {
            ws.send(JSON.stringify(payload));
          },
          close() {
            ws.close();
          },
        };
        extensionConnections.set(connectionId, connection);
        options.onConnection?.("extension");
      },
      message(ws, raw) {
        let message: { id?: string; result?: unknown; error?: string };
        try {
          message = JSON.parse(String(raw)) as {
            id?: string;
            result?: unknown;
            error?: string;
          };
        } catch {
          return;
        }
        if (!message.id) return;
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error));
        else entry.resolve(message.result);
      },
      close(ws) {
        // Remove exactly the connection that closed, named by the id the
        // open handler stored on the socket. The implementation this
        // replaces removed every connection on any close, so one tab
        // disconnecting killed every other tab's connection too.
        const connectionId = (ws.data as { connectionId?: string } | undefined)
          ?.connectionId;
        if (connectionId) extensionConnections.delete(connectionId);
        if (extensionConnections.size === 0) {
          options.onConnection?.("tool");
        }
      },
    },
  });
  server = serverInstance;

  return {
    url: `http://${host}:${serverInstance.port}`,
    async close() {
      const current = server;
      if (current) {
        current.stop(true);
        server = undefined;
      }
    },
    // expose internals for framework composition
  } as BrowserBridgeServer & Record<string, unknown>;
}

export async function startBrowserBridgeServer(
  options: BrowserBridgeServerOptions = {},
) {
  const bridge = createBrowserBridgeServer(options);
  console.log(`[browser-bridge] listening on ${bridge.url}`);
  return bridge;
}

if (
  import.meta.main &&
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await startBrowserBridgeServer();
}
