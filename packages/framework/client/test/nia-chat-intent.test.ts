import { expect, test } from "bun:test";
import type {
  ProviderStreamRequest,
  StreamingProvider,
} from "@anthelia/runtime";
import type { SessionID } from "@anthelia/contracts";
import { createRealRuntimeClient } from "../src";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();

/**
 * R1: Nia's turn is framed by WHAT IT IS FOR, not by the fact that it arrived
 * internally.
 *
 * Every wake into Nia used to carry `internal: true`, and the turn's framing
 * hung off that flag plus a keyword match on the user's own text — so a
 * sister's collaboration message arrived as an audit, and the user's own
 * question could arm the audit machinery by containing the word "审计". The
 * intent (audit / detour / collaboration / user_chat) is now the one answer.
 *
 * These proofs drive the real runtime: a scripted provider records the exact
 * messages each channel's turn received, and the assertions are about what
 * the model would have read.
 */

function joined(requests: ProviderStreamRequest[]) {
  return requests
    .map((request) =>
      request.messages.map((message) => String(message.content)).join("\n"),
    )
    .join("\n");
}

/**
 * The requests that were Nia turns. Her persona is the only channel that
 * carries it — Navi's live context also renders `<live_work_context>`, so
 * matching on that would fold Navi's requests (and Navi's always-present
 * collaboration block) into Nia's.
 */
function niaRequests(requests: ProviderStreamRequest[]) {
  return requests.filter((request) =>
    request.messages.some(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("You are Nia"),
    ),
  );
}

test("the user's own question is a conversation, never an audit", async () => {
  // The G1-5 shape, end to end: an ACTIVE plan whose audit already closed
  // (audit_gaps), and a user whose message contains the audit keyword. The
  // old scan read `internal || /审计|audit|审核/` as the audit intent, so
  // this turn armed the audit machinery: the audit wake prompt, the
  // audit_report requirement, the turn-end audit_pending fallback. None of
  // that belongs in the user's conversation.
  const root = await officialPluginWorkspace("nia-intent-user");
  const requests: ProviderStreamRequest[] = [];
  const provider: StreamingProvider = {
    provider: "intent-provider",
    model: "intent-model",
    async *stream(request: ProviderStreamRequest) {
      requests.push(request);
      yield { type: "content" as const, text: "ok" };
      yield { type: "done" as const };
    },
  };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_nia_intent_user" as SessionID,
    provider,
  });
  client.start(() => undefined);
  try {
    await client.sessionAttach!("ses_nia_intent_user" as SessionID);
    await client.planDocWrite!({
      path: "plans/intent-plan.md",
      content: "# Intent plan\n",
      title: "Intent plan",
    });
    const marked = await client.planDocMark!({
      path: "plans/intent-plan.md",
      title: "Intent plan",
    });
    await client.planDocUpdateStatus!({
      planID: marked.planID,
      status: "audit_gaps",
    });
    await client.planDocActivate!(marked.planID);

    await client.niaChat!.submit({ text: "这个计划的审计结论是什么？" });
    await client.submitAndWait!("main ping");

    const seen = joined(niaRequests(requests));
    // The user's words reached her …
    expect(seen).toContain("这个计划的审计结论是什么？");
    // … with the plan visible for context.
    expect(seen).toContain("Active plan:");
    // The audit machinery stayed disarmed.
    expect(seen).not.toContain("Your audit wake request has arrived");
    expect(seen).not.toContain("AUDIT_REQUIRED");
    expect(seen).not.toContain("AUDIT_ORDER");
    // And the internal blocks the user never asked about are not injected.
    // (The persona itself names `<natalia_collaborations>` when it explains
    // the REPLY_REQUIRED protocol, so the assertions are on the RENDERED
    // block's own lines, not the tag.)
    expect(seen).not.toContain("Pending audit requests");
    expect(seen).not.toContain(
      "These are sister-to-sister messages between you and Natalia",
    );
    expect(seen).not.toContain(
      "Natalia has not sent you collaboration messages yet",
    );
    // The plan's closed audit was not dragged back into the lifecycle.
    const plans = await client.planDocList!();
    expect(plans.find((plan) => plan.planID === marked.planID)?.status).toBe(
      "audit_gaps",
    );
  } finally {
    await client.dispose?.();
  }
});

test("a sister's collaboration message is answered, not audited", async () => {
  // Natalia sends Nia an informal message. The wake that delivers it used to
  // arrive with the audit framing — the collaboration message was answered
  // (or refused) as if it were an audit wake. The request's own kind/source
  // were on the table at the wake site and discarded; now they name the
  // intent.
  const root = await officialPluginWorkspace("nia-intent-collab");
  const requests: ProviderStreamRequest[] = [];
  let mainSteps = 0;
  const provider: StreamingProvider = {
    provider: "intent-collab-provider",
    model: "intent-collab-model",
    async *stream(request: ProviderStreamRequest) {
      requests.push(request);
      const isNia = request.messages.some(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("You are Nia"),
      );
      // (the persona is Nia's alone — see niaRequests)
      if (!isNia) {
        // The main agent: one collaboration message to Nia, then settle.
        mainSteps += 1;
        if (mainSteps === 1) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "c1",
                name: "collab_chat",
                arguments: JSON.stringify({
                  text: "the build is green, please sanity-check the diff",
                  to: "nia",
                }),
              },
            ],
          };
          return;
        }
        yield { type: "content" as const, text: "sent" };
        yield { type: "done" as const };
        return;
      }
      yield { type: "content" as const, text: "checked" };
      yield { type: "done" as const };
    },
  };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_nia_intent_collab" as SessionID,
    provider,
  });
  client.start(() => undefined);
  try {
    await client.sessionAttach!("ses_nia_intent_collab" as SessionID);
    await client.submitAndWait!("tell nia the build is green");

    const seen = joined(niaRequests(requests));
    // The collaboration framing reached her …
    expect(seen).toContain("Natalia sent you a collaboration message");
    // … and the audit framing did not.
    expect(seen).not.toContain("Your audit wake request has arrived");
    expect(seen).not.toContain("AUDIT_REQUIRED");
  } finally {
    await client.dispose?.();
  }
});
