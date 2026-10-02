import { expect, test } from "bun:test";
import { RPC_INTENTIONALLY_LOCAL, RPC_ROUTE_MEMBERS } from "../src/rpc";
import { handleRPCMessage } from "../src/rpc";
import type { RuntimeClient } from "@anthelia/contracts";

/**
 * The explicit exit path.
 *
 * A window that hides on close leaves the runtime alive, so SOMETHING has to be
 * able to end it. Without this the only way out is a signal or a task manager,
 * which is the trap the minimise policy exists to avoid.
 */

/** A client whose only member is the one under test, plus the shape it needs. */
function clientWithShutdown(count: () => void): RuntimeClient {
  return {
    start() {},
    async submit() {
      return {
        type: "turn.submitted",
        id: "t",
        text: "",
        byteLength: 0,
        lineCount: 1,
        sha256: "0",
      };
    },
    shutdown: count,
  } as unknown as RuntimeClient;
}

test("session.shutdown ends the process and answers before it goes away", async () => {
  let calls = 0;
  const response = await handleRPCMessage(
    { jsonrpc: "2.0", id: 1, method: "session.shutdown", params: {} },
    clientWithShutdown(() => {
      calls += 1;
    }),
  );
  expect(response.result).toEqual({ shuttingDown: true });
  expect(calls).toBe(1);
});

test("a second shutdown answers again (a double click is one teardown)", async () => {
  // The client owns idempotence; the transport's job is not to add a second
  // path that could disagree about it.
  let calls = 0;
  const client = clientWithShutdown(() => {
    calls += 1;
  });
  for (const id of [1, 2, 3])
    await handleRPCMessage(
      { jsonrpc: "2.0", id, method: "session.shutdown", params: {} },
      client,
    );
  expect(calls).toBe(3);
});

test("a host without the surface reports it cannot, rather than pretending", async () => {
  // "methodNotFound" would say the protocol disagrees; the honest answer is that
  // THIS deployment has no shutdown surface.
  const response = await handleRPCMessage(
    { jsonrpc: "2.0", id: 4, method: "session.shutdown", params: {} },
    {
      start() {},
      async submit() {
        return {};
      },
    } as unknown as RuntimeClient,
  );
  const error = (
    response as { error?: { data?: { kind?: string; member?: string } } }
  ).error;
  expect(error?.data?.kind).toBe("notSupported");
  expect(error?.data?.member).toBe("shutdown");
});

test("the route has a row, so the method exists rather than being invented", () => {
  // The route table is the authority for what a method IS: a name with no row
  // answers -32601 before any dispatch runs, and it also feeds the availability
  // report. A method that is not in it does not quietly work.
  expect(RPC_ROUTE_MEMBERS["session.shutdown"]).toBe("shutdown");
  // And it is not one of the deliberately-local members.
  expect(RPC_INTENTIONALLY_LOCAL["session.shutdown"]).toBeUndefined();
});
