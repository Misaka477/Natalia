import { expect, test } from "bun:test";
import type {
  RuntimeClient,
  RuntimeEvent,
  SubmittedTurn,
} from "@anthelia/contracts";
import { createRuntimeHttpServer } from "@natalia/transport/host";
import { createNataliaSDK } from "../src";
import { RuntimeVersionMismatchError } from "@anthelia/contracts";

test("SDK uses the TS RPC transport rather than runtime internals", async () => {
  let sink: ((event: RuntimeEvent) => void) | undefined;
  const approvalResponses: unknown[] = [];
  const questionResponses: unknown[] = [];
  const prompts: string[] = [];
  const selectedAgents: Array<string | undefined> = [];
  const selectedModels: Array<{ modelID?: string; variant?: string }> = [];
  const attachedSessions: string[] = [];
  const setCalls: Array<{ patch: Record<string, unknown>; scope: string }> = [];
  const commandExecutions: Array<{
    name: string;
    raw: string;
    args: string[];
  }> = [];
  const client: RuntimeClient = {
    start(handler) {
      sink = handler;
    },
    async submit(text) {
      prompts.push(text);
      const event = {
        type: "turn.submitted",
        id: "turn_sdk",
        text,
        byteLength: text.length,
        lineCount: 1,
        sha256: "sdk",
      } satisfies SubmittedTurn;
      sink?.(event);
      return event;
    },
    cancel() {},
    pause() {
      return { paused: true };
    },
    resume() {
      return { resumed: true };
    },
    selectAgent(name) {
      selectedAgents.push(name);
      return { outcome: "applied" as const, selected: name };
    },
    async agents() {
      return [
        {
          name: "reviewer",
          description: "Review changes",
          mode: "subagent" as const,
          hidden: false,
        },
      ];
    },
    async modelCatalog() {
      return [
        { id: "alpha", name: "alpha", provider: "fixture", variants: ["fast"] },
      ];
    },
    async modelSelection() {
      return { modelID: "alpha", variant: "fast" };
    },
    async selectModel(modelID, variant) {
      selectedModels.push({ modelID, variant });
    },
    async skills() {
      return [
        {
          name: "release",
          enabled: true,
          qualifiedName: "project:release",
          description: "Prepare release evidence",
          source: "project",
          requireApproval: true,
          sandboxRequired: false,
        },
      ];
    },
    async workspaceFiles() {
      return [{ path: "src/model.ts", type: "file" }];
    },
    async workspaceSearch() {
      return [{ path: "src/model.ts", line: 2, text: "needle" }];
    },
    async workspaceList() {
      return {
        entries: [{ path: "src/", type: "directory" }],
        truncated: false,
      };
    },
    async workspaceRead() {
      return {
        path: "src/model.ts",
        content: "export {}\n",
        encoding: "utf8",
        mime: "text/typescript",
      };
    },
    async workspaceGlob() {
      return [{ path: "src/model.ts", type: "file" }];
    },
    async sessionList() {
      return [
        {
          id: "ses_one",
          title: "One",
          createdAt: "2026-01-01T00:00:00.000Z",
          pinned: false,
          events: 1,
          pendingInputs: 0,
          cancelled: false,
          resumable: true,
        },
      ];
    },
    async sessionTouch() {},
    async sessionRename(id, title) {
      return {
        id,
        title,
        createdAt: "2026-01-01T00:00:00.000Z",
        pinned: false,
        events: 1,
        pendingInputs: 0,
        cancelled: false,
        resumable: true,
      };
    },
    async sessionPin(id, pinned) {
      return {
        id,
        title: "One",
        createdAt: "2026-01-01T00:00:00.000Z",
        pinned,
        events: 1,
        pendingInputs: 0,
        cancelled: false,
        resumable: true,
      };
    },
    async sessionDuplicate(id) {
      return {
        id: `${id}_copy`,
        title: "One (copy)",
        createdAt: "2026-01-01T00:00:00.000Z",
        pinned: false,
        events: 1,
        pendingInputs: 0,
        cancelled: false,
        resumable: true,
      };
    },
    async sessionFork(id, turnID) {
      return {
        id: `${id}_fork_${turnID}`,
        title: "One (fork)",
        createdAt: "2026-01-01T00:00:00.000Z",
        pinned: false,
        events: 1,
        pendingInputs: 0,
        cancelled: false,
        resumable: true,
      };
    },
    async messages() {
      return {
        data: [
          {
            id: "turn_message",
            turnID: "turn_message",
            submitted: {
              type: "turn.submitted" as const,
              id: "turn_message",
              text: "projected",
              byteLength: 9,
              lineCount: 1,
              sha256: "sdk",
            },
            rows: [],
          },
        ],
        cursor: {},
      };
    },
    async checkpointList() {
      return [checkpointFixture()];
    },
    async checkpointPreview() {
      return checkpointPreviewFixture(true);
    },
    async checkpointRollback(input) {
      return checkpointPreviewFixture(Boolean(input.dryRun));
    },
    async checkpointRename(input) {
      return { ...checkpointFixture(), id: input.id, name: input.name };
    },
    async sandboxList() {
      return [sandboxFixture()];
    },
    async sandboxDiff() {
      return [{ kind: "modify" as const, path: "draft.txt" }];
    },
    async sandboxResources() {
      return [];
    },
    async sandboxResourceOutput() {
      return "";
    },
    async sessionDelete(id) {
      return { id, removedAttachments: 0 };
    },
    async sessionAttach(id) {
      attachedSessions.push(id);
      return { sessionID: id };
    },
    async settingsGet() {
      return {
        config: { theme: "stub-dark" },
        sources: [
          { scope: "defaults", applied: true },
          { scope: "global", applied: false, diagnostic: "missing" },
          { scope: "project", applied: true },
        ],
      };
    },
    async settingsSet(patch, scope) {
      setCalls.push({ patch, scope });
      return { applied: true };
    },
    async mcpCatalog() {
      return {
        prompts: [{ server: "fixture", name: "review" }],
        resources: [{ server: "fixture", uri: "file:///guide", name: "guide" }],
      };
    },
    async getMcpPrompt(server, name, arguments_) {
      return { server, name, arguments: arguments_ };
    },
    async readMcpResource(server, uri) {
      return { server, uri };
    },
    async plugins() {
      return [
        {
          id: "demo.plugin",
          version: "1.0.0",
          name: "Demo",
          description: "",
          capabilities: ["tools"],
        },
      ];
    },
    async commandExecute(input) {
      commandExecutions.push(input);
    },
    async runtimeStatus() {
      return {
        type: "status.snapshot",
        model: "test",
        provider: "fixture",
        context: "0 tokens",
        step: "0",
        permissions: "ask",
        cwd: "/tmp",
        background: "0 running",
      };
    },
    async diagnostics() {
      return [
        {
          type: "diagnostic",
          level: "info",
          message: "safe",
          at: "2026-07-22T00:00:00.000Z",
        },
      ];
    },
    snapshot: () => ({ type: "snapshot.created", id: "snap_sdk", files: [] }),
    diagnostic() {},
    lastSubmission: () => undefined,
    respondApproval(response) {
      approvalResponses.push(response);
      return { accepted: true };
    },
    respondQuestion(response) {
      questionResponses.push(response);
      return { accepted: true };
    },
  };
  const server = createRuntimeHttpServer({ client, token: "sdk-token" });
  const sdk = createNataliaSDK({ baseURL: server.url, token: "sdk-token" });
  expect(await sdk.health()).toMatchObject({ ok: true, apiVersion: 1 });
  expect(await sdk.prompt("sdk prompt")).toMatchObject({
    id: "turn_sdk",
    text: "sdk prompt",
  });
  expect(await sdk.snapshot()).toMatchObject({ id: "snap_sdk" });
  expect(await sdk.mcpCatalog()).toMatchObject({
    prompts: [{ server: "fixture", name: "review" }],
  });
  expect(await sdk.mcpPrompt("fixture", "review", { scope: "local" })).toEqual({
    server: "fixture",
    name: "review",
    arguments: { scope: "local" },
  });
  expect(await sdk.mcpResource("fixture", "file:///guide")).toEqual({
    server: "fixture",
    uri: "file:///guide",
  });
  expect(await sdk.plugins()).toMatchObject([
    { id: "demo.plugin", capabilities: ["tools"] },
  ]);
  await sdk.commandExecute({
    name: "demo",
    raw: "/demo one",
    args: ["one"],
  });
  expect(commandExecutions).toEqual([
    { name: "demo", raw: "/demo one", args: ["one"] },
  ]);
  expect(await sdk.runtimeStatus()).toMatchObject({ provider: "fixture" });
  expect(await sdk.diagnostics(1)).toMatchObject([{ message: "safe" }]);
  await sdk.pause("sdk pause");
  await sdk.resume();
  await sdk.selectAgent("reviewer");
  expect(await sdk.agents()).toMatchObject([{ name: "reviewer" }]);
  expect(await sdk.modelCatalog()).toMatchObject([
    { id: "alpha", variants: ["fast"] },
  ]);
  expect(await sdk.modelSelection()).toEqual({
    modelID: "alpha",
    variant: "fast",
  });
  await sdk.selectModel("alpha", "fast");
  expect(await sdk.skills()).toMatchObject([
    { qualifiedName: "project:release" },
  ]);
  expect(await sdk.workspaceFiles({ query: "model" })).toEqual([
    { path: "src/model.ts", type: "file" },
  ]);
  expect(await sdk.workspaceSearch({ query: "needle" })).toEqual([
    { path: "src/model.ts", line: 2, text: "needle" },
  ]);
  expect(await sdk.workspaceList()).toEqual({
    entries: [{ path: "src/", type: "directory" }],
    truncated: false,
  });
  expect(await sdk.workspaceRead({ path: "src/model.ts" })).toMatchObject({
    encoding: "utf8",
  });
  expect(await sdk.workspaceGlob({ pattern: "**/*.ts" })).toEqual([
    { path: "src/model.ts", type: "file" },
  ]);
  expect(await sdk.sessions()).toMatchObject([{ id: "ses_one" }]);
  await sdk.touchSession("ses_one");
  expect(await sdk.renameSession("ses_one", "Renamed")).toMatchObject({
    title: "Renamed",
  });
  expect(await sdk.pinSession("ses_one", true)).toMatchObject({ pinned: true });
  expect(await sdk.duplicateSession("ses_one")).toMatchObject({
    id: "ses_one_copy",
  });
  expect(await sdk.forkSession("ses_one", "turn_sdk")).toMatchObject({
    id: "ses_one_fork_turn_sdk",
    title: "One (fork)",
  });
  expect(await sdk.attachSession("ses_two")).toEqual({
    sessionID: "ses_two",
  });
  expect(attachedSessions).toEqual(["ses_two"]);

  expect(await sdk.settingsGet()).toMatchObject({
    config: { theme: "stub-dark" },
  });
  expect(await sdk.settingsSet({ theme: "paper" }, "global")).toEqual({
    applied: true,
  });
  expect(setCalls).toEqual([{ patch: { theme: "paper" }, scope: "global" }]);
  expect(await sdk.messages({ order: "asc" })).toMatchObject({
    data: [{ id: "turn_message" }],
  });

  expect(await sdk.checkpointList()).toMatchObject([{ id: "checkpoint_0" }]);
  expect(await sdk.checkpointPreview("checkpoint_0")).toMatchObject({
    dryRun: true,
  });
  expect(
    await sdk.checkpointRollback({ id: "checkpoint_0", dryRun: false }),
  ).toMatchObject({ dryRun: false });
  expect(
    await sdk.checkpointRename({ id: "checkpoint_0", name: "named" }),
  ).toMatchObject({ id: "checkpoint_0", name: "named" });
  expect(await sdk.sandboxList()).toMatchObject([{ id: "sandbox_fixture" }]);
  expect(await sdk.sandboxDiff("sandbox_fixture")).toMatchObject([
    { path: "draft.txt" },
  ]);
  expect(await sdk.deleteSession("ses_one")).toEqual({
    id: "ses_one",
    removedAttachments: 0,
  });
  await sdk.respondApproval({ requestID: "approval_1", decision: "once" });
  await sdk.respondQuestion({ requestID: "question_1", answers: [["yes"]] });
  await sdk.checkpoint();
  await sdk.checkpoints(2);
  await sdk.rollback("checkpoint_1", { dryRun: true });
  expect(approvalResponses).toContainEqual({
    requestID: "approval_1",
    decision: "once",
  });
  expect(questionResponses).toContainEqual({
    requestID: "question_1",
    answers: [["yes"]],
    rejected: false,
  });
  expect(selectedAgents).toEqual(["reviewer"]);
  expect(selectedModels).toEqual([{ modelID: "alpha", variant: "fast" }]);
  expect(prompts).toEqual(
    expect.arrayContaining([
      "/checkpoint",
      "/checkpoints --limit 2",
      "/rollback checkpoint_1 --dry-run",
    ]),
  );
  const events = sdk.events({ since: 4 });
  const firstEvent = events[Symbol.asyncIterator]().next();
  await sdk.prompt("event prompt");
  const first = await firstEvent;
  expect(first.value).toMatchObject({
    type: "turn.submitted",
    text: "event prompt",
  });
  server.stop(true);
});

function checkpointFixture() {
  return {
    id: "checkpoint_0",
    sequence: 0,
    step: 0,
    reason: "baseline" as const,
    createdAt: "2026-07-23T00:00:00.000Z",
    complete: true,
    errors: [],
    files: 0,
    changes: 0,
    tokenEstimate: 0,
    diskUsageBytes: 0,
  };
}

function checkpointPreviewFixture(dryRun: boolean) {
  return {
    checkpointID: "checkpoint_0",
    dryRun,
    changes: [],
    context: {
      truncateMessages: 0,
      targetJournalOffset: 0,
      targetStep: 0,
      targetTokens: 0,
      compactionGeneration: 0,
    },
    resources: [],
    ignoredFiles: 0,
    diskUsageBytes: 0,
    complete: true,
    warnings: [],
  };
}

function sandboxFixture() {
  return {
    id: "sandbox_fixture",
    root: "/tmp/sandbox_fixture",
    isolationLevel: "workspace" as const,
    changedFiles: 1,
    runningResources: 0,
    envAllowlist: ["PATH"],
  };
}

test("an SDK meeting a newer runtime refuses to guess, and says both versions", async () => {
  // The acceptance case for versioning: the consumer can read the version,
  // can tell it is incompatible, and never silently misreads a changed
  // protocol. The server here speaks a hypothetical future API.
  const client: RuntimeClient = {
    start() {},
    async submit(text) {
      return {
        type: "turn.submitted",
        id: "t",
        text,
        byteLength: 1,
        lineCount: 1,
        sha256: "x",
      };
    },
    cancel() {},
    snapshot() {
      return { type: "diagnostic", level: "info", message: "x" };
    },
    diagnostic() {},
    lastSubmission() {
      return undefined;
    },
    respondApproval() {
      return { accepted: true };
    },
    respondQuestion() {
      return { accepted: true };
    },
  };
  const server = createRuntimeHttpServer({ client, token: "sdk-token" });
  try {
    // Pretend the server speaks a newer protocol by intercepting /healthz.
    const sdk = createNataliaSDK({
      baseURL: server.url,
      token: "sdk-token",
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/healthz")) {
          return Promise.resolve(
            new Response(JSON.stringify({ ok: true, apiVersion: 2 }), {
              status: 200,
            }),
          );
        }
        return fetch(input, init);
      }) as typeof fetch,
    });
    const error = await sdk.prompt("x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeVersionMismatchError);
    expect((error as RuntimeVersionMismatchError).serverVersion).toBe(2);
    expect((error as RuntimeVersionMismatchError).supportedVersion).toBe(1);
  } finally {
    server.stop();
  }
});
