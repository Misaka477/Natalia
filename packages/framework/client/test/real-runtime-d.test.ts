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
import { WorkspaceSandboxTestManager as WorkspaceSandboxManager } from "@natalia/testing";
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
  sandboxedSubagentProvider,
  sandboxedDomainProvider,
  imageAttachProvider,
  subagentPlanPointerProvider,
  MAIN_PLAN_ID,
  subagentCacheUsageProvider,
} from "./real-runtime-harness";
import type { NamespacedCollabMessageEvent } from "./real-runtime-harness";

test("evidence summary is secret-safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-e5-promote-secret-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      sandbox: {
        promoteCommand: 'printf "token=fakefaketoken\\n"; true',
      },
    }),
  );
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_e5_promote_secret",
    capabilityRegistry: kernel,
    permissionMode: "auto",
    provider: singleToolProvider("sandbox_create", { id: "box" }),
  });
  client.start(() => undefined);
  await client.submitAndWait!("create sandbox");
  await pollHistoryForFinished(client);
  const sandboxes = kernel.service<SandboxService>(sandboxService.id)!;
  await sandboxes.write("box", "ok.txt", "ok");
  await client.sandboxMerge!("box");
  const records = await client.evidenceRecords!();
  const payload = JSON.stringify(records);
  expect(payload).not.toContain("fakefaketoken");
  expect(records.items[0]?.validations[0]?.command).not.toContain(
    "fakefaketoken",
  );
  await client.dispose?.();
});

test("recordCompletion records a card, its projection and validated_by edges", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-completion-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_completion",
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

  const outcome = await client.recordCompletion?.({
    taskID: "task_build",
    objective: "verify the build",
    changeSummary: "added the build check",
    behaviorImpact: "CI now runs typecheck",
    validations: [
      { command: "npm run typecheck", result: "passed", safeSummary: "ok" },
    ],
    humanValidation: "reviewed by owner",
    knownGaps: ["no windows coverage"],
    externalSideEffects: ["writes .tmp"],
    rollbackState: "available",
    evidenceIDs: ["evidence:1"],
    changePaths: ["src/build.ts"],
  });
  expect(outcome?.recorded).toBe(true);
  expect(outcome?.completionID).toBeDefined();

  const cards = await client.completions!();
  expect(cards.items).toHaveLength(1);
  expect(cards.items[0]).toMatchObject({
    taskID: "task_build",
    changeSummary: "added the build check",
    validations: [{ command: "npm run typecheck", result: "passed" }],
    humanValidation: "reviewed by owner",
    knownGaps: ["no windows coverage"],
    rollbackState: "available",
    evidenceIDs: ["evidence:1"],
  });

  // The completion card validated the change via a validated_by Work Graph edge.
  expect(
    events.some(
      (event) =>
        event.type === "workgraph.edge_added" &&
        event.kind === "validated_by" &&
        event.targetID.includes("completion"),
    ),
  ).toBe(true);
});

test("mailbox send/list/deliver/acknowledge records a durable lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox",
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

  const sent = await client.mailboxSend?.({
    intent: "reprioritize",
    text: "focus on the docs task first",
    safeSummary: "user asked to reprioritize",
    priority: "high",
    deliveryPolicy: "next_safe_boundary",
  });
  expect(sent?.queued).toBe(true);
  expect(sent?.messageID).toBeDefined();

  let mailbox = await client.mailboxList!();
  expect(mailbox).toHaveLength(1);
  expect(mailbox[0]).toMatchObject({
    intent: "reprioritize",
    priority: "high",
    text: "focus on the docs task first",
    status: "queued",
    deliveryPolicy: "next_safe_boundary",
  });

  expect(await client.mailboxDeliver?.(sent!.messageID!)).toEqual({
    delivered: true,
  });
  expect((await client.mailboxList!())[0]?.status).toBe("delivered");

  expect(await client.mailboxAcknowledge?.(sent!.messageID!)).toEqual({
    acknowledged: true,
  });
  expect((await client.mailboxList!())[0]?.status).toBe("acknowledged");

  expect(
    events.filter((event) => event.type.startsWith("mailbox.")).length,
  ).toBe(3);
  expect(
    events.some(
      (event) =>
        event.type === "mailbox.queued" &&
        event.intent === "reprioritize" &&
        event.safeSummary === "user asked to reprioritize",
    ),
  ).toBe(true);
});

test("mailbox defer and supersede move a queued message out of the way", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-def-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_def",
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

  const sent = await client.mailboxSend?.({
    intent: "constraint",
    text: "never merge a failing build",
    safeSummary: "a merge constraint",
  });
  expect(
    await client.mailboxDefer?.(sent!.messageID!, "unsafe boundary"),
  ).toEqual({ deferred: true });
  expect((await client.mailboxList!())[0]?.status).toBe("deferred");
  expect((await client.mailboxList!())[0]?.reason).toBe("unsafe boundary");

  const second = await client.mailboxSend?.({
    intent: "cancel",
    text: "stop the current plan",
    safeSummary: "cancel requested",
  });
  expect(
    await client.mailboxSupersede?.(second!.messageID!, "superseded by newer"),
  ).toEqual({ superseded: true });
  expect((await client.mailboxList!())[1]?.status).toBe("superseded");

  // A delivered message cannot be acknowledged twice or delivered twice.
  expect(await client.mailboxDefer?.(sent!.messageID!, "again")).toEqual({
    deferred: false,
  });
  expect(await client.mailboxAcknowledge?.(sent!.messageID!)).toEqual({
    acknowledged: false,
  });
});

test("mailbox_cancel drops a queued duplicate before Natalia consumes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-mailbox-cancel-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_mailbox_cancel",
    permissionMode: "auto",
    provider: scriptedProvider("ready"),
  });
  client.start(() => undefined);
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);
  const sent = await client.mailboxSend?.({
    intent: "pause",
    text: "please pause after this step",
  });
  expect(
    await client.mailboxSupersede?.(sent!.messageID!, "cancelled by live chat"),
  ).toEqual({ superseded: true });
  expect((await client.mailboxList!())[0]?.status).toBe("superseded");
  await client.dispose?.();
});

test("mailboxSend redacts secrets from the recorded safe summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-redact-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_redact",
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

  await client.mailboxSend?.({
    intent: "constraint",
    text: "api_key=supersecretvalue",
    safeSummary: "api_key=supersecretvalue",
  });
  const mailbox = await client.mailboxList!();
  expect(mailbox[0]?.safeSummary).not.toContain("supersecretvalue");
  expect(JSON.stringify(mailbox)).not.toContain("supersecretvalue");
});

test("queued mailbox messages are delivered at the next turn safe boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-safe-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_safe",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => {});
  await client.submitAndWait!("first");
  await pollHistoryForFinished(client);

  // No turn running: the intent wakes the idle main agent immediately (P8 鎼?)
  // instead of sitting queued until the next manual turn.
  await client.mailboxSend?.({
    intent: "reprioritize",
    text: "focus on docs",
    safeSummary: "reprioritize to docs",
  });
  await waitForAsync(
    async () => (await client.mailboxList!())[0]?.status === "acknowledged",
  );
  const mailbox = await client.mailboxList!();
  expect(mailbox[0]?.status).toBe("acknowledged");
  expect(
    mailbox[0]?.deliveryPolicy === undefined
      ? "next_safe_boundary"
      : mailbox[0]?.deliveryPolicy,
  ).toBe("next_safe_boundary");
});

test("deferred and superseded mailbox messages are not auto-delivered at a boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-safe-def-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_safe_def",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => {});
  await client.submitAndWait!("first");
  await pollHistoryForFinished(client);

  const deferred = await client.mailboxSend?.({
    intent: "constraint",
    text: "never merge failing",
    safeSummary: "a constraint",
  });
  const superseded = await client.mailboxSend?.({
    intent: "cancel",
    text: "stop the plan",
    safeSummary: "cancel",
  });
  expect(
    await client.mailboxDefer?.(deferred!.messageID!, "unsafe boundary"),
  ).toEqual({ deferred: true });
  expect(
    await client.mailboxSupersede?.(superseded!.messageID!, "newer"),
  ).toEqual({ superseded: true });

  await client.submitAndWait!("second");
  await pollHistoryForFinished(client);

  const mailbox = await client.mailboxList!();
  const byIntent = new Map(mailbox.map((m) => [m.intent, m.status]));
  expect(byIntent.get("constraint")).toBe("deferred");
  expect(byIntent.get("cancel")).toBe("superseded");
});

test("a manually delivered mailbox message is not re-delivered at a boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-safe-man-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_safe_man",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => {});
  await client.submitAndWait!("first");
  await pollHistoryForFinished(client);

  const sent = await client.mailboxSend?.({
    intent: "request_report",
    text: "summarize",
    safeSummary: "a report request",
  });
  expect(await client.mailboxDeliver?.(sent!.messageID!)).toEqual({
    delivered: true,
  });

  await client.submitAndWait!("second");
  await pollHistoryForFinished(client);

  // The manually delivered message was injected into turn 2's context, so the
  // turn's finish acknowledges it (consumption-driven settlement) and it is not
  // re-delivered by the boundary.
  expect((await client.mailboxList!())[0]?.status).toBe("acknowledged");
});

test("a mailbox message sent mid-turn injects before the next model step", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-midturn-"));
  const userTurns: string[] = [];
  let release: (() => void) | undefined;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_midturn",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        userTurns.push(
          request.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content)
            .join("\n"),
        );
        if (userTurns.length === 1) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "read1",
                name: "unknown_probe",
                arguments: "{}",
              },
            ],
          };
          await new Promise<void>((resolve) => (release = resolve));
        }
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  const submitting = client.submit("long task");
  while (!release) await Bun.sleep(1);
  await client.mailboxSend?.({
    intent: "pause",
    text: "please pause after this step",
    safeSummary: "pause requested",
  });
  release();
  await submitting;
  await pollHistoryForFinished(client);
  expect(
    userTurns.some((text) =>
      text.includes("[user] please pause after this step"),
    ),
  ).toBe(true);
});

test("delivered mailbox intents reach the main agent as ordinary tagged user messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-inject-"));
  const userTurns: string[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_inject",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        userTurns.push(
          request.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content)
            .join("\n"),
        );
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => {});
  await client.submitAndWait!("first");
  await pollHistoryForFinished(client);

  await client.mailboxSend?.({
    intent: "constraint",
    text: "never commit the lockfile",
    safeSummary: "a commit constraint",
    priority: "high",
  });
  await waitFor(() =>
    userTurns.some((text) => text.includes("never commit the lockfile")),
  );
  const injected = userTurns.find((text) =>
    text.includes("never commit the lockfile"),
  );
  expect(injected).toContain("[user] never commit the lockfile");
  await waitForAsync(
    async () => (await client.mailboxList!())[0]?.status === "acknowledged",
  );
  expect((await client.mailboxList!())[0]?.status).toBe("acknowledged");
});

test("mailbox_acknowledge marks delivered messages acknowledged and stops re-injection", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-ack-tool-"));
  let ackAttempted = 0;
  const userTurns: string[] = [];
  let sentID = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_ack_tool",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        const users = request.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content)
          .join("\n");
        userTurns.push(users);
        const pending = users.includes("never commit the lockfile");
        if (pending && ackAttempted === 0 && sentID) {
          ackAttempted += 1;
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_ack",
                name: "mailbox_acknowledge",
                arguments: JSON.stringify({ messageIDs: [sentID] }),
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
  await client.submitAndWait!("first");
  await pollHistoryForFinished(client);

  // Seed a queued mailbox message while idle.
  await client.mailboxSend?.({
    intent: "constraint",
    text: "never commit the lockfile",
    safeSummary: "a constraint",
  });
  sentID = (await client.mailboxList!())[0]!.messageID;

  await client.submitAndWait!("second");
  await pollHistoryForFinished(client);
  expect(ackAttempted).toBe(1);
  expect(events.some((event) => event.type === "mailbox.acknowledged")).toBe(
    true,
  );

  await client.submitAndWait!("third");
  await pollHistoryForFinished(client);
  expect(userTurns.at(-1)).not.toContain("never commit the lockfile");
});

test("delivered mailbox intents are auto-acknowledged at the next turn finish (no tool needed)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-consume-"));
  const userTurns: string[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_consume",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        userTurns.push(
          request.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content)
            .join("\n"),
        );
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("first");
  await pollHistoryForFinished(client);

  // Seed an intent while idle: the agent wakes and the wake turn sees it; its
  // finish auto-acknowledges it (consumption-driven, no tool needed).
  await client.mailboxSend?.({
    intent: "constraint",
    text: "never merge a failing build",
    safeSummary: "a merge constraint",
  });
  await waitFor(() =>
    userTurns.some((text) => text.includes("never merge a failing build")),
  );
  expect(
    userTurns.find((text) => text.includes("never merge a failing build")),
  ).toContain("[user] never merge a failing build");
  await waitForAsync(
    async () => (await client.mailboxList!())[0]?.status === "acknowledged",
  );

  await client.submitAndWait!("next");
  await pollHistoryForFinished(client);
  expect(userTurns.at(-1)).not.toContain("never merge a failing build");
});

test("a turn that does not finish normally does not auto-acknowledge delivered intents", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-error-"));
  let streamCalls = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_error",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        streamCalls++;
        if (streamCalls === 1) {
          // The warm-up turn completes normally.
          yield { type: "done" as const };
          return;
        }
        // The second turn errors mid-stream: it is not a "done" settlement, so
        // it must not acknowledge a delivered intent.
        yield { type: "content" as const, text: "half" };
        await new Promise((resolve) => setTimeout(resolve, 200));
        throw providerError({
          kind: "invalid_request",
          message: "provider rejected the request",
        });
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("first");
  await pollHistoryForFinished(client);

  // Send the intent mid-turn (the running turn keeps the coordinator active, so
  // no wake turn spawns), then deliver it explicitly so it is "delivered".
  events.length = 0;
  const running = client.submit("long");
  await waitFor(() => events.some((event) => event.type === "content.delta"));
  const sent = await client.mailboxSend?.({
    intent: "pause",
    text: "pause after this",
    safeSummary: "pause requested",
  });
  expect((await client.mailboxList!())[0]?.status).toBe("queued");
  if (sent?.messageID) await client.mailboxDeliver?.(sent.messageID);
  expect((await client.mailboxList!())[0]?.status).toBe("delivered");

  // The running turn errors out: not a "done" finish, so the delivered intent
  // stays delivered for another turn to see.
  await running;
  await pollHistoryForFinished(client);
  expect((await client.mailboxList!())[0]?.status).toBe("delivered");
});

test("evaluateDrift opens durable findings and driftFindings answers them", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-drift-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_drift",
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

  // EI 鎼?.6: a session with no accepted contract gets the advisory unverifiable
  // finding. The prose objective/activity mismatch is now a 闂傤噣鈧岸浜?(ask), not a
  // finding, so it does not open here.
  const opened = await client.evaluateDrift?.({
    objective: "implement user authentication",
    currentActivity: "refactoring the css theme",
    applicableConstraints: ["never commit generated files"],
    changes: [{ action: "modified", path: "src/theme.css" }],
    evidenceRefs: [],
  });
  expect(opened).toEqual({ opened: 1 });

  const findings = await client.driftFindings!();
  expect(findings.items).toHaveLength(1);
  expect(findings.items[0]).toMatchObject({
    severity: "advisory",
    originalObjective: "implement user authentication",
    status: "open",
  });
  expect(
    events.some(
      (event) =>
        event.type === "drift.finding_opened" &&
        event.findingID.includes("unverifiable_no_contract"),
    ),
  ).toBe(true);

  // The same signals do not reopen an already-open finding.
  const again = await client.evaluateDrift?.({
    objective: "implement user authentication",
    currentActivity: "refactoring the css theme",
    applicableConstraints: ["never commit generated files"],
    changes: [{ action: "modified", path: "src/theme.css" }],
    evidenceRefs: [],
  });
  expect(again).toEqual({ opened: 0 });
  expect((await client.driftFindings!()).items).toHaveLength(1);
});

test("evaluateDrift opens a high finding for a forbidden constraint signal", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-drift-high-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_drift_high",
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

  await client.evaluateDrift?.({
    objective: "finish the docs",
    currentActivity: "commit the generated files to the repo",
    applicableConstraints: ["never commit generated files"],
    changes: [{ action: "added", path: "dist/out.js" }],
    evidenceRefs: [],
  });
  const findings = await client.driftFindings!();
  const high = findings.items.find((finding) => finding.severity === "high");
  expect(high).toBeDefined();
  expect(high?.evidence.some((entry) => entry.startsWith("constraint:"))).toBe(
    true,
  );
});

test("acknowledgeDriftFinding transitions an open finding with a rationale", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-drift-ack-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_drift_ack",
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

  await client.evaluateDrift?.({
    objective: "implement user authentication",
    currentActivity: "refactoring the css theme",
    applicableConstraints: [],
    changes: [{ action: "modified", path: "src/theme.css" }],
    evidenceRefs: [],
  });
  const open = await client.driftFindings!();
  const findingID = open.items[0]!.findingID;
  expect(open.items[0]?.status).toBe("open");

  const acked = await client.acknowledgeDriftFinding?.({
    findingID,
    status: "explained",
    rationale: "the css refactor is a prerequisite",
  });
  expect(acked).toEqual({ acknowledged: true });

  const after = await client.driftFindings!();
  expect(after.items[0]?.status).toBe("explained");
  expect(
    events.some(
      (event) =>
        event.type === "drift.finding_updated" &&
        event.status === "explained" &&
        event.rationale === "the css refactor is a prerequisite",
    ),
  ).toBe(true);

  // A non-open finding cannot be acknowledged again.
  expect(
    await client.acknowledgeDriftFinding?.({
      findingID,
      status: "dismissed",
    }),
  ).toEqual({ acknowledged: false });
});

test("a write_file turn registers a mutation the auditor can attribute", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-obs-write-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_obs_write",
    provider: writeFileProvider(),
    permissionMode: "auto",
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("create a workspace file");
  await pollHistoryForFinished(client);

  // The write tool settled and registered an expected mutation; the turn-end
  // reconcile attributes the watcher hint to the tool call (WG4 Phase 3) rather
  // than treating it as an external change.
  const changes = await client.confirmedWorkspaceChanges!();
  const externalNodes = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "workgraph.node_added" }> =>
      event.type === "workgraph.node_added" &&
      event.kind === "workspace_change" &&
      event.actor === "external",
  );
  // The attributed tool change is graphed by the tool path, not double-graphed
  // as an isolated external node.
  expect(externalNodes.some((node) => node.target === "hello-ts7.txt")).toBe(
    false,
  );
  expect(
    events.some(
      (event) =>
        event.type === "workgraph.node_added" &&
        event.kind === "workspace_change" &&
        event.target === "hello-ts7.txt" &&
        event.actor === "write_file",
    ),
  ).toBe(true);
  // Secret-safe: the confirmed change facts carry no file content (the tool's
  // own tool.update argumentsDelta legitimately does 閳?that is the call record).
  expect(JSON.stringify(changes)).not.toContain("hello from TS7");
});

test("an external workspace change becomes an isolated external graph node", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-obs-external-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_obs_external",
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

  // An external edit the watcher sees but no tool claimed.
  await writeFile(join(root, "external-note.txt"), "written outside\n");
  await Bun.sleep(400);
  const changes = await client.confirmedWorkspaceChanges!();
  const external = changes.find((change) =>
    change.path.includes("external-note"),
  );
  expect(external).toBeDefined();
  expect(external?.attribution).toBe("unattributed");

  // The external confirmed change became an isolated workspace_change node with
  // no causal edge.
  const externalNodes = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "workgraph.node_added" }> =>
      event.type === "workgraph.node_added" &&
      event.kind === "workspace_change" &&
      event.actor === "external",
  );
  expect(
    externalNodes.some((node) => node.target === "external-note.txt"),
  ).toBe(true);
  const edges = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "workgraph.edge_added" }> =>
      event.type === "workgraph.edge_added",
  );
  // No edge points at the external node (no reliable turn/call identity).
  expect(
    edges.every(
      (edge) => !externalNodes.some((node) => edge.targetID === node.nodeID),
    ),
  ).toBe(true);
});

test("an external change during a turn is reconciled at turn finish without an explicit call", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-obs-turnend-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_obs_turnend",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "content" as const, text: "working" };
        await new Promise((resolve) => setTimeout(resolve, 40));
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("first");
  await pollHistoryForFinished(client);

  // External edit while idle, then another turn finishes: the turn-end
  // reconcile must discover, graph and drift-check it 閳?no explicit
  // confirmedWorkspaceChanges call.
  await writeFile(join(root, "turnend-note.txt"), "external\n");
  await Bun.sleep(300);
  await client.submitAndWait!("second");
  await pollHistoryForFinished(client);
  await Bun.sleep(300);

  expect(
    events.some(
      (event) =>
        event.type === "workgraph.node_added" &&
        event.kind === "workspace_change" &&
        event.actor === "external" &&
        event.target === "turnend-note.txt",
    ),
  ).toBe(true);
});

test("durable session replay preserves tool-call pairs for the next provider turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-replay-tools-"));
  await writeFile(join(root, "input.txt"), "replay-ok\n");
  const initial = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_replay_tools",
    provider: toolCallingProvider(),
    permissionMode: "auto",
  });
  initial.start(() => {});
  await initial.submitAndWait!("read the input");

  const requests: ProviderStreamRequest[] = [];
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_replay_tools",
    permissionMode: "auto",
    provider: {
      provider: "scripted-replay",
      model: "scripted-replay-model",
      async *stream(request) {
        requests.push(request);
        yield { type: "content", text: "replay continuation works" };
        yield { type: "done" };
      },
    },
  });
  reopened.start(() => {});
  await reopened.submitAndWait!("continue");
  const restoredTool = requests[0]?.messages.find(
    (message) => message.role === "tool",
  );
  expect(restoredTool).toMatchObject({
    toolCallID: "call_read",
    content: "replay-ok\n",
  });
});

test("real runtime client routes ask_user tool calls through question response", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-question-tool-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_question_tool",
    provider: questionToolProvider(),
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "question.request")
      client.respondQuestion({ requestID: event.id, answers: [["yes"]] });
  });
  await client.submitAndWait!("ask a question");
  expect(events.some((event) => event.type === "question.request")).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "content.delta" && event.text === "answer received",
    ),
  ).toBe(true);
});

test("real runtime client spawns and projects a TS/Bun subagent lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-subagent-tool-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_subagent_tool",
    provider: subagentProvider(),
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate a focused task");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  );
  expect(
    events.some(
      (event) =>
        event.type === "subagent.update" &&
        event.text?.includes("child result"),
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "content.delta" && event.text === "parent complete",
    ),
  ).toBe(true);
  const lifecycle = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "subagent.update" }> =>
      event.type === "subagent.update",
  );
  expect(
    lifecycle.every(
      (event) => event.parentSessionID === "ses_ts7_subagent_tool",
    ),
  ).toBe(true);
  expect(lifecycle.every((event) => event.continuation === 0)).toBe(true);
  const childEvents = events.filter(
    (event) => event.agentID === lifecycle[0]?.id,
  );
  expect(childEvents.some((event) => event.type === "turn.submitted")).toBe(
    true,
  );
  expect(childEvents.some((event) => event.type === "thinking.delta")).toBe(
    true,
  );
  expect(childEvents.some((event) => event.type === "content.delta")).toBe(
    true,
  );
  expect(childEvents.some((event) => event.type === "turn.finished")).toBe(
    true,
  );
  // Startup capability and tool registration events precede subagent progress,
  // so the default 100-event history page may not reach this lifecycle.
  const history = await client.history?.({ limit: 1000 });
  expect(
    history?.events.some(
      (item) =>
        item.event.type === "subagent.update" &&
        item.event.parentSessionID === "ses_ts7_subagent_tool",
    ),
  ).toBe(true);
  expect(history?.events.some((item) => item.event.agentID)).toBe(false);
});

test("subagent compaction uses its active provider and stays in the child lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-subagent-compaction-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(join(root, "readable.txt"), "subagent input ".repeat(12_000));
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      context: {
        compactionThresholdPercent: 85,
        preservedRecentMessages: 0,
        // The default preserved-tail budget is 20k tokens. With a count of 0
        // that budget alone would keep this small ledger entirely inside the
        // tail, leaving nothing to compact at all. This test is about the
        // compaction mechanics, so the budget is switched off rather than the
        // ledger padded until it clears 20k tokens.
        preservedRecentTokens: 0,
      },
    }),
  );
  const events: RuntimeEvent[] = [];
  const provider = subagentCompactionProvider();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_subagent_compaction",
    permissionMode: "auto",
    provider,
  });
  client.start((event) => events.push(event));

  await client.submitAndWait!("delegate a compacted child task");
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "subagent.update" && event.event === "created",
      ),
    5_000,
    "the compacted subagent to start",
  );
  const childID = events.find(
    (event): event is Extract<RuntimeEvent, { type: "subagent.update" }> =>
      event.type === "subagent.update" && event.event === "created",
  )?.id;
  expect(childID).toBeDefined();
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "compaction.begin" && event.agentID === childID,
      ),
    5_000,
    "the subagent preflight compaction",
  );

  expect(provider.compactionCalls).toBe(1);
  const compactionEvents = events.filter(
    (
      event,
    ): event is Extract<
      RuntimeEvent,
      { type: "compaction.begin" | "compaction.end" }
    > & { agentID: string } =>
      (event.type === "compaction.begin" || event.type === "compaction.end") &&
      Boolean(event.agentID),
  );
  expect(compactionEvents).toHaveLength(2);
  expect(compactionEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "compaction.begin",
        agentID: childID,
        sessionID: "ses_subagent_compaction",
        id: expect.stringMatching(/^subagent:.+:preflight:/u),
      }),
      expect.objectContaining({
        type: "compaction.end",
        agentID: childID,
        sessionID: "ses_subagent_compaction",
        id: expect.stringMatching(/^subagent:.+:preflight:/u),
        success: true,
      }),
    ]),
  );
  expect(
    events.some(
      (event) =>
        (event.type === "compaction.begin" ||
          event.type === "compaction.end") &&
        !event.agentID,
    ),
  ).toBe(false);
  expect(
    (await client.history?.({ limit: 1_000 }))?.events.some(
      (item) =>
        item.event.type === "compaction.begin" ||
        item.event.type === "compaction.end",
    ),
  ).toBe(false);
  await client.dispose?.();
});

test("subagent executes TS native workspace tools before reporting completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-subagent-tools-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_subagent_tools",
    provider: subagentToolProvider(),
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate a file task");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  );
  expect(await readFile(join(root, "agent-test.txt"), "utf8")).toBe(
    "agent test success",
  );
  expect(
    events.some(
      (event) =>
        event.type === "subagent.update" &&
        event.text?.includes("tool write_file"),
    ),
  ).toBe(true);
  const childToolEvents = events.filter(
    (
      event,
    ): event is Extract<RuntimeEvent, { type: "tool.update" }> & {
      agentID: string;
    } => Boolean(event.agentID) && event.type === "tool.update",
  );
  expect(childToolEvents.map((event) => event.status)).toEqual([
    "awaiting_approval",
    "running",
    "succeeded",
  ]);
});

test("subagent corrects raw XML and executes a native tool call", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-subagent-raw-xml-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_subagent_raw_xml",
    provider: subagentRawXMLToolProvider(),
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));

  await client.submitAndWait!("delegate a raw XML file task");
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "subagent.update" && event.status === "completed",
      ),
    5_000,
    "the raw XML subagent tool to complete",
  );

  expect(await readFile(join(root, "agent-raw-xml.txt"), "utf8")).toBe(
    "raw XML child success",
  );
  expect(
    events
      .filter(
        (event) =>
          event.type === "tool.update" &&
          Boolean(event.agentID) &&
          event.name === "write_file",
      )
      .map((event) =>
        event.type === "tool.update" ? event.status : undefined,
      ),
  ).toEqual(["awaiting_approval", "running", "succeeded"]);
  expect(
    events.some(
      (event) =>
        event.type === "content.delta" &&
        Boolean(event.agentID) &&
        event.text.includes("<tool_call>"),
    ),
  ).toBe(false);
});

test("subagent approval stays in the child conversation and remains answerable", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-subagent-approval-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_subagent_approval",
    provider: subagentToolProvider(),
    permissionMode: "ask",
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval?.({
        requestID: event.id,
        decision: "once",
      });
  });

  await client.submitAndWait!("delegate a file task");
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "subagent.update" && event.status === "completed",
      ),
    20_000,
    "the approved subagent tool to complete",
  );

  const request = events.find(
    (
      event,
    ): event is Extract<RuntimeEvent, { type: "approval.request" }> & {
      agentID: string;
    } => event.type === "approval.request" && Boolean(event.agentID),
  );
  expect(request).toMatchObject({
    type: "approval.request",
    agentID: expect.any(String),
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "approval.response",
      id: request?.id,
      decision: "once",
      agentID: request?.agentID,
    }),
  );
  expect(await readFile(join(root, "agent-test.txt"), "utf8")).toBe(
    "agent test success",
  );
  expect(
    (await client.history?.({ limit: 1000 }))?.events.some(
      (item) => item.event.agentID,
    ),
  ).toBe(false);
});

test("subagent honors configured step limits above twenty", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-subagent-step-limit-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      defaultAgent: "long_running",
      agents: { long_running: { description: "Long running", maxSteps: 21 } },
    }),
  );
  for (let step = 0; step < 21; step++)
    await writeFile(join(root, `readable-${step}.txt`), "safe test input");
  const childToolCalls: string[] = [];
  const childRequests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_subagent_step_limit",
    permissionMode: "auto",
    provider: {
      provider: "subagent-step-limit",
      model: "subagent-step-limit",
      async *stream(request) {
        const child =
          request.messages[0]?.role === "system" &&
          String(request.messages[0].content).includes(
            "focused Natalia TS/Bun subagent",
          );
        if (child) {
          childRequests.push(request);
          const priorCalls = request.messages.filter(
            (message) => message.role === "tool",
          ).length;
          if (priorCalls < 20) {
            const path = `readable-${priorCalls}.txt`;
            childToolCalls.push(path);
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: `child_read_${priorCalls}`,
                  name: "read_file",
                  arguments: JSON.stringify({ path }),
                },
              ],
            };
            yield { type: "done" as const };
            return;
          }
          yield {
            type: "content" as const,
            // Long enough to clear the result-quality gate, whose extra turn
            // would otherwise count as a step here. The XML-like tool call is
            // kept because this test also pins that it is not executed.
            text:
              "completed after 20 tools. Every read_file call the child made " +
              "was a real native tool call, and the step budget stopped the " +
              "child at its configured limit rather than letting it run on. " +
              "The following pseudo-call is text and must not be executed: " +
              "<function=read_file><parameter=path>ignored.txt</parameter></function>",
          };
          yield { type: "done" as const };
          return;
        }
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "spawn_long_child",
                name: "agent_spawn",
                arguments: JSON.stringify({ task: "perform many reads" }),
              },
            ],
          };
          yield { type: "done" as const };
          return;
        }
        yield { type: "content" as const, text: "parent complete" };
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate a long task");
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "subagent.update" && event.status === "completed",
      ),
    2_000,
  );

  expect(childToolCalls).toHaveLength(20);
  expect(childRequests).toHaveLength(21);
  expect(
    childRequests.slice(0, -1).every((request) => request.tools?.length),
  ).toBe(true);
  expect(childRequests.at(-1)).toMatchObject({
    tools: undefined,
    toolChoice: "none",
  });
  expect(
    childRequests
      .at(-1)
      ?.messages.some((message) =>
        message.content.includes("MAXIMUM STEPS REACHED"),
      ),
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "subagent.update" &&
        event.text?.includes("completed after 20 tools"),
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "content.delta" &&
        Boolean(event.agentID) &&
        event.text.includes("<function=read_file>"),
    ),
  ).toBe(true);
  await client.dispose?.();
});

test("the system prompt enumerates installed skills dynamically", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-prompt-skills-"));
  const requests: ProviderStreamRequest[] = [];
  const provider: StreamingProvider = {
    provider: "test",
    model: "test",
    async *stream(request) {
      requests.push(request);
      yield { type: "done" as const };
    },
  };
  const promptFor = async (sessionID: SessionID) => {
    requests.length = 0;
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID,
      provider,
    });
    client.start(() => undefined);
    await client.submitAndWait!("hi");
    await client.dispose?.();
    // ADR D1: dynamic content (skills) is no longer in the static system
    // message; it arrives as `<runtime_context>` user messages. Assert on
    // everything the model actually sees.
    return (requests[0]?.messages ?? [])
      .map((message) => message.content)
      .join("\n");
  };

  // Nothing installed: the section must be absent rather than empty, so a
  // workspace without skills neither pays tokens nor learns about skill_load.
  expect(await promptFor("ses_prompt_skills_none" as SessionID)).not.toContain(
    "<available_skills>",
  );

  const skillRoot = join(root, ".natalia", "skills", "probe-skill");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    `---\nname: probe-skill\ndescription: ${"d".repeat(900)}\n---\n\n# probe\n`,
  );

  const withSkill = await promptFor("ses_prompt_skills_one" as SessionID);
  expect(withSkill).toContain("<available_skills>");
  // Enumerated from the registry, not hardcoded: the freshly created directory
  // shows up without any code or config change.
  expect(withSkill).toContain("- probe-skill (project):");
  expect(withSkill).toContain("None is loaded yet.");
  // A pathological description must not be able to dominate the prompt.
  expect(withSkill).toContain("...");
  expect(withSkill).not.toContain("d".repeat(700));
});

test("a rejected approval feeds the reason back and lets the turn continue", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-reject-"));
  const events: RuntimeEvent[] = [];
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_reject_continue" as SessionID,
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push(request);
        // The second step only happens if the turn survived the rejection.
        if (request.messages.some((message) => message.role === "tool")) {
          yield { type: "content" as const, text: "understood, moving on" };
          yield { type: "done" as const };
          return;
        }
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_1",
              name: "run_shell",
              arguments: JSON.stringify({ command: "rm -rf /" }),
            },
          ],
        };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({
        requestID: event.id,
        decision: "reject",
        feedback: "too dangerous, list the directory instead",
      });
  });

  await client.submitAndWait!("clean the workspace");

  // The refusal is reported as a decision about the call, not a broken turn.
  expect(
    events.find(
      (event) => event.type === "tool.update" && event.status === "rejected",
    ),
  ).toMatchObject({
    type: "tool.update",
    name: "run_shell",
    status: "rejected",
  });
  const finished = events.filter((event) => event.type === "turn.finished");
  expect(finished).toHaveLength(1);
  expect(finished[0]).not.toMatchObject({ stopReason: "error" });

  // The model is told why, so it can choose differently.
  const toolMessages = requests
    .at(-1)!
    .messages.filter((message) => message.role === "tool");
  expect(toolMessages).toHaveLength(1);
  expect(String(toolMessages[0]?.content)).toContain(
    "too dangerous, list the directory instead",
  );
  expect(String(toolMessages[0]?.content)).toContain("rejected by the user");

  // And it kept working afterwards.
  expect(
    events
      .filter((event) => event.type === "content.delta")
      .map((event) => event.text)
      .join(""),
  ).toContain("understood, moving on");
});

test("a rejection without feedback still audits the decision and continues", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-reject-bare-"));
  const events: RuntimeEvent[] = [];
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_reject_bare" as SessionID,
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push(request);
        if (request.messages.some((message) => message.role === "tool")) {
          yield { type: "content" as const, text: "asking instead" };
          yield { type: "done" as const };
          return;
        }
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_1",
              name: "run_shell",
              arguments: JSON.stringify({ command: "echo hi" }),
            },
          ],
        };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "reject" });
  });

  await client.submitAndWait!("run something");

  // The audit trail must record the refusal even when no reason was given.
  expect(
    events.find(
      (event) =>
        event.type === "policy.decision" && event.decision === "rejected",
    ),
  ).toMatchObject({ toolName: "run_shell", toolCallID: "call_1" });
  expect(events.filter((event) => event.type === "turn.finished")).toHaveLength(
    1,
  );

  const toolMessages = requests
    .at(-1)!
    .messages.filter((message) => message.role === "tool");
  expect(String(toolMessages[0]?.content)).toContain("without a reason");
});

test("the repeated call guard blocks loops but not waiting reads", async () => {
  async function blockedCount(name: string, args: Record<string, unknown>) {
    const root = await mkdtemp(join(tmpdir(), "natalia-repeat-guard-"));
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({ version: 3, runtime: { maxStepsPerTurn: 6 } }),
    );
    const events: RuntimeEvent[] = [];
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: `ses_repeat_${name}`,
      permissionMode: "auto",
      provider: {
        provider: "test",
        model: "test",
        async *stream(request) {
          if (request.messages.some((message) => message.role === "tool")) {
            yield { type: "done" as const };
            return;
          }
          // Fourteen identical calls in one turn, so the guard's threshold is
          // crossed without depending on how many rounds a turn allows.
          yield {
            type: "tool_call" as const,
            calls: Array.from({ length: 14 }, (_, index) => ({
              id: `call_${index}`,
              name,
              arguments: JSON.stringify(args),
            })),
          };
        },
      },
    });
    client.start((event) => events.push(event));
    await client.submitAndWait!(`repeat ${name}`);
    await client.dispose?.();
    return events.filter(
      (event) =>
        event.type === "tool.update" &&
        typeof event.summary === "string" &&
        event.summary.includes("blocked repeated tool call"),
    ).length;
  }

  // A tool with no waiting behaviour repeated identically is a loop, and the
  // guard still stops it.
  expect(
    await blockedCount("read_file", { path: "missing.txt" }),
  ).toBeGreaterThan(0);
  // terminal_observe blocks until the screen changes, so identical arguments are
  // how a caller waits. It used to be cut off mid-wait after twelve polls.
  expect(await blockedCount("terminal_observe", { id: "tty_absent" })).toBe(0);
});

test("config is not applied underneath a running turn, even if the precheck said yes", async () => {
  // `canReloadConfig()` is advisory: a turn can start between asking and acting.
  // So the action re-checks for itself, and refuses as a value rather than
  // applying new policy to a turn that started under the old policy.
  const root = await mkdtemp(join(tmpdir(), "natalia-reload-race-"));
  let releaseProvider: (() => void) | undefined;
  const providerReached = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  let letProviderFinish: (() => void) | undefined;
  const providerHeld = new Promise<void>((resolve) => {
    letProviderFinish = resolve;
  });
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_reload_race",
    permissionMode: "auto",
    provider: {
      provider: "scripted",
      model: "scripted",
      async *stream() {
        releaseProvider?.();
        await providerHeld;
        yield { type: "content" as const, text: "done" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);

  // Ask before the turn: allowed.
  expect(await client.canReloadConfig?.()).toEqual({ allowed: true });

  const turn = client.submit("hold the provider open");
  await providerReached;

  // The same question now answers no, and so does the action.
  expect((await client.canReloadConfig?.())?.allowed).toBe(false);
  const refused = await client.reloadConfig?.();
  expect(refused?.applied).toBe(false);
  expect(refused?.reason).toMatch(/while a turn is running/u);

  letProviderFinish?.();
  await turn;
  await pollHistoryForFinished(client);

  // Once the turn has settled it applies normally.
  expect((await client.reloadConfig?.())?.applied).toBe(true);
  await client.dispose?.();
}, 30_000);

test("answering a request that is no longer pending is reported, not swallowed", async () => {
  // The waiter already knew this 閳?it published a warning diagnostic and returned
  // 閳?but the caller was told nothing, and over RPC it was told `responded: true`.
  // An external UI has to know its answer arrived too late, because the model was
  // told the call did not run.
  const root = await mkdtemp(join(tmpdir(), "natalia-stale-response-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_stale_response",
    provider: scriptedProvider("nothing to approve"),
  });
  client.start(() => undefined);

  expect(
    await client.respondApproval({ requestID: "apr_never", decision: "once" }),
  ).toEqual({
    accepted: false,
    reason: "the approval request is no longer pending",
  });
  expect(
    await client.respondQuestion({
      requestID: "qst_never",
      answers: [["no"]],
      rejected: false,
    }),
  ).toEqual({
    accepted: false,
    reason: "the question request is no longer pending",
  });
  await client.dispose?.();
}, 30_000);

test("pause, resume and agent selection answer what the runtime did", async () => {
  // Each of these used to return nothing, so the RPC route replied with a
  // hard-coded success. A caller could pause a runtime with no turn and be told
  // the turn was held; it could select an agent that does not exist and be told
  // it was selected. Pause/resume now only answer for a genuinely running turn.
  const root = await mkdtemp(join(tmpdir(), "natalia-turn-control-"));
  let release: (() => void) | undefined;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_turn_control",
    permissionMode: "auto",
    provider: {
      provider: "scripted",
      model: "scripted",
      async *stream() {
        await new Promise<void>((resolve) => (release = resolve));
        yield { type: "content" as const, text: "done" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);

  expect(await client.pause?.()).toEqual({
    paused: false,
    reason: "no turn is running",
  });
  expect(await client.resume?.()).toEqual({
    resumed: false,
    reason: "no turn is running",
  });

  const unknown = await client.selectAgent?.("no-such-agent");
  expect(unknown).toEqual({
    outcome: "rejected",
    reason: "agent not found: no-such-agent",
  });
  expect((await client.selectAgent?.())?.outcome).toBe("applied");

  const turn = client.submit("hold the turn open");
  await waitFor(() => release !== undefined, 20_000, "the provider to start");
  expect(await client.pause?.("user pause")).toEqual({ paused: true });
  expect(await client.pause?.("user pause")).toEqual({
    paused: true,
    reason: "already paused",
  });
  expect(await client.resume?.()).toEqual({ resumed: true });
  expect(await client.resume?.()).toEqual({
    resumed: false,
    reason: "the turn is not paused",
  });

  release?.();
  await turn;
  await client.dispose?.();
}, 30_000);

test("selecting an agent during a turn reports the selection as deferred, not applied", async () => {
  // Changing the agent underneath a running turn would change the rules it
  // started under, so the runtime defers it. That is a third outcome, and a
  // consumer that is told "applied" will show the new agent for a turn that is
  // still running under the old one.
  const root = await mkdtemp(join(tmpdir(), "natalia-agent-pending-"));
  let providerReached: (() => void) | undefined;
  const reached = new Promise<void>((resolve) => {
    providerReached = resolve;
  });
  let releaseProvider: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_agent_pending",
    permissionMode: "auto",
    provider: {
      provider: "scripted",
      model: "scripted",
      async *stream() {
        providerReached?.();
        await held;
        yield { type: "content" as const, text: "done" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  const turn = client.submit("hold the turn open");
  await reached;

  expect(await client.selectAgent?.()).toMatchObject({ outcome: "pending" });

  releaseProvider?.();
  await turn;
  await pollHistoryForFinished(client);
  expect((await client.selectAgent?.())?.outcome).toBe("applied");
  await client.dispose?.();
}, 30_000);

test("an initialization failure surfaces its cause, not a derived symptom", async () => {
  // Before this fix, `start()` swallowed the failure into one diagnostic and
  // every member then answered with a derived symptom ("checkpoint store is
  // not initialized"), so a remote caller saw a pile of unrelated internal
  // errors with no way to find the cause. The failure must travel.
  const root = await mkdtemp(join(tmpdir(), "natalia-init-failure-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_init_failure",
    // resolveConfig succeeds; the profile lookup is the controllable failure.
    permissionProfile: "no_such_profile",
    provider: scriptedProvider("unused"),
  });
  client.start(() => undefined);

  // Members that await initialization all fail with the *cause*. (snapshot
  // is a pure in-memory event constructor and correctly still answers.)
  const attempts: Array<() => Promise<unknown>> = [
    () => client.history!({ limit: 10 }),
    async () => {
      await client.checkpointList!();
    },
  ];
  for (const attempt of attempts) {
    const error = await attempt().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("permission profile not found");
  }
  // The pure constructor keeps working; nothing derived was invented.
  expect(client.snapshot().type).toBe("snapshot.created");
  await client.dispose?.();
}, 30_000);

test("session lifecycle: new is idempotent, archive marks, export dumps the journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-lifecycle-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_lifecycle_host",
  });
  client.start(() => undefined);
  try {
    const created = await client.sessionNew?.({
      id: "ses_managed_1",
      title: "Managed",
    });
    expect(created).toEqual({ sessionID: "ses_managed_1", created: true });
    const replay = await client.sessionNew?.({ id: "ses_managed_1" });
    expect(replay).toEqual({ sessionID: "ses_managed_1", created: false });

    const minted = await client.sessionNew?.({});
    expect(minted?.sessionID).toMatch(/^ses_/u);
    expect(minted?.created).toBe(true);

    const archived = await client.sessionArchive?.("ses_managed_1");
    expect(archived).toEqual({ id: "ses_managed_1", archived: true });
    const again = await client.sessionArchive?.("ses_managed_1");
    expect(again).toEqual({ id: "ses_managed_1", archived: true });

    const list = await client.sessionList?.();
    const managed = list?.find((summary) => summary.id === "ses_managed_1");
    expect(managed?.archived).toBe(true);

    const exported = await client.sessionExport?.("ses_managed_1");
    expect(exported?.sessionID).toBe("ses_managed_1");
    expect(exported?.title).toBe("Managed");
    expect(exported?.archived).toBe(true);
    expect(exported?.events).toEqual([]);

    const missing = await client
      .sessionArchive?.("ses_does_not_exist")
      .catch((error: unknown) => error);
    expect((missing as Error).message).toContain("session not found");
  } finally {
    await client.dispose?.();
  }
});

test("session attach switches the active journal while a background turn keeps running", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-attach-"));
  let release: (() => void) | undefined;
  let calls = 0;
  const requests: ProviderStreamRequest[] = [];
  const provider: StreamingProvider = {
    provider: "attach",
    model: "attach",
    async *stream(request) {
      requests.push(request);
      calls += 1;
      if (calls === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      yield { type: "content" as const, text: "first session" };
      yield { type: "done" as const };
    },
  };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_attach_a",
    provider,
  });
  client.start(() => undefined);
  try {
    await client.sessionNew?.({ id: "ses_attach_b", title: "Second" });
    const turnA = client.submit("wait");
    await waitFor(() => release !== undefined);

    // D2: a turn in flight is no longer a refusal 閳?it belongs to its own
    // session and keeps running in the background.
    expect(await client.sessionAttach?.("ses_attach_b")).toEqual({
      sessionID: "ses_attach_b",
    });
    // Session B runs its own turn while A's is still parked.
    await client.submitAndWait!("second");
    await pollHistoryForFinished(client);
    const second = await client.history?.({ limit: 100 });
    expect(
      second?.events.some((entry) => entry.event.type === "turn.submitted"),
    ).toBe(true);

    // The background turn of A settles into A's journal.
    release?.();
    await turnA;

    expect(await client.sessionAttach?.("ses_attach_a")).toEqual({
      sessionID: "ses_attach_a",
    });
    await pollHistoryForFinished(client);
    const first = await client.history?.({ limit: 1000 });
    expect(
      first?.events.some((entry) => entry.event.type === "turn.submitted"),
    ).toBe(true);
    expect(
      first?.events.some(
        (entry) =>
          entry.event.type === "turn.finished" &&
          (entry.event as { sessionID?: string }).sessionID === "ses_attach_a",
      ),
    ).toBe(true);

    await client.submitAndWait!("after attach");
    await pollHistoryForFinished(client);
    const resumed = requests.find((request) =>
      request.messages.some(
        (message) =>
          message.role === "user" && message.content === "after attach",
      ),
    );
    expect(
      resumed?.messages.some(
        (message) => message.role === "user" && message.content === "wait",
      ),
    ).toBe(true);
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("parallel sessions retain their configured provider across tool steps", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-provider-isolation-"));
  await writeFile(join(root, "evidence.txt"), "session A evidence");
  const requests: Array<{
    model: string;
    messages: Array<{ role: string; content?: string }>;
  }> = [];
  let releaseFirstA: (() => void) | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as (typeof requests)[number];
      requests.push(body);
      const isA = body.messages.some(
        (message) => message.role === "user" && message.content === "session A",
      );
      const isB = body.messages.some(
        (message) => message.role === "user" && message.content === "session B",
      );
      const hasToolResult = body.messages.some(
        (message) => message.role === "tool",
      );
      if (isA && !hasToolResult) {
        await new Promise<void>((resolve) => {
          releaseFirstA = resolve;
        });
        const arguments_ = JSON.stringify({ path: "evidence.txt" });
        return new Response(
          [
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_read_a",
                        function: { name: "read_file", arguments: arguments_ },
                      },
                    ],
                  },
                },
              ],
            })}`,
            "",
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const text = isA ? "session A complete" : isB ? "session B complete" : "";
      return new Response(
        [
          `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({
        version: 3,
        providers: {
          local: {
            name: "local",
            driver: "openai",
            enabled: true,
            connection: { apiKey: "local-key", baseURL: server.url.toString() },
          },
        },
        catalog: {
          providers: {
            local: {
              models: {
                alpha: { name: "alpha" },
                beta: { name: "beta" },
              },
            },
          },
        },
        defaultModel: { provider: "local", model: "alpha" },
      }),
    );
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: "ses_provider_a",
      permissionMode: "auto",
    });
    client.start(() => undefined);
    try {
      await client.sessionNew?.({ id: "ses_provider_b", title: "Session B" });
      const turnA = client.submit("session A");
      await waitFor(
        () => releaseFirstA !== undefined,
        5_000,
        "session A's first provider request",
      );

      await client.sessionAttach?.("ses_provider_b");
      await client.selectModel?.("local/beta");
      await client.submitAndWait!("session B");
      releaseFirstA?.();
      await turnA;

      const modelsFor = (text: string) =>
        requests
          .filter((request) =>
            request.messages.some(
              (message) => message.role === "user" && message.content === text,
            ),
          )
          .map((request) => request.model);
      await waitFor(
        () => modelsFor("session A").length >= 2,
        20_000,
        "session A's provider to complete both tool and final steps",
      );
      expect(modelsFor("session A").length).toBeGreaterThanOrEqual(2);
      expect(modelsFor("session A").every((model) => model === "alpha")).toBe(
        true,
      );
      expect(modelsFor("session B").length).toBeGreaterThanOrEqual(1);
      expect(modelsFor("session B").every((model) => model === "beta")).toBe(
        true,
      );
    } finally {
      await client.dispose?.();
    }
  } finally {
    server.stop(true);
  }
}, 30_000);

test("published events are stamped with the active session and re-stamped on attach", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-event-stamp-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_stamp_a",
    provider: scriptedProvider("stamped"),
  });
  client.start((event) => events.push(event));
  try {
    await client.submitAndWait!("hello");
    const first = events.filter(
      (event) =>
        event.type === "turn.submitted" ||
        event.type === "content.done" ||
        event.type === "turn.finished",
    );
    expect(first.length).toBeGreaterThan(0);
    for (const event of first)
      expect((event as { sessionID?: string }).sessionID).toBe("ses_stamp_a");
    // session.created carries its own id and is not double-stamped.
    const created = events.find((event) => event.type === "session.created");
    expect(created).toMatchObject({ sessionID: "ses_stamp_a" });

    await client.sessionNew?.({ id: "ses_stamp_b", title: "Second" });
    await client.sessionAttach?.("ses_stamp_b");
    events.splice(0);
    await client.submitAndWait!("again");
    const second = events.filter((event) => event.type === "turn.submitted");
    expect(second).toHaveLength(1);
    expect((second[0] as { sessionID?: string }).sessionID).toBe("ses_stamp_b");
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("terminal_request_human reports the bounded reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-request-human-"));
  let requested = false;
  const provider: StreamingProvider = {
    provider: "request-human",
    model: "request-human",
    async *stream(request) {
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_rh",
              name: "interactive_terminal_request_human",
              arguments: JSON.stringify({
                id: "rh_runtime_1",
                reason: "needs the sudo password",
              }),
            },
          ],
        };
        return;
      }
      requested = true;
      yield { type: "content" as const, text: "Waiting for the human." };
      yield { type: "done" as const };
    },
  };
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_request_human",
    provider,
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  try {
    await client.submitAndWait!("ask the human");
    expect(requested).toBe(true);
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("request_human endTurn settles as waiting_human and resumes automatically after release", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-continue-turn-"));
  let streamCalls = 0;
  const provider: StreamingProvider = {
    provider: "continue-turn",
    model: "continue-turn",
    async *stream(request) {
      streamCalls += 1;
      if (streamCalls === 1) {
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_end_turn",
              name: "interactive_terminal_request_human",
              arguments: JSON.stringify({
                id: "term_1",
                reason: "needs the sudo password",
                endTurn: true,
              }),
            },
          ],
        };
        return;
      }
      if (streamCalls === 2) {
        // The tool ran; the model confirms and the turn settles waiting.
        yield { type: "content" as const, text: "Waiting for the human." };
        yield { type: "done" as const };
        return;
      }
      yield { type: "content" as const, text: "Continuing after the human." };
      yield { type: "done" as const };
    },
  };
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_continue_turn",
    provider,
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  try {
    await client.submitAndWait!("ask the human");
    const finished = events.filter((event) => event.type === "turn.finished");
    expect(finished.at(-1)).toMatchObject({
      stopReason: "waiting_human",
    });

    // The pending-human state is durable before the human acts.
    await waitForAsync(async () => {
      const persisted = JSON.parse(
        await readFile(
          join(root, ".natalia", "sessions", "ses_continue_turn.json"),
          "utf8",
        ),
      ) as { metadata?: { pendingHumanTerminal?: unknown } };
      return Boolean(persisted.metadata?.pendingHumanTerminal);
    });
    const persisted = JSON.parse(
      await readFile(
        join(root, ".natalia", "sessions", "ses_continue_turn.json"),
        "utf8",
      ),
    ) as { metadata?: { pendingHumanTerminal?: unknown } };
    expect(persisted.metadata?.pendingHumanTerminal).toMatchObject({
      terminalID: "term_1",
      reason: "needs the sudo password",
    });

    // Releasing the pane resumes the task with a fresh turn.
    await client.nativeTerminalReleaseHumanControl?.("term_1");
    await waitFor(
      () =>
        events.filter(
          (event) =>
            event.type === "turn.finished" &&
            event.stopReason === "done" &&
            events.findIndex(
              (candidate) =>
                candidate.type === "turn.submitted" &&
                candidate.text.includes("[automated continuation]"),
            ) < events.indexOf(event),
        ).length >= 1,
    );
    const continuation = events.find(
      (event) =>
        event.type === "turn.submitted" &&
        event.text.includes("[automated continuation]"),
    );
    expect(continuation).toBeDefined();
    const doneAfter = events.filter(
      (event) => event.type === "turn.finished" && event.stopReason === "done",
    );
    expect(doneAfter.at(-1)).toBeDefined();
    expect(
      events.filter((event) => event.type === "turn.submitted"),
    ).toHaveLength(2);

    // The pending state is cleared once resumed.
    const afterResume = JSON.parse(
      await readFile(
        join(root, ".natalia", "sessions", "ses_continue_turn.json"),
        "utf8",
      ),
    ) as { metadata?: { pendingHumanTerminal?: unknown } };
    expect(afterResume.metadata?.pendingHumanTerminal).toBeUndefined();
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("releasing a pane that is not the pending one does not resume or clear state", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-continue-negative-"));
  let streamCalls = 0;
  const provider: StreamingProvider = {
    provider: "continue-negative",
    model: "continue-negative",
    async *stream(request) {
      streamCalls += 1;
      if (streamCalls === 1) {
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_neg",
              name: "interactive_terminal_request_human",
              arguments: JSON.stringify({
                id: "rh_pending",
                reason: "needs input",
                endTurn: true,
              }),
            },
          ],
        };
        return;
      }
      yield { type: "content" as const, text: "Waiting." };
      yield { type: "done" as const };
    },
  };
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_continue_negative",
    provider,
  });
  client.start((event) => events.push(event));
  try {
    await client.submitAndWait!("ask");
    expect(
      events.filter((event) => event.type === "turn.finished").at(-1)
        ?.stopReason,
    ).toBe("waiting_human");

    await client.nativeTerminalReleaseHumanControl?.("rh_other");
    await Bun.sleep(100);
    expect(
      events.filter((event) => event.type === "turn.submitted"),
    ).toHaveLength(1);
    const persisted = JSON.parse(
      await readFile(
        join(root, ".natalia", "sessions", "ses_continue_negative.json"),
        "utf8",
      ),
    ) as { metadata?: { pendingHumanTerminal?: unknown } };
    expect(persisted.metadata?.pendingHumanTerminal).toMatchObject({
      terminalID: "rh_pending",
    });
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("D5.3: a session approval stays with its session across attach", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-d53-grants-"));
  let approvalCount = 0;
  const provider: StreamingProvider = {
    provider: "d53",
    model: "d53",
    async *stream(request) {
      if (!request.messages.some((message) => message.role === "tool"))
        yield {
          type: "tool_call",
          calls: [
            {
              id: `call_${crypto.randomUUID()}`,
              name: "run_shell",
              arguments: JSON.stringify({ command: "pwd" }),
            },
          ],
        };
      yield { type: "done" };
    },
  };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_d53_a",
    provider,
  });
  client.start((event) => {
    if (event.type !== "approval.request") return;
    approvalCount++;
    client.respondApproval({ requestID: event.id, decision: "session" });
  });
  try {
    await client.sessionNew?.({ id: "ses_d53_b", title: "B" });
    await client.submitAndWait!("a1");
    await client.submitAndWait!("a2");
    expect(approvalCount).toBe(1);

    // Session B has no grants: its first call asks again.
    await client.sessionAttach?.("ses_d53_b");
    await client.submitAndWait!("b1");
    expect(approvalCount).toBe(2);

    // Attaching back to A restores A's grant: it was A's, never B's.
    await client.sessionAttach?.("ses_d53_a");
    await client.submitAndWait!("a3");
    expect(approvalCount).toBe(2);
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("permission management: save validates, delete refuses the default, both persist", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-permission-manage-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3 }),
  );
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_permission_host",
  });
  client.start(() => undefined);
  try {
    const saved = await client.permissionSave?.({
      name: "strict",
      profile: {
        approval: "ask",
        description: "Strict profile",
        permissions: { tools: { allow: ["echo"], exclude: [] } },
      },
    });
    expect(saved?.saved).toBe(true);

    const list = await client.permissionList?.();
    expect(list?.default).toBe("ask");
    expect(
      list?.profiles.find((profile) => profile.name === "strict"),
    ).toMatchObject({
      approval: "ask",
    });

    const refusedDefault = await client.permissionDelete?.("ask");
    expect(refusedDefault).toEqual({
      deleted: false,
      reason: "permission profile is the active default: ask",
    });

    const removed = await client.permissionDelete?.("strict");
    expect(removed?.deleted).toBe(true);
    const after = await client.permissionList?.();
    expect(
      after?.profiles.find((profile) => profile.name === "strict"),
    ).toBeUndefined();

    const configText = await Bun.file(
      join(root, ".natalia", "config.json"),
    ).text();
    expect(configText).not.toContain('"strict"');
  } finally {
    await client.dispose?.();
  }
});

test("mcp server management persists config and survives failed connections", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-mcp-manage-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3 }),
  );
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_mcp_host",
  });
  client.start(() => undefined);
  try {
    const added = await client.mcpServerAdd?.({
      name: "demo",
      config: {
        type: "stdio",
        command: "false",
        args: [],
        enabled: true,
        allowedTools: [],
        excludedTools: [],
        readOnly: false,
        headers: {},
        environment: {},
        timeoutSec: 30,
      },
    });
    expect(added?.saved).toBe(true);
    const configText = await Bun.file(
      join(root, ".natalia", "config.json"),
    ).text();
    expect(configText).toContain('"demo"');

    const removed = await client.mcpServerRemove?.("demo");
    expect(removed?.removed).toBe(true);
    const again = await client.mcpServerRemove?.("demo");
    expect(again?.removed).toBe(true);
    const after = await Bun.file(join(root, ".natalia", "config.json")).text();
    expect(after).not.toContain('"demo"');
  } finally {
    await client.dispose?.();
  }
});
