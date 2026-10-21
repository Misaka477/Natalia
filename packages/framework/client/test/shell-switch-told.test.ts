/**
 * The shell switch tells the MODEL, and does not wake it.
 *
 * The switch has two halves a UI click cannot check for itself: the durable
 * `context.instructions {kind: "shell_switch"}` notice (the journal half,
 * same channel a rung switch rides) and the per-turn environment block (the
 * live half — the model reads "Shell: bash" on the turn it is ALREADY
 * running). Without the second half a model that just moved from bash to
 * pwsh keeps writing POSIX syntax into a PowerShell pane and every command
 * dies on the first `&&`.
 *
 * And it must not WAKE an idle session to say so: the switch is a decision
 * about this conversation, recorded durably; a wake would spend a provider
 * call to announce a choice the model meets on its next command anyway.
 */
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import type { ProviderStreamRequest } from "@anthelia/runtime";
import { createRealRuntimeClient } from "../src";
import { recordTurnRequest } from "./e2e-harness";

test("the shell switch tells the model without waking it", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-shell-switch-told-"));
  const sessionID = "ses_shell_switch_told" as SessionID;
  const events: RuntimeEvent[] = [];
  // Turn requests only: the session-title call is a real provider call that
  // belongs to no turn (see `recordTurnRequest`).
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    provider: {
      provider: "capture",
      model: "capture-model",
      async *stream(request: ProviderStreamRequest) {
        recordTurnRequest(requests, request);
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  try {
    await client.sessionAttach!(sessionID);

    const moved = await client.setSessionShell!({ shell: "bash" });
    expect(moved).toMatchObject({ changed: true, to: "bash" });

    // TOLD, the journal half: the durable notice, the same channel a rung
    // switch rides.
    const notice = events.find(
      (event) =>
        event.type === "context.instructions" &&
        (event as { kind?: string }).kind === "shell_switch",
    );
    expect(notice).toBeDefined();
    expect(String((notice as { summary?: string }).summary)).toContain("bash");

    // NOT WOKEN: the switch itself started no turn. The model learns the
    // shell on the turn it is already running, never by a wake.
    expect(requests).toHaveLength(0);

    // TOLD, the live half: the next turn's environment block states the
    // shell and what its syntax means.
    await client.submitAndWait!("run the tests");
    expect(requests.length).toBeGreaterThanOrEqual(1);
    const environment = requests
      .at(-1)!
      .messages.map((message) => String(message.content))
      .find((content) =>
        content.includes('<runtime_context source="environment"'),
      );
    expect(environment).toBeDefined();
    expect(environment).toContain("Shell: bash");
    expect(environment).toContain("POSIX syntax");

    // 自动 back is a real answer too: the session's own choice is cleared
    // and the shell RESOLVES to the platform's own — which the block states
    // rather than omits, because the model must know which syntax its
    // commands run in, not guess it from the absence of a line.
    const cleared = await client.setSessionShell!({ shell: "auto" });
    expect(cleared).toMatchObject({ changed: true, to: "auto" });
    await client.submitAndWait!("run the tests again");
    const afterClear = requests
      .at(-1)!
      .messages.map((message) => String(message.content))
      .find((content) =>
        content.includes('<runtime_context source="environment"'),
      );
    expect(afterClear).toBeDefined();
    expect(afterClear).toContain(
      process.platform === "win32" ? "Shell: pwsh" : "Shell: bash",
    );
  } finally {
    await client.dispose?.();
  }
}, 60_000);
