import { expect, test } from "bun:test";
import {
  RUNTIME_RPC_ERROR_CODES,
  failureKindOfCode,
} from "@anthelia/contracts";
import type { RuntimeClient, RuntimeEvent } from "@anthelia/contracts";
import { createRuntimeHttpServer } from "../src/host";

/**
 * P0-H: the terminal write surface (`nativeTerminal.start` / `.write` /
 * `.resize`) is gated at the deployment layer, like `/tasks/run`. The routes
 * exist and are writes; without the host's explicit `terminalWrite: true`
 * they answer refused, so a host that never opted in cannot be reached
 * remotely through a terminal write. Remote callers are model-side actors.
 */

function stubClient(): RuntimeClient {
  const client: RuntimeClient = {
    start() {},
    async submit() {
      return {
        type: "turn.submitted",
        id: "t",
        text: "",
        byteLength: 0,
        lineCount: 1,
        sha256: "0",
      };
    },
    async cancel() {},
    snapshot() {
      return {
        type: "diagnostic",
        level: "info",
        message: "stub",
      } as RuntimeEvent;
    },
    diagnostic() {},
    lastSubmission() {
      return undefined;
    },
    async respondApproval() {
      return { accepted: true };
    },
    async respondQuestion() {
      return { accepted: true };
    },
    async nativeTerminalStart(input) {
      return {
        id: input.id ?? "term_1",
        host: "wezterm",
        paneID: 1,
        windowID: 1,
        muxWindowID: 1,
        tabID: 1,
        command: input.command,
        cwd: input.cwd ?? "",
        status: "running",
        inputOwner: "model",
        geometryOwner: "human",
        secureInput: false,
        rows: 36,
        cols: 120,
        startedAt: new Date().toISOString(),
        attached: true,
      };
    },
    async nativeTerminalWrite(input) {
      return {
        id: input.id,
        writtenBytes: input.input.length,
        delivery: "accepted",
      };
    },
    async nativeTerminalResize(input) {
      return {
        id: input.id,
        host: "wezterm",
        paneID: 1,
        windowID: 1,
        muxWindowID: 1,
        tabID: 1,
        command: "bash",
        cwd: "",
        status: "running",
        inputOwner: "model",
        geometryOwner: "human",
        secureInput: false,
        rows: input.rows,
        cols: input.cols,
        startedAt: new Date().toISOString(),
        attached: true,
      };
    },
  };
  return client;
}

async function rpc(
  server: ReturnType<typeof createRuntimeHttpServer>,
  method: string,
  params: Record<string, unknown> = {},
) {
  const response = await fetch(`${server.url}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await response.json()) as {
    result?: unknown;
    error?: { code: number; message: string; data?: { kind: string } };
  };
}

test("terminal writes are refused unless the host enables them", async () => {
  const server = createRuntimeHttpServer({
    client: stubClient(),
    events: false,
  });
  try {
    for (const method of [
      "nativeTerminal.start",
      "nativeTerminal.write",
      "nativeTerminal.resize",
    ]) {
      const { error } = await rpc(server, method, {
        command: "bash",
        id: "term_1",
        input: "ls",
        rows: 24,
        cols: 80,
      });
      expect(error?.code, `${method} must be refused when gated`).toBe(
        RUNTIME_RPC_ERROR_CODES.refused,
      );
      expect(error?.message).toContain("terminal write is not enabled");
    }
  } finally {
    server.stop();
  }
});

test("enabling terminal writes makes the three routes call through", async () => {
  const client = stubClient();
  const server = createRuntimeHttpServer({
    client,
    terminalWrite: true,
    events: false,
  });
  try {
    const start = await rpc(server, "nativeTerminal.start", {
      command: "bash",
      cwd: "/tmp",
    });
    expect((start.result as { id?: string })?.id).toBe("term_1");
    expect((start.result as { status?: string })?.status).toBe("running");

    const write = await rpc(server, "nativeTerminal.write", {
      id: "term_1",
      input: "ls\r",
      idempotencyKey: "k1",
    });
    expect((write.result as { delivery?: string })?.delivery).toBe("accepted");

    const resize = await rpc(server, "nativeTerminal.resize", {
      id: "term_1",
      rows: 24,
      cols: 80,
    });
    expect((resize.result as { rows?: number })?.rows).toBe(24);
  } finally {
    server.stop();
  }
});

test("a gated terminal write is refused, not leaked as missing", async () => {
  const server = createRuntimeHttpServer({
    client: stubClient(),
    events: false,
  });
  try {
    const { error } = await rpc(server, "nativeTerminal.write", {
      id: "x",
      input: "y",
    });
    expect(error?.code).toBe(RUNTIME_RPC_ERROR_CODES.refused);
    expect(failureKindOfCode(error?.code ?? 0)).toBe("refused");
    expect(error?.message).not.toContain("not found");
  } finally {
    server.stop();
  }
});
