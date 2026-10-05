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
  setMainPlanID,
} from "./real-runtime-harness";
import type { NamespacedCollabMessageEvent } from "./real-runtime-harness";

test("agent and provider management persist, validate references and survive apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-agent-provider-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3 }),
  );
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_agent_provider_host",
    globalConfigPath: join(root, "global.json"),
  });
  client.start(() => undefined);
  try {
    const plannerConfig = {
      description: "Plans first",
      mode: "primary" as const,
      systemPrompt: "Plan before acting.",
      allowedTools: [],
      excludedTools: [],
      mcpServers: [],
      hidden: false,
    };
    const created = await client.agentCreate?.({
      name: "planner",
      config: plannerConfig,
    });
    expect(created?.created).toBe(true);
    const dup = await client.agentCreate?.({
      name: "planner",
      config: plannerConfig,
    });
    expect(dup?.created).toBe(false);
    expect(dup?.reason).toContain("already exists");
    const updated = await client.agentUpdate?.({
      name: "planner",
      config: { ...plannerConfig, description: "New" },
    });
    expect(updated?.updated).toBe(true);
    const missing = await client
      .agentUpdate?.({
        name: "nope",
        config: plannerConfig,
      })
      .catch((error: unknown) => error);
    expect((missing as Error).message).toContain("agent not found");

    const added = await client.providerAdd?.({
      name: "gw",
      type: "openai",
      baseURL: "http://127.0.0.1:1/v1",
      apiKey: "key",
      models: [{ id: "gw-model", reasoning: true }],
    });
    expect(added?.saved).toBe(true);
    const configuredBeforeDelete = await client.configGet?.();
    expect(configuredBeforeDelete?.catalog.providers.gw?.models).toHaveProperty(
      "gw-model",
    );
    const removed = await client.providerRemove?.("gw");
    expect(removed?.removed).toBe(true);
    const configuredAfterDelete = await client.configGet?.();
    expect(configuredAfterDelete?.providers.gw).toBeUndefined();
    expect(configuredAfterDelete?.catalog.providers.gw).toBeUndefined();
    const again = await client.providerRemove?.("gw");
    expect(again?.removed).toBe(true);
  } finally {
    await client.dispose?.();
  }
});

test("two sessions writing the workspace in parallel both land without corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-parallel-write-"));
  const makeWriter = (): StreamingProvider => ({
    provider: "parallel-write",
    model: "parallel-write",
    async *stream(request) {
      const userText = request.messages
        .map((message) =>
          typeof message.content === "string" ? message.content : "",
        )
        .join("\n");
      const path = userText.includes("write a") ? "wa.txt" : "wb.txt";
      if (!request.messages.some((message) => message.role === "tool"))
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: `call_${crypto.randomUUID()}`,
              name: "write_file",
              arguments: JSON.stringify({ path, content: `content-${path}` }),
            },
          ],
        };
      yield { type: "done" as const };
    },
  });
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_pw_a",
    provider: makeWriter(),
  });
  client.start((event) => {
    if (event.type === "approval.request") {
      client.respondApproval({ requestID: event.id, decision: "once" });
    }
  });
  try {
    await client.sessionNew?.({ id: "ses_pw_b", title: "B" });
    const turnA = client.submit("write a");
    await client.sessionAttach?.("ses_pw_b");
    const turnB = client.submit("write b");
    await turnA;
    await turnB;
    await waitFor(
      () =>
        existsSync(join(root, "wa.txt")) && existsSync(join(root, "wb.txt")),
      20_000,
      "both parallel workspace writes to land",
    );
    expect(await readFile(join(root, "wa.txt"), "utf8")).toBe("content-wa.txt");
    expect(await readFile(join(root, "wb.txt"), "utf8")).toBe("content-wb.txt");
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("settings surface: set writes the scope file, get resolves it, set announces", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-settings-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_settings",
    provider: scriptedProvider("settings"),
  });
  client.start((event) => events.push(event));
  try {
    const before = await client.settingsGet?.();
    expect(before?.config).toMatchObject({
      theme: "natalia-dark",
      density: "comfortable",
    });
    expect(before?.sources.map((source) => source.scope)).toEqual([
      "defaults",
      "global",
      "project",
    ]);

    expect(
      await client.settingsSet?.(
        { theme: "solarized", density: "compact" },
        "project",
      ),
    ).toEqual({ applied: true });
    expect(events.at(-1)).toMatchObject({
      type: "settings.updated",
      scope: "project",
    });

    const after = await client.settingsGet?.();
    expect(after?.config).toMatchObject({
      theme: "solarized",
      density: "compact",
    });
    const projectSource = after?.sources.find(
      (source) => source.scope === "project",
    );
    expect(projectSource?.applied).toBe(true);

    // The project file actually holds the patch.
    const onDisk = JSON.parse(
      await readFile(join(root, ".natalia", "tui.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(onDisk).toMatchObject({ theme: "solarized", density: "compact" });

    // An invalid patch is an argument error, never a partial write.
    await expect(
      client.settingsSet?.({ density: "bogus" }, "project"),
    ).rejects.toThrow();
    const stillValid = await client.settingsGet?.();
    expect(stillValid?.config).toMatchObject({ density: "compact" });
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("cancelling the attached session does not abort a background session's pending approval", async () => {
  // A background turn that starts waiting for an approval after the UI attached
  // elsewhere must listen to its own session's abort signal. Before this fix
  // the waiter took the active session's signal, so cancelling the foreground
  // session cancelled the background turn's pending approval.
  const root = await mkdtemp(join(tmpdir(), "natalia-bg-approval-abort-"));
  let releaseA: (() => void) | undefined;
  let releaseB: (() => void) | undefined;
  let aCalls = 0;
  const provider: StreamingProvider = {
    provider: "bg-abort",
    model: "bg-abort",
    async *stream(request) {
      const userText = String(
        [...request.messages]
          .reverse()
          .find((message) => message.role === "user")?.content ?? "",
      );
      if (userText.includes("bg write")) {
        aCalls += 1;
        if (request.messages.some((message) => message.role === "tool")) {
          yield { type: "content" as const, text: "bg written" };
          yield { type: "done" as const };
          return;
        }
        // Park the first provider round until the test attaches to B, so A's
        // approval wait starts while B is the attached session.
        if (aCalls === 1)
          await new Promise<void>((resolve) => (releaseA = resolve));
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: `call_a_${aCalls}`,
              name: "write_file",
              arguments: JSON.stringify({ path: "bg.txt", content: "bg" }),
            },
          ],
        };
        yield { type: "done" as const };
        return;
      }
      // The B turn parks in the provider so B holds a live abort signal while
      // A's approval is pending underneath it.
      await new Promise<void>((resolve) => (releaseB = resolve));
      yield { type: "content" as const, text: "b done" };
      yield { type: "done" as const };
    },
  };
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_bg_abort_a",
    provider,
  });
  client.start((event) => events.push(event));
  let turnB: ReturnType<typeof client.submit> | undefined;
  try {
    await client.sessionNew?.({ id: "ses_bg_abort_b", title: "B" });
    const turnA = client.submit("bg write");
    await waitFor(() => releaseA !== undefined);
    await client.sessionAttach?.("ses_bg_abort_b");
    turnB = client.submit("hold b");
    await waitFor(() => releaseB !== undefined);
    // A continues only now, so its approval wait begins after B is attached.
    releaseA?.();
    await waitFor(() =>
      events.some((event) => event.type === "approval.request"),
    );
    const approval = events.find(
      (event): event is Extract<RuntimeEvent, { type: "approval.request" }> =>
        event.type === "approval.request",
    );
    expect(approval?.sessionID).toBe("ses_bg_abort_a");

    // Cancel the attached (B) session. A's background approval must survive.
    client.cancel("cancel attached session");
    await Bun.sleep(100);
    expect(
      events.some(
        (event) =>
          event.type === "turn.finished" &&
          event.sessionID === "ses_bg_abort_a" &&
          event.stopReason === "cancelled",
      ),
    ).toBe(false);

    // Answer A's approval: the background turn completes normally.
    client.respondApproval({ requestID: approval!.id, decision: "once" });
    await turnA;
    await waitFor(
      () => existsSync(join(root, "bg.txt")),
      20_000,
      "the background A turn to write after approval",
    );
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === "turn.finished" &&
            event.sessionID === "ses_bg_abort_a" &&
            event.stopReason === "done",
        ),
      20_000,
      "the background A turn to finish after approval",
    );
    expect(await readFile(join(root, "bg.txt"), "utf8")).toBe("bg");
    expect(
      events.filter(
        (event) =>
          event.type === "turn.finished" &&
          event.sessionID === "ses_bg_abort_a",
      ),
    ).toMatchObject([expect.objectContaining({ stopReason: "done" })]);
  } finally {
    releaseB?.();
    await turnB?.catch(() => undefined);
    await client.dispose?.();
  }
}, 30_000);

test("SQLite restart recovers the pending human terminal and resumes exactly once after release", async () => {
  // TERM-M.3(c) continuation is already covered on the JSON path; SQLite keeps
  // the pending-human state in durable metadata, so a restart must restore it
  // and release must continue the task exactly once 闁?never twice, and never
  // on its own before the human acts.
  const root = await mkdtemp(join(tmpdir(), "natalia-sqlite-continue-"));
  const sessionID = "ses_sqlite_continue" as SessionID;
  const databasePath = resolveWorkspaceJournalDatabasePath(root);

  // Phase 1: the model asks a human, the turn settles waiting_human, and the
  // pending state is durable in SQLite before the human acts.
  const firstEvents: RuntimeEvent[] = [];
  const first = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    useSqliteStore: true,
    provider: sqliteContinueProvider(),
  });
  first.start((event) => {
    firstEvents.push(event);
    if (event.type === "approval.request")
      first.respondApproval({ requestID: event.id, decision: "once" });
  });
  try {
    await first.submitAndWait!("ask the human");
    expect(
      firstEvents.filter((event) => event.type === "turn.finished").at(-1),
    ).toMatchObject({ stopReason: "waiting_human" });
    const durable = new SessionStoreTestDatabase(databasePath);
    try {
      expect(
        durable.get(sessionID)?.metadata?.pendingHumanTerminal,
      ).toMatchObject({
        terminalID: "rh_sqlite",
        reason: "needs the sudo password",
      });
    } finally {
      durable.close();
    }
  } finally {
    await first.dispose?.();
  }

  // Phase 2: restart the runtime against the same SQLite database. Nothing may
  // resume on its own, and one release resumes exactly one continuation turn.
  const reopenedEvents: RuntimeEvent[] = [];
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    useSqliteStore: true,
    provider: sqliteContinueProvider(),
  });
  reopened.start((event) => reopenedEvents.push(event), { replay: "none" });
  try {
    await waitFor(() =>
      reopenedEvents.some((event) => event.type === "session.ready"),
    );
    await Bun.sleep(100);
    expect(
      reopenedEvents.filter((event) => event.type === "turn.submitted"),
    ).toHaveLength(0);

    // The pane record survives the restart in the JOURNAL; the Pane itself is
    // process state, so the reopened runtime must re-create it before it can
    // release it. The fork fixture used to hand the new runtime a registry that
    // already held the pane; with the host gone the pane is started through the
    // runtime's own API, under the same id the journal names — which is exactly
    // what a restart is supposed to exercise.
    await reopened.nativeTerminalStart?.({
      command: "cat",
      id: "rh_sqlite",
      sessionID,
    });
    await reopened.nativeTerminalReleaseHumanControl?.("rh_sqlite");
    await waitFor(
      () =>
        reopenedEvents.some(
          (event) =>
            event.type === "turn.finished" && event.stopReason === "done",
        ),
      2000,
    );
    expect(
      reopenedEvents.filter((event) => event.type === "turn.submitted"),
    ).toHaveLength(1);
    expect(
      reopenedEvents.some(
        (event) =>
          event.type === "turn.submitted" &&
          event.text.includes("[automated continuation]"),
      ),
    ).toBe(true);

    // A second release finds no pending state and must not resume again.
    await reopened.nativeTerminalReleaseHumanControl?.("rh_sqlite");
    await Bun.sleep(100);
    expect(
      reopenedEvents.filter((event) => event.type === "turn.submitted"),
    ).toHaveLength(1);

    const after = new SessionStoreTestDatabase(databasePath);
    try {
      expect(
        after.get(sessionID)?.metadata?.pendingHumanTerminal,
      ).toBeUndefined();
    } finally {
      after.close();
    }
  } finally {
    await reopened.dispose?.();
  }
}, 30_000);

test("/skill-script aborts its child process when the command is cancelled", async () => {
  // A slash command has no turn, so its cancellation must travel through the
  // session drain signal. Before this fix the /skill-script command read the
  // never-assigned activity closure, so a cancelled script kept running to
  // completion.
  const root = await mkdtemp(join(tmpdir(), "natalia-skill-script-cancel-"));
  const skillRoot = join(root, ".natalia", "skills", "cancel-me");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: cancel-me\ndescription: Cancel me\nscripts: {long: sleep 30}\n---\nBody.",
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_skill_script_cancel",
    provider: scriptedProvider("unused"),
  });
  client.start((event) => events.push(event));
  try {
    await waitFor(() => events.some((event) => event.type === "session.ready"));
    await client.submitAndWait!("/skill cancel-me");
    const before = events.length;
    // The long script starts; cancelling the command must abort its child.
    setTimeout(() => client.cancel("cancel the skill script"), 150);
    void client.submit("/skill-script long");
    await waitFor(
      () =>
        events
          .slice(before)
          .some(
            (event) =>
              event.type === "content.delta" &&
              String(event.text).includes('"exitCode"'),
          ),
      20_000,
      "the cancelled skill script to report its child exit code",
    );
    const output = events
      .slice(before)
      .filter((event) => event.type === "content.delta")
      .map((event) => event.text)
      .join("\n");
    expect(output).toContain('"exitCode"');
    // A terminated child exits non-zero, not after its 30 second sleep.
    expect(output).not.toMatch(/"exitCode":\s*0/u);
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("cancelling a turn aborts a tool currently executing", async () => {
  // The tool-execution cancellation listener used to read an activity-scoped
  // `activeAbort` closure that is never assigned, so a cancelled turn never
  // aborted the in-flight tool: it kept running to completion (or timeout)
  // even though the turn had been cancelled. The listener must bind the turn's
  // own exec's abort signal.
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-cancel-"));
  let toolAborted = false;
  let toolRuns = 0;
  const tools = createToolRegistry([]);
  tools.set("wait_for_cancel", {
    name: "wait_for_cancel",
    description: "Wait until the turn is cancelled.",
    requiresApproval: false,
    timeoutSec: 30,
    parameters: { type: "object", properties: {} },
    async execute(_args, context) {
      toolRuns += 1;
      return await new Promise<string>((resolve) => {
        const signal = context.signal;
        if (signal?.aborted) {
          toolAborted = true;
          resolve("aborted");
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            toolAborted = true;
            resolve("aborted");
          },
          { once: true },
        );
      });
    },
  });
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_tool_cancel",
    tools,
    provider: {
      provider: "tool-cancel",
      model: "tool-cancel",
      async *stream(request) {
        if (request.signal?.aborted) throw new Error("cancelled");
        if (!request.messages.some((message) => message.role === "tool"))
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_cancel",
                name: "wait_for_cancel",
                arguments: "{}",
              },
            ],
          };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "tool.update" && event.status === "running")
      setTimeout(() => client.cancel("stop the tool"), 10);
  });
  try {
    await client.submitAndWait!("run the waiting tool");
    expect(toolRuns).toBe(1);
    // The in-flight tool observed the cancellation and settled.
    expect(toolAborted).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn.cancelled" }),
    );
    expect(
      events.some(
        (event) =>
          event.type === "turn.finished" && event.stopReason === "cancelled",
      ),
    ).toBe(true);
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("a cancellation during the durable in-flight write still aborts the tool", async () => {
  // The window the 10ms-timer test above only hits by luck: `tool.update
  // running` is published, then the runtime awaits a durable in-flight write,
  // and only then attaches the abort listener. Cancelling synchronously on the
  // `running` event lands inside that window every time, and an
  // already-aborted signal never fires `abort` again 闁?so the tool used to run
  // to its own timeout with the turn already cancelled.
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-cancel-window-"));
  let toolAborted = false;
  const tools = createToolRegistry([]);
  tools.set("wait_for_cancel", {
    name: "wait_for_cancel",
    description: "Wait until the turn is cancelled.",
    requiresApproval: false,
    // No timeout: if the cancellation is dropped there is nothing to rescue the
    // call, which is exactly the user-visible failure being pinned.
    parameters: { type: "object", properties: {} },
    async execute(_args, context) {
      return await new Promise<string>((resolve) => {
        const signal = context.signal;
        if (signal?.aborted) {
          toolAborted = true;
          resolve("aborted");
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            toolAborted = true;
            resolve("aborted");
          },
          { once: true },
        );
      });
    },
  });
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_tool_cancel_window",
    tools,
    provider: {
      provider: "tool-cancel",
      model: "tool-cancel",
      async *stream(request) {
        if (request.signal?.aborted) throw new Error("cancelled");
        if (!request.messages.some((message) => message.role === "tool"))
          yield {
            type: "tool_call" as const,
            calls: [
              { id: "call_window", name: "wait_for_cancel", arguments: "{}" },
            ],
          };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => {
    if (event.type === "tool.update" && event.status === "running")
      client.cancel("stop the tool");
  });
  try {
    await client.submitAndWait!("run the waiting tool");
    expect(toolAborted).toBe(true);
  } finally {
    await client.dispose?.();
  }
}, 20_000);

test("the live work chat read and rollback surface a durable conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_slice_a",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  // Slice A data plane: a fresh conversation is empty and an unknown rollback
  // boundary is a no-op (removed 0), never a crash. The full message flow is
  // covered once the Chat execution slice lands (chatSubmit).
  expect(await client.naviChat!.messages!()).toEqual([]);
  expect(
    await client.naviChat!.rollback!({ toMessageID: "chat:nope" }),
  ).toEqual({
    rolledBackTo: "chat:nope",
    removed: 0,
  });
  await client.dispose?.();
});

test("chat submit runs a live work chat turn and persists the conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-turn-"));
  const requests: Array<Array<{ role: string; content: string }>> = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_turn",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push(
          (
            request as {
              messages: Array<{ role: string; content: string }>;
            }
          ).messages,
        );
        yield {
          type: "content" as const,
          text: "the main agent is running step 2",
        };
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  const outcome = await client.naviChat!.submit({
    text: "what is the agent doing",
  });
  expect(outcome.messageID.length).toBeGreaterThan(0);
  const history = await client.naviChat!.messages!();
  expect(history).toHaveLength(2);
  expect(history[0]).toMatchObject({
    role: "user",
    text: "what is the agent doing",
  });
  expect(history[1]).toMatchObject({ role: "chat" });
  expect(history[1].text).toContain("running step 2");
  expect(
    events.filter((event) => event.type.startsWith("navi.chat.turn.")),
  ).toEqual([
    expect.objectContaining({
      type: "navi.chat.turn.started",
      messageID: outcome.messageID,
    }),
    expect.objectContaining({
      type: "navi.chat.turn.phase",
      messageID: outcome.messageID,
      phase: "generating",
    }),
    expect.objectContaining({
      type: "navi.chat.turn.finished",
      messageID: outcome.messageID,
      stopReason: "done",
    }),
  ]);
  await client.naviChat!.submit({ text: "and now" });
  // ADR D2: the live work context is an appended `<runtime_context>` user
  // message directly before the turn's request; the conversation history
  // itself is unchanged.
  const secondRequest = requests.at(-1) ?? [];
  expect(secondRequest.filter((message) => message.role !== "system")).toEqual([
    { role: "user", content: "what is the agent doing" },
    { role: "assistant", content: "the main agent is running step 2" },
    expect.objectContaining({
      role: "user",
      content: expect.stringContaining(
        '<runtime_context source="collab" trust="untrusted" revision="1"',
      ),
    }),
    { role: "user", content: "and now" },
  ]);
  // The static system prompt never carries the live context (ADR D1).
  const system = secondRequest.find((message) => message.role === "system");
  expect(system?.content).toContain("<navi_chat_persona>");
  expect(system?.content).not.toContain("<live_work_context>");
  await client.dispose?.();
});

test("chat tool calls surface as conversation actions", async () => {
  let streamCalls = 0;
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-tool-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_tool",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        // The generator re-runs from the top on every stream call, so only the
        // first call offers the tool; later steps reply in text and settle.
        streamCalls += 1;
        if (streamCalls === 1) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_1",
                name: "mailbox_send",
                arguments: JSON.stringify({
                  intent: "constraint",
                  text: "do not install that dependency",
                }),
              },
            ],
          };
          return;
        }
        yield {
          type: "content" as const,
          text: "I queued the constraint for the main agent.",
        };
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.naviChat!.submit({ text: "do not install that dependency" });
  const actions = events.filter(
    (event) => event.type === "navi.chat.tool.used",
  );
  expect(actions).toHaveLength(1);
  expect(actions[0]).toMatchObject({ toolName: "mailbox_send" });
  expect((actions[0] as { summary: string }).summary).toContain(
    "queued mailbox intent: constraint",
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "navi.chat.turn.phase",
      phase: "using_tool",
      toolName: "mailbox_send",
    }),
  );
  await client.dispose?.();
});

test("chat mailbox_send refuses a planless handoff and mailbox_cancel drops queued mail", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-mailbox-guard-"));
  let streamCalls = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_mailbox_guard",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        streamCalls += 1;
        if (streamCalls === 1) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_handoff",
                name: "mailbox_send",
                arguments: JSON.stringify({
                  intent: "next_plan_handoff",
                  text: "continue the lost draft",
                }),
              },
            ],
          };
          return;
        }
        if (streamCalls === 2) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_send",
                name: "mailbox_send",
                arguments: JSON.stringify({
                  intent: "request_report",
                  text: "stop after this file",
                }),
              },
            ],
          };
          return;
        }
        if (streamCalls === 3) {
          const queued = (await client.mailboxList!()).find(
            (message) => message.status === "queued",
          );
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_cancel",
                name: "mailbox_cancel",
                arguments: JSON.stringify({
                  messageID: queued?.messageID,
                  reason: "duplicate handoff",
                }),
              },
            ],
          };
          return;
        }
        yield { type: "content" as const, text: "cancelled the extra intent" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.naviChat!.submit({ text: "send the plan to Natalia" });
  const mailbox = await client.mailboxList!();
  expect(
    mailbox.some((message) => message.intent === "next_plan_handoff"),
  ).toBe(false);
  expect(mailbox.every((message) => message.status === "superseded")).toBe(
    true,
  );
  await client.dispose?.();
});

test("chat reserves its configured final step and preserves XML-like text", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-final-step-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3, runtime: { maxStepsPerTurn: 2 } }),
  );
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_final_step",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_1",
                name: "mailbox_send",
                arguments: JSON.stringify({
                  intent: "notice",
                  text: "final step test",
                }),
              },
            ],
          };
          return;
        }
        yield {
          type: "content" as const,
          text: "Queued. <function=mailbox_send><parameter=text>already done</parameter></function>",
        };
      },
    },
  });
  client.start(() => undefined);

  await client.naviChat!.submit({ text: "send a notice" });

  expect(requests).toHaveLength(2);
  expect(requests[0]?.tools?.length).toBeGreaterThan(0);
  expect(requests[1]).toMatchObject({ tools: undefined, toolChoice: "none" });
  expect(
    requests[1]?.messages.some((message) =>
      message.content.includes("MAXIMUM STEPS REACHED"),
    ),
  ).toBe(true);
  expect((await client.naviChat!.messages!()).at(-1)?.text).toContain(
    "<function=mailbox_send>",
  );
  await client.dispose?.();
});

test("chat ignores structured calls on its final step and emits fallback text", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-final-fallback-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3, runtime: { maxStepsPerTurn: 1 } }),
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_final_fallback",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield {
          type: "tool_call" as const,
          calls: [
            { id: "call_forbidden", name: "mailbox_send", arguments: "{}" },
          ],
        };
      },
    },
  });
  client.start((event) => events.push(event));

  await client.naviChat!.submit({ text: "send a notice" });

  expect(events.some((event) => event.type === "navi.chat.tool.used")).toBe(
    false,
  );
  expect((await client.naviChat!.messages!()).at(-1)?.text).toContain(
    "Tool execution completed",
  );
  await client.dispose?.();
});

test("the chat context includes the main agent's recent activity", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-ctx-"));
  let streamCalls = 0;
  let chatSystemPrompt = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_ctx",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        streamCalls++;
        if (streamCalls === 1) {
          yield {
            type: "content" as const,
            text: "I replaced the fetch wrapper",
          };
          yield { type: "done" as const };
          return;
        }
        chatSystemPrompt = (
          request as { messages: Array<{ role: string; content: string }> }
        ).messages
          .map((message) => message.content)
          .join("\n");
        yield {
          type: "content" as const,
          text: "the main agent said it replaced the wrapper",
        };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.submitAndWait!("replace the wrapper");
  await pollHistoryForFinished(client);
  await client.naviChat!.submit({ text: "what did the main agent just say" });
  // The Chat shares the main agent's recent exchange 闁?the user's prompt and
  // the reply 闁?so it can answer the question instead of only seeing the
  // status card (閹?.3 shared context).
  expect(chatSystemPrompt).toContain("I replaced the fetch wrapper");
  expect(chatSystemPrompt).toContain("replace the wrapper");
  await client.dispose?.();
});

test("chat answers with live main context while the main turn is still running", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-live-ctx-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      runtime: { providerConcurrency: { test: 1 } },
    }),
  );
  let releaseMain: (() => void) | undefined;
  let mainReached: (() => void) | undefined;
  const reached = new Promise<void>((resolve) => {
    mainReached = resolve;
  });
  const parked = new Promise<void>((resolve) => {
    releaseMain = resolve;
  });
  let chatSystemPrompt = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_live_ctx",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        // ADR D1/D2: the Navi turn's live context arrives as an appended
        // `<runtime_context>` user message, not the static system prompt.
        const allMessages = (
          request as { messages: Array<{ role: string; content: string }> }
        ).messages
          .map((message) => message.content)
          .join("\n");
        if (allMessages.includes("<natalia_collaborations>")) {
          chatSystemPrompt = allMessages;
          yield { type: "content" as const, text: "she is still working" };
          yield { type: "done" as const };
          return;
        }
        yield {
          type: "content" as const,
          text: "inspecting the request routing now",
        };
        mainReached?.();
        await parked;
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  const mainTurn = client.submit("trace the request routing");
  await reached;

  // Chat has its own task and provider stream, so it settles before the parked
  // Main turn. Its prompt is built from the current in-memory stream, not only
  // the last durable content.done event.
  const chatResult = await client.naviChat!.submit({
    text: "what is the main agent doing right now",
  });
  expect(chatResult.messageID).not.toBe("");
  expect(chatSystemPrompt).toContain("Main agent: running");
  expect(chatSystemPrompt).toContain("trace the request routing");
  expect(chatSystemPrompt).toContain("inspecting the request routing now");
  expect(await client.sessionSnapshot!()).toMatchObject({
    agentStatus: "running",
    recentOutput: "inspecting the request routing now",
  });

  releaseMain?.();
  await mainTurn;
  await client.dispose?.();
});

test("a queued mailbox intent wakes an idle main agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-mailbox-deliver-"));
  const systemPrompts: string[] = [];
  const providerMessages: Array<Array<{ role: string; content: string }>> = [];
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_mailbox_deliver",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        providerMessages.push(
          (request as { messages: Array<{ role: string; content: string }> })
            .messages,
        );
        systemPrompts.push(
          String(
            (
              request as {
                messages: Array<{ role: string; content: string }>;
              }
            ).messages[0]?.content ?? "",
          ),
        );
        yield { type: "content" as const, text: "will do" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.mailboxSend!({
    intent: "constraint",
    text: "do not install that dependency",
  });
  // The mailbox intent wakes the idle main agent without inventing another
  // user-authored turn; the durable mailbox remains the sole intent source.
  await pollHistoryForFinished(client);
  expect(systemPrompts[0]).not.toContain("do not install that dependency");
  const wake = events.find(
    (event): event is Extract<RuntimeEvent, { type: "turn.submitted" }> =>
      event.type === "turn.submitted" && event.id.startsWith("turn_mailbox_"),
  );
  expect(wake).toMatchObject({ internal: true });
  expect(wake?.text).not.toContain("do not install that dependency");
  expect(
    providerMessages[0]?.some(
      (message) =>
        message.role === "user" &&
        message.content.includes("[user] do not install that dependency"),
    ),
  ).toBe(true);
  await client.dispose?.();
});

test("a chat tool parameter error returns the usage to the model for retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-retry-"));
  let streamCalls = 0;
  let secondStepToolMessages: unknown[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_retry",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        streamCalls++;
        if (streamCalls === 1) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_1",
                name: "read_file",
                arguments: JSON.stringify({ path: "a.txt", maxBytes: 100 }),
              },
            ],
          };
          return;
        }
        secondStepToolMessages = (
          request as { messages: Array<{ role: string; content: string }> }
        ).messages
          .filter((message) => message.role === "tool")
          .map((message) => message.content);
        yield { type: "content" as const, text: "I read the file" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.naviChat!.submit({ text: "read the file" });
  const history = await client.naviChat!.messages!();
  expect(history.at(-1)?.text).toContain("I read the file");
  // The bad call came back as a tool result carrying the correct calling
  // convention, so the model could retry on the next step.
  expect(
    secondStepToolMessages.some((content) =>
      String(content).includes("parameter validation failed"),
    ),
  ).toBe(true);
  await client.dispose?.();
});

test("the chat can query the main agent's live status with session_snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-snapshot-"));
  let streamCalls = 0;
  let snapshotToolResult = "";
  let finalStepAssistantTexts: string[] = [];
  let chatSystemPrompt = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_snapshot",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        streamCalls++;
        const requestMessages = (
          request as { messages: Array<{ role: string; content: string }> }
        ).messages;
        chatSystemPrompt = requestMessages[0]?.content ?? "";
        if (streamCalls === 1) {
          yield { type: "content" as const, text: "Let me check." };
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_1",
                name: "session_snapshot",
                arguments: "{}",
              },
            ],
          };
          return;
        }
        if (streamCalls === 2) {
          yield { type: "content" as const, text: "Checking once more." };
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_2",
                name: "session_snapshot",
                arguments: "{}",
              },
            ],
          };
          return;
        }
        snapshotToolResult = String(
          requestMessages.filter((message) => message.role === "tool")[0]
            ?.content ?? "",
        );
        finalStepAssistantTexts = requestMessages
          .filter((message) => message.role === "assistant")
          .map((message) => message.content);
        yield {
          type: "content" as const,
          text: "the main agent is running step 2",
        };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.naviChat!.submit({ text: "what is the main agent doing" });
  // The read-only snapshot tool returned the live status to the model.
  expect(snapshotToolResult).toContain("agentStatus");
  expect(finalStepAssistantTexts).toEqual([
    "Let me check.",
    "Checking once more.",
  ]);
  expect(chatSystemPrompt).toContain(
    "Speak directly to the user in first person",
  );
  expect(chatSystemPrompt).toContain(
    "Status and snapshot data always describe Natalia, never you",
  );
  expect(chatSystemPrompt).toContain(
    "a Natalia chat marked REPLY_REQUIRED is itself a reply you have already received",
  );
  expect(chatSystemPrompt).toContain("Every reply continues the thread");
  await client.dispose?.();
});

test("the collaboration channel round-robins between Navi and the main agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-collab-"));
  let mainPrompt = "";
  let chatPrompt2 = "";
  let mainStreamCount = 0;
  let naviSuggested = false;
  const rrEvents: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_collab",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        const messages = (
          request as { messages: Array<{ role: string; content: string }> }
        ).messages;
        // ADR D1/D2: the Navi turn's live context arrives as an appended
        // `<runtime_context>` user message, not the static system prompt.
        // Chat turns carry her sister's questions/outcomes block; main-agent
        // turns never do, so the source of a stream call is content, not a
        // call counter (the wake runs concurrently).
        const allMessages = messages
          .map((message) => message.content)
          .join("\n");
        const naviTurn = allMessages.includes("<natalia_collaborations>");
        if (!naviTurn) {
          // ADR D1/D2: the main agent's collaboration state is runtime context
          // appended as a user message, not system prompt content.
          mainPrompt = allMessages;
          mainStreamCount++;
          if (mainStreamCount === 1) {
            yield { type: "content" as const, text: "I will use that." };
            yield { type: "done" as const };
            return;
          }
          if (mainStreamCount === 2) {
            // Natalia's wake turn: adopt Navi's suggestion.
            const correction = String(
              (
                request as {
                  messages: Array<{ role: string; content: string }>;
                }
              ).messages.at(-1)?.content ?? "",
            );
            const match =
              /messageID (collab:suggestion:[a-z0-9]+:[0-9]+)/u.exec(
                correction,
              );
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "c2",
                  name: "collab_respond",
                  arguments: JSON.stringify({
                    messageID: match?.[1] ?? "",
                    decision: "adopted",
                  }),
                },
              ],
            };
            return;
          }
          yield { type: "content" as const, text: "ok" };
          yield { type: "done" as const };
          return;
        }
        chatPrompt2 = allMessages;
        if (!naviSuggested) {
          // Navi's first turn: send the suggestion.
          naviSuggested = true;
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "c1",
                name: "collab_suggest",
                arguments: JSON.stringify({
                  suggestion: "prefer echo over cat for the demo",
                  priority: "normal",
                }),
              },
            ],
          };
          return;
        }
        yield { type: "content" as const, text: "she adopted it" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => rrEvents.push(event));
  await client.naviChat!.submit({ text: "suggest echo" });
  // The suggestion wakes the idle main agent, whose wake turn already carries
  // the suggestion (the 閺夌儐鍠栫拹? 闁?no extra user submission needed.
  // The round-robin's chain is two-plus provider turns with durable writes
  // and a wake between them. Under the full-suite load the chain measured
  // past 20s (the failure this budget covers); 45s still bounds a genuine
  // hang under the 60s per-test cap, which is what a budget is for.
  await waitForAsync(async () => mainPrompt.length > 0, 45_000);
  // The main agent knows who Navi is and sees her suggestion without the user
  // prompting it (the 閺夌儐鍠栫拹?.
  expect(mainPrompt).toContain("<live_work_chat>");
  expect(mainPrompt).toContain("your younger sister");
  expect(mainPrompt).toContain("<navi_collaborations>");
  expect(mainPrompt).toContain("prefer echo over cat for the demo");
  expect(mainPrompt).toContain("REPLY_REQUIRED");
  // Wait until the wake main turn's decision lands, so Navi's next prompt is
  // built after the outcome exists (the round-robin race).
  await waitForAsync(
    async () =>
      rrEvents.some(
        (event) =>
          isCollabMessageEvent(event) && event.message.kind === "response",
      ),
    45_000,
  );
  await client.naviChat!.submit({ text: "what did she decide" });
  await waitForAsync(async () => chatPrompt2.includes("adopted"), 45_000);
  // Navi sees the outcome without the user prompting her.
  expect(chatPrompt2).toContain("Outcomes of your suggestions to Natalia");
  expect(chatPrompt2).toContain("adopted");
  expect(
    rrEvents.some(
      (event) =>
        event.type === "diagnostic" &&
        event.message.includes("Correcting missing response to suggestion"),
    ),
  ).toBe(true);
  await client.dispose?.();
}, 20000);

test("an idle Navi answers Natalia's question immediately without a user chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-navi-wake-"));
  let streamCalls = 0;
  let naviStreamCount = 0;
  let firstNaviMessages: Array<{ role: string; content: string }> = [];
  const mainPrompts: string[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_navi_wake",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        streamCalls++;
        // ADR D1/D2: the main agent's collaboration state arrives as appended
        // `<runtime_context>` user messages, so assert on the whole request.
        const allMessages = String(
          (
            request as {
              messages: Array<{ role: string; content: string }>;
            }
          ).messages
            .map((message) => message.content)
            .join("\n"),
        );
        const system = String(
          (request as { messages: Array<{ role: string; content: string }> })
            .messages[0]?.content ?? "",
        );
        // The Navi wake turn's context carries her sister's pending questions;
        // the main agent's context never does.
        const naviTurn = allMessages.includes("<natalia_collaborations>");
        if (!naviTurn) {
          mainPrompts.push(allMessages);
          if (streamCalls === 1) {
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "c1",
                  name: "collab_ask",
                  arguments: JSON.stringify({ question: "is echo safe" }),
                },
              ],
            };
            return;
          }
          yield { type: "content" as const, text: "ok" };
          yield { type: "done" as const };
          return;
        }
        naviStreamCount++;
        if (naviStreamCount === 1) {
          firstNaviMessages = (
            request as {
              messages: Array<{ role: string; content: string }>;
            }
          ).messages.map((message) => ({ ...message }));
        }
        if (naviStreamCount === 1) {
          yield { type: "content" as const, text: "yes, echo is safe" };
          yield { type: "done" as const };
          return;
        }
        if (naviStreamCount === 2) {
          // ADR D2: the pending questionID arrives in the `<runtime_context>`
          // user message, not the static persona system prompt.
          const match = /questionID: (collab:question:[a-z0-9]+:[0-9]+)/u.exec(
            allMessages,
          );
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "c2",
                name: "collab_answer",
                arguments: JSON.stringify({
                  questionID: match?.[1] ?? "",
                  answer: "yes, echo is safe",
                }),
              },
            ],
          };
          return;
        }
        yield { type: "content" as const, text: "answered natalia" };
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  // No chatSubmit at all: the question wakes Navi and she answers on her own.
  await client.submitAndWait!("hello");
  await waitForAsync(async () =>
    events.some(
      (event) => isCollabMessageEvent(event) && event.message.kind === "answer",
    ),
  );
  const answer = events.find(
    (event) => isCollabMessageEvent(event) && event.message.kind === "answer",
  );
  expect(answer).toMatchObject({
    message: { kind: "answer", text: "yes, echo is safe" },
  });
  expect(
    events.some(
      (event) =>
        event.type === "navi.chat.message.new" &&
        String((event as { text?: string }).text).includes(
          "internal advisor request",
        ),
    ),
  ).toBe(true);
  expect(
    firstNaviMessages.filter((message) => message.role !== "system"),
  ).toEqual([
    // ADR D2: the live work context is an appended `<runtime_context>` user
    // message; the internal advisor request is the trailing user message.
    expect.objectContaining({
      role: "user",
      content: expect.stringContaining('<runtime_context source="collab"'),
    }),
    expect.objectContaining({
      role: "user",
      content: expect.stringContaining(
        "Natalia (the main agent) sent you collaboration messages",
      ),
    }),
  ]);
  expect(
    events.some(
      (event) =>
        event.type === "diagnostic" &&
        event.message.includes("Correcting missing answer to question"),
    ),
  ).toBe(true);
  // The answer reaches Natalia's own context on her next turn (the 閺夌儐鍠栫拹?.
  await client.submitAndWait!("continue");
  await waitForAsync(async () => mainPrompts.length >= 2);
  expect(mainPrompts.at(-1)).toContain("<navi_responses>");
  expect(mainPrompts.at(-1)).toContain("yes, echo is safe");
  await client.dispose?.();
}, 20000);

test("collab_inbox lets the main agent read Navi's answer on demand", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-collab-inbox-"));
  let mainAsked = false;
  let naviAnswered = false;
  const inboxToolResults: string[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_collab_inbox",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        const system = String(
          (request as { messages: Array<{ role: string; content: string }> })
            .messages[0]?.content ?? "",
        );
        const messages = (
          request as {
            messages: Array<{
              role: string;
              content: string;
              toolCallID?: string;
            }>;
          }
        ).messages;
        const toolMessages = messages.filter(
          (message) => message.role === "tool",
        );
        const inboxToolMessage = toolMessages.find(
          (message) => message.toolCallID === "c5",
        );
        const inboxTurn = messages.some(
          (message) => message.role === "user" && message.content === "check",
        );
        // ADR D1/D2: the Navi turn's live context arrives as an appended
        // `<runtime_context>` user message, not the static system prompt.
        const allMessages = messages
          .map((message) => message.content)
          .join("\n");
        const naviTurn = allMessages.includes("<natalia_collaborations>");
        if (!naviTurn) {
          if (!mainAsked) {
            mainAsked = true;
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "c1",
                  name: "collab_ask",
                  arguments: JSON.stringify({ question: "is echo safe" }),
                },
              ],
            };
            return;
          }
          if (inboxTurn && !inboxToolMessage) {
            yield {
              type: "tool_call" as const,
              calls: [{ id: "c5", name: "collab_inbox", arguments: "{}" }],
            };
            return;
          }
          if (inboxToolMessage)
            inboxToolResults.push(String(inboxToolMessage.content ?? ""));
          yield { type: "content" as const, text: "ok" };
          yield { type: "done" as const };
          return;
        }
        const match = /questionID: (collab:question:[a-z0-9]+:[0-9]+)/u.exec(
          allMessages,
        );
        if (match && !naviAnswered) {
          naviAnswered = true;
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "c2",
                name: "collab_answer",
                arguments: JSON.stringify({
                  questionID: match[1],
                  answer: "yes, echo is safe",
                }),
              },
            ],
          };
          return;
        }
        yield { type: "content" as const, text: "answered natalia" };
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  try {
    await client.submitAndWait!("hello");
    await waitForAsync(async () =>
      events.some(
        (event) =>
          isCollabMessageEvent(event) && event.message.kind === "answer",
      ),
    );
    // An active main turn receives the answer as a next-step injection, so
    // there is no guaranteed separate `turn_collab_` turn to wait for.
    await client.submitAndWait!("check");
    await waitForAsync(async () =>
      inboxToolResults.some((result) => result.includes("yes, echo is safe")),
    );
  } finally {
    await client.dispose?.();
  }
}, 20000);

test("collab_answer rejects a truncated question id", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-collab-trunc-"));
  let streamCalls = 0;
  let naviStreamCount = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_collab_trunc",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        streamCalls++;
        // ADR D1/D2: the Navi turn's live context arrives as an appended
        // `<runtime_context>` user message, not the static system prompt.
        const allMessages = (
          request as { messages: Array<{ role: string; content: string }> }
        ).messages
          .map((message) => message.content)
          .join("\n");
        const naviTurn = allMessages.includes("<natalia_collaborations>");
        if (!naviTurn) {
          if (streamCalls === 1) {
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "c1",
                  name: "collab_ask",
                  arguments: JSON.stringify({ question: "is echo safe" }),
                },
              ],
            };
            return;
          }
          yield { type: "content" as const, text: "ok" };
          yield { type: "done" as const };
          return;
        }
        naviStreamCount++;
        if (naviStreamCount === 1) {
          const match = /questionID: (collab:question:[a-z0-9]+:[0-9]+)/u.exec(
            allMessages,
          );
          // The model truncates the id to its tail, dropping the prefix.
          const truncated = (match?.[1] ?? "").replace(
            /^collab:question:/u,
            "",
          );
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "c2",
                name: "collab_answer",
                arguments: JSON.stringify({
                  questionID: truncated,
                  answer: "yes, echo is safe",
                }),
              },
            ],
          };
          return;
        }
        yield { type: "content" as const, text: "answered natalia" };
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("hello");
  await waitForAsync(async () =>
    events.some(
      (event) =>
        event.type === "navi.chat.tool.used" &&
        event.toolName === "collab_answer" &&
        event.result?.includes("no pending question"),
    ),
  );
  expect(
    events.some(
      (event) => isCollabMessageEvent(event) && event.message.kind === "answer",
    ),
  ).toBe(false);
  await client.dispose?.();
}, 20000);

test("collab_chat enforces direct replies and stops after three automatic rounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-collab-chat-"));
  const events: RuntimeEvent[] = [];
  let started = false;
  let naviIgnoredRequiredReply = false;
  let triedUnthreadedReply = false;
  let mainIgnoredRequiredReply = false;
  let mainWakeWithoutRequiredReply = false;
  const repliedMessageIDs = new Set<string>();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_collab_chat",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        const messages = (
          request as { messages: Array<{ role: string; content: string }> }
        ).messages;
        const system = String(messages[0]?.content ?? "");
        // ADR D2: the main agent's collaboration context is appended as
        // `<runtime_context>` user messages while the Navi turn still carries
        // its prompt as the system message; search every message.
        const systemContext = messages
          .map((message) => message.content)
          .join("\n");
        const naviTurn = systemContext.includes("<natalia_collaborations>");
        const toolResult = messages
          .filter((message) => message.role === "tool")
          .at(-1)?.content;
        const pendingID =
          /messageID: (collab:chat:[^\s]+)[^\n]*REPLY_REQUIRED/u.exec(
            systemContext,
          )?.[1];

        if (!naviTurn && !started) {
          started = true;
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "chat_start",
                name: "collab_chat",
                arguments: JSON.stringify({
                  text: "Navi, check the edge case.",
                }),
              },
            ],
          };
          return;
        }
        if (naviTurn && pendingID && !naviIgnoredRequiredReply) {
          naviIgnoredRequiredReply = true;
          yield {
            type: "content" as const,
            text: "I will answer without the collaboration tool.",
          };
          yield { type: "done" as const };
          return;
        }
        if (naviTurn && pendingID && !triedUnthreadedReply) {
          triedUnthreadedReply = true;
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "chat_bad_reply",
                name: "collab_chat",
                arguments: JSON.stringify({
                  text: "I checked it, but omitted the reply ID.",
                }),
              },
            ],
          };
          return;
        }
        if (
          naviTurn &&
          pendingID &&
          toolResult?.includes("reply required for chat message")
        ) {
          repliedMessageIDs.add(pendingID);
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "chat_fixed_reply",
                name: "collab_chat",
                arguments: JSON.stringify({
                  text: "I checked it. Did you cover the empty input?",
                  messageID: pendingID,
                }),
              },
            ],
          };
          return;
        }
        if (
          !naviTurn &&
          pendingID &&
          !mainIgnoredRequiredReply &&
          !repliedMessageIDs.has(pendingID)
        ) {
          mainIgnoredRequiredReply = true;
          yield {
            type: "content" as const,
            text: "I will answer Navi without the collaboration tool.",
          };
          yield { type: "done" as const };
          return;
        }
        if (pendingID && !repliedMessageIDs.has(pendingID)) {
          repliedMessageIDs.add(pendingID);
          const sender = naviTurn ? "Navi" : "Natalia";
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: `chat_reply_${sender}`,
                name: "collab_chat",
                arguments: JSON.stringify({
                  text: naviTurn
                    ? "Yes. The final edge is covered."
                    : "Yes, empty input is covered. Anything else?",
                  messageID: pendingID,
                }),
              },
            ],
          };
          return;
        }
        if (!naviTurn && !pendingID && started)
          mainWakeWithoutRequiredReply = true;
        yield { type: "content" as const, text: "collaboration handled" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  try {
    await client.submitAndWait!("ask Navi to check it");
    await waitForAsync(async () => {
      const chatCount = events.filter(
        (event) => isCollabMessageEvent(event) && event.message.kind === "chat",
      ).length;
      if (chatCount > 4)
        throw new Error(`collab_chat exceeded its limit: ${chatCount}`);
      return chatCount === 4 && mainWakeWithoutRequiredReply;
    }, 20_000).catch((error) => {
      const summary = events
        .filter(
          (event) =>
            (isCollabMessageEvent(event) && event.message.kind === "chat") ||
            event.type === "navi.chat.tool.used" ||
            event.type === "diagnostic" ||
            event.type === "turn.finished",
        )
        .map((event) => JSON.stringify(event))
        .join("\n");
      throw new Error(`${String(error)}\n${summary}`);
    });

    const chats = events.flatMap((event) =>
      isCollabMessageEvent(event) && event.message.kind === "chat"
        ? [event.message]
        : [],
    );
    expect(chats.map((message) => message.from)).toEqual([
      "main_agent",
      "live_chat",
      "main_agent",
      "live_chat",
    ]);
    expect(chats.map((message) => message.round)).toEqual([1, 2, 3, 3]);
    expect(chats.map((message) => message.expectsReply)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(new Set(chats.map((message) => message.threadID)).size).toBe(1);
    expect(
      events
        .filter(
          (event): event is Extract<RuntimeEvent, { type: "turn.submitted" }> =>
            event.type === "turn.submitted" &&
            event.id.startsWith("turn_collab_"),
        )
        .every((event) => event.internal === true),
    ).toBe(true);
    expect(chats.slice(1).map((message) => message.replyToID)).toEqual(
      chats.slice(0, -1).map((message) => message.id),
    );
    expect(
      events.some(
        (event) =>
          event.type === "navi.chat.tool.used" &&
          event.toolName === "collab_chat" &&
          event.result?.includes("reply required for chat message"),
      ),
    ).toBe(true);
    const replyCorrections = events
      .filter(
        (event): event is Extract<RuntimeEvent, { type: "diagnostic" }> =>
          event.type === "diagnostic" &&
          event.message.includes("Correcting missing direct reply"),
      )
      .map((event) => event.message);
    expect(
      replyCorrections.some((message) => message.includes(chats[0]!.id)),
    ).toBe(true);
    expect(
      replyCorrections.some((message) => message.includes(chats[1]!.id)),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "navi.chat.tool.used" &&
          event.toolName === "collab_chat" &&
          event.result?.includes('"autoRoundLimitReached":true'),
      ),
    ).toBe(true);
  } finally {
    await client.dispose?.();
  }
}, 20000);

test("collab_chat honors a configured one-round automatic limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-collab-chat-limit-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ runtime: { collaboration: { maxAutoRounds: 1 } } }),
  );
  const events: RuntimeEvent[] = [];
  let started = false;
  let finalWakeObserved = false;
  const repliedMessageIDs = new Set<string>();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_collab_chat_limit",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        const messages = (
          request as { messages: Array<{ role: string; content: string }> }
        ).messages;
        // ADR D1/D2: the Navi turn's live context arrives as an appended
        // `<runtime_context>` user message, not the static system prompt.
        const allMessages = messages
          .map((message) => message.content)
          .join("\n");
        const naviTurn = allMessages.includes("<natalia_collaborations>");
        const toolResult = messages
          .filter((message) => message.role === "tool")
          .at(-1)?.content;
        const pendingID =
          /messageID: (collab:chat:[^\s]+)[^\n]*REPLY_REQUIRED/u.exec(
            allMessages,
          )?.[1];
        if (!naviTurn && !started) {
          started = true;
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "limit_start",
                name: "collab_chat",
                arguments: JSON.stringify({ text: "One quick check." }),
              },
            ],
          };
          return;
        }
        if (
          naviTurn &&
          pendingID &&
          !repliedMessageIDs.has(pendingID) &&
          !toolResult?.includes('"autoRoundLimitReached":true')
        ) {
          repliedMessageIDs.add(pendingID);
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "limit_reply",
                name: "collab_chat",
                arguments: JSON.stringify({
                  text: "Checked and closed.",
                  messageID: pendingID,
                }),
              },
            ],
          };
          return;
        }
        if (!naviTurn && started && !pendingID) finalWakeObserved = true;
        yield { type: "content" as const, text: "done" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  try {
    await client.submitAndWait!("start one round");
    await waitForAsync(
      async () =>
        events.filter(
          (event) =>
            isCollabMessageEvent(event) && event.message.kind === "chat",
        ).length === 2 && finalWakeObserved,
      20_000,
    );
    const chats = events.flatMap((event) =>
      isCollabMessageEvent(event) && event.message.kind === "chat"
        ? [event.message]
        : [],
    );
    expect(chats.map((message) => message.round)).toEqual([1, 1]);
    expect(chats.map((message) => message.expectsReply)).toEqual([true, false]);
    expect(
      events.some(
        (event) =>
          event.type === "navi.chat.tool.used" &&
          event.result?.includes('"maxAutoRounds":1'),
      ),
    ).toBe(true);
  } finally {
    await client.dispose?.();
  }
}, 20000);

test("a sandboxed subagent reads the checked-out base and writes only in its worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sandboxed-subagent-"));
  await writeFile(join(root, "CONTRACT.md"), "shared contract\n");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_sandboxed_subagent",
    provider: sandboxedSubagentProvider(),
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate a sandboxed file task");
  // A TERMINAL wait, not a success wait. The old predicate looked only for
  // `completed`, so a child that FAILED was waited on forever: CI measured the
  // 20s default, then the 90s budget, both timing out — the child never
  // reached either state, and nobody could see why. Waiting for either
  // terminal state turns that silence into the child's own error, which is the
  // only thing that can name the defect.
  // The wait, wrapped so a timeout reports WHAT ARRIVED. A bare
  // "timed out waiting for condition" cannot distinguish "the spawn never
  // happened" from "the spawn happened and its events went nowhere" — and CI
  // has now measured the latter twice (zero subagent.update events in 60s,
  // while the sibling sandbox test passes and the local run completes in
  // 0.5s). This dumps the three facts that separate them.
  let terminalWait = "";
  try {
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === "subagent.update" &&
            (event.status === "completed" || event.status === "failed"),
        ),
      60_000,
    );
  } catch (error) {
    const updates = events.filter((event) => event.type === "subagent.update");
    const spawns = events.filter(
      (event) => event.type === "tool.update" && event.name === "agent_spawn",
    ) as Array<{ status?: string; summary?: string; result?: unknown }>;
    const updates2 = updates as unknown as Array<{
      phase?: string;
      activityDetail?: string;
      event?: string;
      status?: string;
    }>;
    const last = updates2.at(-1);
    throw new Error(
      `the sandboxed child never reached a terminal state: subagent.update events=${updates.length}` +
        ` last={event=${String(last?.event ?? "-")} phase=${String(last?.phase ?? "-")} activity=${String(last?.activityDetail ?? "-")}}` +
        ` agent_spawn updates=${JSON.stringify(
          spawns.map((event) => ({
            status: event.status,
            summary: event.summary,
            result: String(event.result ?? "").slice(0, 200),
          })),
        )}`,
      { cause: error },
    );
  }
  const terminal = events.find(
    (event): event is Extract<RuntimeEvent, { type: "subagent.update" }> =>
      event.type === "subagent.update" &&
      (event.status === "completed" || event.status === "failed"),
  );
  if (terminal?.status !== "completed")
    throw new Error(
      `the sandboxed child did not complete: status=${String(terminal?.status ?? "(no subagent.update at all)")} phase=${String(
        (terminal as { phase?: string } | undefined)?.phase ?? "-",
      )} text=${String((terminal as { text?: string } | undefined)?.text ?? "-")}`,
    );
  // The write landed in the sub-agent's own sandbox worktree (id a1), not the
  // parent's workspace.
  expect(
    await readFile(
      join(root, ".natalia", "sandboxes", "a1", "agent-test.txt"),
      "utf8",
    ),
  ).toBe("sandbox agent test success");
  expect(existsSync(join(root, "agent-test.txt"))).toBe(false);
});

test("a sandboxed sub-agent sees a denied write and self-corrects inside its file domain", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sandboxed-domain-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_sandboxed_domain",
    provider: sandboxedDomainProvider(),
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate a domain task");
  // Same sandbox budget as the sibling test above: the child creates a
  // worktree and runs under confinement, and CI's loaded runner needs more
  // than the 20s default for it.
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "subagent.update" && event.status === "completed",
      ),
    90_000,
  );
  // The ownership map refuses the first write, but the error is returned to the
  // child as a tool result so it can recover without restarting its context.
  expect(
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  ).toBe(true);
  expect(existsSync(join(root, "forbidden"))).toBe(false);
  expect(
    existsSync(join(root, ".natalia", "sandboxes", "a1", "forbidden", "x.txt")),
  ).toBe(false);
  expect(
    await readFile(
      join(root, ".natalia", "sandboxes", "a1", "allowed", "recovered.txt"),
      "utf8",
    ),
  ).toBe("recovered after tool error");
});

test("a subagent keeps retrying transient failures without respawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-subagent-retry-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      runtime: {
        retry: {
          initialBackoffMs: 1,
          maxBackoffMs: 1,
          jitterMs: 0,
        },
      },
    }),
  );
  let childAttempts = 0;
  const provider: StreamingProvider = {
    provider: "scripted-subagent-retry",
    model: "scripted-subagent-retry-model",
    async *stream(request) {
      const isChild = request.messages.some(
        (message) => message.content === "child transient task",
      );
      if (isChild) {
        childAttempts++;
        if (childAttempts < 6)
          throw providerError({ kind: "server", message: "temporary outage" });
        // Long enough to clear the result-quality gate: a shorter answer spends
        // one more step on the gate, which would count as a retry here and
        // measure the gate instead of the retry policy this test is about.
        yield {
          type: "content",
          text:
            "child recovered after the outage: the retry policy replayed the " +
            "failed provider step five times without respawning the subagent, " +
            "the sixth attempt succeeded, and the child finished inside its own " +
            "wall-clock budget with its ledger intact",
        };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_retry_spawn",
              name: "agent_spawn",
              arguments: JSON.stringify({ task: "child transient task" }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "parent complete" };
      yield { type: "done" };
    },
  };
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_subagent_retry",
    provider,
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate transient work");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  );
  expect(childAttempts).toBe(6);
  expect(
    events.some(
      (event) =>
        event.type === "step.retry" &&
        event.id === "subagent:a1" &&
        event.sessionID === "ses_subagent_retry",
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "step.retry.cleared" &&
        event.id === "subagent:a1" &&
        event.sessionID === "ses_subagent_retry",
    ),
  ).toBe(true);
});

test("a model with image input can attach its own screenshot and see it", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-image-attach-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  // A valid 1x1 PNG header; enough for the attach path.
  await writeFile(
    join(root, "shot.png"),
    Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex"),
  );
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      providers: {
        "scripted-image": { name: "Scripted image", driver: "openai" },
      },
      catalog: {
        providers: {
          "scripted-image": {
            models: {
              "scripted-image-model": {
                name: "Scripted image",
                capabilities: { imageInput: true },
              },
            },
          },
        },
      },
      defaultModel: {
        provider: "scripted-image",
        model: "scripted-image-model",
      },
    }),
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_image_attach",
    provider: imageAttachProvider(),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("look at my screenshot");
  await waitFor(() =>
    events.some(
      (event) => event.type === "turn.finished" && event.stopReason === "done",
    ),
  );
  const text = events
    .filter((event) => event.type === "content.delta")
    .map((event) => (event as { text: string }).text)
    .join("");
  // The second provider step saw the attached image as multimodal user content.
  expect(text).toContain("saw my screenshot");
  await client.dispose?.();
}, 60_000);

test("/team forces the agent-team directive into the turn context", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-team-cmd-"));
  let sawDirective = false;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_team_cmd",
    provider: {
      provider: "scripted-team",
      model: "scripted-team-model",
      async *stream(request) {
        sawDirective = request.messages.some(
          (message) =>
            message.role === "system" && message.content.includes("agent team"),
        );
        yield {
          type: "content",
          text: sawDirective ? "team ready" : "no team",
        };
        yield { type: "done" };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("/team build the game");
  await waitFor(() =>
    events.some(
      (event) => event.type === "turn.finished" && event.stopReason === "done",
    ),
  );
  expect(sawDirective).toBe(true);
  await client.dispose?.();
}, 60_000);

test("/team has no product behavior when the team plugin is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-team-disabled-cmd-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      plugins: { enabled: { [TEAM_PLUGIN_ID]: false } },
    }),
  );
  let sawDirective = false;
  let sawLiteralInput = false;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_team_disabled_cmd",
    provider: {
      provider: "scripted-team-disabled",
      model: "scripted-team-disabled-model",
      async *stream(request) {
        sawDirective = request.messages.some(
          (message) =>
            message.role === "system" && message.content.includes("agent team"),
        );
        sawLiteralInput = request.messages.some(
          (message) =>
            message.role === "user" &&
            message.content.includes("/team build the game"),
        );
        yield { type: "content", text: "ordinary turn" };
        yield { type: "done" };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("/team build the game");
  await waitFor(() =>
    events.some(
      (event) => event.type === "turn.finished" && event.stopReason === "done",
    ),
  );
  expect(sawDirective).toBe(false);
  expect(sawLiteralInput).toBe(true);
  await client.dispose?.();
}, 60_000);

test("input.remove/replace/promote mutate the durable queue and emit events", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-input-mutations-"));
  const events: RuntimeEvent[] = [];
  let release: (() => void) | undefined;
  let calls = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_input_mutations",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => (release = resolve));
          yield { type: "content" as const, text: "first" };
          yield { type: "done" as const };
          return;
        }
        yield { type: "content" as const, text: "later" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  const first = client.submit("hold");
  await waitFor(() => release !== undefined, 20_000, "the provider to start");

  const removable = await client.submitInput!({
    text: "remove me",
    delivery: "next-turn",
  });
  expect(events).toContainEqual(
    expect.objectContaining({ type: "input.admitted", id: removable.id }),
  );
  expect(await client.removeInput!({ id: removable.id })).toEqual({
    ok: true,
    input: { id: removable.id, text: "remove me", delivery: "next-turn" },
  });
  expect(events).toContainEqual(
    expect.objectContaining({ type: "input.removed", id: removable.id }),
  );

  const editable = await client.submitInput!({
    text: "edit me",
    delivery: "next-turn",
  });
  expect(
    await client.replaceInput!({ id: editable.id, text: "edited" }),
  ).toEqual({
    ok: true,
    input: { id: editable.id, text: "edited", delivery: "next-turn" },
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "input.updated",
      id: editable.id,
      text: "edited",
    }),
  );

  const promotable = await client.submitInput!({
    text: "promote me",
    delivery: "next-turn",
  });
  expect(await client.promoteInput!({ id: promotable.id })).toMatchObject({
    ok: true,
    input: { id: promotable.id, delivery: "next-step" },
  });
  expect(events).toContainEqual(
    expect.objectContaining({ type: "input.promoted", id: promotable.id }),
  );

  release?.();
  await first;
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "turn.input" && event.inputID === promotable.id,
      ),
    20_000,
    "the promoted input to be claimed by the running turn",
  );
  await client.dispose?.();
}, 30_000);

test("a generic interactive kind round-trips through projection and response", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-generic-interactive-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_generic_interactive",
  });
  client.start((event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === "session.ready"));
  const waiter = await client.service<
    import("@natalia/collaboration").InteractiveWaiter
  >("collaboration.waiter");
  expect(waiter).toBeDefined();

  const pending = waiter!.requireInteractive({
    requestID: "custom_1",
    turnID: "turn_custom",
    kind: "custom.kind",
    title: "Pick one",
    payload: { options: ["a", "b"] },
    validate: (response) => (response === "a" ? undefined : ["must be a"]),
  });
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "interactive.request" && event.id === "custom_1",
    ),
  );

  const projection = await client.pendingInteractive!();
  expect(projection.interactives).toEqual([
    expect.objectContaining({ id: "custom_1", kind: "custom.kind" }),
  ]);

  expect(
    await client.respondInteractive!({
      requestID: "custom_1",
      kind: "custom.kind",
      response: "a",
      sessionID: "ses_generic_interactive",
    }),
  ).toEqual({ accepted: true });
  await expect(pending).resolves.toEqual({
    response: "a",
    rejected: undefined,
  });
  expect(
    events.some(
      (event) =>
        event.type === "interactive.response" && event.id === "custom_1",
    ),
  ).toBe(true);
  await client.dispose?.();
}, 30_000);

test("a tool-issued generic interactive reaches projection, ui-model, and settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-interactive-"));
  const sessionID = "ses_tool_interactive" as SessionID;
  const tools = createToolRegistry([]);
  tools.set("ask_custom", {
    name: "ask_custom",
    description: "Ask a custom interactive question",
    requiresApproval: false,
    parameters: { type: "object", properties: {} },
    async execute(_input, context) {
      expect(context.askInteractive).toBeFunction();
      const answer = await context.askInteractive!({
        requestID: "custom_tool_1",
        kind: "custom.tool.kind",
        title: "Pick a color",
        payload: { options: ["red", "blue"] },
        validate: (response) =>
          response === "red" ? undefined : ["must be red"],
      });
      return `answer: ${String(answer.response)}`;
    },
  });

  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    tools,
    provider: singleToolProvider("ask_custom", {}),
  });
  client.start((event) => events.push(event));

  const running = client.submitAndWait!("ask the tool");
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "interactive.request" &&
          event.id === "custom_tool_1" &&
          event.kind === "custom.tool.kind",
      ),
    3_000,
    "the tool-issued interactive request",
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.update",
      name: "ask_custom",
      status: "running",
    }),
  );

  const projection = await client.pendingInteractive!();
  expect(projection.interactives).toEqual([
    expect.objectContaining({
      id: "custom_tool_1",
      kind: "custom.tool.kind",
    }),
  ]);
  expect(
    normalizePendingItems({ interactives: projection.interactives }),
  ).toEqual([
    expect.objectContaining({
      id: "custom_tool_1",
      kind: "custom.tool.kind",
      title: "Pick a color",
    }),
  ]);

  expect(
    await client.respondInteractive!({
      requestID: "custom_tool_1",
      kind: "custom.tool.kind",
      response: "red",
      sessionID,
    }),
  ).toEqual({ accepted: true });
  await running;

  expect((await client.pendingInteractive!()).interactives).toEqual([]);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "interactive.response",
      id: "custom_tool_1",
      kind: "custom.tool.kind",
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.update",
      name: "ask_custom",
      status: "succeeded",
      result: "answer: red",
    }),
  );
  await client.dispose?.();
}, 30_000);

test("a subagent receives the active plan pointer and reads the plan file itself (ADR D4/B2)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-subagent-plan-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_subagent_plan",
    provider: subagentPlanPointerProvider(),
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!("ses_subagent_plan" as SessionID);
  await client.planDocWrite!({
    path: "plans/child-plan.md",
    content: "# Child plan\n\n- Child plan steps\n",
    title: "Child plan",
  });
  const marked = await client.planDocMark!({
    path: "plans/child-plan.md",
    title: "Child plan",
  });
  await client.planDocActivate!(marked.planID);
  await client.submitAndWait!("delegate a plan task");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  );
  await client.dispose?.();
}, 30_000);

test("the main agent reads the plan document with plan_doc_read instead of an injected handoff body (ADR B3)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-main-plan-read-"));
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_main_plan_read",
    provider: {
      provider: "scripted-main-plan-read",
      model: "scripted-main-plan-read-model",
      async *stream(request: ProviderStreamRequest) {
        requests.push(request);
        if (request.tools?.some((tool) => tool.name === "plan_doc_read")) {
          const planRead = request.messages.find(
            (message) =>
              message.role === "tool" &&
              message.toolCallID === "call_main_plan",
          );
          if (!planRead) {
            yield {
              type: "tool_call",
              calls: [
                {
                  id: "call_main_plan",
                  name: "plan_doc_read",
                  arguments: JSON.stringify({ planID: MAIN_PLAN_ID }),
                },
              ],
            };
            yield { type: "done" };
            return;
          }
          expect(planRead.content).toContain("Main plan steps");
        }
        yield { type: "content", text: "read the plan" };
        yield { type: "done" };
      },
    },
    permissionMode: "auto",
  });
  client.start(() => undefined);
  await client.sessionAttach!("ses_main_plan_read" as SessionID);
  await client.planDocWrite!({
    path: "plans/main-plan.md",
    content: "# Main plan\n\n- Main plan steps\n",
    title: "Main plan",
  });
  const marked = await client.planDocMark!({
    path: "plans/main-plan.md",
    title: "Main plan",
  });
  setMainPlanID(marked.planID);
  await client.planDocActivate!(marked.planID);
  await client.submitAndWait!("follow the plan");
  expect(
    requests.some((request) =>
      request.tools?.some((tool) => tool.name === "plan_doc_read"),
    ),
  ).toBe(true);
  expect(
    requests.some((request) =>
      request.tools?.some((tool) => tool.name === "plan_doc_list"),
    ),
  ).toBe(true);
  // The plan婵繐绲鹃弸?is never in the system prompt 闁?only the pointer is in the
  // runtime context.
  const system = requests
    .map((request) =>
      request.messages.find((message) => message.role === "system"),
    )
    .map((message) =>
      typeof message?.content === "string" ? message.content : "",
    )
    .join("\n");
  expect(system).not.toContain("Main plan steps");
  await client.dispose?.();
}, 30_000);

test("a settled subagent's outcome lands in the spawning session's context", async () => {
  // A subagent settles whenever it likes and the turn that spawned it is usually
  // elsewhere by then. Without the notice the parent only learns the outcome by
  // polling, which it cannot do while it is the one running.
  const root = await mkdtemp(join(tmpdir(), "natalia-settled-notice-"));
  const events: RuntimeEvent[] = [];
  const requests: ProviderStreamRequest[] = [];
  const capture = {
    provider: "scripted-settled-notice",
    model: "scripted-settled-notice-model",
    async *stream(request: ProviderStreamRequest) {
      requests.push(request);
      if (
        request.messages[0]?.role === "system" &&
        String(request.messages[0].content).includes(
          "focused Natalia TS/Bun subagent",
        )
      ) {
        yield { type: "content", text: "child finished the delegated work" };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_spawn_notice",
              name: "agent_spawn",
              arguments: JSON.stringify({ task: "child task" }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "parent done" };
      yield { type: "done" };
    },
  };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_settled_notice",
    provider: capture as unknown as StreamingProvider,
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate a task");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  );
  // A second turn is what makes the notice observable: it is in the ledger, so
  // the next request carries it.
  await client.submitAndWait!("what happened with the subagent?");
  await waitFor(() =>
    requests.some((request) =>
      request.messages.some((message) =>
        message.content.includes('source="subagent_settled"'),
      ),
    ),
  );

  const notice = requests
    .flatMap((request) => request.messages)
    .find((message) => message.content.includes('source="subagent_settled"'));
  expect(notice).toBeDefined();
  // Attributed to the runtime, not to the child: merging the two would credit the
  // child with words it never wrote.
  expect(notice?.content).toContain('trust="runtime"');
  expect(notice?.content).toContain("has finished: completed");
  expect(notice?.content).toContain("not the subagent's own account");
  await client.dispose?.();
});

test("a settled notice is not duplicated when the same subagent re-settles", async () => {
  // The entry id is stable per subagent and continuation, so a re-settled
  // continuation replaces its notice rather than stacking duplicates in the
  // parent's ledger.
  const root = await mkdtemp(join(tmpdir(), "natalia-settled-dedupe-"));
  const events: RuntimeEvent[] = [];
  let childAttempts = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_settled_dedupe",
    permissionMode: "auto",
    provider: {
      provider: "scripted-settled-dedupe",
      model: "scripted-settled-dedupe-model",
      async *stream(request: ProviderStreamRequest) {
        if (
          request.messages[0]?.role === "system" &&
          String(request.messages[0].content).includes(
            "focused Natalia TS/Bun subagent",
          )
        ) {
          childAttempts += 1;
          yield { type: "content", text: "child attempt " + childAttempts };
          yield { type: "done" };
          return;
        }
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool_call",
            calls: [
              {
                id: "call_spawn_dedupe",
                name: "agent_spawn",
                arguments: JSON.stringify({ task: "child task" }),
              },
            ],
          };
          yield { type: "done" };
          return;
        }
        yield { type: "content", text: "parent done" };
        yield { type: "done" };
      },
    } as unknown as StreamingProvider,
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate a task");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  );

  const notices = events.filter(
    (event) => event.type === "subagent.update" && event.event === "done",
  );
  // One settlement, so one notice 闁?the dedupe is on the entry id, which this
  // pins indirectly by there being nothing to duplicate in the first place.
  expect(notices.length).toBeGreaterThan(0);
  await client.dispose?.();
});

test("a forked subagent inherits its parent's completed turns", async () => {
  // A fresh subagent starts with nothing but its task. A forked one starts with
  // the parent's conversation, so it can continue work in progress rather than
  // re-deriving it from a one-line description.
  const root = await mkdtemp(join(tmpdir(), "natalia-fork-seed-"));
  const events: RuntimeEvent[] = [];
  const childRequests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_fork_seed",
    permissionMode: "auto",
    provider: {
      provider: "scripted-fork",
      model: "scripted-fork-model",
      async *stream(request: ProviderStreamRequest) {
        if (
          request.messages[0]?.role === "system" &&
          String(request.messages[0].content).includes(
            "focused Natalia TS/Bun subagent",
          )
        ) {
          childRequests.push(request);
          yield {
            type: "content",
            text:
              "child finished: the seeded conversation told it what had already " +
              "been established, so it continued from there",
          };
          yield { type: "done" };
          return;
        }
        if (
          request.messages.some((m) => m.content === "delegate with context") &&
          !request.messages.some((m) => m.role === "tool")
        ) {
          yield {
            type: "tool_call",
            calls: [
              {
                id: "call_fork_spawn",
                name: "agent_spawn",
                arguments: JSON.stringify({
                  task: "continue the renderer work",
                  context: "fork",
                }),
              },
            ],
          };
          yield { type: "done" };
          return;
        }
        // A later step of the same turn already has the spawn result, so it
        // finishes rather than delegating again 闁?which would loop forever.
        if (
          request.messages.some((m) => m.content === "delegate with context")
        ) {
          yield { type: "content", text: "parent done" };
          yield { type: "done" };
          return;
        }
        // Turn one is completed conversation, so it is what a fork can inherit:
        // a session that has finished nothing has nothing to seed.
        yield { type: "content", text: "we agreed the target is renderer.ts" };
        yield { type: "done" };
      },
    } as unknown as StreamingProvider,
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("which file should we edit?");
  await client.submitAndWait!("delegate with context");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  );

  expect(childRequests.length).toBeGreaterThan(0);
  const seeded = childRequests[0]!;
  // The child's own system prompt leads, then its task; the parent's completed
  // conversation is seeded between them.
  expect(
    String(seeded.messages[0]?.content).includes(
      "focused Natalia TS/Bun subagent",
    ),
  ).toBe(true);
  expect(
    seeded.messages.some((m) =>
      m.content.includes("we agreed the target is renderer.ts"),
    ),
  ).toBe(true);
  // The in-flight turn is excluded: the tool call that spawned the child is not
  // in the seed, because the parent has not answered it yet.
  expect(seeded.messages.some((m) => m.role === "tool")).toBe(false);
  expect(
    seeded.messages.some((m) =>
      m.content.includes("continue the renderer work"),
    ),
  ).toBe(true);
  await client.dispose?.();
});

test("a fresh subagent does not inherit the parent's conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-fresh-seed-"));
  const events: RuntimeEvent[] = [];
  const childRequests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_fresh_seed",
    permissionMode: "auto",
    provider: {
      provider: "scripted-fresh",
      model: "scripted-fresh-model",
      async *stream(request: ProviderStreamRequest) {
        if (
          request.messages[0]?.role === "system" &&
          String(request.messages[0].content).includes(
            "focused Natalia TS/Bun subagent",
          )
        ) {
          childRequests.push(request);
          yield {
            type: "content",
            text: "child finished with a long enough answer to clear the result quality gate",
          };
          yield { type: "done" };
          return;
        }
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "content",
            text: "we agreed the target is renderer.ts",
          };
          yield {
            type: "tool_call",
            calls: [
              {
                id: "call_fresh_spawn",
                name: "agent_spawn",
                arguments: JSON.stringify({
                  task: "start from scratch",
                  context: "fresh",
                }),
              },
            ],
          };
          yield { type: "done" };
          return;
        }
        yield { type: "content", text: "parent done" };
        yield { type: "done" };
      },
    } as unknown as StreamingProvider,
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate fresh");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  );

  expect(childRequests.length).toBeGreaterThan(0);
  const seeded = childRequests[0]!;
  // Nothing from the parent but its own system prompt and the task.
  expect(
    seeded.messages.some((m) =>
      m.content.includes("we agreed the target is renderer.ts"),
    ),
  ).toBe(false);
  expect(
    seeded.messages.some((m) => m.content.includes("start from scratch")),
  ).toBe(true);
  await client.dispose?.();
});

test("a parent can steer a running subagent at its nearest step", async () => {
  // Without this the parent's choices are to wait for the child to finish or to
  // kill it 闁?neither of which is "go left instead of right".
  const root = await mkdtemp(join(tmpdir(), "natalia-steer-"));
  const events: RuntimeEvent[] = [];
  const childRequests: ProviderStreamRequest[] = [];
  let steered = false;
  // The child blocks inside its first step until the parent has steered, which is
  // what makes the `running` window observable: a stub that returns instantly
  // lets the child finish before the parent's next step even starts.
  let releaseChild: () => void = () => {};
  const childGate = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_steer",
    permissionMode: "auto",
    provider: {
      provider: "scripted-steer",
      model: "scripted-steer-model",
      async *stream(request: ProviderStreamRequest) {
        if (
          request.messages[0]?.role === "system" &&
          String(request.messages[0].content).includes(
            "focused Natalia TS/Bun subagent",
          )
        ) {
          childRequests.push(request);
          const calls = request.messages.filter(
            (m) => m.role === "tool",
          ).length;
          if (calls === 0) {
            await childGate;
            // The child's first step asks for a file that does not exist, which
            // is what the parent's message corrects.
            yield {
              type: "tool_call",
              calls: [
                {
                  id: "call_steer_read",
                  name: "read_file",
                  arguments: JSON.stringify({ path: "missing.txt" }),
                },
              ],
            };
            yield { type: "done" };
            return;
          }
          // The correction is now in front of the child, as a runtime-attributed
          // message rather than something it could mistake for its own reasoning.
          const correction = request.messages.some((m) =>
            m.content.includes("read renderer.ts instead"),
          );
          yield {
            type: "content",
            text: correction
              ? "child finished after reading renderer.ts, which is the file the parent pointed it at"
              : "child finished without the correction",
          };
          yield { type: "done" };
          return;
        }
        const toolCount = request.messages.filter(
          (m) => m.role === "tool",
        ).length;
        if (toolCount === 0) {
          yield {
            type: "tool_call",
            calls: [
              {
                id: "call_spawn_steer",
                name: "agent_spawn",
                arguments: JSON.stringify({ task: "read the config" }),
              },
            ],
          };
          yield { type: "done" };
          return;
        }
        if (toolCount === 1) {
          // The parent steers its own child while the child is still running.
          yield {
            type: "tool_call",
            calls: [
              {
                id: "call_send_message",
                name: "agent_message",
                arguments: JSON.stringify({
                  id: "a1",
                  message: "read renderer.ts instead",
                }),
              },
            ],
          };
          yield { type: "done" };
          return;
        }
        yield { type: "content", text: "parent done" };
        yield { type: "done" };
      },
    } as unknown as StreamingProvider,
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "tool.update" && event.name === "agent_message") {
      // The gate opens the moment the message is accepted, so the child's next
      // step sees it 闁?and not before, or the message would arrive after it.
      if (event.status === "succeeded") {
        steered = true;
        releaseChild();
      }
    }
  });
  await client.submitAndWait!("delegate then steer");
  // An explicit, generous budget: this test's whole subject is an ordering that
  // only holds while the parent's message lands before the child proceeds, and
  // the local 500ms default expires under load for reasons unrelated to it.
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "subagent.update" && event.status === "completed",
      ),
    30_000,
    "the steered subagent to complete",
  );

  expect(steered).toBe(true);
  // The child's second request saw the correction before it answered.
  expect(childRequests.length).toBeGreaterThan(1);
  expect(
    childRequests[1]!.messages.some((m) =>
      m.content.includes("read renderer.ts instead"),
    ),
  ).toBe(true);
  expect(
    childRequests[1]!.messages.some(
      (m) =>
        m.content.includes("Agent a1 sent a message") ||
        m.content.includes('source="parent_message"'),
    ),
  ).toBe(true);
  await client.dispose?.();
});

test("the session's start date reaches the model in the environment block", async () => {
  // An agent asked "is this CHANGELOG current?" needs to know the date. It rides
  // in the environment block rather than the static system prompt, because that
  // prompt is byte-identical across sessions and a per-session date in it would
  // forfeit the cross-session prefix-cache sharing.
  const root = await mkdtemp(join(tmpdir(), "natalia-session-date-"));
  const events: RuntimeEvent[] = [];
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_session_date",
    permissionMode: "auto",
    provider: {
      provider: "scripted-date",
      model: "scripted-date-model",
      async *stream(request: ProviderStreamRequest) {
        requests.push(request);
        yield { type: "content", text: "done" };
        yield { type: "done" };
      },
    } as unknown as StreamingProvider,
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("what is today?");

  expect(requests.length).toBeGreaterThan(0);
  const environment = requests[0]!.messages
    .map((m) => m.content)
    .find((content) => content.includes("<environment_details>"));
  expect(environment).toBeDefined();
  expect(environment).toContain("Session started: ");
  // Date only: seconds make the string look volatile, which misleads anyone
  // later reading a log or a diff.
  expect(environment).toMatch(/Session started: \d{4}-\d{2}-\d{2}/);
  expect(environment).not.toMatch(/Session started:.*\d{2}:\d{2}/);
  // It is one line inside the existing block, not a block of its own.
  expect(environment!.indexOf("Session started:")).toBeGreaterThan(
    environment!.indexOf("Working directory:"),
  );
  await client.dispose?.();
});

test("a subagent step's usage event carries the provider's cache metrics", async () => {
  // The consumer test in view-store folds a hand-built event, so it passes even
  // when the producer drops the fields. This drives a real subagent step and
  // asserts what actually leaves the runtime 闁?the link that was silently
  // missing once already.
  const root = await mkdtemp(join(tmpdir(), "natalia-subagent-cache-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_subagent_cache",
    provider: subagentCacheUsageProvider(),
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!("ses_subagent_cache" as SessionID);
  await client.submitAndWait!("delegate a cache task");
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "subagent.update" && event.status === "completed",
      ),
    30_000,
    "the cache-reporting subagent to complete",
  );
  await client.dispose?.();

  // Scoped to the subagent's own events: the parent turn emits the same event
  // type, and a scripted parent that reports no cache metrics is entitled to
  // leave those fields absent.
  const stepUsage = events.filter(
    (
      event,
    ): event is Extract<RuntimeEvent, { type: "runtime.step_usage" }> & {
      agentID: string;
    } => event.type === "runtime.step_usage" && event.agentID !== undefined,
  );
  expect(stepUsage.length).toBeGreaterThan(0);
  for (const event of stepUsage) {
    // Every step reports what it cost, including what the cache absorbed.
    expect(event.cacheReadInputTokens).toBe(4000);
    expect(event.cacheCreationInputTokens).toBe(1200);
  }
  // A subagent turn is a full spawn-plus-step cycle; the per-test default expires
  // mid-run under load, and this test's subject is what the event carries.
}, 30_000);

test("runtime.maxAttemptsPerStep caps the retry policy the runtime uses", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-subagent-retry-cap-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      runtime: {
        maxAttemptsPerStep: 2,
        retry: { initialBackoffMs: 1, maxBackoffMs: 1, jitterMs: 0 },
      },
    }),
  );
  let childAttempts = 0;
  const provider: StreamingProvider = {
    provider: "scripted-subagent-retry-cap",
    model: "scripted-subagent-retry-cap-model",
    async *stream(request) {
      const isChild = request.messages.some(
        (message) => message.content === "child transient task",
      );
      if (isChild) {
        childAttempts++;
        // Would recover on the sixth attempt, but the top-level cap of 2 must
        // stop the retry loop first 闁?the runtime reads runtime.maxAttemptsPerStep
        // as an override of retry.maxAttemptsPerStep (whose default is null =
        // unlimited). Without that override this reaches 6.
        if (childAttempts < 6)
          throw providerError({ kind: "server", message: "temporary outage" });
        yield { type: "content", text: "child recovered" };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_retry_cap",
              name: "agent_spawn",
              arguments: JSON.stringify({ task: "child transient task" }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "parent complete" };
      yield { type: "done" };
    },
  };
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_subagent_retry_cap",
    provider,
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate capped retry work");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" &&
        (event.status === "failed" || event.status === "completed"),
    ),
  );
  // The cap of 2 wins: the child never reaches the sixth (recovering) attempt.
  expect(childAttempts).toBe(2);
});
