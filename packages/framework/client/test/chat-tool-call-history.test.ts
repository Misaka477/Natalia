import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";
import { createTestContext } from "@anthelia/runtime-services";
import { createSessionRecord } from "@anthelia/session";
import { sessionStoreController } from "@anthelia/session-store";
import { attachmentService as attachmentServiceToken } from "@anthelia/attachments";
import { createAttachmentService } from "@anthelia/attachments";
import { defaultConfigV3 } from "@anthelia/config";
import {
  ContextLedger,
  TokenMeter,
  type ProviderStreamRequest,
  type StreamingProvider,
} from "@anthelia/runtime";
import type { RuntimeTool } from "@anthelia/tools";
import { feedSessionFactState } from "@anthelia/substrate";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import { createNaviChatTurn } from "@natalia/collab";

/**
 * The P30 regression: a chat turn that calls a tool must rebuild its history
 * from the WHOLE durable log, not the window the fast-attach path left on the
 * execution.
 *
 * The fast path seeds `exec.session.events` with only the post-epoch tail, and
 * `naviChatHistory` folds exactly what the exec holds. Without a store-backed
 * widening the earlier exchange disappears: the second turn's request body was
 * `[system, user]` — the tool call, its result and the assistant's own text all
 * gone — while the first turn worked because it was built from live memory. On
 * a gateway that validates OpenAI's pairing rules the same shape also produces
 * "tool_calls.id and tool_calls.type are required" (400).
 *
 * This test drives the real turn twice and asserts on the SECOND turn's request
 * body, which is the one built from the rebuilt history.
 */

const TOOL: RuntimeTool = {
  name: "plan_doc_write",
  description: "Write a plan document.",
  requiresApproval: false,
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  async execute() {
    return JSON.stringify({ written: true });
  },
};

type Harness = {
  root: string;
  events: RuntimeEvent[];
  requests: ProviderStreamRequest[];
  exec: SessionExecutionState;
  ctx: RuntimeContext;
  /** The session the exec holds, so a harness can append like the sink does. */
  session: { id: `ses_${string}`; events: RuntimeEvent[] };
  /** The event sink's fact-state feed. */
  feed: (event: RuntimeEvent) => void;
};

async function makeHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-tool-history-"));
  const config = defaultConfigV3();
  config.providers.local = {
    name: "Local",
    driver: "openai",
    enabled: true,
    connection: { apiKey: "test-only" },
    requestDefaults: { stream: true, headers: {}, options: {} },
  };
  config.catalog.providers.local = {
    models: {
      chat: {
        name: "chat",
        status: "stable",
        source: "manual",
        capabilities: {
          toolCall: true,
          reasoning: true,
          thinking: true,
          imageInput: false,
          videoInput: false,
        },
        limits: { contextWindow: "auto", maxOutputTokens: null },
      },
    },
  };
  config.defaultModel = { provider: "local", model: "chat" };

  const events: RuntimeEvent[] = [];
  let sequence = 0;
  let round = 0;
  const requests: ProviderStreamRequest[] = [];
  const provider: StreamingProvider = {
    provider: "fake",
    model: "chat",
    async *stream(request) {
      requests.push(request);
      round += 1;
      if (round === 1) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_plan_1",
              name: "plan_doc_write",
              arguments: '{"path":"p.md"}',
            },
          ],
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "content", text: "documented" };
      yield { type: "done", finishReason: "stop" };
    },
  };
  const attachmentService = createAttachmentService(root);
  // The full-log read the turn performs when the exec is windowed: the same
  // durable log, which is what a real store would answer.
  const harnessSession = () => {
    const session = createSessionRecord(harness.session.id, "t");
    session.events = events;
    return session;
  };
  const harness = {
    session: { id: "ses_chat_tool_history" as `ses_${string}`, events },
    // The event sink's two side effects, in the order the sink performs them.
    feed: (event: RuntimeEvent) => {
      feedSessionFactState(harness.exec, event);
    },
    exec: undefined as unknown as SessionExecutionState,
  };
  const exec = {
    session: harness.session,
    // The fast-attach shape: the exec holds the post-epoch tail only, so the
    // history rebuild must widen it from the store. (The attachments harness
    // uses `fullEventsLoaded: true`, which makes the JSON path return the live
    // array — it has no store-backed load to exercise.)
    fullEventsLoaded: false,
    eventCount: 1,
    tokenMeter: new TokenMeter(),
    naviTokenMeter: new TokenMeter(),
    niaTokenMeter: new TokenMeter(),
    naviChatLedger: new ContextLedger(),
    niaChatLedger: new ContextLedger(),
    naviPendingQueue: [],
    niaPendingQueue: [],
  } as unknown as SessionExecutionState;
  harness.exec = exec;
  const ctx = {
    state: {
      serviceDirectory: createTestContext([
        attachmentServiceToken.mock(attachmentService),
        sessionStoreController.mock({
          status: () => ({ initialized: true, mode: "json" as const }),
          flush: async () => undefined,
          loadFullAsync: async () => harnessSession(),
          eventsAfter: () => [],
          loadProjectionCheckpoint: () => undefined,
          // The fact state's paging read: one page of the durable log.
          history: async () => ({
            events: harnessSession().events.map((event, index) => ({
              event,
              seq: index + 1,
            })),
            hasMore: false,
          }),
        } as never),
      ]),
    },
    ports: {
      getTsRuntimeConfig: () => config,
      getContextWindowResolver: () => ({
        resolve: async () => ({ contextWindow: 200_000, source: "test" }),
      }),
      resolveContextStatusConfig: async () => ({
        max: 200_000,
        thresholdPercent: 85,
        reserved: 20_000,
      }),
      modelRefKeyForSelection: () => "local/chat",
      getChatDefaultProvider: () => provider,
      providerFromEnvironment: () => undefined,
      publishForSession: (_exec: unknown, event: RuntimeEvent) => {
        // The real sink appends to the session the exec holds AND feeds the
        // incremental fact state; the harness must do both, or a full-log load
        // replaces exec.session.events with a snapshot and the two diverge.
        events.push(event);
        harness.session.events.push(event);
        harness.feed(event);
      },
      nextChatSequence: () => sequence++,
      nextPlanSequence: () => sequence++,
      naviChatPersona: () => "<navi_chat_persona>Navi</navi_chat_persona>",
      naviChatLiveContext: () => "",
      niaChatPersona: () => "<nia_chat_persona>Nia</nia_chat_persona>",
      niaChatLiveContext: () => "",
      naviChatTools: () => [TOOL],
      niaChatTools: () => [TOOL],
      effectiveMaxSteps: () => 3,
      redactToolOutput: (text: string) => text,
      getWorkspaceRoot: () => root,
      getReady: async () => undefined,
      chatToolSummary: (toolName: string) => `summary of ${toolName}`,
      // The card projection a Chat publisher makes (R4): the real wiring
      // reads the tool's output definition, so the harness does the same
      // rather than stubbing it away.
      chatToolCard: (
        output:
          | {
              presentResult?: (
                args: unknown,
                value: string,
                meta?: Record<string, unknown>,
              ) => unknown;
              presentationMeta?: (args: unknown, value: string) => unknown;
            }
          | undefined,
        args: Record<string, unknown>,
        result: string,
      ) => {
        if (!output) return {};
        const meta = output.presentationMeta?.(args, result) as
          | Record<string, unknown>
          | undefined;
        const card = output.presentResult?.(args, result, meta);
        return {
          ...(card ? { card } : {}),
          ...(meta ? { meta } : {}),
        };
      },
      resolveService: (name: string) =>
        name === attachmentServiceToken.id ? attachmentService : undefined,
      getSessionPersistenceForSession: () => Promise.resolve(),
    },
  } as unknown as RuntimeContext;
  return {
    root,
    events,
    requests,
    exec,
    ctx,
    session: harness.session,
    feed: harness.feed,
  };
}

/** Every role:"tool" message must be paired by an assistant toolCalls entry. */
function danglingToolMessages(messages: ProviderStreamRequest["messages"]) {
  const openCalls = new Set<string>();
  const dangling: string[] = [];
  for (const message of messages) {
    const role = String(message.role);
    if (role === "assistant") {
      for (const call of message.toolCalls ?? []) openCalls.add(call.id);
      continue;
    }
    if (role !== "tool") continue;
    const raw = message as { toolCallID?: string; tool_call_id?: string };
    const id = raw.toolCallID ?? raw.tool_call_id;
    if (!id) dangling.push("a tool result with no id");
    else if (!openCalls.has(id))
      dangling.push(`a result for ${id} with no call`);
  }
  return dangling;
}

test("the second turn's request body keeps the first turn's tool exchange", async () => {
  const harness = await makeHarness();
  const navi = createNaviChatTurn(harness.ctx);
  const turn = (text: string, id: string) => ({
    text,
    responseMessageID: id,
    exec: harness.exec,
    internal: true,
  });
  // The surface publishes the user's message before the turn runs; the
  // rebuild then sees the question it is answering.
  const userMessage = (text: string, id: string) => {
    const event = {
      type: `${"navi"}.chat.message.new`,
      id: `${id}:user`,
      messageID: `${id}:user`,
      role: "user",
      text,
      at: new Date().toISOString(),
    } as RuntimeEvent;
    harness.events.push(event);
    harness.session.events.push(event);
    harness.feed(event);
  };

  userMessage("document this", "navi-chat:1");
  await navi.runNaviChatTurn(
    turn("document this", "navi-chat:1"),
    new AbortController().signal,
  );
  userMessage("and that is enough", "navi-chat:2");
  await navi.runNaviChatTurn(
    turn("and that is enough", "navi-chat:2"),
    new AbortController().signal,
  );

  // (1) turn one's tool call, (2) turn one's final answer, (3) turn two's
  // request — the only one built from the rebuilt history.
  expect(harness.requests).toHaveLength(3);
  const second = harness.requests[2]!;
  const roles = second.messages.map((message) => String(message.role));
  // The earlier exchange must still be there: an assistant that called a tool
  // and the tool's result, properly paired with it.
  // system, the earlier question, this turn's question, the assistant that
  // called the tool, the tool's result, and this turn's runtime context.
  expect(roles).toEqual([
    "system",
    "user",
    "user",
    "assistant",
    "tool",
    "user",
    "user",
  ]);
  expect(danglingToolMessages(second.messages), roles.join(",")).toEqual([]);
  const assistant = second.messages.find(
    (m) => String(m.role) === "assistant",
  )!;
  expect(assistant.toolCalls?.map((call) => call.id)).toEqual(["call_plan_1"]);
  const result = second.messages.find((m) => String(m.role) === "tool")!;
  expect(String(result.content)).toContain("written");
});
