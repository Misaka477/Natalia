import { randomBytes } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import {
  decodeNativeInputClaim,
  encodeNativeInputDecision,
  nativeInputBrokerDecision,
  nativeInputBrokerEndpoint,
} from "./input-broker";
import type { NativeTerminalRegistry } from "./index";

export type NativeInputBroker = {
  endpoint: string;
  token: string;
  stop(): Promise<void>;
};

/**
 * Serves a private, line-delimited claim/decision exchange. The native host
 * retains the input bytes and writes them through its original pane path.
 */
export async function startNativeInputBroker(input: {
  registry: NativeTerminalRegistry;
  runtimeDir: string;
  daemonID: string;
  token?: string;
  platform?: NodeJS.Platform;
  onInput?: (input: {
    terminalID: string;
    paneID: number;
    kind: string;
    byteLength: number;
  }) => void;
  onDenied?: (input: {
    terminalID: string;
    paneID: number;
    tokenAccepted: boolean;
    paneAccepted: boolean;
  }) => void;
}): Promise<NativeInputBroker> {
  const platform = input.platform ?? process.platform;
  const endpoint = nativeInputBrokerEndpoint({
    runtimeDir: input.runtimeDir,
    daemonID: input.daemonID,
    platform,
  });
  const token = input.token ?? randomBytes(32).toString("base64url");
  if (platform !== "win32") await rm(endpoint, { force: true });
  const server = createServer({ allowHalfOpen: true }, (socket) =>
    handleConnection(
      socket,
      input.registry,
      token,
      input.onInput,
      input.onDenied,
    ),
  );
  const serverEvents = server as unknown as NodeJS.EventEmitter;
  await new Promise<void>((resolve, reject) => {
    serverEvents.once("error", reject);
    server.listen(endpoint, () => {
      serverEvents.off("error", reject);
      resolve();
    });
  });
  if (platform !== "win32") await chmod(endpoint, 0o600);
  return { endpoint, token, stop: () => stop(server, endpoint, platform) };
}

async function stop(
  server: Server,
  endpoint: string,
  platform: NodeJS.Platform,
) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (platform !== "win32") await rm(endpoint, { force: true });
}

function handleConnection(
  socket: Socket,
  registry: NativeTerminalRegistry,
  token: string,
  onInput?: (input: {
    terminalID: string;
    paneID: number;
    kind: string;
    byteLength: number;
  }) => void,
  onDenied?: (input: {
    terminalID: string;
    paneID: number;
    tokenAccepted: boolean;
    paneAccepted: boolean;
  }) => void,
) {
  let buffer = "";
  socket.setTimeout(1_000, () => socket.destroy());
  socket.on("data", async (chunk) => {
    buffer += chunk.toString("utf8");
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const frame = buffer.slice(0, newline);
    buffer = "";
    try {
      const event = decodeNativeEvent(frame);
      const knownPanes = new Map(
        registry
          .list()
          .filter((session) => session.status === "running")
          .map((session) => [session.paneID, session.id]),
      );
      const decision = nativeInputBrokerDecision({
        event,
        expectedToken: token,
        knownPanes,
      });
      const terminalID = knownPanes.get(event.paneID);
      if (!decision.permit)
        onDenied?.({
          terminalID: terminalID ?? event.terminalID,
          paneID: event.paneID,
          tokenAccepted: event.token === token,
          paneAccepted: terminalID !== undefined,
        });
      if (decision.permit) {
        const ownershipChanged = !registry.isHumanInputOwner(terminalID!);
        await registry.claimHumanInput(terminalID!);
        if (ownershipChanged)
          onInput?.({
            terminalID: terminalID!,
            paneID: event.paneID,
            kind: event.kind,
            byteLength: event.byteLength,
          });
      }
      socket.end(encodeNativeInputDecision(decision));
    } catch {
      socket.destroy();
    }
  });
}

function decodeNativeEvent(frame: string) {
  return decodeNativeInputClaim(frame);
}
