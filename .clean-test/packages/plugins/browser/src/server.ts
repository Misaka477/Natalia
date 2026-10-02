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
  const extensionConnections = new Set<ExtensionConnection>();
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
  let server: ReturnType<typeof Bun.serve<{ extension: boolean }>> | undefined;

  function sendToExtension(message: unknown) {
    for (const connection of extensionConnections) connection.send(message);
  }

  const serverInstance = Bun.serve<{ extension: boolean }>({
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
        const connection: ExtensionConnection = {
          send(payload) {
            ws.send(JSON.stringify(payload));
          },
          close() {
            ws.close();
          },
        };
        extensionConnections.add(connection);
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
        for (const connection of [...extensionConnections]) {
          // No per-connection id; remove all for simplicity in this base version.
          extensionConnections.delete(connection);
        }
        options.onConnection?.("tool");
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
