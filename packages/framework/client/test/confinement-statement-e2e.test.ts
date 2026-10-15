import { expect, test } from "bun:test";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import {
  createOfficialRuntimeClient,
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";
import { createScriptedProvider } from "./e2e-harness";

/**
 * The agent layer of the danger design (sandbox study §6b①), end to end:
 * the Main Agent's provider request states its CURRENT confinement mode in
 * the dynamic context block — the tool schema advertises the escalation
 * targets, the request says where the agent IS. It rides the dynamic layer,
 * so the cached prefix (system prompt + tool schemas) is untouched.
 */

useWorkspaceCleanup();

test("the main agent's request states the session's confinement mode", async () => {
  const root = await officialPluginWorkspace("confinement-statement");
  const sessionID = "ses_confinement_statement" as SessionID;
  const requestTexts: string[] = [];
  const client = createOfficialRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request: {
        messages?: Array<{ role: string; content: string }>;
      }) {
        // The captured request text: the environment block's line is the
        // observable — a static prompt line would fail this capture's
        // dynamic-block shape.
        for (const message of request.messages ?? [])
          if (message.role === "user") requestTexts.push(message.content);
        yield { type: "content" as const, text: "ok" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.sessionAttach!(sessionID);
  await client.submitAndWait!("do a thing");

  const requests = requestTexts.join("\n");
  // The mode the request states is the deployment default as THIS host
  // can enforce it: workspace-write where the rung exists, the degraded
  // danger-full-access where it does not (Windows). The escalation
  // targets are the same either way — danger-full-access is the only
  // widening a rung-less host can offer.
  expect(requests).toContain(
    `Confinement mode: ${
      process.platform === "linux" ? "workspace-write" : "danger-full-access"
    }`,
  );
  // And the widening advertisement matches the mode: from
  // workspace-write there is one target, from danger-full-access there
  // is none — the product says so rather than naming an unreachable
  // target.
  if (process.platform === "linux") {
    expect(requests).toContain("targets: danger-full-access");
  } else {
    expect(requests).toContain("no wider mode exists from here");
  }
  // Inside the dynamic context block — never the static system prompt.
  expect(requests).toContain('<runtime_context source="environment"');

  await client.dispose?.();
}, 30_000);
