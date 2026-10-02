import { expect, test } from "bun:test";
import type {
  RuntimeClient,
  RuntimeNativeTerminalSession,
} from "@anthelia/contracts";
import { createRuntimeHttpServer } from "../src/host";
import {
  matchTerminalPath,
  authorizeTerminalSession,
} from "../src/terminal-ws";

test("matchTerminalPath extracts session and terminal ids", () => {
  expect(matchTerminalPath("/terminal/ses_abc/term_1")).toEqual({
    sessionID: "ses_abc",
    terminalID: "term_1",
  });
  expect(matchTerminalPath("/rpc")).toBeUndefined();
});

test("authorizeTerminalSession respects credential session grants", () => {
  expect(authorizeTerminalSession("ses_a", undefined)).toBe(true);
  expect(
    authorizeTerminalSession("ses_a", {
      write: true,
      sessions: new Set(["ses_a"]),
    }),
  ).toBe(true);
  expect(
    authorizeTerminalSession("ses_b", {
      write: true,
      sessions: new Set(["ses_a"]),
    }),
  ).toBe(false);
});

test("HTTP terminal websocket is gated behind terminalWrite", async () => {
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
      return { type: "diagnostic", level: "info", message: "stub" };
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
  };
  const closed = createRuntimeHttpServer({ client });
  const denied = await fetch(`${closed.url}/terminal/ses_a/term_1`);
  expect(denied.status).toBe(403);
  closed.stop(true);

  const sessions: RuntimeNativeTerminalSession[] = [];
  const writes: string[] = [];
  const open = createRuntimeHttpServer({
    client: {
      ...client,
      async nativeTerminalList() {
        return sessions;
      },
      async nativeTerminalStart(input) {
        const session: RuntimeNativeTerminalSession = {
          id: input.id ?? "term_1",
          host: "pty",
          paneID: 1,
          windowID: 0,
          muxWindowID: 0,
          tabID: 0,
          command: input.command,
          cwd: input.cwd ?? "",
          status: "running",
          inputOwner: "model",
          geometryOwner: "human",
          secureInput: false,
          rows: 24,
          cols: 80,
          startedAt: new Date().toISOString(),
          attached: true,
          sessionID: input.sessionID,
        };
        sessions.push(session);
        return session;
      },
      async nativeTerminalRead(id) {
        return { id, text: "prompt$ " };
      },
      async nativeTerminalWrite(input) {
        writes.push(input.input);
        return {
          id: input.id,
          writtenBytes: input.input.length,
          delivery: "accepted",
        };
      },
      subscribeTerminalOutput(_id, listener) {
        listener("live\n");
        return () => undefined;
      },
    },
    terminalWrite: true,
  });
  const ws = new WebSocket(
    `${open.url.replace("http", "ws")}/terminal/ses_a/term_web`,
  );
  const messages: unknown[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws failed"));
  });
  await new Promise<void>((resolve) => {
    ws.onmessage = (event) => {
      messages.push(JSON.parse(String(event.data)));
      if (messages.some((item) => (item as { type?: string }).type === "ready"))
        resolve();
    };
  });
  // The pane's screen comes back BEFORE the live stream continues, so a
  // reattach does not start blank.
  expect(messages).toEqual([
    { type: "restore", id: "term_web", text: "prompt$ " },
    { type: "output", data: "live\n" },
    expect.objectContaining({ type: "ready", id: "term_web" }),
  ]);
  ws.send(JSON.stringify({ type: "input", data: "ls\n" }));
  await Bun.sleep(50);
  expect(writes).toEqual(["ls\n"]);
  ws.close();
  open.stop(true);
});

test("HTTP terminal websocket reports missing start as a fatal error", async () => {
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
      return { type: "diagnostic", level: "info", message: "stub" };
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
  };
  const server = createRuntimeHttpServer({ client, terminalWrite: true });
  const ws = new WebSocket(
    `${server.url.replace("http", "ws")}/terminal/ses_a/term_web`,
  );
  const messages: unknown[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws failed"));
  });
  await new Promise<void>((resolve) => {
    ws.onmessage = (event) => {
      messages.push(JSON.parse(String(event.data)));
      resolve();
    };
  });
  expect(messages).toEqual([
    {
      type: "error",
      fatal: true,
      message:
        "no active workspace: open or activate a workspace before using the terminal",
    },
  ]);
  ws.close();
  server.stop(true);
});

test("HTTP terminal websocket refuses a terminal owned by another session", async () => {
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
      return { type: "diagnostic", level: "info", message: "stub" };
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
    async nativeTerminalList() {
      return [
        {
          id: "term_a",
          host: "pty" as const,
          paneID: 1,
          windowID: 0,
          muxWindowID: 0,
          tabID: 0,
          command: "bash",
          cwd: "",
          status: "running" as const,
          inputOwner: "model" as const,
          geometryOwner: "human" as const,
          secureInput: false,
          rows: 24,
          cols: 80,
          startedAt: new Date().toISOString(),
          attached: true,
          sessionID: "ses_a",
        },
      ];
    },
    async nativeTerminalStart() {
      throw new Error("should not start a foreign terminal");
    },
  };
  const server = createRuntimeHttpServer({ client, terminalWrite: true });
  const ws = new WebSocket(
    `${server.url.replace("http", "ws")}/terminal/ses_b/term_a`,
  );
  const messages: unknown[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws failed"));
  });
  await new Promise<void>((resolve) => {
    ws.onmessage = (event) => {
      messages.push(JSON.parse(String(event.data)));
      resolve();
    };
  });
  expect(messages).toEqual([
    {
      type: "error",
      fatal: true,
      message: "terminal term_a belongs to session ses_a",
    },
  ]);
  ws.close();
  server.stop(true);
});

test("a failed screen replay does not cost the pane its live stream", async () => {
  // The replay is a convenience; the live output is the pane. A controller that
  // cannot serialise its buffer (a host without the reader, a pane already
  // gone) must degrade to "starts blank" rather than "never connects".
  const sessions: RuntimeNativeTerminalSession[] = [];
  const seen: string[] = [];
  const server = createRuntimeHttpServer({
    client: {
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
        return { type: "diagnostic", level: "info", message: "stub" };
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
      async nativeTerminalList() {
        return sessions;
      },
      async nativeTerminalStart(input) {
        const session: RuntimeNativeTerminalSession = {
          id: input.id ?? "term_replay",
          host: "pty",
          paneID: 1,
          windowID: 0,
          muxWindowID: 0,
          tabID: 0,
          command: input.command,
          cwd: input.cwd ?? "",
          status: "running",
          inputOwner: "model",
          geometryOwner: "human",
          secureInput: false,
          rows: 24,
          cols: 80,
          startedAt: new Date().toISOString(),
          attached: true,
          sessionID: input.sessionID,
        };
        sessions.push(session);
        return session;
      },
      async nativeTerminalRead() {
        throw new Error("buffer serialiser unavailable");
      },
      async nativeTerminalWrite() {
        return { id: "x", writtenBytes: 0, delivery: "accepted" as const };
      },
      subscribeTerminalOutput(_id, listener) {
        listener("still streaming\n");
        return () => undefined;
      },
    },
    terminalWrite: true,
  });
  const ws = new WebSocket(
    `${server.url.replace("http", "ws")}/terminal/ses_r/term_replay`,
  );
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws failed"));
  });
  await new Promise<void>((resolve) => {
    ws.onmessage = (event) => {
      seen.push(String(event.data));
      if (String(event.data).includes('"ready"')) resolve();
    };
  });
  // The failure is reported, and the live output still arrives.
  expect(seen.some((raw) => raw.includes("screen replay failed"))).toBe(true);
  expect(seen.some((raw) => raw.includes("still streaming"))).toBe(true);
  ws.close();
  server.stop(true);
});

test("an empty pane reconnects to an empty screen, not to the last session's", async () => {
  // The reattach hazard that survives "the replay is sent": the server only sends
  // a restore when the pane HAS text, so a genuinely empty pane (a shell that just
  // started, or one that exited and was respawned) gets no restore at all — and
  // the client never clears. Whatever the previous connection left on screen stays
  // there, which is the old session's content presented as this one's.
  //
  // The client's two restore handlers both do `term.clear()` before writing, so
  // the fix is on the sender: it must clear unconditionally and let the empty
  // text be empty.
  const server = createRuntimeHttpServer({
    client: {
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
        return { type: "diagnostic", level: "info", message: "stub" };
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
      async nativeTerminalList() {
        return [];
      },
      async nativeTerminalStart(input) {
        return {
          id: input.id ?? "term_empty",
          host: "pty",
          paneID: 1,
          windowID: 0,
          muxWindowID: 0,
          tabID: 0,
          command: input.command,
          cwd: "",
          status: "running",
          inputOwner: "model",
          geometryOwner: "human",
          secureInput: false,
          rows: 24,
          cols: 80,
          startedAt: new Date().toISOString(),
          attached: true,
          sessionID: input.sessionID,
        } as RuntimeNativeTerminalSession;
      },
      async nativeTerminalRead() {
        // The pane is genuinely empty.
        return { id: "term_empty", text: "" };
      },
      async nativeTerminalWrite() {
        return { id: "x", writtenBytes: 0, delivery: "accepted" as const };
      },
      subscribeTerminalOutput() {
        return () => undefined;
      },
    },
    terminalWrite: true,
  });
  const ws = new WebSocket(
    `${server.url.replace("http", "ws")}/terminal/ses_empty/term_empty`,
  );
  const messages: Array<Record<string, unknown>> = [];
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws failed"));
  });
  await new Promise<void>((resolve) => {
    ws.onmessage = (event) => {
      messages.push(JSON.parse(String(event.data)));
      if (messages.some((m) => m["type"] === "ready")) resolve();
    };
  });
  // The FIRST message must be the replay, and it must be sent even though the
  // text is empty: an absent restore leaves the previous session on screen.
  expect(messages[0]).toEqual({
    type: "restore",
    id: "term_empty",
    text: "",
  });
  ws.close();
  server.stop(true);
});
