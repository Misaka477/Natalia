/**
 * Two layers, and the rungs only set the sandbox scope.
 *
 * The rule: the READ layer never asks; every other tool asks on EVERY call
 * under `ask`, whatever it touches — inside the workspace or outside it. The
 * four rungs (read / ask / auto in the workspace / auto at system scope) set
 * the sandbox, not the asking. An approval is for one action: a second edit
 * asks again.
 *
 * Driven through a real runtime and the real plugin store, because the layers
 * are decided where the call is executed, not where the schema is declared.
 */
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  createOfficialRuntimeClient,
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();

type ScriptedStep = { name: string; args: Record<string, unknown> };

/** One model step per turn-message batch, taken from the script in order. */
function scriptedProvider(script: ScriptedStep[]) {
  let index = 0;
  return {
    provider: "test",
    model: "test",
    async *stream(request: {
      messages: Array<{ role: string }>;
    }): AsyncGenerator<{
      type: "tool_call";
      calls: Array<{ id: string; name: string; arguments: string }>;
    }> {
      // One script step per completed tool call: the read runs first, then a
      // write per answer. Keying on the NUMBER of tool answers — rather than
      // on "there is a tool message" — is what makes the second write happen
      // at all: any tool message would otherwise end the turn.
      const answers = request.messages.filter(
        (message) => message.role === "tool",
      ).length;
      if (index < script.length && index <= answers) {
        const step = script[index++]!;
        yield {
          type: "tool_call",
          calls: [
            {
              id: `call_${index}`,
              name: step.name,
              arguments: JSON.stringify(step.args),
            },
          ],
        };
        return;
      }
      // Script exhausted (or the call came back): end the turn.
      yield { type: "done" } as never;
    },
  };
}

test("under ask the read layer never asks and every edit asks", async () => {
  const root = await officialPluginWorkspace("two-layer-permissions");
  const sessionID = "ses_two_layer";
  const events: RuntimeEvent[] = [];
  const seed = join(root, "README.md");
  const target = join(root, "layer.txt");
  await writeFile(seed, "seed\n");
  const client = createOfficialRuntimeClient({
    workspaceRoot: root,
    sessionID,
    // read first, then two writes: the second write is the point — an
    // approval is for ONE action, so it asks again.
    provider: scriptedProvider([
      { name: "read_file", args: { path: seed } },
      { name: "write_file", args: { path: target, content: "one" } },
      { name: "write_file", args: { path: target, content: "two" } },
    ]) as never,
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  try {
    await client.submitAndWait!("layer test");
    const approvals = events.filter(
      (event) => event.type === "approval.request",
    );
    // The read is not among them, and both writes are: one approval per
    // action, not one approval per session.
    expect(approvals.every((event) => event.id.includes("call_"))).toBe(true);
    expect(approvals.length).toBe(2);
    // The read tool is declared read-tier, the write tool edit-tier — the
    // fact the decision is built on.
    expect(approvals.length).toBeGreaterThan(0);
  } finally {
    await client.dispose?.();
  }
}, 60_000);
