import { expect, test } from "bun:test";
import type {
  RuntimeEvent,
  RuntimeProjectedMessage,
} from "@anthelia/contracts";
import { createUiPluginHost, defineUiPlugin } from "../src";

function fakeRoot(): HTMLElement {
  const node = {
    tagName: "DIV",
    children: [] as unknown[],
    innerHTML: "",
    textContent: "",
    replaceChildren() {
      node.children = [];
      node.innerHTML = "";
      node.textContent = "";
    },
    appendChild(child: unknown) {
      node.children.push(child);
      return child;
    },
  };
  return node as unknown as HTMLElement;
}

function runtimeFixture() {
  let sink: ((event: RuntimeEvent) => void) | undefined;
  const runtime = {
    start(next: (event: RuntimeEvent) => void) {
      sink = next;
    },
    cancel() {},
  } as unknown as import("@anthelia/contracts").RuntimeClient;
  return {
    runtime,
    emit(event: RuntimeEvent) {
      sink?.(event);
    },
  };
}

function page(turnID: string, text: string): RuntimeProjectedMessage {
  const submitted: Extract<RuntimeEvent, { type: "turn.submitted" }> = {
    type: "turn.submitted",
    id: turnID,
    text,
    byteLength: text.length,
    lineCount: 1,
    sha256: "x",
    sessionID: "ses_shared" as never,
  };
  return {
    id: turnID,
    turnID,
    submitted,
    rows: [
      {
        id: `${turnID}:user`,
        turnID,
        kind: "user",
        event: submitted,
      },
    ],
  };
}

test("a late workspace event must not fork an empty session state key", async () => {
  const fixture = runtimeFixture();
  const host = await createUiPluginHost({
    root: fakeRoot(),
    runtime: fixture.runtime,
  });
  await host.load(
    defineUiPlugin({
      id: "shadow-repro",
      name: "Shadow repro",
      version: "1",
      mount() {},
    }),
  );

  // Startup hydrates before the session list knows the workspace id, so the
  // state lands on the `default:` key.
  host.projection.activateSession?.("ses_shared");
  host.projection.hydrateMessages?.([page("t1", "history")], "newer");
  expect(host.projection.getState().natalia.messages.length).toBe(1);

  // Switch away; the session is no longer active.
  host.projection.activateSession?.("ses_other");

  // A background event now carries the concrete workspace id. It must join the
  // existing `default:` state rather than fork a second shell key.
  fixture.emit({
    type: "session.created",
    sessionID: "ses_shared",
    workspaceID: "ws_a",
    title: "Shared",
  } as RuntimeEvent);

  // Returning to the session with the concrete workspace id must still show
  // the hydrated history, not an empty shell.
  host.projection.activateSession?.("ses_shared", "ws_a");
  expect(host.projection.getState().sessionID).toBe("ses_shared");
  expect(
    host.projection.getState().natalia.messages.map((message) => message.text),
  ).toContain("history");

  await host.close();
});
