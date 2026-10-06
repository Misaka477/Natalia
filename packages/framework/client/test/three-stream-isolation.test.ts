import { expect, test } from "bun:test";
import type {
  ProviderStreamRequest,
  StreamingProvider,
} from "@anthelia/runtime";
import type { RuntimeEvent } from "@anthelia/contracts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRealRuntimeClient } from "../src";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();

type ChatRequest = {
  channel: "navi" | "nia";
  request: ProviderStreamRequest;
};

type Gate = {
  promise: Promise<void>;
  release: () => void;
};

type StreamGate = Gate & {
  started: Promise<void>;
  markStarted: () => void;
};

function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function streamGate(): StreamGate {
  const blocked = gate();
  const entered = gate();
  return { ...blocked, started: entered.promise, markStarted: entered.release };
}

function releaseAll(gates: Map<string, StreamGate>) {
  for (const value of gates.values()) value.release();
}

async function waitForGateOrAbort(gate: Gate, signal: AbortSignal | undefined) {
  if (!signal) return gate.promise;
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  await Promise.race([
    gate.promise,
    new Promise<void>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(signal.reason ?? new Error("aborted")),
        { once: true },
      );
    }),
  ]);
}

function eventType(event: RuntimeEvent): string {
  return event.type;
}

function chatMessages(request: ProviderStreamRequest) {
  return request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role, content: message.content }));
}

function providerForChat(
  requests: ChatRequest[],
  gates: Map<string, StreamGate>,
): StreamingProvider {
  return {
    provider: "test-chat",
    model: "test-chat-model",
    async *stream(request) {
      const system = String(request.messages[0]?.content ?? "");
      const channel = system.includes("<nia_chat_persona>") ? "nia" : "navi";
      requests.push({ channel, request });
      const prompt = request.messages.findLast(
        (message) => message.role === "user",
      )?.content;
      const wait = gates.get(channel);
      yield { type: "thinking" as const, text: `${channel}-thinking:` };
      wait?.markStarted();
      if (wait) await waitForGateOrAbort(wait, request.signal);
      if (request.signal?.aborted)
        throw request.signal.reason ?? new Error("aborted");
      yield { type: "content" as const, text: `${channel}:${prompt}` };
      yield {
        type: "usage" as const,
        inputTokens: 11,
        outputTokens: 7,
      };
      yield { type: "done" as const };
    },
  };
}

async function makeClient(
  suffix: string,
  requests: ChatRequest[],
  gates: Map<string, StreamGate>,
  options?: { maxStepsPerTurn?: number },
) {
  const root = await officialPluginWorkspace(`three-stream-${suffix}`);
  if (options?.maxStepsPerTurn)
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({
        version: 3,
        runtime: { maxStepsPerTurn: options.maxStepsPerTurn },
      }),
    );
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: `ses_three_stream_${suffix}`,
    provider: providerForChat(requests, gates),
  });
  client.start(() => undefined);
  return { client, root };
}

test("Navi and Nia run concurrently with independent event and thinking namespaces", async () => {
  const requests: ChatRequest[] = [];
  const gates = new Map<string, StreamGate>([
    ["navi", streamGate()],
    ["nia", streamGate()],
  ]);
  const { client } = await makeClient("concurrent", requests, gates);
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  try {
    const navi = client.naviChat!.submit({ text: "navi first" });
    const nia = client.niaChat!.submit({ text: "nia first" });
    await Promise.all([gates.get("navi")!.started, gates.get("nia")!.started]);
    expect(requests).toHaveLength(2);
    expect(requests.map(({ channel }) => channel)).toEqual(
      expect.arrayContaining(["navi", "nia"]),
    );
    expect(
      events.filter((event) => eventType(event).startsWith("chat.")),
    ).toEqual([]);
    expect(
      events.some((event) => eventType(event) === "navi.chat.thinking.delta"),
    ).toBe(true);
    expect(
      events.some((event) => eventType(event) === "nia.chat.thinking.delta"),
    ).toBe(true);
    gates.get("navi")!.release();
    gates.get("nia")!.release();
    await Promise.all([navi, nia]);
    expect(
      events.some((event) => eventType(event) === "navi.chat.message.delta"),
    ).toBe(true);
    expect(
      events.some((event) => eventType(event) === "nia.chat.message.delta"),
    ).toBe(true);
    expect(
      events.some((event) => eventType(event) === "navi.chat.turn.finished"),
    ).toBe(true);
    expect(
      events.some((event) => eventType(event) === "nia.chat.turn.finished"),
    ).toBe(true);
    expect(
      events
        .filter((event) => eventType(event).startsWith("navi.chat."))
        .every((event) => !eventType(event).startsWith("nia.chat.")),
    ).toBe(true);
  } finally {
    releaseAll(gates);
    await client.dispose?.();
  }
});

test("Navi and Nia provider usage feeds the session usage dashboard", async () => {
  const requests: ChatRequest[] = [];
  const { client } = await makeClient("usage", requests, new Map());
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  try {
    await client.naviChat!.submit({ text: "navi usage" });
    await client.niaChat!.submit({ text: "nia usage" });
    const naviUsage = events.filter(
      (event) => event.type === "navi.runtime.step_usage",
    );
    const niaUsage = events.filter(
      (event) => event.type === "nia.runtime.step_usage",
    );
    expect(naviUsage).toHaveLength(1);
    expect(niaUsage).toHaveLength(1);
    expect(naviUsage[0]).toMatchObject({
      type: "navi.runtime.step_usage",
      inputTokens: 11,
      outputTokens: 7,
    });
    expect(niaUsage[0]).toMatchObject({
      type: "nia.runtime.step_usage",
      inputTokens: 11,
      outputTokens: 7,
    });
  } finally {
    await client.dispose?.();
  }
});

test("pending user messages are drained only by their own stream and reach the provider", async () => {
  const requests: ChatRequest[] = [];
  const gates = new Map<string, StreamGate>([
    ["navi", streamGate()],
    ["nia", streamGate()],
  ]);
  const { client } = await makeClient("pending", requests, gates);
  try {
    const naviBusy = client.naviChat!.submit({ text: "navi busy" });
    const niaBusy = client.niaChat!.submit({ text: "nia busy" });
    await Promise.all([gates.get("navi")!.started, gates.get("nia")!.started]);
    const queuedNavi = client.naviChat!.submit({
      text: "navi pending",
    });
    const queuedNia = client.niaChat!.submit({
      text: "nia pending",
    });
    gates.get("navi")!.release();
    gates.get("nia")!.release();
    await Promise.all([naviBusy, niaBusy, queuedNavi, queuedNia]);
    const naviPending = requests.find(
      ({ channel, request }) =>
        channel === "navi" &&
        chatMessages(request).some(
          (message) => message.content === "navi pending",
        ),
    );
    const niaPending = requests.find(
      ({ channel, request }) =>
        channel === "nia" &&
        chatMessages(request).some(
          (message) => message.content === "nia pending",
        ),
    );
    expect(naviPending).toBeDefined();
    expect(niaPending).toBeDefined();
    expect(
      chatMessages(naviPending!.request).some(
        (message) => message.content === "nia pending",
      ),
    ).toBe(false);
    expect(
      chatMessages(niaPending!.request).some(
        (message) => message.content === "navi pending",
      ),
    ).toBe(false);
  } finally {
    releaseAll(gates);
    await client.dispose?.();
  }
});

test("identical queued Navi text is consumed once per message ID", async () => {
  const requests: ChatRequest[] = [];
  const gates = new Map<string, StreamGate>([["navi", streamGate()]]);
  const { client } = await makeClient("duplicate-pending", requests, gates);
  try {
    const busy = client.naviChat!.submit({ text: "busy" });
    await gates.get("navi")!.started;
    const first = await client.naviChat!.submit({
      text: "same text",
    });
    const second = await client.naviChat!.submit({
      text: "same text",
    });
    expect(first.messageID).not.toBe(second.messageID);
    gates.get("navi")!.release();
    await busy;
    const drained = requests.at(-1)?.request;
    expect(drained).toBeDefined();
    expect(
      chatMessages(drained!).filter(
        (message) => message.role === "user" && message.content === "same text",
      ),
    ).toHaveLength(2);
  } finally {
    releaseAll(gates);
    await client.dispose?.();
  }
});

test("a Navi message arriving after the last-step drain gets a follow-up provider step", async () => {
  const requests: ChatRequest[] = [];
  const gates = new Map<string, StreamGate>([["navi", streamGate()]]);
  const { client } = await makeClient("last-step-pending", requests, gates, {
    maxStepsPerTurn: 1,
  });
  try {
    const busy = client.naviChat!.submit({ text: "last step" });
    await gates.get("navi")!.started;
    const pending = await client.naviChat!.submit({
      text: "arrived after drain",
    });
    gates.get("navi")!.release();
    await busy;
    expect(pending.messageID).toBeTruthy();
    expect(requests).toHaveLength(2);
    expect(
      chatMessages(requests[1]!.request).some(
        (message) =>
          message.role === "user" && message.content === "arrived after drain",
      ),
    ).toBe(true);
  } finally {
    releaseAll(gates);
    await client.dispose?.();
  }
});

test.each([
  ["navi", "nia"],
  ["nia", "navi"],
] as const)("aborting %s does not abort %s", async (aborted, peer) => {
  const requests: ChatRequest[] = [];
  const gates = new Map<string, StreamGate>([
    [aborted, streamGate()],
    [peer, streamGate()],
  ]);
  const { client } = await makeClient(`abort-${aborted}`, requests, gates);
  try {
    const chat = aborted === "navi" ? client.naviChat! : client.niaChat!;
    const cancelled = chat.submit({
      text: `${aborted} abort`,
    });
    const survivor = (
      peer === "navi" ? client.naviChat! : client.niaChat!
    ).submit({
      text: `${peer} peer`,
    });
    await Promise.all([gates.get(aborted)!.started, gates.get(peer)!.started]);
    expect(await chat.abort!()).toEqual({ aborted: true });
    gates.get(aborted)!.release();
    gates.get(peer)!.release();
    await survivor;
    await cancelled;
    expect(
      await (peer === "navi" ? client.naviChat! : client.niaChat!).abort!(),
    ).toEqual({ aborted: false });
    // The channels, not just the count. CI saw `Received length: 3` at this
    // assertion, which says a third provider request was issued but not WHICH
    // stream issued it — so the failure was not actionable without pulling the
    // log apart. A count is the one failure shape that carries no diagnosis.
    // Which channels, as a SET. Not a sequence: the two streams' provider calls
    // race, and demanding an order fails 4 runs out of 5 under concurrency — I
    // added that order requirement in round 102 thinking it made the failure
    // diagnosable, and it instead manufactured a failure that then cost six
    // rounds to diagnose. Sorted, so a third request still shows as an extra name
    // (CI's `[nia, navi, nia]`) and a missing one as a short list.
    // The count on its own line first. With only the sorted comparison, a third
    // request shows as one removed and one added name, which a reader has to count
    // to interpret; stating the count first makes CI's `[nia, navi, nia]` read as
    // "3 requests where 2 were expected" before the names appear.
    expect(requests).toHaveLength(2);
    expect(requests.map((entry) => entry.channel).sort()).toEqual(
      [aborted, peer].sort(),
    );
  } finally {
    releaseAll(gates);
    await client.dispose?.();
  }
});

test("Nia normal profile selects its configured model and reasoning for submit and wake", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let sawCompletionToolResult = false;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push({
        path: new URL(request.url).pathname,
        body,
      });
      const openAI = new URL(request.url).pathname.endsWith(
        "/chat/completions",
      );
      if (!openAI)
        return new Response("event: message_stop\ndata: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      // Nia's turns carry her collaboration marker and keep the plain
      // reply; the main agent's turn scripts the completion once and then
      // settles (the tool result in the request marks the second step).
      const messages = (body.messages ?? []) as Array<{
        role: string;
        content: unknown;
      }>;
      const isNiaTurn = messages.some((message) =>
        String(message.content).includes("<natalia_collaborations>"),
      );
      if (isNiaTurn)
        return new Response(
          'data: {"choices":[{"delta":{"reasoning_content":"think","content":"ok"}}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      sawCompletionToolResult = messages.some(
        (message) =>
          message.role === "tool" &&
          String(message.content).includes('"recorded":true'),
      );
      if (!sawCompletionToolResult)
        return new Response(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"record_completion","arguments":"{\"taskID\":\"profile-audit\",\"objective\":\"close the audit line\",\"changeSummary\":\"one trigger, projected lifecycle\"}"}}]}}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      return new Response(
        'data: {"choices":[{"delta":{"content":"recorded"}}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const root = await officialPluginWorkspace("three-stream-profiles");
  const config = {
    version: 3,
    providers: {
      grok: {
        name: "Grok",
        driver: "openai",
        connection: {
          apiKey: "test",
          baseURL: `http://127.0.0.1:${server.port}/v1`,
        },
      },
      qifengstep: {
        name: "Step",
        driver: "anthropic-compatible",
        connection: {
          apiKey: "test",
          baseURL: `http://127.0.0.1:${server.port}/v1`,
        },
      },
    },
    catalog: {
      providers: {
        grok: { models: { "grok-4.6": { name: "Grok 4.6" } } },
        qifengstep: { models: { "step-3.7-flash": { name: "Step 3.7" } } },
      },
    },
    defaultModel: { provider: "qifengstep", model: "step-3.7-flash" },
  };
  const globalConfigPath = join(root, ".natalia-test-global.json");
  await writeFile(globalConfigPath, JSON.stringify(config));
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify(config),
  );
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_three_stream_profiles",
    globalConfigPath,
  });
  client.start(() => undefined);
  try {
    await client.niaChat!.submit({ text: "establish execution" });
    expect(
      await client.niaChat!.setModelProfile!({
        normal: { modelID: "grok/grok-4.6", reasoningEffort: "high" },
      }),
    ).toEqual({ saved: true });
    await client.niaChat!.submit({ text: "audit" });
    await client.planDocWrite!({
      path: "plans/profile-audit.md",
      content: "# Profile audit\n",
      title: "Profile audit",
    });
    const marked = await client.planDocMark!({
      path: "plans/profile-audit.md",
    });
    // The 2026-09-25 convergence: the waker is no longer the status write
    // (the deleted second trigger) but the completion fact's one home —
    // requestAuditAfterCompletion. The profile assertion below is the
    // same one; only how the wake is reached changed.
    await client.submitAndWait!(`record completion for ${marked.planID}`);
    await Bun.sleep(50);
    // The wake is the request the grok profile sent: the main agent runs
    // on the default (anthropic-compatible) driver, so the driver path
    // is not the filter — the MODEL is.
    const grokRequests = requests.filter(
      (request) => request.body.model === "grok-4.6",
    );
    expect(grokRequests.length).toBeGreaterThanOrEqual(1);
    expect(grokRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: expect.objectContaining({
            model: "grok-4.6",
            reasoning_effort: "high",
          }),
        }),
      ]),
    );
    expect(await client.niaChat!.modelProfile!()).toMatchObject({
      normal: { modelID: "grok/grok-4.6", reasoningEffort: "high" },
    });
  } finally {
    await client.dispose?.();
    server.stop(true);
  }
});

test("a completion wakes Nia; a status write alone wakes nobody (the cut)", async () => {
  // The 2026-09-25 convergence: the OLD drive was planDocUpdateStatus(
  // awaiting_audit) — the deleted SECOND trigger. The wake now has exactly
  // one home: the completion fact's requestAuditAfterCompletion. The
  // negative half is the cut's own proof — writing the status projects it
  // and wakes nobody.
  const requests: ProviderStreamRequest[] = [];
  const wakeStarted = gate();
  let mainSteps = 0;
  let completionTaskID = "";
  let auditReported = false;
  const provider: StreamingProvider = {
    provider: "nia-wake-provider",
    model: "nia-wake-model",
    async *stream(request) {
      requests.push(request);
      const allMessages = String(
        request.messages.map((message) => message.content).join("\n"),
      );
      const niaTurn = allMessages.includes("<natalia_collaborations>");
      if (!niaTurn) {
        // The main agent: one completion, then settle. The completion's
        // taskID is the audit target's planID, so the EI projection has a
        // plan to project onto.
        mainSteps += 1;
        if (mainSteps === 1) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "c1",
                name: "record_completion",
                arguments: JSON.stringify({
                  taskID: completionTaskID,
                  objective: "close the audit line",
                  changeSummary: "one trigger, projected lifecycle",
                }),
              },
            ],
          };
          return;
        }
        yield { type: "content" as const, text: "recorded" };
        yield { type: "done" as const };
        return;
      }
      const isWakeRequest = request.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.includes("Your audit wake request has arrived"),
      );
      if (isWakeRequest) wakeStarted.release();
      // The audit's happy path: her wake turn's first step reports a
      // pass (the plan's taskID is the completion's taskID), which closes
      // the lifecycle — awaiting_audit → auditing → completed. A one-shot
      // flag, not a message-shape check: her earlier chat in this session
      // already puts assistant messages in her history.
      if (isWakeRequest && !auditReported && completionTaskID) {
        auditReported = true;
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "c_audit",
              name: "audit_report",
              arguments: JSON.stringify({
                planID: completionTaskID,
                verdict: "passed",
              }),
            },
          ],
        };
        return;
      }
      yield { type: "thinking" as const, text: "nia-wake-thinking" };
      yield { type: "content" as const, text: "nia wake reply" };
      yield { type: "done" as const };
    },
  };
  const root = await officialPluginWorkspace("three-stream-nia-wake");
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_three_stream_nia_wake",
    provider,
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  const waitForStatus = async (planID: string, expected: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { status } = await client.planDocStatus!(planID);
      if (status === expected) return;
      await Bun.sleep(100);
    }
    throw new Error(`plan ${planID} never reached ${expected}`);
  };
  try {
    await client.niaChat!.submit({ text: "establish execution" });
    await client.niaChat!.setModelProfile!({
      normal: { reasoningEffort: "high" },
    });
    await client.planDocWrite!({
      path: "plans/audit-target.md",
      content: "# Audit target\n",
      title: "Audit target",
    });
    const marked = await client.planDocMark!({ path: "plans/audit-target.md" });
    // Activate: her turn's auditing projection keys off the session's
    // active plan, and the lifecycle pin below needs the whole chain.
    await client.planDocActivate!(marked.planID);
    completionTaskID = marked.planID;
    await client.submitAndWait!("record it");
    await wakeStarted.promise;
    // Any request carrying the wake text: her whole turn (initial plus
    // corrections). The turn is over by now, so a NEW one after the
    // status write can only be a new wake.
    const isWakeRequest = (request: ProviderStreamRequest) =>
      request.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.includes("Your audit wake request has arrived"),
      );
    expect(
      events.some((event) => eventType(event) === "nia.chat.thinking.delta"),
    ).toBe(true);
    // The lifecycle, projected end to end: the completion's EI projection
    // opened it (awaiting_audit — asserted by the projection test below in
    // the no-report case), her turn start projected auditing, and her turn
    // end without an audit_report fell back to audit_pending. Each state
    // has exactly one owner now.
    // The whole chain from the journal (a poll would miss the ephemeral
    // auditing window; the events are the durable truth): the completion's
    // EI projection opened it, her turn start projected the middle, her
    // audit_report(passed) closed it. Each state has exactly one owner.
    await waitForStatus(marked.planID, "completed");
    const lifecycle = events
      .filter(
        (event) =>
          event.type === "plan.doc.status" &&
          (event as { planID?: string }).planID === marked.planID,
      )
      .map((event) => (event as { status: string }).status);
    expect(lifecycle).toEqual(["awaiting_audit", "auditing", "completed"]);
    // The cut: writing the status (the OLD trigger's own input) wakes
    // nobody — no new wake request appears, before vs after the write. The
    // write is now REFUSED outright (T-20: a completed plan is terminal, so
    // returning it to awaiting_audit is not a legal transition), which is the
    // cut at its source: the old trigger's input cannot even move the plan.
    const wakeRequestsBefore = requests.filter(isWakeRequest).length;
    expect(wakeRequestsBefore).toBeGreaterThanOrEqual(1);
    const refused = await client.planDocUpdateStatus!({
      planID: marked.planID,
      status: "awaiting_audit",
    });
    expect(refused.updated).toBe(false);
    expect(refused.reason).toContain("terminal");
    await Bun.sleep(100);
    expect(requests.filter(isWakeRequest).length).toBe(wakeRequestsBefore);
  } finally {
    await client.dispose?.();
  }
  // A real integration wait (a completion has to drive Nia's wake through the
  // whole runtime). CI builds wasm packs and installs a toolchain in the same
  // job, and the 20s this used to carry failed there twice in a row while
  // passing locally at 1s. A hang still fails; only the wall moves.
}, 90_000);

test("main, Navi, and Nia publish thinking in their independent namespaces", async () => {
  const requests: ChatRequest[] = [];
  const gates = new Map<string, StreamGate>();
  const { client } = await makeClient("thinking", requests, gates);
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  try {
    await client.submitAndWait!("main thinking");
    await client.naviChat!.submit({ text: "navi thinking" });
    await client.niaChat!.submit({ text: "nia thinking" });
    expect(events.some((event) => eventType(event) === "thinking.delta")).toBe(
      true,
    );
    expect(
      events.some((event) => eventType(event) === "navi.chat.thinking.delta"),
    ).toBe(true);
    expect(
      events.some((event) => eventType(event) === "nia.chat.thinking.delta"),
    ).toBe(true);
  } finally {
    await client.dispose?.();
  }
});

test("durable thinking rows replay independently and never enter later chat prompts", async () => {
  const initialRequests: ChatRequest[] = [];
  const root = await officialPluginWorkspace("three-stream-thinking-replay");
  const sessionID = "ses_three_stream_thinking_replay";
  const initial = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    provider: providerForChat(initialRequests, new Map()),
  });
  initial.start(() => undefined);
  try {
    await initial.naviChat!.submit({ text: "first navi" });
    await initial.niaChat!.submit({ text: "first nia" });
    const naviRows = await initial.naviChat!.messages!();
    const niaRows = await initial.niaChat!.messages!();
    expect(naviRows).toContainEqual(
      expect.objectContaining({ kind: "thinking", text: "navi-thinking:" }),
    );
    expect(niaRows).toContainEqual(
      expect.objectContaining({ kind: "thinking", text: "nia-thinking:" }),
    );
  } finally {
    await initial.dispose?.();
  }

  const replayRequests: ChatRequest[] = [];
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    provider: providerForChat(replayRequests, new Map()),
  });
  const reopenedReady = gate();
  reopened.start((event) => {
    if (event.type === "session.ready") reopenedReady.release();
  });
  try {
    await reopenedReady.promise;
    const naviRows = await reopened.naviChat!.messages!();
    const niaRows = await reopened.niaChat!.messages!();
    expect(naviRows.filter((row) => row.kind === "thinking")).toEqual([
      expect.objectContaining({ text: "navi-thinking:" }),
    ]);
    expect(niaRows.filter((row) => row.kind === "thinking")).toEqual([
      expect.objectContaining({ text: "nia-thinking:" }),
    ]);

    await reopened.naviChat!.submit({ text: "second navi" });
    await reopened.niaChat!.submit({ text: "second nia" });
    expect(replayRequests).toHaveLength(2);
    expect(
      replayRequests.flatMap(({ request }) =>
        request.messages.filter((message) =>
          message.content.endsWith("thinking:"),
        ),
      ),
    ).toEqual([]);
  } finally {
    await reopened.dispose?.();
  }
});

test("plan document paths are validated without masking the reason as internal", async () => {
  const root = await officialPluginWorkspace("three-stream-plan-path");
  const provider: StreamingProvider = {
    provider: "plan-path",
    model: "plan-path",
    async *stream() {},
  };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plan_path",
    provider,
  });
  client.start(() => undefined);
  try {
    await expect(
      client.planDocMark!({ path: "/tmp/outside-plan.md" }),
    ).rejects.toMatchObject({
      name: "RuntimeInvalidParams",
      message: expect.stringContaining("must be under .natalia/plans"),
    });
    await expect(
      client.planDocMark!({ path: ".natalia/plans/missing.md" }),
    ).rejects.toMatchObject({
      name: "RuntimeInvalidParams",
      message: expect.stringContaining("does not exist"),
    });
  } finally {
    await client.dispose?.();
  }
});
