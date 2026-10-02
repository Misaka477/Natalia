import { expect, test } from "bun:test";
import {
  RUNTIME_RPC_ERROR_CODES,
  type InputMutationResult,
  type RuntimeClient,
  type RuntimeEvent,
} from "@anthelia/contracts";
import { handleRPCMessage } from "../src/host";

function stubClient(overrides: Partial<RuntimeClient> = {}): RuntimeClient {
  return {
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
    ...overrides,
  };
}

const result: InputMutationResult = {
  ok: true,
  input: { id: "in_1", text: "queued", delivery: "next-turn" },
};

test("input.remove/replace/promote validate params and delegate", async () => {
  const calls: Array<[string, unknown]> = [];
  const client = stubClient({
    async removeInput(input) {
      calls.push(["removeInput", input]);
      return result;
    },
    async replaceInput(input) {
      calls.push(["replaceInput", input]);
      return result;
    },
    async promoteInput(input) {
      calls.push(["promoteInput", input]);
      return result;
    },
  });

  const remove = await handleRPCMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "input.remove",
      params: { id: "in_1", sessionID: "ses_1" },
    },
    client,
  );
  expect(remove.result).toEqual(result);
  const replace = await handleRPCMessage(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "input.replace",
      params: { id: "in_1", text: "edited", sessionID: "ses_1" },
    },
    client,
  );
  expect(replace.result).toEqual(result);
  const promote = await handleRPCMessage(
    { jsonrpc: "2.0", id: 3, method: "input.promote", params: { id: "in_1" } },
    client,
  );
  expect(promote.result).toEqual(result);

  expect(calls).toEqual([
    ["removeInput", { id: "in_1", sessionID: "ses_1" }],
    ["replaceInput", { id: "in_1", text: "edited", sessionID: "ses_1" }],
    ["promoteInput", { id: "in_1" }],
  ]);
});

test("input mutations reject malformed params before touching the runtime", async () => {
  const client = stubClient({
    async removeInput() {
      throw new Error("must not be reached");
    },
    async replaceInput() {
      throw new Error("must not be reached");
    },
  });

  const missingId = await handleRPCMessage(
    { jsonrpc: "2.0", id: 1, method: "input.remove", params: {} },
    client,
  );
  expect(missingId.error?.code).toBe(RUNTIME_RPC_ERROR_CODES.invalidParams);
  expect(missingId.result).toBeUndefined();

  const missingText = await handleRPCMessage(
    { jsonrpc: "2.0", id: 2, method: "input.replace", params: { id: "in_1" } },
    client,
  );
  expect(missingText.error?.code).toBe(RUNTIME_RPC_ERROR_CODES.invalidParams);

  const badSession = await handleRPCMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "input.promote",
      params: { id: "in_1", sessionID: 7 },
    },
    client,
  );
  expect(badSession.error?.code).toBe(RUNTIME_RPC_ERROR_CODES.invalidParams);
});

test("goal.control validates the action and delegates to the runtime", async () => {
  const calls: Array<[string, string | undefined]> = [];
  const client = stubClient({
    async goalControl(action, sessionID) {
      calls.push([action, sessionID]);
      return { ok: true, action };
    },
  });

  const paused = await handleRPCMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "goal.control",
      params: { action: "pause", sessionID: "ses_1" },
    },
    client,
  );
  expect(paused.result).toEqual({ ok: true, action: "pause" });
  expect(calls).toEqual([["pause", "ses_1"]]);

  // A member this runtime lacks is "not supported", not a silent no-op.
  const unsupported = await handleRPCMessage(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "goal.control",
      params: { action: "resume" },
    },
    stubClient(),
  );
  expect(unsupported.error?.code).toBe(RUNTIME_RPC_ERROR_CODES.notSupported);

  const badAction = await handleRPCMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "goal.control",
      params: { action: "explode" },
    },
    client,
  );
  expect(badAction.error?.code).toBe(RUNTIME_RPC_ERROR_CODES.invalidParams);
  expect(calls).toHaveLength(1);
});

test("goal.edit validates the input and delegates to the runtime", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = stubClient({
    async goalEdit(input, sessionID) {
      calls.push({ ...input, sessionID });
      return { ok: true, action: "edit" };
    },
  });

  const edited = await handleRPCMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "goal.edit",
      params: {
        input: { goalID: "goal_1", revision: 2, objective: "new objective" },
        sessionID: "ses_1",
      },
    },
    client,
  );
  expect(edited.result).toEqual({ ok: true, action: "edit" });
  expect(calls).toEqual([
    {
      goalID: "goal_1",
      revision: 2,
      objective: "new objective",
      sessionID: "ses_1",
    },
  ]);

  const missingRevision = await handleRPCMessage(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "goal.edit",
      params: { input: { goalID: "goal_1" } },
    },
    client,
  );
  expect(missingRevision.error?.code).toBe(
    RUNTIME_RPC_ERROR_CODES.invalidParams,
  );

  const emptyEdit = await handleRPCMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "goal.edit",
      params: { input: { goalID: "goal_1", revision: 2 } },
    },
    client,
  );
  expect(emptyEdit.error?.code).toBe(RUNTIME_RPC_ERROR_CODES.invalidParams);

  const badCap = await handleRPCMessage(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "goal.edit",
      params: { input: { goalID: "goal_1", revision: 2, maxGoalRounds: -1 } },
    },
    client,
  );
  expect(badCap.error?.code).toBe(RUNTIME_RPC_ERROR_CODES.invalidParams);
  expect(calls).toHaveLength(1);
});
