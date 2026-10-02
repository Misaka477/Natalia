import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOfficialRuntimeClient as createRealRuntimeClient,
  officialPluginWorkspace as mkdtemp,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();
import type {
  MCPCatalogSnapshot,
  RuntimeClient,
  RuntimeEvent,
  RuntimeReasoningEffort,
  SubmittedTurn,
} from "@anthelia/contracts";
import {
  attachRuntimeClientWorker,
  createWorkerRuntimeClient,
} from "../src/worker";
import { CapabilityHost } from "@anthelia/capability";

async function waitForWorker(
  predicate: () => boolean,
  timeoutMs = 5000,
  label = "condition",
) {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 10) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("worker transport: submit after cancel starts the next turn instead of queueing forever", async () => {
  // The real-device Stop-then-send flow crosses the worker channel: the TUI
  // submits through createWorkerRuntimeClient, and the worker dispatches the
  // request into the live runtime. A serialized channel or an admission that
  // awaits the whole previous turn would make the second submit never reach
  // the provider — the message "sends" into a dead queue.
  const root = await mkdtemp(join(tmpdir(), "natalia-worker-cancel-submit-"));
  const requests: string[] = [];
  let release: (() => void) | undefined;
  const createRuntime = () =>
    createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: "ses_worker_cancel_submit",
      provider: {
        provider: "test",
        model: "test",
        async *stream(request) {
          const text = request.messages.at(-1)?.content ?? "";
          requests.push(text);
          if (text === "first")
            await new Promise<void>((resolve) => (release = resolve));
          yield { type: "done" as const };
        },
      },
    });
  const channel = new MessageChannel();
  attachRuntimeClientWorker(channel.port1, createRuntime());
  const client = createWorkerRuntimeClient(channel.port2);
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));

  await client.submit("first");
  await waitForWorker(() => requests.includes("first"), 5000, "first turn");
  client.cancel("stop");
  while (!release) await Bun.sleep(1);
  release?.();
  await waitForWorker(() =>
    events.some(
      (event) =>
        event.type === "turn.finished" || event.type === "turn.cancelled",
    ),
  );
  // The second submit must be admitted and woken even though the previous
  // turn's drain may still be settling in the worker.
  await client.submit("second");
  await waitForWorker(
    () => requests.includes("second"),
    5000,
    "the second turn to reach the provider",
  );
  expect(requests.filter((text) => text === "first")).toHaveLength(1);
  expect(requests).toContain("second");
  await client.dispose?.();
});

test("worker client buffers runtime events published before start", async () => {
  const channel = new MessageChannel();
  let sink: ((event: RuntimeEvent) => void) | undefined;
  const host: RuntimeClient = {
    start(handler) {
      sink = handler;
    },
    async submit(text) {
      return {
        type: "turn.submitted",
        id: "turn_buffered",
        text,
        byteLength: text.length,
        lineCount: 1,
        sha256: "test",
      } satisfies SubmittedTurn;
    },
    cancel() {},
    snapshot: () => ({
      type: "snapshot.created",
      id: "snapshot_worker",
      files: [],
    }),
    diagnostic() {},
    lastSubmission: () => undefined,
    respondApproval() {
      return { accepted: true };
    },
    respondQuestion() {
      return { accepted: true };
    },
  };
  attachRuntimeClientWorker(channel.port1, host);
  const client = createWorkerRuntimeClient(channel.port2);
  // The worker can start and emit early events before the TUI mounts and calls
  // start(). Buffering them keeps workspace/session switches from losing the
  // initial session.ready/history stream.
  sink?.({
    type: "session.ready",
    sessionID: "ses_buffered",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "session.ready",
      sessionID: "ses_buffered",
    }),
  );
});

test("worker RuntimeClient transport remains behind contracts boundary", async () => {
  const channel = new MessageChannel();
  let sink: ((event: RuntimeEvent) => void) | undefined;
  const host: RuntimeClient = {
    start(handler) {
      sink = handler;
    },
    async submit(text) {
      const event: SubmittedTurn = {
        type: "turn.submitted",
        id: "turn_worker",
        text,
        byteLength: text.length,
        lineCount: 1,
        sha256: "test",
      };
      sink?.(event);
      return event;
    },
    cancel() {},
    snapshot: () => ({
      type: "snapshot.created",
      id: "snapshot_worker",
      files: [],
    }),
    diagnostic() {},
    lastSubmission: () => undefined,
    respondApproval() {
      return { accepted: true };
    },
    respondQuestion() {
      return { accepted: true };
    },
  };
  attachRuntimeClientWorker(channel.port1, host);
  const client = createWorkerRuntimeClient(channel.port2);
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await expect(client.submit("worker prompt")).resolves.toMatchObject({
    text: "worker prompt",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(events).toContainEqual(
    expect.objectContaining({ type: "turn.submitted", text: "worker prompt" }),
  );
});

test("a failing notification is reported instead of crashing the host", async () => {
  const channel = new MessageChannel();
  let sink: ((event: RuntimeEvent) => void) | undefined;
  const host: RuntimeClient = {
    start(handler) {
      sink = handler;
    },
    async submit(text) {
      return {
        type: "turn.submitted",
        id: "turn_reject",
        text,
        byteLength: text.length,
        lineCount: 1,
        sha256: "test",
      } satisfies SubmittedTurn;
    },
    // The real failure this reproduces is a teardown error surfacing through a
    // notification, which used to become an unhandled rejection.
    cancel() {
      throw new Error("kill() failed: ESRCH: No such process");
    },
    snapshot: () => ({
      type: "snapshot.created",
      id: "snapshot_reject",
      files: [],
    }),
    diagnostic() {},
    lastSubmission: () => undefined,
    respondApproval() {
      return { accepted: true };
    },
    respondQuestion() {
      return { accepted: true };
    },
  };
  attachRuntimeClientWorker(channel.port1, host);
  const client = createWorkerRuntimeClient(channel.port2);
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));

  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    client.cancel("stop");
    await Bun.sleep(50);
  } finally {
    process.off("unhandledRejection", onRejection);
  }

  expect(rejections).toEqual([]);
  expect(
    events.filter(
      (event) =>
        event.type === "diagnostic" && event.message.includes("cancel failed"),
    ).length,
  ).toBeGreaterThan(0);
});

test("config reload replaces the worker runtime and keeps event forwarding", async () => {
  const channel = new MessageChannel();
  const disposed: string[] = [];
  const submitted: string[] = [];
  let generation = 0;
  const createHost = (): RuntimeClient => {
    const id = `host-${++generation}`;
    let sink: ((event: RuntimeEvent) => void) | undefined;
    return {
      start(handler) {
        sink = handler;
      },
      async submit(text) {
        submitted.push(`${id}:${text}`);
        const event = {
          type: "turn.submitted" as const,
          id: `turn-${id}`,
          text: `${id}:${text}`,
          byteLength: text.length,
          lineCount: 1,
          sha256: "test",
        };
        sink?.(event);
        return event;
      },
      async runtimeStatus() {
        return { type: "status.snapshot", permissions: "ask" } as never;
      },
      async dispose() {
        disposed.push(id);
      },
      cancel() {},
      snapshot: () => ({
        type: "snapshot.created",
        id: `snapshot-${id}`,
        files: [],
      }),
      diagnostic() {},
      lastSubmission: () => undefined,
      respondApproval() {
        return { accepted: true };
      },
      respondQuestion() {
        return { accepted: true };
      },
    };
  };
  const first = createHost();
  attachRuntimeClientWorker(channel.port1, first, { reload: createHost });
  const client = createWorkerRuntimeClient(channel.port2);
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));

  await Promise.race([
    client.reloadConfig?.(),
    Bun.sleep(1_000).then(() => {
      throw new Error("config reload request timed out");
    }),
  ]);
  const submission = Promise.race([
    client.submit("after reload"),
    Bun.sleep(1_000).then(() => {
      throw new Error(
        `submit after config reload timed out (${submitted.join(", ")})`,
      );
    }),
  ]);
  const result = await submission;
  expect(result).toMatchObject({ text: "host-2:after reload" });
  await Bun.sleep(0);

  expect(disposed).toEqual(["host-1"]);
  expect(submitted).toEqual(["host-2:after reload"]);
  expect(events).toContainEqual(
    expect.objectContaining({ text: "host-2:after reload" }),
  );
});

test("config reload preserves a busy runtime instead of cancelling it", async () => {
  const channel = new MessageChannel();
  let disposed = false;
  const host = {
    start() {},
    async submit() {
      throw new Error("not used");
    },
    async canReloadConfig() {
      return { allowed: false, reason: "turn is running" };
    },
    async dispose() {
      disposed = true;
    },
    cancel() {},
    snapshot: () => ({
      type: "snapshot.created" as const,
      id: "snapshot_busy",
      files: [],
    }),
    diagnostic() {},
    lastSubmission: () => undefined,
    respondApproval() {
      return { accepted: true };
    },
    respondQuestion() {
      return { accepted: true };
    },
  } satisfies RuntimeClient;
  attachRuntimeClientWorker(channel.port1, host, { reload: () => host });
  const client = createWorkerRuntimeClient(channel.port2);
  client.start(() => undefined);

  // Being told "not now" is an ordinary answer, so it arrives as a value. It used
  // to be thrown, which made a busy runtime indistinguishable from a broken
  // channel for any caller that only saw the rejection.
  await expect(client.reloadConfig?.()).resolves.toEqual({
    applied: false,
    reason: "turn is running",
  });
  // The point of the test is unchanged: a busy runtime is preserved, not rebuilt.
  expect(disposed).toBe(false);
});

test("config reload applies changed permission profiles to the same worker client", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-worker-reload-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  const configPath = join(root, ".natalia", "config.json");
  const writeProfile = async (
    approval: "ask" | "read_only",
    agents: Record<string, { description: string }> = {},
  ) =>
    writeFile(
      configPath,
      JSON.stringify({
        version: 3,
        defaultAgentMode: "active",
        agentModes: { active: { approval } },
        agents,
      }),
    );
  await writeProfile("ask");

  const channel = new MessageChannel();
  const createRuntime = () =>
    createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: "ses_worker_reload",
      provider: {
        provider: "test",
        model: "test",
        async *stream() {
          yield { type: "done" as const };
        },
      },
    });
  attachRuntimeClientWorker(channel.port1, createRuntime(), {
    reload: createRuntime,
  });
  const client = createWorkerRuntimeClient(channel.port2);
  client.start(() => undefined);

  expect(await client.runtimeStatus?.()).toMatchObject({ permissions: "ask" });
  await writeProfile("read_only", {
    reviewer: { description: "Reloaded reviewer" },
  });
  await client.reloadConfig?.();
  expect(await client.runtimeStatus?.()).toMatchObject({
    permissions: "read_only",
  });
  expect(await client.agents?.()).toContainEqual(
    expect.objectContaining({
      name: "reviewer",
      description: "Reloaded reviewer",
    }),
  );
  await client.dispose?.();
});

test("the worker channel carries the runtime's answer instead of assuming one", async () => {
  // These were fire-and-forget notifications, so the worker-backed client had no
  // way to know what happened and would have had to make an outcome up. They are
  // round trips now: the host already returned the value, nothing was reading it.
  const channel = new MessageChannel();
  const host: RuntimeClient = {
    start() {},
    async submit(text) {
      return {
        type: "turn.submitted",
        id: "turn_outcome",
        text,
        byteLength: text.length,
        lineCount: 1,
        sha256: "test",
      };
    },
    cancel() {},
    pause() {
      return { paused: false, reason: "no turn has been submitted" };
    },
    resume() {
      return { resumed: false, reason: "the turn is not paused" };
    },
    snapshot: () => ({
      type: "snapshot.created",
      id: "snapshot_outcome",
      files: [],
    }),
    diagnostic() {},
    lastSubmission: () => undefined,
    respondApproval() {
      return {
        accepted: false,
        reason: "the approval request is no longer pending",
      };
    },
    respondQuestion() {
      return {
        accepted: false,
        reason: "the question request is no longer pending",
      };
    },
  };
  attachRuntimeClientWorker(channel.port1, host);
  const client = createWorkerRuntimeClient(channel.port2);
  client.start(() => undefined);

  expect(await client.pause?.()).toEqual({
    paused: false,
    reason: "no turn has been submitted",
  });
  expect(await client.resume?.()).toMatchObject({ resumed: false });
  expect(
    await client.respondApproval({ requestID: "apr_gone", decision: "once" }),
  ).toEqual({
    accepted: false,
    reason: "the approval request is no longer pending",
  });
  expect(
    await client.respondQuestion({
      requestID: "qst_gone",
      answers: [["no"]],
      rejected: false,
    }),
  ).toMatchObject({ accepted: false });
  await client.dispose?.();
});

test("the worker channel routes the MCP surface", async () => {
  // The TUI's @-resource autocomplete calls backend.mcpCatalog; before the
  // channel routed it, the proxy object simply had no such method, so the
  // autocomplete silently returned empty. The method must exist and round-trip.
  const channel = new MessageChannel();
  const catalog: MCPCatalogSnapshot = {
    prompts: [{ server: "fixture", name: "review" }],
    resources: [],
  };
  const host: RuntimeClient = {
    start() {},
    async submit(text) {
      return {
        type: "turn.submitted",
        id: "turn_mcp",
        text,
        byteLength: text.length,
        lineCount: 1,
        sha256: "test",
      };
    },
    cancel() {},
    snapshot: () => ({ type: "snapshot.created", id: "snap_mcp", files: [] }),
    diagnostic() {},
    lastSubmission: () => undefined,
    async mcpCatalog() {
      return catalog;
    },
    async getMcpPrompt(server, name, _arguments, workspaceID) {
      return { server, name, workspaceID };
    },
    async readMcpResource(server, uri, workspaceID) {
      return { server, uri, workspaceID };
    },
    respondApproval() {
      return { accepted: true };
    },
    respondQuestion() {
      return { accepted: true };
    },
  };
  attachRuntimeClientWorker(channel.port1, host);
  const client = createWorkerRuntimeClient(channel.port2);
  client.start(() => undefined);

  expect(typeof client.mcpCatalog).toBe("function");
  expect(await client.mcpCatalog!()).toEqual(catalog);
  expect(
    await client.getMcpPrompt!("fixture", "review", undefined, "ws_remote"),
  ).toEqual({
    server: "fixture",
    name: "review",
    workspaceID: "ws_remote",
  });
  expect(
    await client.readMcpResource!("fixture", "x://y", "ws_remote"),
  ).toEqual({
    server: "fixture",
    uri: "x://y",
    workspaceID: "ws_remote",
  });
  await client.dispose?.();
});

test("the worker channel routes permission profile management", async () => {
  const channel = new MessageChannel();
  let reasoningEffort: RuntimeReasoningEffort | undefined;
  const host: RuntimeClient = {
    start() {},
    async submit(text) {
      return {
        type: "turn.submitted",
        id: "turn_permission",
        text,
        byteLength: text.length,
        lineCount: 1,
        sha256: "test",
      };
    },
    cancel() {},
    snapshot: () => ({
      type: "snapshot.created",
      id: "snap_permission",
      files: [],
    }),
    diagnostic() {},
    lastSubmission: () => undefined,
    permissionList: async () => ({
      default: "ask",
      profiles: [
        {
          name: "ask",
          description: "Ask before actions",
          approval: "ask",
        },
      ],
    }),
    permissionSave: async (input) => ({
      saved: input.name === "strict",
      applied: true,
    }),
    permissionDelete: async (name) => ({ deleted: name !== "ask" }),
    reasoningEffort: async () => reasoningEffort,
    setReasoningEffort: async (effort) => {
      reasoningEffort = effort;
    },
    respondApproval() {
      return { accepted: true };
    },
    respondQuestion() {
      return { accepted: true };
    },
  };
  attachRuntimeClientWorker(channel.port1, host);
  const client = createWorkerRuntimeClient(channel.port2);
  client.start(() => undefined);

  expect(await client.permissionList?.()).toEqual({
    default: "ask",
    profiles: [
      {
        name: "ask",
        description: "Ask before actions",
        approval: "ask",
      },
    ],
  });
  expect(
    await client.permissionSave?.({
      name: "strict",
      profile: { description: "Strict profile", approval: "ask" },
    }),
  ).toEqual({ saved: true, applied: true });
  expect(await client.permissionDelete?.("ask")).toEqual({ deleted: false });
  await client.setReasoningEffort?.("high");
  expect(await client.reasoningEffort?.()).toBe("high");
  await client.dispose?.();
});

test("worker teardown releases workspace capability storage once", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-worker-host-dispose-"));
  const capabilities = new CapabilityHost({ workspaceRoot: root });
  capabilities.registerOwner({
    id: "review",
    name: "Review",
    version: "1",
    scope: "workspace",
    grants: [],
  });
  const channel = new MessageChannel();
  attachRuntimeClientWorker(
    channel.port1,
    createRealRuntimeClient({ workspaceRoot: root }),
    { disposeHost: () => capabilities.dispose() },
  );
  const client = createWorkerRuntimeClient(channel.port2);
  client.start(() => undefined);

  await client.dispose?.();
  expect(capabilities.has("review")).toBe(false);
});

test("the worker channel routes the sandbox, agent-select and fork surface", async () => {
  // DialogSandbox guards every call (`if (!backend.sandboxList)`), so a missing
  // route degrades the whole sandbox dialog silently; App.tsx uses selectAgent
  // and sessionFork the same guarded way. The methods must exist and round-trip.
  const channel = new MessageChannel();
  const host: RuntimeClient = {
    start() {},
    async submit(text) {
      return {
        type: "turn.submitted",
        id: "turn_surface",
        text,
        byteLength: text.length,
        lineCount: 1,
        sha256: "test",
      };
    },
    cancel() {},
    snapshot: () => ({
      type: "snapshot.created",
      id: "snap_surface",
      files: [],
    }),
    diagnostic() {},
    lastSubmission: () => undefined,
    async sandboxList() {
      return [
        {
          id: "box_1",
          root: "/r/box_1",
          isolationLevel: "workspace" as const,
          changedFiles: 2,
          runningResources: 1,
          envAllowlist: [],
        },
      ];
    },
    async sandboxDiff(id) {
      return [{ kind: "modify", path: `${id}/a.ts`, oldPath: undefined }];
    },
    async sandboxResources(id) {
      return [
        {
          id: "srv",
          sandboxID: id,
          command: "sleep 60",
          pid: 42,
          status: "running" as const,
          outputPath: "/r/srv.out",
          startedAt: "2026-08-12T00:00:00.000Z",
        },
      ];
    },
    async sandboxResourceOutput(input) {
      return `output of ${input.resourceID}`;
    },
    async sandboxResourceStop(input) {
      return {
        id: input.resourceID,
        sandboxID: input.id,
        command: "sleep 60",
        pid: 42,
        status: "stopped" as const,
        outputPath: "/r/srv.out",
        startedAt: "2026-08-12T00:00:00.000Z",
      };
    },
    async sandboxMerge(id) {
      return [{ kind: "add", path: `${id}/b.ts`, oldPath: undefined }];
    },
    async sandboxDelete(id) {
      return { pendingChanges: [], runningResources: [] };
    },
    async selectAgent(name) {
      return { outcome: "applied" as const, selected: name };
    },
    async sessionFork(id, turnID) {
      return {
        id: `${id}_fork`,
        title: "fork",
        createdAt: "2026-08-12T00:00:00.000Z",
        pinned: false,
        events: 0,
        pendingInputs: 0,
        cancelled: false,
        resumable: true,
      };
    },
    respondApproval() {
      return { accepted: true };
    },
    respondQuestion() {
      return { accepted: true };
    },
  };
  attachRuntimeClientWorker(channel.port1, host);
  const client = createWorkerRuntimeClient(channel.port2);
  client.start(() => undefined);

  expect(typeof client.sandboxList).toBe("function");
  expect(typeof client.sessionFork).toBe("function");
  expect(await client.sandboxList!()).toEqual([
    {
      id: "box_1",
      root: "/r/box_1",
      isolationLevel: "workspace",
      changedFiles: 2,
      runningResources: 1,
      envAllowlist: [],
    },
  ]);
  expect(await client.sandboxMerge!("box_1")).toEqual([
    { kind: "add", path: "box_1/b.ts", oldPath: undefined },
  ]);
  expect(
    await client.sandboxResourceOutput!({ id: "box_1", resourceID: "srv" }),
  ).toBe("output of srv");
  expect(await client.selectAgent!("helper")).toEqual({
    outcome: "applied",
    selected: "helper",
  });
  expect(await client.sessionFork!("ses_a", "turn_1")).toEqual({
    id: "ses_a_fork",
    title: "fork",
    createdAt: "2026-08-12T00:00:00.000Z",
    pinned: false,
    events: 0,
    pendingInputs: 0,
    cancelled: false,
    resumable: true,
  });
  expect(await client.sandboxDelete!("box_1")).toEqual({
    pendingChanges: [],
    runningResources: [],
  });
});

test("fact-domain read queries and mailbox writes route through the channel", async () => {
  const channel = new MessageChannel();
  let sink: ((event: RuntimeEvent) => void) | undefined;
  const host: RuntimeClient = {
    start(handler) {
      sink = handler;
    },
    async submit(text) {
      const event: SubmittedTurn = {
        type: "turn.submitted",
        id: "turn_worker_facts",
        text,
        byteLength: text.length,
        lineCount: 1,
        sha256: "test",
      };
      sink?.(event);
      return event;
    },
    cancel() {},
    diagnostic() {},
    lastSubmission: () => undefined,
    snapshot: () => ({
      type: "snapshot.created",
      id: "snapshot_worker_facts",
      files: [],
    }),
    respondApproval() {
      return { accepted: true };
    },
    respondQuestion() {
      return { accepted: true };
    },
    sessionSnapshot: async () => ({
      agentStatus: "running",
      changedFiles: 1,
      unvalidatedChanges: 1,
      hasPTY: false,
      hasSandbox: false,
    }),
    planDocList: async () => [
      {
        planID: "plan:1",
        title: "t",
        documentPath: ".natalia/plans/plan_1.md",
        status: "executing",
        createdBy: "main_agent",
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
        revision: 1,
      },
    ],
    planDocStatus: async () => ({ status: "executing" }),
    mailboxList: async () => [],
    mailboxSend: async (input) => ({ queued: true, messageID: "mailbox:1" }),
    mailboxAcknowledge: async () => ({ acknowledged: true }),
    driftFindings: async () => ({
      items: [],
      returned: 0,
      total: 0,
      truncated: false,
    }),
    completions: async () => ({
      items: [],
      returned: 0,
      total: 0,
      truncated: false,
    }),
    constitutionRules: async () => [],
    decisionRecords: async () => ({
      items: [],
      returned: 0,
      total: 0,
      truncated: false,
    }),
    evidenceRecords: async () => ({
      items: [],
      returned: 0,
      total: 0,
      truncated: false,
    }),
    naviChat: {
      submit: async () => ({ messageID: "chat:m1" }),
      messages: async () => [
        { messageID: "chat:m1", role: "user", text: "hi", at: "now" },
      ],
      rollback: async () => ({ rolledBackTo: "chat:m1", removed: 1 }),
    },
    niaChat: {
      submit: async () => ({ messageID: "chat:n1" }),
      messages: async () => [],
      rollback: async () => ({ rolledBackTo: "chat:n1", removed: 0 }),
    },
  };
  attachRuntimeClientWorker(channel.port1, host);
  const client = createWorkerRuntimeClient(channel.port2);
  client.start((event) => sink?.(event));

  expect(await client.sessionSnapshot!()).toMatchObject({
    agentStatus: "running",
  });
  expect(await client.planDocList!()).toHaveLength(1);
  expect(await client.planDocStatus!("plan:1")).toEqual({
    status: "executing",
  });
  expect(
    await client.mailboxSend!({ intent: "clarification", text: "hi" }),
  ).toEqual({
    queued: true,
    messageID: "mailbox:1",
  });
  expect(await client.mailboxList!()).toEqual([]);
  expect(await client.mailboxAcknowledge!("mailbox:1")).toEqual({
    acknowledged: true,
  });
  expect(await client.driftFindings!()).toMatchObject({
    items: [],
    returned: 0,
    total: 0,
    truncated: false,
  });
  expect(await client.completions!()).toMatchObject({
    items: [],
    returned: 0,
    total: 0,
    truncated: false,
  });
  expect(await client.constitutionRules!()).toEqual([]);
  expect(await client.decisionRecords!()).toMatchObject({
    items: [],
    returned: 0,
    total: 0,
    truncated: false,
  });
  expect(await client.evidenceRecords!()).toMatchObject({
    items: [],
    returned: 0,
    total: 0,
    truncated: false,
  });
  expect(await client.naviChat!.messages!()).toEqual([
    { messageID: "chat:m1", role: "user", text: "hi", at: "now" },
  ]);
  expect(await client.naviChat!.rollback!({ toMessageID: "chat:m1" })).toEqual({
    rolledBackTo: "chat:m1",
    removed: 1,
  });
});
