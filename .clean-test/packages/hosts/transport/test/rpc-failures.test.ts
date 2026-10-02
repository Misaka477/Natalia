import { expect, test } from "bun:test";
import {
  RuntimeRefusal,
  RUNTIME_RPC_ERROR_CODES,
  failureKindOfCode,
} from "@anthelia/contracts";
import type { RuntimeClient, RuntimeEvent } from "@anthelia/contracts";
import { handleRPCMessage } from "../src/host";

/**
 * The five failure kinds, at the point where they are decided.
 *
 * Before this, every failure left as `-32602` with a string, so a remote consumer
 * could not tell "there is no such method" from "this runtime cannot" from "your
 * argument is wrong" from "policy says no" from "something broke" — five
 * situations with five different correct reactions. These tests assert on codes
 * and structured data only; matching on message text is the thing being removed,
 * so it must not reappear in the tests that guard it.
 */

function stubClient(
  overrides: Partial<RuntimeClient> = {},
): RuntimeClient & { diagnostics_: string[] } {
  const diagnostics_: string[] = [];
  // Only the required members. A runtime this small must still be able to answer,
  // and it is what proves `-32000` is about the member rather than the route.
  const client: RuntimeClient & { diagnostics_: string[] } = {
    diagnostics_,
    start() {},
    async submit(text) {
      return {
        type: "turn.submitted",
        id: "turn_1",
        text,
        byteLength: text.length,
        lineCount: 1,
        sha256: "stub",
      };
    },
    cancel() {},
    snapshot(): RuntimeEvent {
      return { type: "diagnostic", level: "info", message: "stub" };
    },
    diagnostic(message) {
      diagnostics_.push(message);
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
    ...overrides,
  };
  return client;
}

async function fail(
  method: string,
  params?: Record<string, unknown>,
  overrides?: Partial<RuntimeClient>,
) {
  const client = stubClient(overrides);
  const response = await handleRPCMessage(
    { jsonrpc: "2.0", id: 1, method, params },
    client,
  );
  expect(response.result).toBeUndefined();
  return { error: response.error!, client };
}

test("a method with no route is method-not-found, not invalid params", async () => {
  const { error } = await fail("no.such.method");
  expect(error.code).toBe(RUNTIME_RPC_ERROR_CODES.methodNotFound);
  expect(error.data).toEqual({
    kind: "methodNotFound",
    method: "no.such.method",
  });
});

test("provider discovery accepts empty keys with auth headers and validates header values", async () => {
  let received: unknown;
  const response = await handleRPCMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "provider.discover",
      params: {
        type: "openai-compatible",
        baseURL: "https://example.test",
        apiKey: "",
        headers: { Authorization: "Bearer custom" },
      },
    },
    stubClient({
      providerDiscover: async (input) => {
        received = input;
        return { models: ["model"] };
      },
    }),
  );
  expect(response.result).toEqual({ models: ["model"] });
  expect(received).toEqual({
    type: "openai-compatible",
    baseURL: "https://example.test",
    apiKey: "",
    headers: { Authorization: "Bearer custom" },
  });

  const invalid = await fail(
    "provider.discover",
    {
      type: "openai-compatible",
      baseURL: "https://example.test",
      apiKey: "key",
      headers: { Authorization: 42 },
    },
    { providerDiscover: async () => ({ models: [] }) },
  );
  expect(invalid.error.code).toBe(RUNTIME_RPC_ERROR_CODES.invalidParams);
});

test("provider addition accepts an empty API key for custom authentication", async () => {
  let received: unknown;
  const response = await handleRPCMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "provider.add",
      params: {
        name: "custom",
        type: "openai-compatible",
        apiKey: "",
        headers: { Authorization: "Bearer custom" },
      },
    },
    stubClient({
      providerAdd: async (input) => {
        received = input;
        return { saved: true };
      },
    }),
  );
  expect(response.result).toEqual({ saved: true });
  expect(received).toMatchObject({
    apiKey: "",
    headers: { Authorization: "Bearer custom" },
  });
});

test("a routed member this runtime lacks is not-supported, and names its capability", async () => {
  // The route exists; the member behind it does not. The caller cannot fix this
  // by changing arguments, so it must not look like an argument problem.
  const { error } = await fail("pause");
  expect(error.code).toBe(RUNTIME_RPC_ERROR_CODES.notSupported);
  expect(error.data).toEqual({
    kind: "notSupported",
    member: "pause",
    capability: "turnControl",
  });
});

test("the capability travels with every not-supported member, so a consumer can switch off a group", async () => {
  // One member per group would be a coincidence; the mapping comes from the
  // capability table, so spot-checking three different groups is the point.
  for (const [method, member, capability] of [
    ["checkpoint.list", "checkpointList", "checkpoint"],
    ["sandbox.merge", "sandboxMerge", "sandbox"],
    ["session.list", "sessionList", "sessions"],
  ] as const) {
    const { error } = await fail(method);
    expect(error.data).toEqual({ kind: "notSupported", member, capability });
  }
});

test("bad arguments are invalid params, and only bad arguments are", async () => {
  const withRead: Partial<RuntimeClient> = {
    async workspaceRead() {
      throw new Error("must not be reached");
    },
  };
  const { error } = await fail(
    "workspace.read",
    { path: "a.txt", offset: -1 },
    withRead,
  );
  expect(error.code).toBe(RUNTIME_RPC_ERROR_CODES.invalidParams);
  expect(error.data).toEqual({ kind: "invalidParams" });
  // A missing required argument is the same kind, and the member is never called.
  const missing = await fail("workspace.read", {}, withRead);
  expect(missing.error.code).toBe(RUNTIME_RPC_ERROR_CODES.invalidParams);

  const withResourceRead: Partial<RuntimeClient> = {
    async resourceRead() {
      throw new Error("must not be reached");
    },
  };
  const badResource = await fail(
    "resource.read",
    { resource: "demo", params: { sessionID: 1 } },
    withResourceRead,
  );
  expect(badResource.error.code).toBe(RUNTIME_RPC_ERROR_CODES.invalidParams);
  const missingResource = await fail("resource.read", {}, withResourceRead);
  expect(missingResource.error.code).toBe(
    RUNTIME_RPC_ERROR_CODES.invalidParams,
  );
});

test("an envelope that is not a request is invalid request", async () => {
  const response = await handleRPCMessage("not an object", stubClient());
  expect(response.error?.code).toBe(RUNTIME_RPC_ERROR_CODES.invalidRequest);
  expect(response.error?.data).toEqual({ kind: "invalidRequest" });
});

test("a refusal from the runtime keeps its reason and stays out of the internal bucket", async () => {
  const { error, client } = await fail("session.list", undefined, {
    async sessionList() {
      throw new RuntimeRefusal("a turn is running");
    },
  });
  expect(error.code).toBe(RUNTIME_RPC_ERROR_CODES.refused);
  expect(error.data).toEqual({ kind: "refused", reason: "a turn is running" });
  // A refusal is an answer, not a fault: it must not be recorded as a runtime
  // failure, or every ordinary "not now" would show up in diagnostics.
  expect(client.diagnostics_).toEqual([]);
});

test("an unclassified failure is internal, says nothing, and puts the detail in diagnostics", async () => {
  const secret = "/home/someone/project/.env";
  const { error, client } = await fail("session.list", undefined, {
    async sessionList() {
      throw new Error(`ENOENT: no such file or directory, open '${secret}'`);
    },
  });
  expect(error.code).toBe(RUNTIME_RPC_ERROR_CODES.internal);
  // The message is the whole point: an unclassified error's text can carry a
  // path, a command line or a secret, and we do not know which.
  expect(error.message).not.toContain(secret);
  expect(error.message).not.toContain("ENOENT");
  const data = error.data as { kind: string; errorID: string };
  expect(data.kind).toBe("internal");
  expect(data.errorID).toMatch(/^err_/u);
  // Dropped from the reply, not dropped: the detail is durable and correlated, so
  // an operator can still find out what happened.
  expect(client.diagnostics_).toHaveLength(1);
  expect(client.diagnostics_[0]).toContain(data.errorID);
  expect(client.diagnostics_[0]).toContain(secret);
});

test("reporting a failure cannot itself fail", async () => {
  // Found by an existing CLI test: the first version of this called
  // `client.diagnostic` unconditionally, and a client that does not have it —
  // the contract says required, some clients are wrong — turned an ordinary
  // failure into a dead connection. Recording the detail is best effort; owing
  // the caller an answer is not.
  const client = stubClient({
    async sessionList() {
      throw new Error("boom");
    },
  });
  delete (client as { diagnostic?: unknown }).diagnostic;
  const response = await handleRPCMessage(
    { jsonrpc: "2.0", id: 1, method: "session.list" },
    client,
  );
  expect(response.error?.code).toBe(RUNTIME_RPC_ERROR_CODES.internal);
  expect(response.error?.data).toMatchObject({ kind: "internal" });
});

test("every code we answer with maps to exactly one kind", async () => {
  // A consumer switches on the kind, so two codes meaning the same thing (or a
  // code meaning nothing) would put it back to guessing.
  const codes = Object.values(RUNTIME_RPC_ERROR_CODES);
  expect(new Set(codes).size).toBe(codes.length);
  for (const code of codes) expect(failureKindOfCode(code)).toBeString();
  expect(failureKindOfCode(-1)).toBeUndefined();
});

test("navi.chat / nia.chat routes reach the object surface, not a function-only guard", async () => {
  // naviChat / niaChat are object surfaces (methods on an object), so the
  // function-only requireMember guard must not be applied to them. This is the
  // exact drift that made a live web UI see "this runtime does not support
  // naviChat" while the runtime did implement the surface.
  const calls: Array<{ stream: string; input: unknown }> = [];
  const client = stubClient({
    naviChat: {
      async messagesPage(input: unknown) {
        calls.push({ stream: "navi", input });
        return { data: [], cursor: {} };
      },
    } as never,
    niaChat: {
      async messagesPage(input: unknown) {
        calls.push({ stream: "nia", input });
        return { data: [], cursor: {} };
      },
    } as never,
  });

  const navi = await handleRPCMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "navi.chat.messages.page",
      params: { sessionID: "ses_navi", limit: 5 },
    },
    client,
  );
  expect(navi.error).toBeUndefined();
  expect(navi.result).toEqual({ data: [], cursor: {} });
  expect(calls[0]).toEqual({
    stream: "navi",
    input: { sessionID: "ses_navi", limit: 5 },
  });

  const nia = await handleRPCMessage(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "nia.chat.messages.page",
      params: { sessionID: "ses_nia" },
    },
    client,
  );
  expect(nia.error).toBeUndefined();
  expect(calls[1]).toEqual({
    stream: "nia",
    input: { sessionID: "ses_nia" },
  });
});

test("navi.chat with no surface answers method-not-available (-32601), not -32000", async () => {
  const client = stubClient();
  const response = await handleRPCMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "navi.chat.messages.page",
      params: { sessionID: "ses_missing" },
    },
    client,
  );
  expect(response.error?.code).toBe(-32601);
  expect(response.error?.message).toContain(
    "navi.chat surface is not available",
  );
});
