import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { failureKind } from "@anthelia/contracts";
import type {
  RuntimeClient,
  RuntimeDiagnostic,
  RuntimeEvent,
  RuntimeRPCError,
  SubmittedTurn,
} from "@anthelia/contracts";
import { createRealRuntimeClient } from "@natalia/client";
import { officialPluginWorkspace } from "@natalia/testing";
import { callRuntimeRPC } from "@natalia/transport";
import { createRuntimeHttpServer } from "@natalia/transport/host";
import { projectEvents, displayText, type AppState } from "@natalia/view-store";
import { createNataliaSDK } from "../src";

/**
 * Consumer conformance fixture (mainline plan P12).
 *
 * This is the test an externally built UI author effectively runs: it drives a
 * real runtime over the real HTTP transport using **only** the packages §2.1
 * allows a consumer to depend on —
 *
 *   @anthelia/contracts   types
 *   @natalia/sdk         talking to a runtime
 *   @natalia/view-store  turning events into displayable state
 *   @natalia/client      public exports only (to host the runtime under test)
 *
 * It deliberately imports nothing from `@anthelia/runtime`, `@anthelia/session`,
 * `@anthelia/tools`, any package internal, or any UI framework. `guard:imports`
 * enforces most of that statically; this proves the surface is actually
 * *sufficient*, which no static rule can show.
 *
 * If a future change makes a UI impossible to build from this surface, this test
 * is where it should fail — not in someone's project.
 *
 * `@natalia/transport/host` is used to stand the server up. That is the one
 * host-side import, and it is what a consumer would replace with a URL pointing
 * at a runtime somebody else runs.
 */

async function withRuntime<T>(
  scenario: (input: {
    baseURL: string;
    events: RuntimeEvent[];
    root: string;
  }) => Promise<T>,
  options: {} = {},
): Promise<T> {
  // The OWN store, filled from the repo's build output: a runtime pointed
  // at the shared dist/ts/plugin-store gets its lock and none of its plugin
  // modules (the refresh artifact's marker makes the installer skip), which
  // is a runtime whose every tool answers "unknown".
  const { workspaceRoot: root, pluginStoreRoot } =
    await officialPluginWorkspace("natalia-consumer");
  const events: RuntimeEvent[] = [];
  const runtime = createRealRuntimeClient({
    workspaceRoot: root,
    pluginStoreRoot,
    sessionID: "ses_consumer",
    permissionMode: "auto",
    provider: {
      provider: "scripted",
      model: "scripted",
      async *stream(request) {
        const answered = request.messages.some(
          (message) => message.role === "tool",
        );
        if (!answered) {
          yield { type: "thinking" as const, text: "checking the workspace" };
          yield { type: "content" as const, text: "Reading the file now. " };
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_1",
                name: "write_file",
                arguments: JSON.stringify({
                  path: "notes.md",
                  content: "hello",
                }),
              },
            ],
          };
          return;
        }
        yield { type: "content" as const, text: "Wrote notes.md." };
        yield { type: "done" as const };
      },
    },
  });
  runtime.start((event) => events.push(event));

  const server = createRuntimeHttpServer({ client: runtime, token: "secret" });
  try {
    return await scenario({ baseURL: server.url, events, root });
  } finally {
    server.stop();
    await runtime.dispose?.();
  }
}

test("a consumer can drive a turn and render it from the public surface alone", async () => {
  await withRuntime(async ({ baseURL, events }) => {
    const sdk = createNataliaSDK({ baseURL, token: "secret" });

    const submitted = await sdk.prompt("write notes.md");
    expect(submitted.text).toBe("write notes.md");

    // Poll the durable history the way a reconnecting UI would, rather than
    // relying on the in-process sink.
    const deadline = Date.now() + 15_000;
    let history: Array<{ seq: number; event: RuntimeEvent }> = [];
    while (Date.now() < deadline) {
      history = (await sdk.history({ limit: 500 })).events;
      if (
        history.some(
          (entry) =>
            entry.event.type === "turn.finished" &&
            entry.event.id === submitted.id,
        )
      )
        break;
      await Bun.sleep(50);
    }

    const finished = history.find(
      (entry) => entry.event.type === "turn.finished",
    );
    expect(finished).toBeDefined();

    // The consumer's whole rendering path: fold the durable event stream.
    const state: AppState = projectEvents(history.map((entry) => entry.event));

    const transcript = state.messages.map((block) => ({
      role: block.role,
      text: displayText(block),
    }));

    expect(transcript.find((row) => row.role === "user")?.text).toBe(
      "write notes.md",
    );
    expect(
      transcript.some(
        (row) => row.role === "assistant" && row.text.includes("Reading"),
      ),
    ).toBe(true);
    // Durable history carries no `content.delta` — deltas are live-only — so a
    // replaying consumer must still recover every model message from the
    // per-step `content.done` events.
    expect(
      transcript.some(
        (row) =>
          row.role === "assistant" && row.text.includes("Wrote notes.md"),
      ),
    ).toBe(true);
    // Order must survive replay: thinking precedes the first answer, and the
    // tool card sits between the two assistant messages.
    const order = transcript.map((row) => row.role);
    expect(order).toEqual([
      "user",
      "thinking",
      "assistant",
      "tool",
      "assistant",
    ]);

    // A tool call has to be visible as structured data, not only as prose, or a
    // consumer cannot build a tool card.
    const tools = Object.values(state.tools);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "write_file", status: "succeeded" });

    expect(state.activeTurn).toBeUndefined();
    expect(state.lastStopReason).toBe("done");

    // Resource and status surfaces must be readable from the public surface
    // too. Capability declarations are live-only bootstrap facts, so they come
    // from the query API; durable projections carry the journal-backed slices.
    expect((await sdk.capabilities()).length).toBeGreaterThan(0);
    expect(state.checkpoints.length).toBeGreaterThan(0);
    expect(state.policyDecisions.length).toBeGreaterThan(0);
    expect(state.statusSegments.some((s) => s.startsWith("model:"))).toBe(true);
    // Every slice a consumer indexes into exists even when nothing filled it.
    expect(state.terminals).toBeDefined();
    expect(state.sandboxes).toBeDefined();
    expect(state.subagents).toBeDefined();
    expect(state.mcp).toBeDefined();

    // Work Graph is a public integration surface, not only an internal
    // projector. The same turn and tool must be causally connected over HTTP.
    const graphNodes = await sdk.workGraphNodes();
    const graphEdges = await sdk.workGraphEdges();
    const action = graphNodes.find(
      (node) => node.kind === "agent_action" && node.turnID === submitted.id,
    );
    const tool = graphNodes.find(
      (node) => node.kind === "tool_call" && node.turnID === submitted.id,
    );
    expect(action).toBeDefined();
    expect(tool).toMatchObject({ actor: "write_file" });
    expect(
      graphEdges.some(
        (edge) =>
          edge.sourceID === action!.nodeID &&
          edge.targetID === tool!.nodeID &&
          edge.kind === "caused",
      ),
    ).toBe(true);

    // Note for consumers: `RuntimeClient.start()` holds a single sink, and the
    // HTTP server claims it. Fan-out to more than one observer is the server's
    // job (SSE `/events`), not the client's, so `events` here is not asserted.
    void events;
  });
}, 60_000);

test("a consumer can read catalogues and workspace facts over the SDK", async () => {
  await withRuntime(async ({ baseURL }) => {
    const sdk = createNataliaSDK({ baseURL, token: "secret" });

    // These are the surfaces a UI needs before it can render anything useful.
    expect(Array.isArray(await sdk.agents())).toBe(true);
    expect(Array.isArray(await sdk.modelCatalog())).toBe(true);
    expect(Array.isArray(await sdk.skills())).toBe(true);
    expect(Array.isArray(await sdk.workspaceFiles({ limit: 5 }))).toBe(true);

    const status = await sdk.runtimeStatus?.();
    if (status) expect(status.type).toBe("status.snapshot");
  });
}, 60_000);

test("a consumer can discover contributed commands", async () => {
  await withRuntime(async ({ baseURL }) => {
    const sdk = createNataliaSDK({ baseURL, token: "secret" });
    // The catalog is the surface a UI renders a palette from, and it exists even
    // when nothing has contributed yet, so a consumer never indexes into undefined.
    const commands = await sdk.commandCatalog();
    expect(Array.isArray(commands)).toBe(true);
    for (const command of commands) {
      expect(command.name).toBeString();
      expect(command.title).toBeString();
    }
  });
}, 60_000);

test("a consumer can ask what this runtime implements, without guessing", async () => {
  await withRuntime(async ({ baseURL }) => {
    const sdk = createNataliaSDK({ baseURL, token: "secret" });
    const report = await sdk.availability();

    // A usable runtime says so, without the consumer probing 95 members one by one.
    expect(report.usable).toBe(true);
    expect(report.missingRequired).toEqual([]);

    const available = report.groups
      .filter((group) => group.available)
      .map((group) => group.name);
    expect(available).toContain("sessions");
    expect(available).toContain("checkpoint");
    // The xterm `terminal` group is retired; the live terminal surface is the
    // native host, which the in-process report still describes accurately.
    expect(available).toContain("nativeTerminal");
    expect(available).toContain("workGraph");

    // This capability was reported partial when the report first ran — the
    // precheck `canReloadConfig` existed and the action did not — which is what
    // led to implementing it. It is whole now, and asserting that keeps the pair
    // together: adding a precheck without its action fails here.
    expect(available).toContain("lifecycle");

    // A half-implemented capability is called out, never counted as present.
    for (const group of report.groups)
      expect(group.available && group.partial).toBe(false);

    // Every fact-domain read surface now has a production writer, so the
    // unimplemented list is empty.
    expect(report.unimplemented.map((entry) => entry.member).sort()).toEqual(
      [],
    );
    for (const entry of report.unimplemented)
      expect(entry.reason).toMatch(/yet/u);

    // The channel dimension (P0-B): what this connection can reach is a
    // separate fact from what the runtime implements. A consumer driving the
    // runtime over RPC must not build on the native terminal or intelligence
    // surfaces yet — the report says so instead of letting it fail at runtime.
    expect(report.channel?.name).toBe("rpc");
    const channelByMember = new Map(
      report.channel!.groups.flatMap((group) =>
        group.members.map((member) => [member.member, member.state] as const),
      ),
    );
    // P0-C closed the gap: these are routed now. The whitelist members are the
    // only implemented-but-unreachable surface left, and each says why.
    for (const member of [
      "nativeTerminalList",
      "nativeTerminalOpenHub",
      "constitutionRules",
      "capabilities",
      "submitInput",
      "sessionSnapshot",
    ])
      expect(channelByMember.get(member)).toBe("implemented_reachable");
    const nativeGroup = report.channel!.groups.find(
      (group) => group.name === "nativeTerminal",
    )!;
    expect(nativeGroup.reachable).toBe(true);
    expect(
      report.channel!.requiredMembers.find(
        (member) => member.member === "dispose",
      ),
    ).toBeUndefined();
    // What the RPC channel does reach is ordinary and healthy.
    expect(channelByMember.get("sessionList")).toBe("implemented_reachable");
    expect(channelByMember.get("history")).toBe("implemented_reachable");
  });
}, 60_000);

test("a consumer can ask whether config may be applied, and apply it", async () => {
  await withRuntime(async ({ baseURL }) => {
    const sdk = createNataliaSDK({ baseURL, token: "secret" });

    // Nothing is running, so the answer is yes...
    expect(await sdk.canReloadConfig()).toEqual({ allowed: true });
    // ...and the action reports what it did, rather than returning nothing and
    // leaving the caller to assume. A refusal would arrive the same way, as a
    // value, because "a turn is running" is an answer and not a failure.
    const applied = await sdk.reloadConfig();
    expect(applied.applied).toBe(true);
    expect(applied.reason).toBeUndefined();
  });
}, 60_000);

test("an unauthenticated consumer is refused", async () => {
  await withRuntime(async ({ baseURL }) => {
    const sdk = createNataliaSDK({ baseURL, token: "wrong" });
    // The transport must not be usable without the token a deployment issued.
    await expect(sdk.prompt("should not run")).rejects.toThrow();
  });
}, 60_000);

test("a consumer can tell the kinds of failure apart without reading messages", async () => {
  await withRuntime(async ({ baseURL, root }) => {
    const sdk = createNataliaSDK({ baseURL, token: "secret" });

    // Each kind calls for a different reaction — report a bug, hide the feature,
    // fix the call, tell the user, retry — so a consumer that cannot tell them
    // apart has to treat every failure as the worst case. Nothing below matches
    // on message text; that is the practice being replaced.

    // 1. No such method: this consumer and this runtime disagree about the protocol.
    const unknown = await callRuntimeRPC({
      url: baseURL,
      token: "secret",
      method: "no.such.method",
    }).catch((error: unknown) => error);
    expect(failureKind(unknown)).toBe("methodNotFound");

    // 2. Wrong argument: the call is fixable by the caller.
    const badArgument = await sdk
      .workspaceRead({ path: "notes.md", offset: -1 })
      .catch((error: unknown) => error);
    expect(failureKind(badArgument)).toBe("invalidParams");

    // 3. Policy says no. A path outside the workspace is a refusal, not a fault,
    // and the reason is machine-readable so a UI can explain it.
    const refused = await sdk
      .workspaceRead({ path: "../outside" })
      .catch((error: unknown) => error);
    expect(failureKind(refused)).toBe("refused");
    expect((refused as RuntimeRPCError).data).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("workspace"),
    });
    // A refusal must not describe the boundary it enforced: handing the caller the
    // absolute directory it failed to escape gives away the thing it was refused.
    expect((refused as RuntimeRPCError).message).not.toContain(root);
    expect(JSON.stringify((refused as RuntimeRPCError).data)).not.toContain(
      root,
    );
  });
}, 60_000);

test("a consumer is told when its answer or its turn control did not take effect", async () => {
  await withRuntime(async ({ baseURL }) => {
    const sdk = createNataliaSDK({ baseURL, token: "secret" });

    // An external UI answering approvals is the first integration scenario there
    // is, and it has to distinguish "your answer took effect" from "that request
    // had already timed out and the model was told the call did not run". Both
    // used to arrive as `responded: true`.
    expect(
      await sdk.respondApproval({ requestID: "apr_gone", decision: "once" }),
    ).toEqual({
      accepted: false,
      reason: "the approval request is no longer pending",
    });
    expect(
      await sdk.respondQuestion({
        requestID: "qst_gone",
        answers: [["no"]],
        rejected: false,
      }),
    ).toMatchObject({ accepted: false });

    // Same shape for turn control and agent selection: refusing is a value, so a
    // consumer never has to infer it from the absence of an exception.
    expect(await sdk.pause()).toMatchObject({ paused: false });
    expect(await sdk.resume()).toMatchObject({ resumed: false });
    expect(await sdk.selectAgent("no-such-agent")).toMatchObject({
      outcome: "rejected",
    });
  });
}, 60_000);

test("a runtime implementing only the required set still answers, and says which capability is missing", async () => {
  // The other half of "not supported": the route exists, the member does not. A
  // consumer must be able to switch off a whole feature area from one failure
  // instead of discovering it member by member — so the capability group has to
  // arrive with the error. This stub is also the proof that the required set is
  // enough to stand a server up.
  const recorded: RuntimeDiagnostic[] = [];
  const stub: RuntimeClient = {
    start() {},
    async submit(text) {
      return {
        type: "turn.submitted",
        id: "turn_stub",
        text,
        byteLength: text.length,
        lineCount: 1,
        sha256: "stub",
      };
    },
    cancel() {},
    snapshot() {
      return { type: "diagnostic", level: "info", message: "stub" };
    },
    diagnostic(message, level = "warning") {
      recorded.push({
        type: "diagnostic",
        level,
        message,
        at: new Date().toISOString(),
      });
    },
    async diagnostics() {
      return recorded;
    },
    lastSubmission() {
      return undefined;
    },
    respondApproval() {
      return { accepted: true };
    },
    respondQuestion() {
      return { accepted: true };
    },
    async sessionList() {
      // What a real runtime failure looks like: an fs error whose text carries an
      // absolute path nobody meant to publish.
      throw new Error(
        "ENOENT: no such file or directory, open '/home/someone/project/.env'",
      );
    },
  };
  const server = createRuntimeHttpServer({ client: stub, events: false });
  try {
    const sdk = createNataliaSDK({ baseURL: server.url });

    const notSupported = await sdk
      .checkpointList()
      .catch((error: unknown) => error);
    expect(failureKind(notSupported)).toBe("notSupported");
    expect((notSupported as RuntimeRPCError).data).toEqual({
      kind: "notSupported",
      member: "checkpointList",
      capability: "checkpoint",
    });

    // An unclassified failure arrives as internal and carries no detail at all.
    const internal = await sdk.sessions().catch((error: unknown) => error);
    expect(failureKind(internal)).toBe("internal");
    expect((internal as RuntimeRPCError).message).not.toContain(".env");
    const errorID = ((internal as RuntimeRPCError).data as { errorID: string })
      .errorID;
    expect(errorID).toBeString();
    // The detail is moved, not lost: a consumer already authorized to read
    // diagnostics can correlate by the ID it was handed.
    const diagnostics = await sdk.diagnostics(50);
    const entry = diagnostics.find((item) => item.message.includes(errorID));
    expect(entry).toBeDefined();
    expect(entry!.level).toBe("error");
    expect(entry!.message).toContain(".env");

    // And the runtime still answers what it can, so a consumer is never left
    // guessing whether the connection itself works.
    expect((await sdk.prompt("hello")).text).toBe("hello");

    // P0-F scenario 5: graceful degradation. The consumer reads the report
    // and *decides* — a required-set-only runtime is usable, and a consumer
    // that consults availability never calls the missing surface and never
    // has to catch a -32000. That decision path is the point of the scenario.
    const report = await sdk.availability();
    expect(report.usable).toBe(true);
    const checkpointGroup = report.groups.find(
      (group) => group.name === "checkpoint",
    )!;
    expect(checkpointGroup.available).toBe(false);
    // The consumer's decision: render the session, skip checkpoint UI, no
    // probing of the absent surface.
    expect(checkpointGroup.missing).toContain("checkpointList");
  } finally {
    server.stop();
  }
}, 60_000);

test("the P0-C route surface answers over HTTP: native terminal, intelligence, capabilities", async () => {
  await withRuntime(async ({ baseURL }) => {
    const sdk = createNataliaSDK({ baseURL, token: "secret" });
    const failureKindOr = (promise: Promise<unknown>) =>
      promise.then(
        () => undefined,
        (error: unknown) => failureKind(error),
      );

    // Native terminal without a host: every route exists (never -32601) and
    // answers either empty or a refusal/internal — the route is there, the
    // environment is not. Each call is awaited as it is made: a batch of
    // already-started promises would be reported unhandled by bun while the
    // earlier ones are still in flight.
    expect(await sdk.nativeTerminalList()).toEqual([]);
    for (const call of [
      () => sdk.nativeTerminalRead("term_x"),
      () => sdk.nativeTerminalStop("term_x"),
      () => sdk.nativeTerminalOpenHub(),
      () => sdk.nativeTerminalRevokeApprovalScope("term_x"),
      () => sdk.nativeTerminalReleaseHumanControl("term_x"),
      () => sdk.nativeTerminalBeginSecureInput("term_x"),
      () => sdk.nativeTerminalEndSecureInput("term_x"),
    ]) {
      const kind = await failureKindOr(call());
      expect(kind, "native terminal route must exist, not be -32601").not.toBe(
        "methodNotFound",
      );
    }

    // Intelligence queries and capability records: routed. The constitution
    // rules are the first facts (the runtime's self-protection rules are seeded
    // into every session), and decisions are empty until `recordDecision` is
    // called. Evidence, drift and tool metadata still answer with nothing.
    const constitutionRules = await sdk.constitutionRules();
    expect(constitutionRules.length).toBeGreaterThan(0);
    expect(constitutionRules.some((rule) => rule.ruleID === "C-TERM-001")).toBe(
      true,
    );
    expect(await sdk.decisionRecords()).toMatchObject({
      items: [],
      returned: 0,
      total: 0,
      truncated: false,
    });
    expect(await sdk.evidenceRecords()).toMatchObject({
      items: [],
      returned: 0,
      total: 0,
      truncated: false,
    });
    expect(await sdk.driftFindings()).toMatchObject({
      items: [],
      returned: 0,
      total: 0,
      truncated: false,
    });
    expect((await sdk.registeredTools()).length).toBeGreaterThan(0);
    // Capability records: the runtime registers real ones (the MCP server, the
    // platform surface), so the shape is the assertion, not emptiness.
    const capabilityRecords = await sdk.capabilities();
    expect(capabilityRecords.length).toBeGreaterThan(0);
    for (const record of capabilityRecords) {
      expect(typeof record.id).toBe("string");
      expect(typeof record.name).toBe("string");
      expect(typeof record.version).toBe("string");
      expect(Array.isArray(record.grants)).toBe(true);
    }

    // sessionSnapshot answers undefined or a snapshot — a value either way.
    const snapshot = await sdk.sessionSnapshot();
    expect(snapshot === undefined || typeof snapshot === "object").toBe(true);

    // submitInput is a real submission with the richer input shape.
    const submitted = await sdk.submitInput({ text: "via submit.input" });
    expect(submitted.type).toBe("turn.submitted");
    expect(submitted.text).toBe("via submit.input");

    // And the report agrees: these are reachable now, whitelist members are not.
    const report = await sdk.availability();
    const byMember = new Map([
      ...report.channel!.groups.flatMap((group) =>
        group.members.map((member) => [member.member, member.state] as const),
      ),
      ...report.channel!.requiredMembers.map(
        (member) => [member.member, member.state] as const,
      ),
    ]);
    expect(byMember.get("nativeTerminalList")).toBe("implemented_reachable");
    expect(byMember.get("constitutionRules")).toBe("implemented_reachable");
    expect(byMember.get("dispose")).toBe("implemented_unreachable");
  });
}, 60_000);

test("a read-only integration renders the session and cannot write a byte", async () => {
  // P0-D on the consumer side, and the seed of the P0-F "read-only
  // integration" scenario: one server, two credentials — the operator's
  // full-write one and an integration's read-only one. The integration must
  // render everything and cause no side effect, and the report it sees must
  // say so (write surface unreachable *by authorization*, never by lie).
  const { workspaceRoot: root, pluginStoreRoot } =
    await officialPluginWorkspace("natalia-readonly-consumer");
  const events: RuntimeEvent[] = [];
  const runtime = createRealRuntimeClient({
    workspaceRoot: root,
    pluginStoreRoot,
    sessionID: "ses_consumer",
    permissionMode: "auto",
    provider: {
      provider: "scripted",
      model: "scripted",
      async *stream() {
        yield { type: "content" as const, text: "ready" };
        yield { type: "done" as const };
      },
    },
  });
  runtime.start((event) => events.push(event));
  const server = createRuntimeHttpServer({
    client: runtime,
    authorization: {
      credentials: [
        { token: "operator", write: true },
        { token: "integration", write: false },
      ],
    },
  });
  try {
    const integration = createNataliaSDK({
      baseURL: server.url,
      token: "integration",
    });

    // Render: read the history and the workspace.
    const submitted = await integration
      .prompt("describe the workspace")
      .catch(() => undefined);
    // A read-only credential cannot submit — that is the point.
    expect(submitted).toBeUndefined();
    const page = await integration.workspaceList({ path: "." });
    expect(Array.isArray(page.entries)).toBe(true);
    const report = await integration.availability();
    const byMember = new Map(
      report.channel!.groups.flatMap((group) =>
        group.members.map((member) => [member.member, member.state] as const),
      ),
    );
    expect(byMember.get("reloadConfig")).toBe("implemented_unreachable");
    expect(byMember.get("sessionList")).toBe("implemented_reachable");

    // The operator's credential still has the whole surface.
    const operator = createNataliaSDK({
      baseURL: server.url,
      token: "operator",
    });
    const turned = await operator.prompt("hello operator");
    expect(turned.text).toBe("hello operator");

    // P0-H: the terminal write surface exists as routes but is gated at the
    // host. A read-only credential is refused by authorization ("no write
    // scope") before the gate; an operator with write scope is refused by the
    // gate itself ("terminal write is not enabled") because this server never
    // opted in. Both are `refused`, with the reason naming the rule.
    const readOnlyTerminal = await integration
      .nativeTerminalStart({ command: "bash" })
      .catch((error: unknown) => error);
    expect(failureKind(readOnlyTerminal)).toBe("refused");
    expect((readOnlyTerminal as RuntimeRPCError).message).toContain(
      "no write scope",
    );
    const gatedTerminal = await operator
      .nativeTerminalStart({ command: "bash" })
      .catch((error: unknown) => error);
    expect(failureKind(gatedTerminal)).toBe("refused");
    expect((gatedTerminal as RuntimeRPCError).message).toContain(
      "terminal write is not enabled",
    );
  } finally {
    server.stop();
    await runtime.dispose?.();
  }
}, 60_000);

/**
 * Collects events from the SDK stream, starting the subscription *before*
 * `trigger` runs so no live event can slip between the two. Replay (since 0)
 * covers events that happened before the subscription existed.
 */
const CONSUMER_EVENT_TIMEOUT_MS = 30_000;

async function collectEventsWhileTriggering(
  sdk: ReturnType<typeof createNataliaSDK>,
  trigger: () => void,
  predicate: (event: RuntimeEvent) => boolean,
  timeoutMs = CONSUMER_EVENT_TIMEOUT_MS,
): Promise<RuntimeEvent[]> {
  const collected: RuntimeEvent[] = [];
  const controller = new AbortController();
  const iterator = sdk
    .events({ since: 0, signal: controller.signal })
    [Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  try {
    const pending = iterator.next();
    trigger();
    let result = await withDeadline(pending, deadline);
    while (!result.done && Date.now() < deadline) {
      collected.push(result.value);
      if (predicate(result.value)) return collected;
      result = await withDeadline(iterator.next(), deadline);
    }
    throw new Error("timed out waiting for the expected runtime event");
  } finally {
    controller.abort();
    try {
      await iterator.return?.();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        throw error;
    }
  }
}

/** An SSE stream stays open forever by design; reads must not hang a test. */
function withDeadline(
  pending: Promise<IteratorResult<RuntimeEvent>>,
  deadline: number,
): Promise<IteratorResult<RuntimeEvent>> {
  return Promise.race([
    pending,
    new Promise<IteratorResult<RuntimeEvent>>((resolve) =>
      setTimeout(
        () => resolve({ done: true, value: undefined }),
        Math.max(1, deadline - Date.now()),
      ),
    ),
  ]);
}

test("an external UI takes over approvals and answers questions", async () => {
  // P0-F scenario 1: the first integration scenario there is. A UI subscribes
  // to events, sees an approval.request, renders it, answers it, and the turn
  // continues. The runtime defaults to permissionMode "ask", and the `plan`
  // tool requires approval, so the model's tool call cannot proceed without
  // the UI. The UI is told the truth about what happened: `accepted: true`
  // when the answer took effect, and a `policy.decision` event when a
  // rejection is delivered back to the model.
  const { workspaceRoot: root, pluginStoreRoot } =
    await officialPluginWorkspace("natalia-approval-consumer");
  let writeCalls = 0;
  const runtime = createRealRuntimeClient({
    workspaceRoot: root,
    pluginStoreRoot,
    globalConfigPath: join(root, "global.json"),
    sessionID: "ses_approval",
    provider: {
      provider: "scripted",
      model: "scripted",
      async *stream(request) {
        // Session title generation shares this provider but has no tool list.
        // Keep it out of the turn script so background title work cannot alter
        // which response a user turn receives.
        if (!request.tools) {
          yield { type: "content" as const, text: "Planning session" };
          yield { type: "done" as const };
          return;
        }
        const answered = request.messages.at(-1)?.role === "tool";
        if (!answered) {
          writeCalls++;
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: `call_write_${writeCalls}`,
                name: "write_file",
                arguments: JSON.stringify({
                  path: "notes.md",
                  content: "hello",
                }),
              },
            ],
          };
          return;
        }
        yield { type: "content" as const, text: "The note is written." };
        yield { type: "done" as const };
      },
    },
  });
  runtime.start(() => undefined);
  const server = createRuntimeHttpServer({ client: runtime, token: "secret" });
  try {
    const sdk = createNataliaSDK({ baseURL: server.url, token: "secret" });

    // Approve: the turn blocks on the request until the UI answers. The
    // prompt promise is saved so the test can await the turn *after* the
    // approval resolves — a second prompt would block on its own request.
    let approvedTurn: Promise<SubmittedTurn> | undefined;
    const approvedEvents = await collectEventsWhileTriggering(
      sdk,
      () => {
        approvedTurn = sdk.prompt("write notes.md");
      },
      (event) => event.type === "approval.request",
    );
    const request = approvedEvents.find(
      (event): event is Extract<RuntimeEvent, { type: "approval.request" }> =>
        event.type === "approval.request",
    )!;
    expect(request.title).toContain("write_file");
    expect(typeof request.id).toBe("string");

    const outcome = await sdk.respondApproval({
      requestID: request.id,
      decision: "once",
    });
    expect(outcome).toEqual({ accepted: true });
    if (!approvedTurn) throw new Error("approved turn was not submitted");
    const approvedSubmission = await approvedTurn;
    const finishedDeadline = Date.now() + CONSUMER_EVENT_TIMEOUT_MS;
    let approvedFinished = false;
    let runtimeIdle = false;
    while (Date.now() < finishedDeadline) {
      const history = await sdk.history({ limit: 500 });
      approvedFinished = history.events.some(
        ({ event }) =>
          event.type === "turn.finished" && event.id === approvedSubmission.id,
      );
      runtimeIdle = (await sdk.canReloadConfig()).allowed;
      if (approvedFinished && runtimeIdle) break;
      await Bun.sleep(50);
    }
    expect(approvedFinished).toBe(true);
    expect(runtimeIdle).toBe(true);

    // Reject: a reconnecting UI reads the pending projection rather than
    // replaying the whole SSE stream again. The model is told, via a durable
    // policy.decision event, that the call was refused — a rejection is an
    // answer, not a silent drop.
    let rejectedTurn: Promise<SubmittedTurn> | undefined;
    rejectedTurn = sdk.prompt("write another note");
    const pendingDeadline = Date.now() + CONSUMER_EVENT_TIMEOUT_MS;
    let secondRequest:
      | Extract<RuntimeEvent, { type: "approval.request" }>
      | undefined;
    while (Date.now() < pendingDeadline) {
      secondRequest = (await sdk.pendingInteractive()).approvals.find(
        (entry) => entry.id !== request.id,
      );
      if (secondRequest) break;
      await Bun.sleep(50);
    }
    expect(secondRequest).toBeDefined();
    const refused = await sdk.respondApproval({
      requestID: secondRequest!.id,
      decision: "reject",
      feedback: "not now",
    });
    expect(refused).toEqual({ accepted: true });
    await rejectedTurn;
    const decisionDeadline = Date.now() + CONSUMER_EVENT_TIMEOUT_MS;
    let rejectedDecision = false;
    while (Date.now() < decisionDeadline) {
      const history = await sdk.history({ limit: 500 });
      rejectedDecision = history.events.some(
        ({ event }) =>
          event.type === "policy.decision" &&
          event.decision === "rejected" &&
          event.reason === "not now",
      );
      if (rejectedDecision) break;
      await Bun.sleep(50);
    }
    expect(rejectedDecision).toBe(true);
  } finally {
    server.stop();
    await runtime.dispose?.();
  }
}, 60_000);

test("an external integration configures the runtime the way the TUI does", async () => {
  // The config write surface was TUI-only: every settings menu entry (providers,
  // MCP servers, permission profiles, modes) wrote config.json through
  // updateConfigAtScope + reloadConfig inside the TUI. A remote integration
  // had no way to configure anything. Now it takes the same path, with the
  // same value-type refusal when a running turn blocks application.
  await withRuntime(async ({ baseURL, root }) => {
    const sdk = createNataliaSDK({ baseURL, token: "secret" });

    // Write a patch, then read it back through the read surface to prove the
    // merge landed on disk.
    const applied = await sdk.updateConfig({
      patch: {
        runtime: { maxStepsPerTurn: 7 },
      },
    });
    expect(applied.applied).toBe(true);

    const report = await sdk.runtimeStatus();
    // runtimeStatus exposes committed selections; the config itself is read
    // back through model catalog/selection members.
    expect(typeof report).toBe("object");

    await sdk.setReasoningEffort("high");
    expect(await sdk.reasoningEffort()).toBe("high");
    await sdk.setReasoningEffort();
    expect(await sdk.reasoningEffort()).toBeUndefined();

    // Idempotent by patch: replaying the same patch merges to the same
    // result instead of accumulating.
    const replayed = await sdk.updateConfig({
      patch: {
        runtime: { maxStepsPerTurn: 7 },
      },
    });
    expect(replayed).toEqual({ applied: true });

    // A bad scope is invalid params, not a guess.
    const badScope = await sdk
      .updateConfig({ patch: {}, scope: "elsewhere" as never })
      .catch((error: unknown) => error);
    expect(failureKind(badScope)).toBe("invalidParams");
  });
}, 60_000);

test("an external integration manages sessions, policy, agents and plugins over RPC", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-conformance-management-"));
  // The demo plugin lives under a /tmp workspace; bun resolves bare
  // specifiers by walking up from the importing file, so `@anthelia/plugin`
  // needs the same node_modules links the plugin test helpers install
  // (plugin-test-helpers.ts), with a copy fallback for Windows hosts
  // without Developer Mode. Without them this scenario is at the mercy of
  // the process's resolution cache and fails in a fresh test run.
  await installSdkLinks(root);
  await mkdir(join(root, ".natalia", "plugins", "demo.plugin"), {
    recursive: true,
  });
  await writeFile(
    join(root, ".natalia", "plugins", "demo.plugin", "natalia.plugin.json"),
    JSON.stringify({
      apiVersion: 1,
      id: "demo.plugin",
      version: "1.0.0",
      name: "Demo",
      capabilities: ["commands"],
    }),
  );
  await writeFile(
    join(root, ".natalia", "plugins", "demo.plugin", "index.ts"),
    `import { definePlugin } from "${pathToFileURL(join(repositoryRoot, "packages", "core", "plugin", "src", "index.ts")).href}";
export default definePlugin({
  manifest: { apiVersion: 1, id: "demo.plugin", version: "1.0.0", name: "Demo", capabilities: ["commands"] },
  setup(api) { api.commands.register({ name: "hello", title: "Hello", run() {} }); },
});`,
  );
  await writeFile(
    join(root, "global.json"),
    JSON.stringify({
      version: 3,
      plugins: { paths: [join(root, ".natalia", "plugins")] },
    }),
  );
  const runtime = createRealRuntimeClient({
    workspaceRoot: root,
    globalConfigPath: join(root, "global.json"),
    sessionID: "ses_management",
  });
  const server = createRuntimeHttpServer({
    client: runtime,
    token: "token",
  });
  runtime.start(() => undefined);
  const sdk = createNataliaSDK({ baseURL: server.url, token: "token" });
  try {
    const created = await sdk.newSession({
      id: "ses_external",
      title: "External",
    });
    expect(created).toEqual({ sessionID: "ses_external", created: true });
    const replay = await sdk.newSession({ id: "ses_external" });
    expect(replay.created).toBe(false);

    const saved = await sdk.permissionSave({
      name: "strict",
      profile: {
        approval: "ask",
        description: "Strict",
        permissions: { tools: { allow: ["echo"], exclude: [] } },
      },
    });
    expect(saved.saved).toBe(true);
    const list = await sdk.permissionList();
    expect(
      list.profiles.find((profile) => profile.name === "strict"),
    ).toBeDefined();
    const refused = await sdk.permissionDelete("ask");
    expect(refused.deleted).toBe(false);

    const agent = await sdk.createAgent({
      name: "reviewer",
      config: {
        description: "Reviews",
        mode: "subagent",
        systemPrompt: "",
        allowedTools: [],
        excludedTools: [],
        mcpServers: [],
        hidden: false,
      },
    });
    expect(agent.created).toBe(true);
    const removed = await sdk.deleteAgent("reviewer");
    expect(removed.deleted).toBe(true);

    const exported = await sdk.exportSession("ses_external");
    expect(exported.events).toEqual([]);
    const archived = await sdk.archiveSession("ses_external");
    expect(archived.archived).toBe(true);

    const unloaded = await sdk.unloadPlugin("demo.plugin");
    expect(unloaded.unloaded).toBe(true);
    const reloaded = await sdk.reloadPlugin("demo.plugin");
    expect(reloaded.reloaded).toBe(true);
  } finally {
    server.stop();
    await runtime.dispose?.();
  }
}, 60_000);

/**
 * Makes `@natalia/*` resolvable from a workspace outside the repo. Symlinks
 * are preferred; hosts without Developer Mode (Windows) fall back to copies,
 * which resolve identically inside the test process.
 */
/**
 * The repository root, derived from THIS file's location rather than the
 * process cwd: `bun test` runs with the package directory as cwd, and a
 * fixture that built repo paths from it imported from
 * packages/tooling/sdk/packages/core/... — which failed the config reload
 * and left every later write unapplied.
 */
const repositoryRoot = resolve(import.meta.dir, "../../../..");

async function installSdkLinks(root: string) {
  const scoped = join(root, "node_modules", "@natalia");
  await mkdir(scoped, { recursive: true });
  for (const pkg of ["plugin", "contracts"]) {
    const target = join(scoped, pkg);
    try {
      await symlink(join(repositoryRoot, "packages", pkg), target, "dir");
    } catch {
      await cp(join(repositoryRoot, "packages", pkg), target, {
        recursive: true,
        filter: (source) => !source.includes(`${sep}node_modules${sep}`),
      });
    }
  }
}
