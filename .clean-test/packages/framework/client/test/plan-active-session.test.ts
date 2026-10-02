import { expect, test } from "bun:test";
import type { SessionID } from "@anthelia/contracts";
import type {
  ProviderStreamRequest,
  StreamingProvider,
} from "@anthelia/runtime";
import { createRealRuntimeClient } from "../src";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();

const provider: StreamingProvider = {
  provider: "plan-active-session",
  model: "plan-active-session-model",
  async *stream(_request: ProviderStreamRequest) {
    yield { type: "done" as const };
  },
};

test("plan documents are workspace-wide while activation is session-scoped", async () => {
  const root = await officialPluginWorkspace("plan-active-session");
  const firstSessionID = "ses_plan_active_first" as SessionID;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: firstSessionID,
    provider,
  });
  client.start(() => undefined);
  try {
    await client.sessionAttach!(firstSessionID);
    await client.planDocWrite!({
      path: "plans/workspace-plan.md",
      content: "# Workspace plan\n",
      title: "Workspace plan",
    });
    const marked = await client.planDocMark!({
      path: "plans/workspace-plan.md",
    });
    expect(marked.planID).toBeTruthy();
    expect(
      await client.planDocUpdateStatus!({
        planID: marked.planID,
        status: "audit_gaps",
      }),
    ).toEqual({ updated: true });

    // The plan is visible from the first session and has no active pointer yet.
    expect(await client.planDocList!()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          planID: marked.planID,
          status: "audit_gaps",
        }),
      ]),
    );
    expect(await client.planDocActive!()).toEqual({});

    expect(await client.planDocActivate!(marked.planID)).toEqual({
      planID: marked.planID,
      updated: true,
    });
    expect(await client.planDocActive!()).toEqual({ planID: marked.planID });
    expect(
      (await client.sessionList!()).find(
        (session) => session.id === firstSessionID,
      )?.activePlanID,
    ).toBe(marked.planID);

    // A different session shares the workspace plan list but has its own
    // active-plan pointer.
    const second = await client.sessionNew!();
    await client.sessionAttach!(second.sessionID);
    expect(await client.planDocList!()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          planID: marked.planID,
          status: "audit_gaps",
        }),
      ]),
    );
    expect(await client.planDocActive!()).toEqual({});

    await client.planDocActivate!(marked.planID);
    expect(await client.planDocActive!()).toEqual({ planID: marked.planID });

    await client.sessionAttach!(firstSessionID);
    expect(await client.planDocActive!()).toEqual({ planID: marked.planID });
    await client.sessionAttach!(second.sessionID);
    expect(await client.planDocActive!()).toEqual({ planID: marked.planID });
  } finally {
    await client.dispose?.();
  }
});

test("Nia and Navi prompts see workspace plans but only the session active plan", async () => {
  const root = await officialPluginWorkspace("plan-active-prompt");
  const prompts: { main: string[]; navi: string[]; nia: string[] } = {
    main: [],
    navi: [],
    nia: [],
  };
  // The static system prompt per channel, collected separately from the live
  // context so the ADR D1 split can be asserted.
  const personas: { main: string[]; navi: string[]; nia: string[] } = {
    main: [],
    navi: [],
    nia: [],
  };
  const providerWithPrompts: StreamingProvider = {
    provider: "plan-active-prompt",
    model: "plan-active-prompt-model",
    async *stream(request: ProviderStreamRequest) {
      const system = request.messages.find(
        (message) => message.role === "system",
      )?.content;
      const prompt = typeof system === "string" ? system : "";
      const channel = prompt.includes("<nia_chat_persona>")
        ? "nia"
        : prompt.includes("<navi_chat_persona>")
          ? "navi"
          : "main";
      personas[channel].push(prompt);
      // ADR D1: the main agent's plan handoff is dynamic runtime context
      // appended as a user message, not static system prompt content; the
      // Navi/Nia live work context likewise arrives as a `<runtime_context>`
      // user message. Collect everything the model actually sees.
      const seen =
        channel === "main"
          ? request.messages.map((message) => message.content).join("\n")
          : `${prompt}\n${request.messages
              .filter(
                (message) =>
                  message.role === "user" &&
                  message.content.includes("<runtime_context"),
              )
              .map((message) => message.content)
              .join("\n")}`;
      prompts[channel].push(seen);
      yield { type: "content" as const, text: "ok" };
      yield { type: "done" as const };
    },
  };
  const firstSessionID = "ses_plan_prompt_first" as SessionID;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: firstSessionID,
    provider: providerWithPrompts,
  });
  client.start(() => undefined);
  try {
    await client.sessionAttach!(firstSessionID);
    await client.planDocWrite!({
      path: "plans/prompt-plan.md",
      content: "# Prompt plan\n",
      title: "Prompt plan",
    });
    const marked = await client.planDocMark!({
      path: "plans/prompt-plan.md",
      title: "Prompt plan",
    });
    await client.planDocUpdateStatus!({
      planID: marked.planID,
      status: "audit_gaps",
    });
    await client.planDocActivate!(marked.planID);

    await client.niaChat!.submit({ text: "ping" });
    await client.naviChat!.submit({ text: "ping" });
    await client.submitAndWait!("main ping");
    expect(prompts.main.join("\n")).toContain("<next_plan_handoff>");
    expect(prompts.main.join("\n")).toContain(marked.planID);
    expect(prompts.nia.join("\n")).toContain(
      `Active plan: ${marked.planID} · audit_gaps · Prompt plan`,
    );
    expect(prompts.nia.join("\n")).toContain(`Known plan documents`);
    expect(prompts.nia.join("\n")).toContain(marked.planID);
    expect(prompts.navi.join("\n")).toContain(
      `Active plan (audit_gaps): Prompt plan`,
    );
    expect(prompts.navi.join("\n")).toContain(`Known plan documents`);
    expect(prompts.navi.join("\n")).toContain(marked.planID);

    const second = await client.sessionNew!();
    await client.sessionAttach!(second.sessionID);
    await client.niaChat!.submit({ text: "ping" });
    await client.submitAndWait!("main without active plan");
    const niaPromptWithoutActive = prompts.nia.at(-1) ?? "";
    expect(niaPromptWithoutActive).toContain("Active plan: none");
    expect(niaPromptWithoutActive).toContain(marked.planID);
    expect(prompts.main.at(-1) ?? "").not.toContain("<next_plan_handoff>");

    await client.sessionAttach!(firstSessionID);
    await client.planDocDeactivate!();
    await client.niaChat!.submit({ text: "ping" });
    const niaPromptAfterDeactivate = prompts.nia.at(-1) ?? "";
    expect(niaPromptAfterDeactivate).toContain("Active plan: none");
    expect(niaPromptAfterDeactivate).toContain(marked.planID);

    // ADR D1: the Navi/Nia system prompt is the static persona only —
    // byte-identical across sessions and workspace state. Live plans, mailbox
    // and collaboration messages arrive as `<runtime_context>` user messages.
    expect(new Set(personas.navi).size).toBe(1);
    expect(new Set(personas.nia).size).toBe(1);
    expect(personas.nia[0]).toContain("<nia_chat_persona>");
    expect(personas.nia[0]).not.toContain("Active plan");
    expect(personas.nia[0]).not.toContain("Known plan documents");
    expect(personas.navi[0]).toContain("<navi_chat_persona>");
    expect(personas.navi[0]).not.toContain("Active plan");
    expect(personas.navi[0]).not.toContain("Known plan documents");
  } finally {
    await client.dispose?.();
  }
});

test("Nia can update the Markdown plan document without gaining project write access", async () => {
  const root = await officialPluginWorkspace("nia-plan-write");
  let niaToolNames: string[] = [];
  let niaToolCallIssued = false;
  const provider: StreamingProvider = {
    provider: "nia-plan-write",
    model: "nia-plan-write-model",
    async *stream(request: ProviderStreamRequest) {
      const system = request.messages.find(
        (message) => message.role === "system",
      )?.content;
      const prompt = typeof system === "string" ? system : "";
      if (!prompt.includes("<nia_chat_persona>")) {
        yield { type: "content" as const, text: "ok" };
        yield { type: "done" as const };
        return;
      }
      niaToolNames = (request.tools ?? []).map((tool) => tool.name);
      const hasToolResult = request.messages.some(
        (message) => message.role === "tool",
      );
      if (!niaToolCallIssued && !hasToolResult) {
        niaToolCallIssued = true;
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_write_nia_plan",
              name: "plan_doc_write",
              arguments: JSON.stringify({
                path: "plans/nia-audit.md",
                content:
                  "# Nia updated plan\n\n- audit gap closed\n- next step recorded\n",
              }),
            },
          ],
        };
        yield { type: "done" as const };
        return;
      }
      yield { type: "content" as const, text: "updated the plan document" };
      yield { type: "done" as const };
    },
  };
  const sessionID = "ses_nia_plan_write" as SessionID;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    provider,
  });
  client.start(() => undefined);
  try {
    await client.sessionAttach!(sessionID);
    await client.planDocWrite!({
      path: "plans/nia-audit.md",
      content: "# Original plan\n",
      title: "Nia audit plan",
    });
    const marked = await client.planDocMark!({
      path: "plans/nia-audit.md",
      title: "Nia audit plan",
    });
    await client.planDocActivate!(marked.planID, sessionID);

    await client.niaChat!.submit({
      text: "update the plan document with the latest notes",
    });

    expect(niaToolNames).toContain("plan_doc_write");
    expect(niaToolNames).not.toContain("write_file");
    expect(niaToolNames).not.toContain("apply_edits");
    const document = await client.planDocRead!({
      path: "plans/nia-audit.md",
    });
    expect(document.content).toContain("Nia updated plan");
    expect(document.content).toContain("audit gap closed");
  } finally {
    await client.dispose?.();
  }
});
