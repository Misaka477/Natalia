import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import {
  NATIVE_INPUT_BROKER_VERSION,
  NativeTerminalRegistry,
  decodeNativeInputDecision,
  startNativeInputBroker,
} from "../src";

test("local input broker atomically claims without relaying input bytes", async () => {
  const writes: string[] = [];
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 91, window_id: 2, tab_id: 3 };
    },
    async list() {
      return [{ pane_id: 91, window_id: 2, tab_id: 3, rows: 24, cols: 80 }];
    },
    async read() {
      return "";
    },
    async write(_paneID, data) {
      writes.push(data);
    },
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const session = await registry.start({ cwd: "/repo", command: "cat" });
  const broker = await startNativeInputBroker({
    registry,
    runtimeDir: await mkdtemp(join(tmpdir(), "natalia-input-broker-")),
    daemonID: "daemon_1",
    token: "token_1",
  });
  try {
    const response = await send(
      broker.endpoint,
      `${JSON.stringify({
        version: NATIVE_INPUT_BROKER_VERSION,
        type: "claim",
        nonce: "nonce_1",
        token: broker.token,
        terminalID: `pane_${session.paneID}`,
        paneID: session.paneID,
        kind: "paste",
        byteLength: 16,
      })}\n`,
    );
    expect(decodeNativeInputDecision(response)).toMatchObject({ permit: true });
    expect(registry.list()).toMatchObject([{ inputOwner: "human" }]);
    expect(writes).toEqual([]);
  } finally {
    await broker.stop();
  }
});

test("local input broker records only the first human ownership claim", async () => {
  const inputs: Array<{ terminalID: string; kind: string }> = [];
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 94, window_id: 2, tab_id: 3 };
    },
    async list() {
      return [{ pane_id: 94, window_id: 2, tab_id: 3, rows: 24, cols: 80 }];
    },
    async read() {
      return "";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const session = await registry.start({ cwd: "/repo", command: "cat" });
  const broker = await startNativeInputBroker({
    registry,
    runtimeDir: await mkdtemp(join(tmpdir(), "natalia-input-broker-")),
    daemonID: "claim_once",
    token: "token_claim_once",
    onInput: (input) => inputs.push(input),
  });
  try {
    for (const nonce of ["nonce_first", "nonce_second"]) {
      const response = await send(
        broker.endpoint,
        `${JSON.stringify({
          version: NATIVE_INPUT_BROKER_VERSION,
          type: "claim",
          nonce,
          token: broker.token,
          terminalID: `pane_${session.paneID}`,
          paneID: session.paneID,
          kind: "keyboard",
          byteLength: 1,
        })}\n`,
      );
      expect(decodeNativeInputDecision(response).permit).toBe(true);
    }
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      terminalID: session.id,
      kind: "keyboard",
    });
    expect(registry.list()[0]).toMatchObject({ inputOwner: "human" });
  } finally {
    await broker.stop();
    await registry.dispose();
  }
});

test("local input broker denies an unknown pane without changing ownership", async () => {
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 92, window_id: 2, tab_id: 3 };
    },
    async list() {
      return [{ pane_id: 92, window_id: 2, tab_id: 3, rows: 24, cols: 80 }];
    },
    async read() {
      return "";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const session = await registry.start({ cwd: "/repo", command: "cat" });
  const broker = await startNativeInputBroker({
    registry,
    runtimeDir: await mkdtemp(join(tmpdir(), "natalia-input-broker-")),
    daemonID: "daemon_2",
    token: "token_2",
  });
  try {
    const response = await send(
      broker.endpoint,
      `${JSON.stringify({
        version: NATIVE_INPUT_BROKER_VERSION,
        type: "claim",
        nonce: "nonce_2",
        token: broker.token,
        terminalID: `pane_${session.paneID + 1}`,
        paneID: session.paneID + 1,
        kind: "keyboard",
        byteLength: 1,
      })}\n`,
    );
    expect(decodeNativeInputDecision(response)).toMatchObject({
      permit: false,
    });
    expect(registry.list()).toMatchObject([{ inputOwner: "model" }]);
  } finally {
    await broker.stop();
  }
});

test("metadata-only native claim switches ownership without relaying bytes", async () => {
  const writes: string[] = [];
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 93, window_id: 2, tab_id: 3 };
    },
    async list() {
      return [{ pane_id: 93, window_id: 2, tab_id: 3, rows: 24, cols: 80 }];
    },
    async read() {
      return "";
    },
    async write(_paneID, data) {
      writes.push(data);
    },
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const session = await registry.start({ cwd: "/repo", command: "cat" });
  const broker = await startNativeInputBroker({
    registry,
    runtimeDir: await mkdtemp(join(tmpdir(), "natalia-input-broker-")),
    daemonID: "daemon_3",
    token: "token_3",
  });
  try {
    const response = await send(
      broker.endpoint,
      `${JSON.stringify({
        version: NATIVE_INPUT_BROKER_VERSION,
        type: "claim",
        nonce: "nonce_3",
        token: broker.token,
        terminalID: `pane_${session.paneID}`,
        paneID: session.paneID,
        kind: "ime_commit",
        byteLength: 6,
      })}\n`,
    );
    expect(decodeNativeInputDecision(response)).toMatchObject({ permit: true });
    expect(registry.list()).toMatchObject([{ inputOwner: "human" }]);
    expect(writes).toEqual([]);
  } finally {
    await broker.stop();
  }
});

function send(endpoint: string, frame: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection(endpoint);
    let response = "";
    socket.on("connect", () => socket.write(frame));
    socket.on("data", (chunk) => (response += chunk.toString("utf8")));
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}
