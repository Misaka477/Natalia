import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp as createEmptyWorkspace,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, expect, test } from "bun:test";
import { createRealRuntimeClient as createRuntimeClient } from "../src";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import type {
  ProviderStreamRequest,
  StreamingProvider,
} from "@anthelia/runtime";
import { providerError } from "@anthelia/runtime";
import { CapabilityRegistry } from "@anthelia/capability";
import { createToolRegistry } from "@anthelia/tools";
import { fingerprintFile, recordTrust, resolveConfig } from "@anthelia/config";
import { SessionStoreTestDatabase } from "@natalia/testing";
import {
  sandboxService,
  terminalController,
  type SandboxService,
} from "@anthelia/runtime-services";
import { checkpointFactory } from "@anthelia/checkpoint";
import { retryService } from "@anthelia/retry";
import { resolveWorkspaceJournalDatabasePath } from "@anthelia/platform";
import { turnController } from "@anthelia/turn-orchestration";
import { providerModelController } from "@anthelia/provider-model";
import { compactionService } from "@anthelia/compaction";
import {
  workspaceFiles,
  workspaceMutations,
  workspaceWriteLock,
} from "@anthelia/workspace";
import {
  TerminalTestRegistry as NativeTerminalRegistry,
  WorkspaceSandboxTestManager as WorkspaceSandboxManager,
} from "@natalia/testing";
import {
  createOfficialRuntimeClient,
  restoreOfficialPluginConfig,
  installFixturePlugin,
  officialPluginWorkspace as mkdtemp,
  useWorkspaceCleanup,
  registerTestArtifact,
} from "./plugin-test-helpers";

useWorkspaceCleanup();
import { projectedWorkGraphEdges } from "@anthelia/session";
import { toolCallNodeID } from "@natalia/work-ledger";
import { normalizePendingItems } from "@natalia/ui-model";
import type { ProviderModelController } from "@anthelia/provider-model";

import {
  ambientGovernanceRoot,
  MCP_PLUGIN_ID,
  SKILLS_PLUGIN_ID,
  TEAM_PLUGIN_ID,
  TODO_PLUGIN_ID,
  createRealRuntimeClient,
  scriptedProvider,
  singleToolProvider,
  interactiveTerminalProvider,
  nativeTerminalFixture,
  usageProvider,
  contextLimitThenSuccessProvider,
  toolCallingProvider,
  writeFileProvider,
  approvalWriteProvider,
  questionToolProvider,
  delayedStreamingProvider,
  subagentProvider,
  subagentCompactionProvider,
  subagentToolProvider,
  subagentRawXMLToolProvider,
  waitFor,
  waitForProcessExit,
  fingerprintEntry,
  isCollabMessageEvent,
  waitForAsync,
  pollHistoryForFinished,
  sqliteContinueProvider,
  sqliteContinueRegistry,
  sandboxedSubagentProvider,
  sandboxedDomainProvider,
  imageAttachProvider,
  subagentPlanPointerProvider,
  MAIN_PLAN_ID,
  subagentCacheUsageProvider,
} from "./real-runtime-harness";
import type { NamespacedCollabMessageEvent } from "./real-runtime-harness";

test("ordinary tools settle as failed when their execution timeout expires", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-tool-timeout-"));
  const tools = createToolRegistry([]);
  tools.set("wait_forever", {
    name: "wait_forever",
    description: "Wait until the runtime cancels this tool.",
    requiresApproval: false,
    timeoutSec: 0.01,
    parameters: { type: "object", properties: {} },
    async execute() {
      return await new Promise<string>(() => undefined);
    },
  });
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_tool_timeout",
    tools,
    provider: {
      provider: "scripted-tool-timeout",
      model: "scripted-tool-timeout-model",
      async *stream(request) {
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool_call",
            calls: [
              {
                id: "call_wait",
                name: "wait_forever",
                arguments: "{}",
              },
            ],
          };
        } else {
          yield { type: "content", text: "The tool timed out; task stopped." };
        }
        yield { type: "done" };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("wait forever");

  expect(
    events.find(
      (event) =>
        event.type === "tool.update" &&
        event.callID === "call_wait" &&
        event.status === "failed",
    ),
  ).toBeDefined();
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "turn.finished",
      id: expect.any(String),
      stopReason: "done",
      sessionID: "ses_ts7_tool_timeout",
    }),
  );
});

test("a tool can extend its timeout through a bounded per-call argument", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-ts7-tool-timeout-override-"),
  );
  const tools = createToolRegistry([]);
  tools.set("wait_briefly", {
    name: "wait_briefly",
    description: "Wait briefly before returning.",
    requiresApproval: false,
    timeoutSec: 0.1,
    maxTimeoutSec: 5,
    parameters: {
      type: "object",
      properties: { timeoutSec: { type: "number" } },
    },
    async execute() {
      await Bun.sleep(250);
      return "finished";
    },
  });
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_tool_timeout_override",
    tools,
    provider: {
      provider: "scripted-tool-timeout-override",
      model: "scripted-tool-timeout-override-model",
      async *stream(request) {
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool_call",
            calls: [
              {
                id: "call_wait_briefly",
                name: "wait_briefly",
                arguments: JSON.stringify({ timeoutSec: 1 }),
              },
            ],
          };
        } else {
          yield { type: "content", text: "The bounded wait finished." };
        }
        yield { type: "done" };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("wait briefly");

  expect(
    events.find(
      (event) =>
        event.type === "tool.update" &&
        event.callID === "call_wait_briefly" &&
        event.status === "succeeded",
    ),
  ).toBeDefined();
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "turn.finished",
      id: expect.any(String),
      stopReason: "done",
      sessionID: "ses_ts7_tool_timeout_override",
    }),
  );
});

test("runtime status counts managed background processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-background-"));
  const handled = new Set<string>();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_background",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        const text = [...request.messages]
          .reverse()
          .find((message) => message.role === "user")?.content;
        if (typeof text === "string" && !handled.has(text)) {
          handled.add(text);
          yield {
            type: "tool_call" as const,
            calls: [
              text === "start"
                ? {
                    id: "start",
                    name: "process_start",
                    arguments: JSON.stringify({
                      id: "proc_status",
                      command: "sleep 30",
                    }),
                  }
                : {
                    id: "stop",
                    name: "process_stop",
                    arguments: JSON.stringify({ id: "proc_status" }),
                  },
            ],
          };
        }
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("start");
  expect(await client.runtimeStatus?.()).toMatchObject({
    background: "1 running",
  });
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "status.snapshot" && event.background === "1 running",
    ),
  );
  await client.submitAndWait!("stop");
  expect(await client.runtimeStatus?.()).toMatchObject({
    background: "0 running",
  });
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "status.snapshot" && event.background === "0 running",
    ),
  );
});

test("write approval uses a compact preview and preserves raw request detail", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-approval-preview-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_approval_preview",
    provider: approvalWriteProvider(),
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.submitAndWait!("write a note");
  const approval = events.find(
    (event): event is Extract<RuntimeEvent, { type: "approval.request" }> =>
      event.type === "approval.request",
  )!;
  expect(approval.preview).toContain("Write long-note.md");
  expect(approval.preview.length).toBeLessThan(300);
  expect(approval.detail).toContain('"content"');
});

test("cancelling a pending approval settles the active turn without polling", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-approval-cancel-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_approval_cancel",
    provider: approvalWriteProvider(),
  });
  let cancelled = false;
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request" && !cancelled) {
      cancelled = true;
      client.cancel("approval cancelled");
    }
  });

  await client.submitAndWait!("write then cancel");
  expect(events.some((event) => event.type === "turn.cancelled")).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "turn.finished" && event.stopReason === "cancelled",
    ),
  ).toBe(true);
  expect(
    events.filter(
      (event) =>
        event.type === "turn.finished" && event.stopReason === "cancelled",
    ),
  ).toHaveLength(1);
});

test("submit after cancel returns without waiting for the next turn to finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-submit-after-cancel-"));
  let streamCalls = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_submit_after_cancel",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        streamCalls += 1;
        if (streamCalls === 1) {
          // Hold the turn open but honor abort: a provider that ignored the
          // signal would keep the interrupted drain from ever settling.
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) resolve();
            else
              request.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
          return;
        }
        yield { type: "content" as const, text: "continued" };
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  void client.submit("hang until cancelled");
  await waitFor(
    () => events.some((event) => event.type === "turn.submitted"),
    20_000,
    "the first turn to be admitted",
  );
  client.cancel("user cancel");
  const started = Date.now();
  const second = await Promise.race([
    client.submit("continue after stop"),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("submit hung")), 1000),
    ),
  ]);
  expect(Date.now() - started).toBeLessThan(500);
  expect(second.text).toBe("continue after stop");
  await waitFor(
    () =>
      events.some(
        (event) => event.type === "turn.submitted" && event.id === second.id,
      ),
    20_000,
    "the second turn to be admitted",
  );
  await client.dispose?.();
}, 120_000);

test("provider admission is persisted before the provider turn begins", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-admission-"));
  let started = false;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_ts7_admission",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        started = true;
        yield { type: "content" as const, text: "done" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  const submitted = await client.submitAndWait!("persist me first");
  await waitFor(() => started, 20_000, "the admitted turn to start streaming");
  expect(started).toBe(true);
  const stored = JSON.parse(
    await readFile(
      join(root, ".natalia", "sessions", "ses_ts7_admission.json"),
      "utf8",
    ),
  ) as { events: RuntimeEvent[]; inbox?: Array<Record<string, unknown>> };
  expect(
    stored.events.some(
      (event) => event.type === "turn.submitted" && event.id === submitted.id,
    ),
  ).toBe(true);
  expect(stored.inbox).toMatchObject([
    {
      id: submitted.id,
      text: "persist me first",
      delivery: "next-turn",
      promotedAt: expect.any(String),
    },
  ]);
});

test("queued input wakes an idle session after durable admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-queued-input-"));
  let started = false;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_ts7_queued_input",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        started = true;
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  const submitted = await client.submitInput!({
    text: "wait for idle",
    delivery: "next-turn",
  });
  await waitFor(() => started, 20_000, "the queued input to start streaming");
  expect(started).toBe(true);
  const stored = JSON.parse(
    await readFile(
      join(root, ".natalia", "sessions", "ses_ts7_queued_input.json"),
      "utf8",
    ),
  ) as { inbox?: Array<Record<string, unknown>> };
  expect(stored.inbox).toMatchObject([
    { id: submitted.id, text: "wait for idle", delivery: "next-turn" },
  ]);
  expect(stored.inbox?.[0]?.promotedAt).toEqual(expect.any(String));
  await client.dispose?.();
});

test("queued inputs promote in FIFO order after the active turn becomes idle", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-queued-promotion-"));
  const requests: string[] = [];
  let release: (() => void) | undefined;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_ts7_queued_promotion",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        const text = request.messages.at(-1)?.content ?? "";
        requests.push(text);
        if (text === "first")
          await new Promise<void>((resolve) => (release = resolve));
        yield { type: "content" as const, text: "done" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  const first = client.submit("first");
  while (!release) await Bun.sleep(1);
  const queued = await Promise.all(
    ["queued one", "queued two", "queued three"].map((text) =>
      client.submitInput!({ text, delivery: "next-turn" }),
    ),
  );
  release();
  await first;
  // Admission is fire-and-forget: queued rows promote through the coalesced
  // successor drain once the active turn goes idle.
  await waitFor(
    () =>
      requests.includes("queued one") &&
      requests.includes("queued two") &&
      requests.includes("queued three"),
    20_000,
    "the queued inputs to promote in order",
  );
  expect(requests.filter((text) => text === "first")).toHaveLength(1);
  expect(requests.filter((text) => text.startsWith("queued"))).toEqual([
    "queued one",
    "queued two",
    "queued three",
  ]);
  const stored = JSON.parse(
    await readFile(
      join(root, ".natalia", "sessions", "ses_ts7_queued_promotion.json"),
      "utf8",
    ),
  ) as { inbox?: Array<{ id: string; promotedAt?: string }> };
  expect(
    queued.every(
      (turn) =>
        stored.inbox?.find((item) => item.id === turn.id)?.promotedAt !==
        undefined,
    ),
  ).toBe(true);
  await client.dispose?.();
});

test("a queued input survives cancellation and drains on the next prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-cancel-queue-"));
  const requests: string[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_cancel_queue",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push(request.messages.at(-1)?.content ?? "");
        if (requests.length === 1)
          await new Promise<void>((resolve) => {
            const finish = () => resolve();
            if (request.signal?.aborted) finish();
            else
              request.signal?.addEventListener("abort", finish, { once: true });
          });
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  const first = client.submit("first");
  await waitFor(() => requests.length === 1, 20_000, "the first turn to start");
  await client.submitInput!({ text: "queued", delivery: "next-turn" });
  client.cancel("stop mid-turn");
  await first;
  // Stop interrupts the running drain and leaves durable inbox work alone:
  // nothing auto-promotes until the next admission wakes the session.
  await Bun.sleep(30);
  expect(requests).toEqual(["first"]);
  await client.submitInput!({ text: "resume please", delivery: "next-step" });
  await waitFor(
    () => requests.includes("queued"),
    20_000,
    "the queued input to drain after the next prompt",
  );
  expect(requests).toEqual(["first", "resume please", "queued"]);
  await client.dispose?.();
});

test("cancelling after admission but before execution does not start the turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-cancel-admission-"));
  const events: RuntimeEvent[] = [];
  let providerCalls = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_cancel_admission",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        providerCalls += 1;
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => {
    events.push(event);
    // Admission (`input.admitted`) still precedes execution (`turn.submitted`),
    // so cancelling here removes the queued input before any provider call.
    if (event.type === "input.admitted") client.cancel("cancel admission");
  });
  await client.submitAndWait!("do not start");
  await Bun.sleep(20);

  expect(providerCalls).toBe(0);
  expect(events).toContainEqual(
    expect.objectContaining({ type: "input.removed" }),
  );
  expect(events.some((event) => event.type === "turn.submitted")).toBe(false);
  await client.dispose?.();
});

test("exact input retry does not duplicate a completed provider turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-input-retry-"));
  let calls = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_input_retry",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        calls++;
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.submitAndWait!({
    id: "turn_retry",
    text: "same",
    delivery: "next-step",
  });
  await client.submitAndWait!({
    id: "turn_retry",
    text: "same",
    delivery: "next-step",
  });
  expect(calls).toBe(1);
  await expect(
    client.submitInput!({
      id: "turn_retry",
      text: "different",
      delivery: "next-step",
    }),
  ).rejects.toThrow("session input conflicts");
});

test("restart resumes a pending queued input but does not replay interrupted provider work", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-restart-queue-"));
  await mkdir(join(root, ".natalia", "sessions"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "sessions", "ses_ts7_restart_queue.json"),
    JSON.stringify({
      id: "ses_ts7_restart_queue",
      title: "Interrupted",
      createdAt: "2026-07-21T00:00:00.000Z",
      cancelled: false,
      resumable: true,
      metadata: {
        inFlightOperation: {
          kind: "provider_dispatch",
          turnID: "turn_interrupted",
          startedAt: "2026-07-21T00:00:01.000Z",
        },
      },
      events: [
        {
          type: "turn.submitted",
          id: "turn_interrupted",
          text: "unsafe to replay",
          byteLength: 16,
          lineCount: 1,
          sha256: "test",
        },
      ],
      inbox: [
        {
          id: "turn_queued",
          sessionID: "ses_ts7_restart_queue",
          text: "safe queued",
          delivery: "next-turn",
          admittedAt: "2026-07-21T00:00:00.000Z",
        },
      ],
    }),
  );

  const events: RuntimeEvent[] = [];
  let calls = 0;
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_ts7_restart_queue",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        calls++;
        yield { type: "done" as const };
      },
    },
  });
  reopened.start((event) => events.push(event));
  // A cold start replays the session, registers tools and rebuilds context
  // before it can wake the queued input, so the budget is the runtime's
  // startup, not a single tick.
  await waitFor(
    () => calls > 0,
    20_000,
    "the queued input to reach the provider",
  );
  expect(calls).toBe(1);
  await waitFor(
    () =>
      events.some(
        (event) => event.type === "turn.finished" && event.id === "turn_queued",
      ),
    20_000,
    "the queued turn to finish",
  );
  expect(
    events.some(
      (event) =>
        event.type === "diagnostic" &&
        event.message.includes("provider dispatch") &&
        event.message.includes("cannot be replayed"),
    ),
  ).toBe(true);
  const persisted = JSON.parse(
    await readFile(
      join(root, ".natalia", "sessions", "ses_ts7_restart_queue.json"),
      "utf8",
    ),
  );
  expect(persisted.metadata?.inFlightOperation).toBeUndefined();
});

test("restart safely settles a durable tool execution window without replaying its side effect", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-ts7-restart-tool-window-"),
  );
  await mkdir(join(root, ".natalia", "sessions"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "sessions", "ses_ts7_restart_tool_window.json"),
    JSON.stringify({
      id: "ses_ts7_restart_tool_window",
      title: "Interrupted tool",
      createdAt: "2026-07-21T00:00:00.000Z",
      cancelled: false,
      resumable: true,
      metadata: {
        inFlightOperation: {
          kind: "tool_execution",
          turnID: "turn_interrupted_tool",
          toolName: "write_file",
          toolCallID: "call_write",
          startedAt: "2026-07-21T00:00:01.000Z",
        },
      },
      events: [
        {
          type: "turn.submitted",
          id: "turn_interrupted_tool",
          text: "write this once",
          byteLength: 15,
          lineCount: 1,
          sha256: "test",
        },
        {
          type: "tool.update",
          id: "turn_interrupted_tool:call_write",
          name: "write_file",
          callID: "call_write",
          status: "running",
          summary: "running",
          startedAt: 1,
        },
      ],
      inbox: [
        {
          id: "turn_queued_after_tool",
          sessionID: "ses_ts7_restart_tool_window",
          text: "safe queued",
          delivery: "next-turn",
          admittedAt: "2026-07-21T00:00:00.000Z",
        },
      ],
    }),
  );

  const events: RuntimeEvent[] = [];
  let calls = 0;
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_restart_tool_window",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        calls++;
        yield { type: "done" as const };
      },
    },
  });
  reopened.start((event) => events.push(event));
  await waitFor(
    () => calls > 0,
    20_000,
    "the queued input to reach the provider",
  );
  expect(calls).toBe(1);
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "turn.finished" &&
          event.id === "turn_queued_after_tool",
      ),
    20_000,
    "the queued turn to finish",
  );
  expect(
    events.some(
      (event) =>
        event.type === "turn.finished" &&
        event.id === "turn_interrupted_tool" &&
        event.stopReason === "error",
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "diagnostic" &&
        event.message.includes("tool execution") &&
        event.message.includes("cannot be replayed"),
    ),
  ).toBe(true);
});

test("runtime history supplies a stable local cursor without SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-history-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_history",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.submitAndWait!("one");
  await client.submitAndWait!("two");
  const first = await client.history!({ limit: 1 });
  expect(first.events).toHaveLength(1);
  expect(first.hasMore).toBe(true);
  const next = await client.history!({
    after: first.events[0]!.seq,
    limit: 100,
  });
  expect(next.events[0]!.seq).toBe(first.events[0]!.seq + 1);
});

test("durable history retains full assistant settlement without live fragments", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-durable-content-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_ts7_durable_content",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "content" as const, text: "hello " };
        yield { type: "content" as const, text: "world" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.submitAndWait!("greet");
  await waitForAsync(async () => {
    try {
      const persisted = JSON.parse(
        await readFile(
          join(root, ".natalia", "sessions", "ses_ts7_durable_content.json"),
          "utf8",
        ),
      ) as { events: RuntimeEvent[] };
      return persisted.events.some(
        (event) =>
          event.type === "content.done" && event.text === "hello world",
      );
    } catch {
      return false;
    }
  });
  const stored = JSON.parse(
    await readFile(
      join(root, ".natalia", "sessions", "ses_ts7_durable_content.json"),
      "utf8",
    ),
  ) as { events: RuntimeEvent[] };
  expect(stored.events.some((event) => event.type === "content.delta")).toBe(
    false,
  );
  expect(
    stored.events.find((event) => event.type === "content.done"),
  ).toMatchObject({ text: "hello world" });
});

test("restart restores the latest durable context checkpoint before later events", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-context-epoch-"));
  const requests: Array<{
    messages: Array<{ role: string; content: string }>;
  }> = [];
  const first = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_ts7_context_epoch",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "content" as const, text: "first answer" };
        yield { type: "done" as const };
      },
    },
  });
  first.start(() => undefined);
  await first.submitAndWait!("first question");
  await waitForAsync(async () => {
    try {
      const persisted = JSON.parse(
        await readFile(
          join(root, ".natalia", "sessions", "ses_ts7_context_epoch.json"),
          "utf8",
        ),
      ) as { events: RuntimeEvent[] };
      return persisted.events.some(
        (event) => event.type === "context.checkpoint",
      );
    } catch {
      return false;
    }
  });
  const persisted = JSON.parse(
    await readFile(
      join(root, ".natalia", "sessions", "ses_ts7_context_epoch.json"),
      "utf8",
    ),
  ) as { events: RuntimeEvent[] };
  expect(
    persisted.events.some((event) => event.type === "context.checkpoint"),
  ).toBe(true);

  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_ts7_context_epoch",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push({
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        });
        yield { type: "done" as const };
      },
    },
  });
  const reopenedEvents: RuntimeEvent[] = [];
  reopened.start((event) => reopenedEvents.push(event));
  await Bun.sleep(5);
  const initializationFailure = reopenedEvents.find(
    (event) => event.type === "diagnostic" && event.level === "error",
  );
  expect(initializationFailure).toBeUndefined();
  await reopened.submitAndWait!("second question");
  expect(requests[0]?.messages).toEqual(
    expect.arrayContaining([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
    ]),
  );
});

test("context-limit compaction persists a durable context epoch", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-context-compaction-"));
  let attempts = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_ts7_context_compaction",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        attempts++;
        if (attempts === 1)
          throw providerError({
            kind: "context_limit",
            message: "context limit",
          });
        yield { type: "content" as const, text: "recovered" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.submitAndWait!("compact then retry");
  await waitForAsync(async () => {
    try {
      const persisted = JSON.parse(
        await readFile(
          join(root, ".natalia", "sessions", "ses_ts7_context_compaction.json"),
          "utf8",
        ),
      ) as { events: RuntimeEvent[] };
      return persisted.events.some(
        (event) => event.type === "context.checkpoint",
      );
    } catch {
      return false;
    }
  });
  const stored = JSON.parse(
    await readFile(
      join(root, ".natalia", "sessions", "ses_ts7_context_compaction.json"),
      "utf8",
    ),
  ) as { events: RuntimeEvent[] };
  expect(
    stored.events.some((event) => event.type === "context.checkpoint"),
  ).toBe(true);
});

test("SQLite restart restores context from epoch baseline without duplicate history", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-ts7-sqlite-context-epoch-"),
  );
  const first = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_sqlite_context_epoch",
    useSqliteStore: true,
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "content" as const, text: "first answer" };
        yield { type: "done" as const };
      },
    },
  });
  first.start(() => undefined);
  await first.submitAndWait!("first question");

  const requests: Array<{
    messages: Array<{ role: string; content: string }>;
  }> = [];
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_sqlite_context_epoch",
    useSqliteStore: true,
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push({
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        });
        yield { type: "done" as const };
      },
    },
  });
  reopened.start(() => undefined, { replay: "none" });
  await reopened.submitAndWait!("second question");
  const restored = requests[0]!.messages;
  expect(
    restored.filter((message) => message.content === "first question"),
  ).toHaveLength(1);
  expect(
    restored.filter((message) => message.content === "first answer"),
  ).toHaveLength(1);
  expect(
    restored.filter((message) => message.content === "second question"),
  ).toHaveLength(1);
});

test("SQLite indexed replay recovers pending interactive control state", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-ts7-sqlite-indexed-interactive-"),
  );
  const sessionID = "ses_ts7_sqlite_indexed_interactive" as SessionID;
  const databasePath = resolveWorkspaceJournalDatabasePath(root);
  await mkdir(join(root, ".natalia"), { recursive: true });
  const store = new SessionStoreTestDatabase(databasePath);
  store.create(sessionID, "Indexed interactive");
  store.appendEvents(sessionID, [
    {
      type: "context.checkpoint",
      id: "epoch_indexed_interactive",
      snapshot: {
        entries: [],
        resources: [],
        journalOffset: 0,
        step: 0,
        tokenEstimate: 0,
        compactionGeneration: 0,
      },
    },
    {
      type: "approval.request",
      id: "approval_indexed",
      title: "Write",
      preview: "file",
    },
    {
      type: "question.request",
      id: "question_indexed",
      title: "Choice",
    },
  ]);
  store.close();

  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    useSqliteStore: true,
    provider: scriptedProvider("unused"),
  });
  client.start((event) => events.push(event), { replay: "none" });
  await waitFor(() => events.some((event) => event.type === "session.ready"));
  expect(await client.pendingInteractive!()).toMatchObject({
    approvals: [{ id: "approval_indexed" }],
    questions: [{ id: "question_indexed" }],
  });
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "approval.request",
        id: "approval_indexed",
      }),
      expect.objectContaining({
        type: "question.request",
        id: "question_indexed",
      }),
    ]),
  );
  await client.dispose?.();
});

test("SQLite indexed replay recovers bounded durable diagnostics", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-ts7-sqlite-indexed-diagnostics-"),
  );
  const sessionID = "ses_ts7_sqlite_indexed_diagnostics" as SessionID;
  const databasePath = resolveWorkspaceJournalDatabasePath(root);
  await mkdir(join(root, ".natalia"), { recursive: true });
  const store = new SessionStoreTestDatabase(databasePath);
  store.create(sessionID, "Indexed diagnostics");
  store.appendEvents(sessionID, [
    {
      type: "context.checkpoint",
      id: "epoch_indexed_diagnostics",
      snapshot: {
        entries: [],
        resources: [],
        journalOffset: 0,
        step: 0,
        tokenEstimate: 0,
        compactionGeneration: 0,
      },
    },
    {
      type: "diagnostic",
      level: "warning",
      message: "durable indexed diagnostic",
      at: "2026-07-25T00:00:00.000Z",
    },
  ]);
  store.close();

  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    useSqliteStore: true,
    provider: scriptedProvider("unused"),
  });
  client.start(() => undefined, { replay: "none" });
  await Bun.sleep(50);
  expect(await client.diagnostics?.(10)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ message: "durable indexed diagnostic" }),
    ]),
  );
  await client.dispose?.();
});

test("restart projects unresolved interactive requests from durable events", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-ts7-interactive-restart-"),
  );
  await mkdir(join(root, ".natalia", "sessions"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "sessions", "ses_ts7_interactive_restart.json"),
    JSON.stringify({
      id: "ses_ts7_interactive_restart",
      title: "Interactive",
      createdAt: "2026-07-21T00:00:00.000Z",
      cancelled: false,
      resumable: true,
      events: [
        {
          type: "approval.request",
          id: "approval_open",
          title: "Write",
          preview: "file",
        },
        {
          type: "approval.request",
          id: "approval_closed",
          title: "Shell",
          preview: "pwd",
        },
        { type: "approval.response", id: "approval_closed", decision: "once" },
        { type: "question.request", id: "question_open", title: "Choice" },
      ],
    }),
  );
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_interactive_restart",
    provider: toolCallingProvider(),
  });
  client.start(() => undefined);
  expect(await client.pendingInteractive!()).toMatchObject({
    approvals: [{ id: "approval_open" }],
    questions: [{ id: "question_open" }],
  });
  client.respondApproval({ requestID: "approval_open", decision: "once" });
  client.respondQuestion({ requestID: "question_open", answers: [["answer"]] });
  client.respondApproval({ requestID: "approval_open", decision: "reject" });
  client.respondQuestion({ requestID: "question_open", answers: [["late"]] });
  expect(await client.pendingInteractive!()).toEqual({
    approvals: [],
    questions: [],
    interactives: [],
  });
  await waitForAsync(async () => {
    const history = await client.history!({ limit: 500 });
    return (
      history.events.some(
        (entry) =>
          entry.event.type === "approval.response" &&
          entry.event.id === "approval_open",
      ) &&
      history.events.some(
        (entry) =>
          entry.event.type === "question.response" &&
          entry.event.id === "question_open",
      )
    );
  });
  const history = await client.history!({ limit: 500 });
  expect(
    history.events.filter(
      (entry) =>
        entry.event.type === "approval.response" &&
        entry.event.id === "approval_open",
    ),
  ).toHaveLength(1);
  expect(
    history.events.filter(
      (entry) =>
        entry.event.type === "question.response" &&
        entry.event.id === "question_open",
    ),
  ).toHaveLength(1);
});

test("restart durably rejects orphaned interactive requests from a crashed turn", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-ts7-interrupted-interactive-restart-"),
  );
  await mkdir(join(root, ".natalia", "sessions"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "sessions", "ses_ts7_interrupted_interactive.json"),
    JSON.stringify({
      id: "ses_ts7_interrupted_interactive",
      title: "Interrupted interactive",
      createdAt: "2026-07-21T00:00:00.000Z",
      cancelled: false,
      resumable: true,
      events: [
        {
          type: "turn.submitted",
          id: "turn_crashed",
          text: "write",
          byteLength: 5,
          lineCount: 1,
          sha256: "test",
        },
        {
          type: "approval.request",
          id: "turn_crashed:write",
          title: "Write",
          preview: "file",
        },
        {
          type: "question.request",
          id: "turn_crashed:write:question",
          title: "Confirm",
        },
        {
          type: "approval.request",
          id: "independent_approval",
          title: "Independent",
          preview: "safe",
        },
      ],
    }),
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_interrupted_interactive",
    provider: toolCallingProvider(),
  });
  client.start((event) => events.push(event));

  expect(await client.pendingInteractive!()).toEqual({
    approvals: [expect.objectContaining({ id: "independent_approval" })],
    questions: [],
    interactives: [],
  });
  const history = await client.history!({ limit: 500 });
  expect(history.events.map((entry) => entry.event)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "approval.response",
        id: "turn_crashed:write",
        decision: "reject",
      }),
      expect.objectContaining({
        type: "question.response",
        id: "turn_crashed:write:question",
        rejected: true,
      }),
      expect.objectContaining({
        type: "turn.finished",
        id: "turn_crashed",
        stopReason: "error",
      }),
    ]),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "diagnostic",
      level: "warning",
      message: expect.stringContaining(
        "unresolved interactive requests were rejected",
      ),
    }),
  );
});

test("provider can load a discovered skill through the canonical tool path", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-skill-tool-"));
  const skillRoot = join(root, ".natalia", "skills", "review");
  await mkdir(join(skillRoot, "references"), { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: review\ndescription: Review\n---\nReview guidance",
  );
  await writeFile(join(skillRoot, "references", "guide.md"), "guide");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_skill_tool",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_skill",
                name: "skill_load",
                arguments: JSON.stringify({ name: "review" }),
              },
            ],
          };
          yield { type: "done" as const };
          return;
        }
        yield { type: "content" as const, text: "skill loaded" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("load review skill");
  expect(
    events.some(
      (event) =>
        event.type === "tool.update" &&
        event.name === "skill_load" &&
        event.status === "succeeded",
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) => event.type === "content.done" && event.text === "skill loaded",
    ),
  ).toBe(true);
});

test("two local clients serialize provider turns for one durable session", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-shared-session-"));
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const provider = (label: string) => ({
    provider: "test",
    model: "test",
    async *stream() {
      order.push(`${label}:start`);
      if (label === "first")
        await new Promise<void>((resolve) => (releaseFirst = resolve));
      order.push(`${label}:end`);
      yield { type: "done" as const };
    },
  });
  const first = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_shared_session",
    provider: provider("first"),
  });
  const second = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_shared_session",
    provider: provider("second"),
  });
  first.start(() => undefined);
  second.start(() => undefined);
  const firstSubmit = first.submit("one");
  while (!releaseFirst) await Bun.sleep(1);
  const secondSubmit = second.submit("two");
  await Bun.sleep(2);
  expect(order).toEqual(["first:start"]);
  releaseFirst?.();
  await Promise.all([firstSubmit, secondSubmit]);
  await waitFor(
    () => order.includes("second:start") && order.includes("second:end"),
    20_000,
    "the second local client's provider turn to run",
  );
  expect(order).toEqual([
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

test("real runtime client discovers and activates native Skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-skills-"));
  const skillRoot = join(root, ".natalia", "skills", "read-only");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: read-only\ndescription: Read files only\nallowed-tools: [read_file]\n---\nInspect before changing.",
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_skills",
    provider: scriptedProvider("unused"),
  });
  client.start((event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === "session.ready"));
  await client.submitAndWait!("/skills");
  await client.submitAndWait!("/skill read-only");
  expect(
    events.some(
      (event) =>
        event.type === "content.delta" &&
        event.text.includes("project:read-only"),
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "content.delta" &&
        event.text.includes("activated skill project:read-only"),
    ),
  ).toBe(true);
});

test("real runtime client provides provider-independent doctor and help commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-doctor-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_doctor",
  });
  client.start((event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === "session.ready"));
  await client.submitAndWait!("/doctor");
  await client.submitAndWait!("/help");

  const output = events
    .filter((event) => event.type === "content.delta")
    .map((event) => event.text)
    .join("\n");
  expect(output).toContain("Natalia TS7 runtime doctor");
  expect(output).toContain("provider: not configured");
  expect(output).toContain("/checkpoint");
  expect(output).toContain(
    "the application-layer host allowlist only covers fetch-style tools",
  );
  expect(output).toContain("run_shell and native terminal input");
  await client.dispose?.();
});

test("real runtime client records provider usage checkpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-usage-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_usage",
    provider: usageProvider(),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("Track usage");

  expect(
    events.some(
      (event) =>
        event.type === "context.status" &&
        event.used === 15 &&
        event.source === "exact_checkpoint",
    ),
  ).toBe(true);
});

test("real runtime forks a session at a submitted-turn boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-session-fork-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_ts7_session_fork",
    provider: scriptedProvider("answer"),
  });
  client.start(() => undefined);
  const first = await client.submitAndWait!("first");
  const second = await client.submitAndWait!("second");

  const fork = await client.sessionFork!("ses_ts7_session_fork", second.id);
  const child = JSON.parse(
    await readFile(
      join(root, ".natalia", "sessions", `${fork.id}.json`),
      "utf8",
    ),
  ) as { events: RuntimeEvent[] };
  expect(fork.title).toBe("New session (fork)");
  expect(
    child.events.some(
      (event) => event.type === "turn.submitted" && event.text === "second",
    ),
  ).toBe(false);
  expect(
    child.events.some(
      (event) => event.type === "turn.submitted" && event.text === "first",
    ),
  ).toBe(true);
});

test("real runtime exposes projected message pages independently from event history", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-message-pages-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_message_pages",
    provider: scriptedProvider("answer"),
  });
  client.start(() => undefined);
  await client.submitAndWait!("first");
  await client.submitAndWait!("second");

  const page = await client.messages!({ order: "asc", limit: 1 });
  expect(page.data).toHaveLength(1);
  expect(page.data[0]).toMatchObject({
    id: expect.stringMatching(/^turn_/u),
    submitted: { text: "first" },
  });
  expect(page.data[0]?.rows.map((row) => row.kind)).toContain("assistant");
  expect(page.cursor.next).toEqual(expect.any(String));
  expect((await client.history!({ limit: 1 })).events[0]?.event.type).toBe(
    "checkpoint.created",
  );
});

test("real runtime client publishes provider chunks before stream completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-live-stream-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_live_stream",
    provider: delayedStreamingProvider(),
  });
  client.start((event) => events.push(event));
  const submission = client.submit("stream live");
  await waitFor(() =>
    events.some(
      (event) => event.type === "content.delta" && event.text === "first ",
    ),
  );
  expect(events.some((event) => event.type === "turn.finished")).toBe(false);
  await submission;
  await waitFor(
    () => events.some((event) => event.type === "turn.finished"),
    20_000,
    "the streamed turn to finish",
  );
  expect(
    events
      .filter((event) => event.type === "content.delta")
      .map((event) => event.text)
      .join(""),
  ).toBe("first second");
});

test("real runtime client retries once when a new turn has no old context to compact", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-context-limit-"));
  const events: RuntimeEvent[] = [];
  const provider = contextLimitThenSuccessProvider();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_context_limit",
    provider,
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("Recover context");

  expect(provider.calls).toBe(2);
  expect(
    events.some(
      (event) => event.type === "context.limit.recovery" && !event.compacted,
    ),
  ).toBe(true);
  expect(events.some((event) => event.type === "compaction.begin")).toBe(false);
  expect(
    events.some(
      (event) => event.type === "content.delta" && event.text === "recovered",
    ),
  ).toBe(true);
});

test("real runtime client writes inside its selected workspace after approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-workspace-tool-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_workspace_tool",
    provider: writeFileProvider(),
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.submitAndWait!("create a workspace file");

  expect(await readFile(join(root, "hello-ts7.txt"), "utf8")).toBe(
    "hello from TS7\n",
  );
  expect(
    events.some(
      (event) => event.type === "tool.update" && event.status === "succeeded",
    ),
  ).toBe(true);
});

test("session intelligence writer publishes real snapshot facts for a working turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-intelligence-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_intelligence",
    provider: writeFileProvider(),
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.submitAndWait!("create a workspace file");

  const snapshots = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "session.snapshot" }> =>
      event.type === "session.snapshot",
  );
  expect(snapshots.length).toBeGreaterThan(0);

  // The snapshot reflects the real turn lifecycle: running while the turn is
  // active, idle after it settles.
  const running = snapshots.find(
    (snapshot) => snapshot.agentStatus === "running",
  );
  expect(running).toBeDefined();
  const settled = snapshots.find((snapshot) => snapshot.agentStatus === "idle");
  expect(settled).toBeDefined();

  // The write tool is the active tool on at least one snapshot, and the Work
  // Graph records the workspace change the snapshot counts.
  const withTool = snapshots.find(
    (snapshot) => snapshot.activeTool === "write_file",
  );
  expect(withTool).toBeDefined();
  const last = snapshots.at(-1);
  expect(last?.changedFiles).toBeGreaterThan(0);
  expect(last?.unvalidatedChanges).toBeGreaterThan(0);

  // Secret-safe: no file content, no tool arguments, no command text.
  const serialized = JSON.stringify(snapshots);
  expect(serialized).not.toContain("hello from TS7");
  expect(serialized).not.toContain("call_write");
});

test("session intelligence writer survives replay with the same facts", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-ts7-intelligence-replay-"),
  );
  const initial = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_intelligence_replay",
    provider: writeFileProvider(),
  });
  initial.start((event) => {
    if (event.type === "approval.request")
      initial.respondApproval({ requestID: event.id, decision: "once" });
  });
  await initial.submitAndWait!("create a workspace file");
  await pollHistoryForFinished(initial);

  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_intelligence_replay",
    provider: writeFileProvider(),
  });
  reopened.start(() => undefined);
  await reopened.sessionAttach!("ses_ts7_intelligence_replay");

  // `session.snapshot` is live/reconstructible now, so replay does not carry
  // historical snapshot events. The read model must rebuild the same facts
  // from the durable journal on demand.
  const snapshot = await reopened.sessionSnapshot?.();
  expect(snapshot).toBeDefined();
  expect(snapshot?.changedFiles).toBeGreaterThan(0);
  expect(snapshot?.agentStatus).toBe("idle");
  expect(JSON.stringify(snapshot)).not.toContain("hello from TS7");
});

test("session intelligence read model answers the latest published snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-intelligence-read-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_intelligence_read",
    provider: writeFileProvider(),
  });
  client.start((event) => {
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.submitAndWait!("create a workspace file");
  await pollHistoryForFinished(client);

  // Before the writer existed this answered `undefined` forever. Now the RPC
  // member reports the latest durable snapshot with real work facts.
  const snapshot = await client.sessionSnapshot?.();
  expect(snapshot).toBeDefined();
  expect(snapshot?.changedFiles).toBeGreaterThan(0);
  expect(snapshot?.agentStatus).toBe("idle");
  expect(snapshot?.hasPTY).toBe(false);
  expect(snapshot?.hasSandbox).toBe(false);
});

test("the self-protection rules are seeded as the first constitution facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-constitution-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_constitution",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);

  const rules = await client.constitutionRules!();
  expect(rules.map((rule) => rule.ruleID)).toEqual([
    "C-TERM-001",
    "C-TERM-002",
    "C-TERM-003",
    "C-REL-001",
    "C-REL-002",
  ]);
  for (const rule of rules.filter((item) => item.ruleID !== "C-REL-001"))
    expect(rule).toMatchObject({
      scope: "release",
      priority: "critical",
      source: "policy",
      enforcement: "deny",
    });
  expect(rules.find((rule) => rule.ruleID === "C-REL-001")).toMatchObject({
    scope: "release",
    priority: "critical",
    source: "policy",
    enforcement: "approval",
    overridePolicy: "user_scoped",
  });
  expect(
    events.some(
      (event) =>
        event.type === "constitution.rule_added" &&
        event.ruleID === "C-TERM-001",
    ),
  ).toBe(true);
});

test("recordDecision writes a durable decision fact", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-decision-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_decision",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);

  const outcome = await client.recordDecision?.({
    decision: "workspace isolation is not container/VM security",
    rationale: ["the sandbox is a workspace boundary"],
    linkedConstraints: ["C-TERM-001"],
  });
  expect(outcome).toEqual({ recorded: true });
  const records = await client.decisionRecords!();
  const recorded = records.items.find(
    (record) =>
      record.decision === "workspace isolation is not container/VM security",
  );
  expect(recorded).toBeDefined();
  expect(recorded).toMatchObject({
    decision: "workspace isolation is not container/VM security",
    rationale: ["the sandbox is a workspace boundary"],
    status: "accepted",
    linkedConstraints: ["C-TERM-001"],
  });
  expect(
    events.some(
      (event) =>
        event.type === "decision.recorded" &&
        event.decision === "workspace isolation is not container/VM security",
    ),
  ).toBe(true);
});

test("seeded constitution rules and decisions are Work Graph constraint/decision nodes (CST4)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-cst4-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_cst4",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);

  // Each seeded self-protection rule is a constraint node in the graph.
  const constraintNodes = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "workgraph.node_added" }> =>
      event.type === "workgraph.node_added" && event.kind === "constraint",
  );
  expect(constraintNodes.length).toBeGreaterThanOrEqual(3);
  expect(constraintNodes.some((node) => node.target === "C-TERM-001")).toBe(
    true,
  );

  // A recorded decision becomes a decision node.
  await client.recordDecision?.({
    decision: "default no commit/push",
    rationale: ["the framework should never write to git without asking"],
  });
  expect(
    events.some(
      (event) =>
        event.type === "workgraph.node_added" && event.kind === "decision",
    ),
  ).toBe(true);
});

test("constitution rules and decisions survive replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-const-replay-"));
  const initial = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_const_replay",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  initial.start(() => {});
  await initial.submitAndWait!("hello");
  await initial.recordDecision?.({
    decision: "default no commit/push",
  });
  await pollHistoryForFinished(initial);

  const replayed: RuntimeEvent[] = [];
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_const_replay",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  reopened.start((event) => replayed.push(event));
  await reopened.submitAndWait!("again");
  await pollHistoryForFinished(reopened);

  const rules = await reopened.constitutionRules!();
  expect(rules.map((rule) => rule.ruleID)).toEqual([
    "C-TERM-001",
    "C-TERM-002",
    "C-TERM-003",
    "C-REL-001",
    "C-REL-002",
  ]);
  const decisions = await reopened.decisionRecords!();
  expect(decisions.items.map((decision) => decision.decision)).toContain(
    "default no commit/push",
  );
  // Replay must not duplicate the seeded rules: the reopened session replays
  // the original three rule_added events to the sink and the idempotent seed
  // skips them — exactly three, not six.
  const ruleAdded = replayed.filter(
    (
      event,
    ): event is Extract<RuntimeEvent, { type: "constitution.rule_added" }> =>
      event.type === "constitution.rule_added",
  );
  expect(ruleAdded.map((event) => event.ruleID).sort()).toEqual([
    "C-REL-001",
    "C-REL-002",
    "C-TERM-001",
    "C-TERM-002",
    "C-TERM-003",
  ]);
});

test("recordValidation runs a command and records durable evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-evidence-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_evidence",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);

  const passed = await client.recordValidation?.({
    taskID: "task_build",
    objective: "verify the build passes",
    command: "exit 0",
  });
  expect(passed).toEqual({ recorded: true, result: "passed", safeSummary: "" });
  const failed = await client.recordValidation?.({
    taskID: "task_build",
    objective: "verify the build passes",
    command: "exit 1",
  });
  expect(failed?.result).toBe("failed");

  const records = await client.evidenceRecords!();
  expect(records.items).toHaveLength(2);
  expect(records.items[0]).toMatchObject({
    taskID: "task_build",
    status: "validated",
    validations: [{ command: "exit 0", result: "passed" }],
  });
  expect(records.items[1]).toMatchObject({
    status: "failed",
    validations: [{ command: "exit 1", result: "failed" }],
  });
  expect(
    events.filter(
      (event): event is Extract<RuntimeEvent, { type: "evidence.recorded" }> =>
        event.type === "evidence.recorded",
    ).length,
  ).toBe(2);
});

test("recordValidation redacts secrets from the recorded summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-evidence-redact-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_evidence_redact",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => {});
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);

  await client.recordValidation?.({
    taskID: "task_secret",
    objective: "a validation that prints a secret",
    command: 'printf "api_key=supersecretvalue\\n"; exit 0',
  });
  const records = await client.evidenceRecords!();
  const summary = records.items[0]?.validations[0]?.safeSummary ?? "";
  expect(summary).not.toContain("supersecretvalue");
  expect(JSON.stringify(records)).not.toContain("supersecretvalue");
});

test("promoting framework sources emits restart_required", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-e5-restart-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await mkdir(join(root, "packages", "framework"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      sandbox: { promoteCommand: "true" },
    }),
  );
  const kernel = new CapabilityRegistry();
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_e5_restart",
    capabilityRegistry: kernel,
    permissionMode: "auto",
    provider: singleToolProvider("sandbox_create", { id: "box" }),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("create sandbox");
  await pollHistoryForFinished(client);
  const sandboxes = kernel.service<SandboxService>(sandboxService.id)!;
  await sandboxes.write("box", "packages/framework/restart.ts", "export {}\n");
  await client.sandboxMerge!("box");
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "diagnostic",
      message: "restart_required",
    }),
  );
  await client.dispose?.();
});

test("promote records evidence when validation passes", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-e5-promote-pass-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      sandbox: { promoteCommand: "true" },
    }),
  );
  const kernel = new CapabilityRegistry();
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_e5_promote_pass",
    capabilityRegistry: kernel,
    permissionMode: "auto",
    provider: singleToolProvider("sandbox_create", { id: "box" }),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("create sandbox");
  await pollHistoryForFinished(client);
  const sandboxes = kernel.service<SandboxService>(sandboxService.id)!;
  await sandboxes.write("box", "promoted.txt", "landed");
  const changes = await client.sandboxMerge!("box");
  expect(changes).toContainEqual(
    expect.objectContaining({ path: "promoted.txt" }),
  );
  expect(await readFile(join(root, "promoted.txt"), "utf8")).toBe("landed");
  const records = await client.evidenceRecords!();
  expect(records.items).toContainEqual(
    expect.objectContaining({
      taskID: "sandbox:box",
      status: "promoted",
      validations: [
        expect.objectContaining({ command: "true", result: "passed" }),
      ],
    }),
  );
  expect(JSON.stringify(records)).not.toContain("stdout");
  const cards = await client.completions!();
  expect(cards.items).toContainEqual(
    expect.objectContaining({
      taskID: "sandbox:box",
      rollbackState: "available",
      changeSummary: "1 files promoted from sandbox box",
    }),
  );
  expect(events.some((event) => event.type === "evidence.recorded")).toBe(true);
  await client.dispose?.();
});

test("a high-risk promotion requires a multi-stage user confirmation (E5 R3/R4)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-e5-highrisk-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3, sandbox: { promoteCommand: "true" } }),
  );
  const kernel = new CapabilityRegistry();
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_e5_highrisk",
    capabilityRegistry: kernel,
    permissionMode: "ask",
    provider: singleToolProvider("sandbox_create", { id: "box" }),
  });
  const approvalRequests: string[] = [];
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request") {
      approvalRequests.push(String((event as { scope?: string }).scope ?? ""));
      client.respondApproval({ requestID: event.id, decision: "once" });
    }
  });
  await client.submitAndWait!("create sandbox");
  await pollHistoryForFinished(client);
  const sandboxes = kernel.service<SandboxService>(sandboxService.id)!;
  // A change to the tool contract is high risk.
  await sandboxes.write(
    "box",
    "packages/core/tools/src/types.ts",
    "export {}\n",
  );
  const changes = await client.sandboxMerge!("box");
  // The multi-stage gate fired for the high-risk promotion.
  expect(approvalRequests).toContain("sandbox_promotion");
  // The user approved, so the high-risk file landed.
  expect(changes).toContainEqual(
    expect.objectContaining({ path: "packages/core/tools/src/types.ts" }),
  );
  await client.dispose?.();
});

test("a rejected high-risk promotion leaves the host unchanged and records failed evidence (E5 R3/R4)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-e5-highrisk-reject-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3, sandbox: { promoteCommand: "true" } }),
  );
  const kernel = new CapabilityRegistry();
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_e5_highrisk_reject",
    capabilityRegistry: kernel,
    permissionMode: "ask",
    provider: singleToolProvider("sandbox_create", { id: "box" }),
  });
  let gateFired = false;
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request") {
      if ((event as { scope?: string }).scope === "sandbox_promotion") {
        gateFired = true;
        client.respondApproval({ requestID: event.id, decision: "reject" });
      } else {
        client.respondApproval({ requestID: event.id, decision: "once" });
      }
    }
  });
  await client.submitAndWait!("create sandbox");
  await pollHistoryForFinished(client);
  const sandboxes = kernel.service<SandboxService>(sandboxService.id)!;
  await sandboxes.write(
    "box",
    "packages/core/tools/src/types.ts",
    "export {}\n",
  );

  // The high-risk gate fired and the user rejected it: the merge refuses.
  let rejected = false;
  try {
    await client.sandboxMerge!("box");
  } catch (error) {
    rejected = /rejected by the user/iu.test(
      error instanceof Error ? error.message : String(error),
    );
  }
  expect(gateFired).toBe(true);
  expect(rejected).toBe(true);
  // The host is unchanged: the high-risk file did not land.
  const landed = await readFile(
    join(root, "packages/core/tools/src/types.ts"),
    "utf8",
  ).then(
    () => true,
    () => false,
  );
  expect(landed).toBe(false);
  // Failed promotion evidence is recorded.
  const records = await client.evidenceRecords!();
  expect(
    records.items.some(
      (record) => record.taskID === "sandbox:box" && record.status === "failed",
    ),
  ).toBe(true);
  await client.dispose?.();
});

test("a low-risk promotion skips the multi-stage confirmation (E5)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-e5-lowrisk-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3, sandbox: { promoteCommand: "true" } }),
  );
  const kernel = new CapabilityRegistry();
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_e5_lowrisk",
    capabilityRegistry: kernel,
    permissionMode: "auto",
    provider: singleToolProvider("sandbox_create", { id: "box" }),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("create sandbox");
  await pollHistoryForFinished(client);
  const sandboxes = kernel.service<SandboxService>(sandboxService.id)!;
  // A docs change is low risk.
  await sandboxes.write("box", "docs/note.md", "hello");
  const changes = await client.sandboxMerge!("box");
  expect(changes).toContainEqual(
    expect.objectContaining({ path: "docs/note.md" }),
  );
  // No multi-stage confirmation gate for a low-risk promotion.
  expect(
    events.some(
      (event) =>
        event.type === "approval.request" &&
        (event as { scope?: string }).scope === "sandbox_promotion",
    ),
  ).toBe(false);
  await client.dispose?.();
});

test("failed validation records failed evidence and does not promote", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-e5-promote-fail-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      sandbox: { promoteCommand: "exit 1" },
    }),
  );
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_e5_promote_fail",
    capabilityRegistry: kernel,
    permissionMode: "auto",
    provider: singleToolProvider("sandbox_create", { id: "box" }),
  });
  client.start(() => undefined);
  await client.submitAndWait!("create sandbox");
  await pollHistoryForFinished(client);
  const sandboxes = kernel.service<SandboxService>(sandboxService.id)!;
  await sandboxes.write("box", "blocked.txt", "should-not-land");
  await expect(client.sandboxMerge!("box")).rejects.toThrow(
    /failed validation/u,
  );
  await expect(
    readFile(join(root, "blocked.txt"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const records = await client.evidenceRecords!();
  expect(records.items).toContainEqual(
    expect.objectContaining({
      taskID: "sandbox:box",
      status: "failed",
      knownGaps: ["candidate failed validation; host unchanged"],
      validations: [
        expect.objectContaining({ command: "exit 1", result: "failed" }),
      ],
    }),
  );
  await client.dispose?.();
});
