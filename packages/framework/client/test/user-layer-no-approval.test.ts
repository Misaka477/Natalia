/**
 * The user layer is never gated by the permission layer.
 *
 * The rule: the tool layer decides whether the MODEL (and a sub-agent) has to
 * ask, and the human at the interface never does — clicking a control in the
 * shell always succeeds. Structurally the two paths are separate: a model
 * turn reaches a tool through `execute-run`, which consults
 * `tool.requiresApproval`, while a click reaches the runtime's own face
 * (`nativeTerminalStart` and its siblings) and calls the controller directly.
 *
 * This pins the user side of that split, because the other half already has a
 * test: a pane the MODEL starts waits for an approval answer
 * (`real-runtime-d.test.ts`), while the pane a click starts is created with no
 * approval request anywhere in the event stream.
 */
import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  createOfficialRuntimeClient,
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();

const provider = {
  provider: "test",
  model: "test",
  async *stream(): AsyncGenerator<never> {
    yield { type: "done" } as never;
  },
};

test("a pane the user starts is created without an approval request", async () => {
  const root = await officialPluginWorkspace("user-layer-no-approval");
  const sessionID = "ses_user_layer_no_approval";
  const events: RuntimeEvent[] = [];
  const client = createOfficialRuntimeClient({
    workspaceRoot: root,
    sessionID,
    provider,
  });
  client.start((event) => {
    events.push(event);
  });
  try {
    // The face a click reaches. `command` is empty on purpose: the runtime
    // resolves the shell this host has, and the answer still has to arrive
    // without anyone being asked.
    const started = await client.nativeTerminalStart?.({
      command: "",
      cwd: root,
      sessionID,
    });
    expect(started?.id).toBeTruthy();
    // No approval request was raised for the human's own action...
    expect(events.filter((event) => event.type === "approval.request")).toEqual(
      [],
    );
    // ...and the pane really exists rather than the call being swallowed.
    const listed = await client.nativeTerminalList?.(sessionID);
    expect(listed?.some((session) => session.id === started?.id)).toBe(true);
  } finally {
    await client.dispose?.();
  }
}, 30_000);
