// The shared prelude and helpers of the real-runtime suite, split out
// when the suite became five parallel CI jobs: one harness imported by
// every file, so a helper exists once. Not a test file — no test().

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp as createEmptyWorkspace,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
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

// The governance-root override below is process-global, so this file restores
// the ambient value when it ends: without the restore, every later test file's
// runtime in the same bun process reads and writes its constitution into the
// last workspace's ledger — cross-file state leakage the hygiene guard caught
// as a recreated governance directory.
export const ambientGovernanceRoot = process.env.NATALIA_TEST_GOVERNANCE_ROOT;

afterAll(() => {
  if (ambientGovernanceRoot === undefined)
    delete process.env.NATALIA_TEST_GOVERNANCE_ROOT;
  else process.env.NATALIA_TEST_GOVERNANCE_ROOT = ambientGovernanceRoot;
});

export const MCP_PLUGIN_ID = "natalia-mcp";

export const SKILLS_PLUGIN_ID = "natalia-skills";

export const TEAM_PLUGIN_ID = "natalia-team";

export const TODO_PLUGIN_ID = "natalia-tool-todo";

export function createRealRuntimeClient(
  options: Parameters<typeof createRuntimeClient>[0] = {},
) {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  restoreOfficialPluginConfig(workspaceRoot);
  const globalConfigPath =
    options.globalConfigPath ??
    join(workspaceRoot, ".natalia-test-global.json");
  const projectPath = join(workspaceRoot, ".natalia", "config.json");
  if (
    !options.globalConfigPath &&
    !existsSync(globalConfigPath) &&
    existsSync(projectPath)
  ) {
    const project = JSON.parse(readFileSync(projectPath, "utf8")) as Record<
      string,
      unknown
    >;
    const modelConfig = Object.fromEntries(
      ["providers", "catalog", "modelOverrides", "defaultModel"].flatMap(
        (key) => (Object.hasOwn(project, key) ? [[key, project[key]]] : []),
      ),
    );
    if (Object.keys(modelConfig).length) {
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(globalConfigPath, JSON.stringify(modelConfig));
    }
  }
  // Keep each test workspace's governance ledger isolated. The default
  // governance root is derived from the plugin store and would otherwise be
  // shared across every tmp workspace, allowing records/overrides from one
  // test to leak into the next.
  // Normal tests get a per-workspace governance ledger so records from one
  // tmp workspace cannot leak into the next. Tests that deliberately exercise
  // a shared/custom governance store pass pluginStoreRoot and manage the env
  // themselves.
  if (!options.pluginStoreRoot) {
    // `basename`, NOT `workspaceRoot.split("/").pop()`.
    //
    // The split form assumed a POSIX separator. On Windows it does not cut at
    // all, so `.pop()` returned the ENTIRE absolute path and the governance root
    // became a directory whose name contained a drive letter and colons:
    //   …\.natalia-test-governance-E:\…\client-test-workspaces\<tmpdir>
    // which mkdir refuses (ENOENT / invalid name). Every real-runtime test that
    // does not pass an explicit pluginStoreRoot hit it on Windows, which is the
    // same Windows-path-separator family that has cost this project four times.
    const suffix = basename(workspaceRoot) || "workspace";
    const governanceRoot = join(
      workspaceRoot,
      "..",
      `.natalia-test-governance-${suffix}`,
    );
    process.env.NATALIA_TEST_GOVERNANCE_ROOT = governanceRoot;
    // The governance ledger lives beside the workspace so it survives a
    // workspace relocation; that also puts it outside the workspace removal,
    // so register it for the helper's per-file sweep or it leaks one directory
    // per test into the shared test-workspaces root.
    registerTestArtifact(governanceRoot);
  }
  return createOfficialRuntimeClient({
    ...options,
    globalConfigPath,
  });
}

// The standalone workflow engine is gone, so a workflow step can no longer be
// the carrier for these two protections. They are still real for direct tool
// calls, so the coverage moves to the direct path instead of disappearing.
test("sandbox merge retains manifest path authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sandbox-merge-policy-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      sandbox: { promoteCommand: "true" },
      defaultAgent: "review",
      agents: {
        review: {
          description: "Review",
          permissions: {
            files: {
              writePaths: [
                {
                  pattern: "protected.txt",
                  allow: false,
                  reason: "protected by agent policy",
                },
              ],
            },
          },
        },
      },
    }),
  );
  const sandboxes = new WorkspaceSandboxManager(
    join(root, ".natalia", "sandboxes"),
  );
  await sandboxes.create("box");
  await sandboxes.write("box", "allowed.txt", "allowed");
  await sandboxes.write("box", "protected.txt", "protected");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_sandbox_merge_policy",
    permissionMode: "auto",
    provider: singleToolProvider("sandbox_merge", { id: "box" }),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("merge the sandbox");

  const failure = events.find(
    (event): event is Extract<RuntimeEvent, { type: "tool.update" }> =>
      event.type === "tool.update" &&
      event.name === "sandbox_merge" &&
      event.status === "failed",
  );
  expect(failure?.summary).toContain("protected by agent policy");
  // A refused path must not let the rest of the merge land either.
  await expect(
    readFile(join(root, "allowed.txt"), "utf8"),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    readFile(join(root, "protected.txt"), "utf8"),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
  await client.dispose?.();
});

// Two durable turns with a live approval in between: seconds of real work,
// and the file's accumulated state makes the default 5s per-test budget a
// load lottery rather than a measurement.
test("session approval grants the approved tool for this runtime instance only", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-approval-"));
  let approvalCount = 0;
  const provider: StreamingProvider = {
    provider: "session-approval",
    model: "session-approval",
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
    sessionID: "ses_session_approval",
    provider,
  });
  client.start((event) => {
    if (event.type !== "approval.request") return;
    approvalCount++;
    client.respondApproval({ requestID: event.id, decision: "session" });
  });
  await client.submitAndWait!("run pwd once");
  await client.submitAndWait!("run pwd again");
  expect(approvalCount).toBe(1);
  await client.dispose?.();

  const reopenedApprovals: RuntimeEvent[] = [];
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_session_approval",
    provider,
  });
  reopened.start((event) => {
    reopenedApprovals.push(event);
    if (event.type === "approval.request")
      reopened.respondApproval({ requestID: event.id, decision: "once" });
  });
  await reopened.submitAndWait!("run pwd after restart");
  expect(reopenedApprovals).toContainEqual(
    expect.objectContaining({ type: "approval.request" }),
  );
  await reopened.dispose?.();
}, 30_000);

export function scriptedProvider(text: string): StreamingProvider {
  return {
    provider: "scripted",
    model: "scripted-model",
    async *stream(_request: ProviderStreamRequest) {
      yield { type: "content", text };
      yield { type: "done" };
    },
  };
}

export function singleToolProvider(
  name: string,
  arguments_: unknown,
): StreamingProvider {
  return {
    provider: "scripted-single-tool",
    model: "scripted-single-tool-model",
    async *stream(request: ProviderStreamRequest) {
      if (!request.messages.some((message) => message.role === "tool"))
        yield {
          type: "tool_call",
          calls: [
            {
              id: "single",
              name,
              arguments: JSON.stringify(arguments_),
            },
          ],
        };
      yield { type: "done" };
    },
  };
}

export function interactiveTerminalProvider(): StreamingProvider {
  return {
    provider: "scripted-interactive-terminal",
    model: "scripted-interactive-terminal-model",
    async *stream(request) {
      if (!request.messages.some((message) => message.role === "tool"))
        yield {
          type: "tool_call",
          calls: [
            {
              id: "start",
              name: "interactive_terminal_start",
              arguments: JSON.stringify({
                id: "tty_management",
                command: "cat",
              }),
            },
          ],
        };
      yield { type: "done" };
    },
  };
}

export function usageProvider(): StreamingProvider {
  return {
    provider: "scripted-usage",
    model: "scripted-usage-model",
    async *stream(_request: ProviderStreamRequest) {
      yield { type: "content", text: "usage ok" };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "done" };
    },
  };
}

export function contextLimitThenSuccessProvider(): StreamingProvider & {
  calls: number;
} {
  return {
    provider: "scripted-context-limit",
    model: "scripted-context-limit-model",
    calls: 0,
    async *stream(this: StreamingProvider & { calls: number }) {
      this.calls++;
      if (this.calls === 1)
        throw providerError({
          kind: "context_limit",
          message: "context length exceeded",
        });
      yield { type: "content", text: "recovered" };
      yield { type: "done" };
    },
  };
}

export function toolCallingProvider(): StreamingProvider & {
  requests: ProviderStreamRequest[];
} {
  const requests: ProviderStreamRequest[] = [];
  return {
    provider: "scripted-tools",
    model: "scripted-tool-model",
    requests,
    async *stream(request: ProviderStreamRequest) {
      requests.push(request);
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_read",
              name: "read_file",
              arguments: JSON.stringify({ path: "input.txt" }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "tool said: tool data" };
      yield { type: "done" };
    },
  };
}

export function writeFileProvider(): StreamingProvider {
  return {
    provider: "scripted-write",
    model: "scripted-write-model",
    async *stream(request: ProviderStreamRequest) {
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_write",
              name: "write_file",
              arguments: JSON.stringify({
                path: "hello-ts7.txt",
                content: "hello from TS7\n",
              }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "file created" };
      yield { type: "done" };
    },
  };
}

export function approvalWriteProvider(): StreamingProvider {
  return {
    provider: "scripted-approval-write",
    model: "scripted-approval-write-model",
    async *stream(request: ProviderStreamRequest) {
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_approval_write",
              name: "write_file",
              arguments: JSON.stringify({
                path: "long-note.md",
                content: "long content ".repeat(100),
              }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "file created" };
      yield { type: "done" };
    },
  };
}

export function questionToolProvider(): StreamingProvider {
  return {
    provider: "scripted-question",
    model: "scripted-question-model",
    async *stream(request: ProviderStreamRequest) {
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_question",
              name: "ask_user",
              arguments: JSON.stringify({
                question: "Continue?",
                options: ["yes", "no"],
              }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "answer received" };
      yield { type: "done" };
    },
  };
}

export function delayedStreamingProvider(): StreamingProvider {
  return {
    provider: "scripted-delayed",
    model: "scripted-delayed-model",
    async *stream(_request: ProviderStreamRequest) {
      yield { type: "content", text: "first " };
      await Bun.sleep(80);
      yield { type: "content", text: "second" };
      yield { type: "done" };
    },
  };
}

export function subagentProvider(): StreamingProvider {
  return {
    provider: "scripted-subagent",
    model: "scripted-subagent-model",
    async *stream(request: ProviderStreamRequest) {
      if (
        request.messages[0]?.role === "system" &&
        String(request.messages[0].content).includes(
          "focused Natalia TS/Bun subagent",
        )
      ) {
        yield { type: "thinking", text: "checking the delegated task" };
        yield { type: "content", text: "child result" };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_subagent",
              name: "agent_spawn",
              arguments: JSON.stringify({ task: "child task" }),
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
}

export function subagentCompactionProvider(): StreamingProvider & {
  compactionCalls: number;
} {
  let compactionCalls = 0;
  return {
    provider: "scripted-subagent-compaction",
    model: "scripted-subagent-compaction-model",
    get compactionCalls() {
      return compactionCalls;
    },
    async *stream(request: ProviderStreamRequest) {
      // Round 12 made the summarization call replay the span, so its
      // instruction rides as the final message rather than in a leading system
      // message — that is what identifies this call now.
      if (
        request.messages
          .at(-1)
          ?.content?.includes("Summarize this Natalia agent session")
      ) {
        compactionCalls += 1;
        // Must satisfy the summary contract (every required section and the
        // minimum length): a shorter answer is regenerated and then rejected,
        // which fails the compaction this test is trying to observe.
        yield {
          type: "content",
          text: [
            "## Objective",
            "- Compact the child's context so the compaction runs against the active provider.",
            "",
            "## Important Details",
            "- The summarization call is a provider call like any other.",
            "",
            "## Work State",
            "### Completed",
            "- Read readable.txt.",
            "",
            "### Active",
            "- Finishing the compacted child turn.",
            "",
            "### Blocked",
            "- (none)",
            "",
            "## Next Move",
            "1. Return the compacted result to the parent.",
            "",
            "## Relevant Files",
            "- readable.txt: the file the child read.",
          ].join("\n"),
        };
        yield { type: "done" };
        return;
      }
      const hasCompactedSummary = request.messages.some((message) =>
        message.content.includes("Natalia compacted context summary"),
      );
      const isChild =
        (hasCompactedSummary ||
          (request.messages[0]?.role === "system" &&
            request.messages[0].content.includes(
              "focused Natalia TS/Bun subagent",
            ))) &&
        request.messages.some((message) =>
          message.content.includes("child compaction task"),
        );
      if (
        isChild &&
        !request.messages.some((message) => message.role === "tool")
      ) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_child_read_for_compaction",
              name: "read_file",
              arguments: JSON.stringify({ path: "readable.txt" }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      if (isChild) {
        // Short on purpose: it is under the result-quality gate's minimum, so
        // the gate spends one more turn asking for detail. That turn is a second
        // user message, and it is what gives this single-turn child a history
        // worth compacting — the preserved tail always reaches back to the last
        // user message, so a child with only its task has nothing before it but
        // the protected system head.
        yield { type: "content", text: "child compacted result" };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_spawn_compacted_child",
              name: "agent_spawn",
              arguments: JSON.stringify({ task: "child compaction task" }),
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
}

export function subagentToolProvider(): StreamingProvider {
  return {
    provider: "scripted-subagent-tools",
    model: "scripted-subagent-tools-model",
    async *stream(request: ProviderStreamRequest) {
      const isChild = request.messages.some(
        (message) => message.content === "child file task",
      );
      if (
        isChild &&
        !request.messages.some((message) => message.role === "tool")
      ) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_child_write",
              name: "write_file",
              arguments: JSON.stringify({
                path: "agent-test.txt",
                content: "agent test success",
              }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      if (isChild) {
        yield { type: "content", text: "created agent-test.txt successfully" };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_subagent_tools",
              name: "agent_spawn",
              arguments: JSON.stringify({ task: "child file task" }),
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
}

export function subagentRawXMLToolProvider(): StreamingProvider {
  return {
    provider: "scripted-subagent-raw-xml",
    model: "scripted-subagent-raw-xml-model",
    async *stream(request: ProviderStreamRequest) {
      const isChild = request.messages.some(
        (message) => message.content === "child raw XML file task",
      );
      if (
        isChild &&
        !request.messages.some((message) => message.role === "tool")
      ) {
        yield {
          type: "content",
          text: [
            "Inspecting. ",
            "<tool_call><function=write_file>",
            "<parameter=path>&quot;agent-raw-xml.txt&quot;</parameter>",
            "<parameter=content>&quot;raw XML child success&quot;</parameter>",
            "</function></tool_call>",
          ].join(""),
        };
        yield { type: "done" };
        return;
      }
      if (isChild) {
        yield { type: "content", text: "created the raw XML child file" };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_subagent_raw_xml",
              name: "agent_spawn",
              arguments: JSON.stringify({ task: "child raw XML file task" }),
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
}

/**
 * Waits for a condition. The default budget is generous for the same
 * reason waitForAsync's is: this file's conditions routinely cross
 * process boundaries (a settle on disk, a wake that has to run), and a
 * 500ms default was a lottery under the concurrent suite — a different
 * victim every run. The 60s per-test cap still bounds a genuine hang.
 */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 20_000,
  label = "condition",
) {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 10) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export async function waitForProcessExit(pid: number, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
}

/** Re-pins a family's trust record to the promoted bytes (the promotion step). */
export async function fingerprintEntry(
  workspaceRoot: string,
  entryPath: string,
) {
  await recordTrust(workspaceRoot, {
    key: resolve(entryPath, ".."),
    source: resolve(entryPath, ".."),
    fingerprint: await fingerprintFile(entryPath),
    installedAt: new Date().toISOString(),
  });
}

export type NamespacedCollabMessageEvent = Extract<
  RuntimeEvent,
  {
    type:
      | "natalia.collab.message"
      | "navi.collab.message"
      | "nia.collab.message";
  }
>;

export function isCollabMessageEvent(
  event: RuntimeEvent,
): event is NamespacedCollabMessageEvent {
  return event.type.endsWith(".collab.message");
}

/** Polls until an async predicate holds (the runtime wakes turns asynchronously). */
/**
 * Waits for a durable condition. The default budget is deliberately
 * generous: these conditions cross process boundaries (a settle on disk,
 * a wake that has to run), and this file runs for minutes inside a
 * concurrent suite — a 3s default was a load lottery that failed a
 * different test on every run. The per-test cap (60s) is what still
 * bounds a genuine hang.
 */
export async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000,
) {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 50) {
    if (await predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error("timed out waiting for async condition");
}

/** Polls the attached session's history until a turn has settled on disk. */
export async function pollHistoryForFinished(
  client: ReturnType<typeof createRealRuntimeClient>,
  timeoutMs = 20_000,
) {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 50) {
    // A larger window than 100: seeded constitution rules and session
    // snapshots are durable events too, so a turn's `turn.finished` can sit
    // beyond a 100-event window and must not look like the turn never settled.
    const history = await client.history?.({ limit: 1000 });
    if (history?.events.some((entry) => entry.event.type === "turn.finished"))
      return;
    await Bun.sleep(50);
  }
  throw new Error("timed out waiting for a settled turn in history");
}

export function sqliteContinueProvider(): StreamingProvider {
  return {
    provider: "sqlite-continue",
    model: "sqlite-continue",
    async *stream(request) {
      const userText = String(
        [...request.messages]
          .reverse()
          .find((message) => message.role === "user")?.content ?? "",
      );
      if (userText.includes("automated continuation")) {
        yield { type: "content" as const, text: "Continuing after the human." };
        yield { type: "done" as const };
        return;
      }
      // Which step this is, counted rather than sniffed: a tool message's
      // content is a parts array, so `String(content)` is "[object Object]" and
      // a substring test against it is a coin flip. Counting the tool results
      // already in the request is the same information, deterministically.
      const toolResults = request.messages.filter(
        (message) => message.role === "tool",
      ).length;
      if (toolResults === 0) {
        // Start the pane FIRST: the pane it later asks a human about has to
        // exist. The fork registry used to pre-create it as a fixture; with the
        // host gone the runtime's own pty controller makes it here, so the id
        // this call names is a pane the runtime really owns.
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_start",
              name: "interactive_terminal_start",
              arguments: JSON.stringify({
                command: "cat",
                id: "rh_sqlite",
              }),
            },
          ],
        };
        return;
      }
      if (toolResults === 1) {
        // The pane exists now; ask the human about it.
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_rh",
              name: "interactive_terminal_request_human",
              arguments: JSON.stringify({
                id: "rh_sqlite",
                reason: "needs the sudo password",
                endTurn: true,
              }),
            },
          ],
        };
        return;
      }
      yield { type: "content" as const, text: "Waiting for the human." };
      yield { type: "done" as const };
    },
  };
}

export function sandboxedSubagentProvider(): StreamingProvider {
  return {
    provider: "scripted-sandboxed-subagent",
    model: "scripted-sandboxed-subagent-model",
    async *stream(request: ProviderStreamRequest) {
      const isChild = request.messages.some(
        (message) => message.content === "child sandbox file task",
      );
      const contractRead = request.messages.find(
        (message) =>
          message.role === "tool" &&
          message.toolCallID === "call_sandbox_child_read",
      );
      const childWrite = request.messages.some(
        (message) =>
          message.role === "tool" &&
          message.toolCallID === "call_sandbox_child_write",
      );
      if (isChild && !contractRead) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_sandbox_child_read",
              name: "read_file",
              arguments: JSON.stringify({
                path: "CONTRACT.md",
              }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      if (isChild && !childWrite) {
        // A fixture must not ASSERT inside the system under test: this
        // `expect` used to run inside the provider generator, so a drift in
        // read_file's result shape threw INSIDE the child's stream — and the
        // retry service then re-ran the same step forever (CI measured 18
        // identical `step 2 calling provider` calls before the 60s budget),
        // which reads as a hang rather than as the assertion that failed.
        // The drift is now RECORDED and the flow continues, so a shape change
        // shows up as a visible mismatch at the next expectation, and the
        // full content is carried in the drift record for the failure output.
        // The child's read result carries the tool's window facts as an
        // envelope (read_file returns JSON text on the kernel's string
        // contract, the same as glob and grep). Compare the PAGE, not the
        // spelling: parse the envelope when it is one, and compare the inner
        // content. Measured on CI: the child's content is exactly
        // `{"content":"shared contract","totalLines":1,"truncated":false}` —
        // the windowed read working as designed.
        const childReadContent = (() => {
          const raw = contractRead?.content;
          if (typeof raw !== "string") return raw;
          try {
            const parsed = JSON.parse(raw) as { content?: unknown };
            return typeof parsed.content === "string" ? parsed.content : raw;
          } catch {
            return raw;
          }
        })();
        // The page, with or without the file's trailing newline: the windowed
        // read joins lines (no trailing separator), the pre-window spelling
        // carried it. Both are the same page.
        if (typeof childReadContent === "string"
          ? childReadContent.replace(/\n$/u, "") !== "shared contract"
          : childReadContent !== "shared contract")
          (
            globalThis as { __nataliaChildReadDrift?: unknown }
          ).__nataliaChildReadDrift = contractRead?.content;
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_sandbox_child_write",
              name: "write_file",
              arguments: JSON.stringify({
                path: "agent-test.txt",
                content: "sandbox agent test success",
              }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      if (isChild) {
        yield {
          type: "content",
          text: "created agent-test.txt successfully",
        };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_sandbox_subagent",
              name: "agent_spawn",
              arguments: JSON.stringify({
                task: "child sandbox file task",
                mode: "sandbox",
              }),
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
}

export function sandboxedDomainProvider(): StreamingProvider {
  return {
    provider: "scripted-sandboxed-domain",
    model: "scripted-sandboxed-domain-model",
    async *stream(request: ProviderStreamRequest) {
      const isChild = request.messages.some(
        (message) => message.content === "child domain task",
      );
      const domainError = request.messages.find(
        (message) =>
          message.role === "tool" && message.toolCallID === "call_domain_write",
      );
      const recoveredWrite = request.messages.some(
        (message) =>
          message.role === "tool" &&
          message.toolCallID === "call_domain_recovery",
      );
      if (isChild && !domainError) {
        // The child tries to write outside its file domain.
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_domain_write",
              name: "write_file",
              arguments: JSON.stringify({
                path: "forbidden/x.txt",
                content: "should be refused",
              }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      if (isChild && !recoveredWrite) {
        expect(domainError?.content).toContain("ERROR:");
        expect(domainError?.content).toContain("outside file domain");
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_domain_recovery",
              name: "write_file",
              arguments: JSON.stringify({
                path: "allowed/recovered.txt",
                content: "recovered after tool error",
              }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      if (isChild) {
        yield { type: "content", text: "recovered from denied write" };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_domain_spawn",
              name: "agent_spawn",
              arguments: JSON.stringify({
                task: "child domain task",
                mode: "sandbox",
                writePaths: ["allowed"],
              }),
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
}

export function imageAttachProvider(): StreamingProvider {
  let calls = 0;
  return {
    provider: "scripted-image",
    model: "scripted-image-model",
    async *stream(request: ProviderStreamRequest) {
      calls++;
      if (calls === 1) {
        // Main turn: the model decides to look at its own screenshot.
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_image",
              name: "image_read",
              arguments: JSON.stringify({ path: "shot.png" }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      // Second step: the attached image must be in the messages the model sees.
      const hasImage = request.messages.some(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.images) &&
          (message.images as unknown[]).length > 0,
      );
      yield {
        type: "content",
        text: hasImage ? "saw my screenshot" : "no image",
      };
      yield { type: "done" };
    },
  };
}

export function subagentPlanPointerProvider(): StreamingProvider {
  return {
    provider: "scripted-subagent-plan",
    model: "scripted-subagent-plan-model",
    async *stream(request: ProviderStreamRequest) {
      const isChild = request.messages.some(
        (message) => message.content === "child plan task",
      );
      if (isChild) {
        const planPointer = request.messages.find(
          (message) =>
            message.role === "user" &&
            message.content.includes('<runtime_context source="plan_ptr"'),
        );
        if (!planPointer)
          throw new Error(
            "subagent request is missing the plan_ptr runtime context",
          );
        const planRead = request.messages.find(
          (message) =>
            message.role === "tool" && message.toolCallID === "call_child_plan",
        );
        if (!planRead) {
          yield {
            type: "tool_call",
            calls: [
              {
                id: "call_child_plan",
                name: "read_file",
                arguments: JSON.stringify({
                  path: ".natalia/plans/plans/child-plan.md",
                }),
              },
            ],
          };
          yield { type: "done" };
          return;
        }
        expect(planRead.content).toContain("Child plan steps");
        yield {
          type: "content",
          text: "read the plan document from the pointer",
        };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_subagent_plan",
              name: "agent_spawn",
              arguments: JSON.stringify({ task: "child plan task" }),
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
}

export let MAIN_PLAN_ID = "";

/**
 * The assignment point for the main-plan id. Module bindings are
 * read-only across files, so the file that creates the plan sets it
 * through here; every other file reads the live binding.
 */
export function setMainPlanID(id: string) {
  MAIN_PLAN_ID = id;
}

export function subagentCacheUsageProvider(): StreamingProvider {
  return {
    provider: "scripted-subagent-cache",
    model: "scripted-subagent-cache-model",
    async *stream(request) {
      const isChild = request.messages.some(
        (message) => message.content === "child cache task",
      );
      if (isChild) {
        yield {
          type: "usage",
          inputTokens: 10_000,
          outputTokens: 50,
          // A warm cache on the child's own prefix: read is large, write is small.
          cacheReadInputTokens: 4_000,
          cacheCreationInputTokens: 1_200,
        };
        yield {
          type: "content",
          text:
            "child finished with a warm prefix cache: the step read 4000 cached " +
            "tokens and wrote 1200, and both figures must survive the trip from " +
            "the provider chunk to the session's usage totals",
        };
        yield { type: "done" };
        return;
      }
      // The parent spawns on its first request, then answers once the tool result
      // is back — the same two-phase shape the other subagent tests use.
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_spawn_cache",
              name: "agent_spawn",
              arguments: JSON.stringify({ task: "child cache task" }),
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
}
