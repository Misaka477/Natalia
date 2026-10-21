import { expect, test } from "bun:test";
import type { RuntimeClient, RuntimeEvent } from "@anthelia/contracts";
import { handleRPCMessage } from "../src/host";

/**
 * `shell.set` carries 自动 through to the client.
 *
 * The contract's `setSessionShell` accepts `auto` — it clears the session's
 * own choice and the slot, so the executor falls back to the platform shell —
 * and the client implements exactly that. But the route's whitelist named only
 * bash/pwsh/zsh, so a settings row that picked 自动 was answered
 * invalidParams: the pane kept the old shell until the next start, while the
 * row's own comment promised "the next command uses the new shell without a
 * restart". Measured: the row said 自动, the pane prompt still said PS.
 */

/** Only the required members — the route guard is about the member, not the runtime. */
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
    async diagnostics() {
      return [];
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
}

test("自动 is a value the route forwards, not one it rejects", async () => {
  const calls: Array<{ shell?: string; sessionID?: string }> = [];
  const client = stubClient({
    async setSessionShell(input) {
      calls.push(input);
      return { changed: true, to: "auto" };
    },
  });
  const result = await handleRPCMessage(
    { jsonrpc: "2.0", id: 1, method: "shell.set", params: { shell: "auto" } },
    client,
    undefined,
    undefined,
  );
  expect(result.error).toBeUndefined();
  expect(calls).toEqual([{ shell: "auto" }]);
});

test("a shell the runtime cannot name is still refused by the route", async () => {
  // The whitelist is the route's own check, and widening it for 自动 must not
  // widen it for everything: a value nothing implements is still invalidParams.
  const result = await handleRPCMessage(
    { jsonrpc: "2.0", id: 1, method: "shell.set", params: { shell: "fish" } },
    stubClient({
      async setSessionShell() {
        return { changed: false, to: "fish" };
      },
    }),
    undefined,
    undefined,
  );
  expect(result.error?.code).toBe(-32602);
});
