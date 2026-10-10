import { expect, test } from "bun:test";
import type {
  ConstitutionRule,
  RuntimeEvent,
  SessionID,
} from "@anthelia/contracts";
import { configV3Schema } from "@anthelia/contracts";
import { buildGeneration } from "@anthelia/composition";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";
import { createRealRuntimeClient } from "../src/runtime/main";
import { niaFace } from "../src/runtime/verification-faces";

useWorkspaceCleanup();

/**
 * The Nia audit face (study §4.3): the candidate becomes a plan document,
 * Nia audits it through the existing chat surface, her audit_report flips
 * the plan's status — and the evidence she files lands in the journal
 * whether or not the face is watching.
 *
 * The scripted provider cannot close over the planID (the FACE creates the
 * plan), so it extracts the id from the face's own message: exactly what a
 * reading Nia does.
 */

const CONFIG = configV3Schema.parse({
  version: 3,
  providers: {
    nia: {
      name: "Nia",
      driver: "openai-compatible",
      connection: { apiKey: "test-secret" },
    },
  },
  catalog: { providers: { nia: { models: { model: { name: "model" } } } } },
});

const RULE: ConstitutionRule = {
  id: "C-NIA-001",
  statement: "审计结论必须附证据",
  scope: "release",
  priority: "critical",
  source: "policy",
  enforcement: "deny",
  overridePolicy: "forbidden",
  evidenceRefs: [],
};

function candidate() {
  return buildGeneration({
    config: CONFIG,
    catalog: [
      { id: "natalia-tool-shell", enabled: true, fingerprint: "fp-shell" },
    ],
    policyRows: [RULE],
    prompts: { perRoleStatic: {}, docs: [] },
  });
}

function auditProvider(
  verdict: "passed" | "gaps" | "silent",
  capture: { planID: string },
) {
  return {
    provider: "test-nia-audit",
    model: "test-nia-audit-model",
    async *stream(request: { messages?: unknown }) {
      const reported = (
        request.messages as Array<{ role?: string; toolCallID?: string }>
      ).some(
        (message) =>
          message.role === "tool" && message.toolCallID === "call_audit",
      );
      if (reported) {
        yield { type: "content" as const, text: "audit reported" };
        yield { type: "done" as const };
        return;
      }
      if (verdict === "silent") {
        yield { type: "content" as const, text: "declining to audit" };
        yield { type: "done" as const };
        return;
      }
      yield {
        type: "tool_call" as const,
        calls: [
          {
            id: "call_audit",
            name: "audit_report",
            // The face reports its plan through onAuditPlan before Nia is
            // woken (planDocMark generates the id), exactly how the
            // plan-contract test captures it from the mark's return.
            arguments: JSON.stringify({ planID: capture.planID, verdict }),
          },
        ],
      };
      yield { type: "done" as const };
    },
  };
}

async function attach(verdict: "passed" | "gaps" | "silent") {
  const root = await officialPluginWorkspace(`verification-nia-${verdict}`);
  const events: RuntimeEvent[] = [];
  const capture = { planID: "" };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: `ses_verification_nia_${verdict}` as SessionID,
    permissionMode: "auto",
    provider: auditProvider(verdict, capture),
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!(`ses_verification_nia_${verdict}` as SessionID);
  return {
    events,
    client,
    capture,
    // Disposal here; workspace + plugin-store removal is the registered
    // sweep's job (useWorkspaceCleanup) — the plugin store is a sibling
    // directory a manual rm(workspace) would miss.
    cleanup: async () => {
      await client.dispose?.();
    },
  };
}

test("a passed audit turns the face green and files its evidence", async () => {
  const { events, client, capture, cleanup } = await attach("passed");
  try {
    const check = await niaFace(client, {
      timeoutMs: 20_000,
      onAuditPlan: (planID) => {
        capture.planID = planID;
      },
    })(candidate());
    expect(check.check).toBe("nia");
    expect(check.ok).toBe(true);
    // The study's "evidence 落盘": her report files an evidence record in
    // the journal whether or not the face watched for it.
    const evidence = events.filter(
      (event) => event.type === "evidence.recorded",
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ status: "validated" });
  } finally {
    await cleanup();
  }
}, 40_000);

test("audit_gaps fails the face and names where the evidence is", async () => {
  const { client, capture, cleanup } = await attach("gaps");
  try {
    const check = await niaFace(client, {
      timeoutMs: 20_000,
      onAuditPlan: (planID) => {
        capture.planID = planID;
      },
    })(candidate());
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("audit_gaps");
  } finally {
    await cleanup();
  }
}, 40_000);

test("a Nia who never reports fails with a timeout, never a hang", async () => {
  const { client, capture, cleanup } = await attach("silent");
  try {
    const check = await niaFace(client, { timeoutMs: 1_500 })(candidate());
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("no audit_report verdict");
  } finally {
    await cleanup();
  }
}, 40_000);

test("the audit document never carries the candidate's credentials (P0-1)", async () => {
  // The 2026-10-08 audit's P0-1: this face writes a Markdown document INTO
  // THE WORKSPACE, and the candidate's config carries the live providers'
  // keys. `security.redactToolOutput` had not saved it — that flag guards the
  // tool-output layer, not files on disk. The document is redacted before the
  // write, and gated after.
  const { client, capture, cleanup } = await attach("passed");
  let path = "";
  try {
    const check = await niaFace(client, {
      timeoutMs: 20_000,
      onAuditPlan: (_planID, planPath) => {
        capture.planID = _planID;
        path = planPath;
      },
    })(candidate());
    expect(check.ok).toBe(true);
    const doc = await client.planDocRead!({ planID: capture.planID });
    // The key the candidate carried is nowhere in the document.
    expect(doc.content).not.toContain("test-secret");
    expect(doc.content).toContain("[REDACTED]");
    // The document is still a readable, valid plan.
    expect(doc.content).toContain("## Config");
    expect(doc.content).toContain('"apiKey"');
  } finally {
    await cleanup();
  }
});

test("a Nia who never reports enters the audit lifecycle and fails honestly", async () => {
  // F-B, part one: the gate woke Nia framed as a USER CHAT (`submit` hard-
  // coded intent:"user_chat"), on no particular session, with the plan left
  // at `marked`. So none of the audit machinery engaged — no AUDIT_ORDER
  // before collab_chat, no `auditing` projection, no turn-end fallback — and
  // the gate waited out its whole budget to report "no audit_report verdict"
  // for an audit nobody had been asked to perform.
  //
  // The fix names the intent, activates on the running session, and walks the
  // plan into the lifecycle (`awaiting_audit`). What is asserted here is what
  // that buys: the plan actually reaches `auditing` (the lifecycle engaged),
  // and when no verdict arrives the face fails naming the state the runtime
  // REALLY reached rather than claiming no verdict exists.
  const { client, cleanup } = await attach("silent");
  try {
    const check = await niaFace(client, { timeoutMs: 20_000 })(candidate());
    expect(check.ok).toBe(false);
    // The lifecycle engaged AND the turn was framed as an audit: Nia's
    // turn-start projection moves awaiting_audit -> auditing, and it is
    // gated on the intent. `awaiting_audit` alone would mean the gate walked
    // the plan into the lifecycle but still woke her as a user chat.
    expect(check.detail).not.toContain("the plan is still marked");
    expect(check.detail).toContain("auditing");
    // The audit is never declared skipped.
    expect(check.detail).toContain("a verdict is required, never skipped");
  } finally {
    await cleanup();
  }
}, 40_000);

test("the audit document never carries the candidate's credentials (P0-1)", async () => {
  // The 2026-10-08 audit's P0-1: this face writes a Markdown document INTO
  // THE WORKSPACE, and the candidate's config carries the live providers'
  // keys. `security.redactToolOutput` had not saved it — that flag guards the
  // tool-output layer, not files on disk. The document is redacted before the
  // write, and gated after.
  const { client, capture, cleanup } = await attach("passed");
  let path = "";
  try {
    const check = await niaFace(client, {
      timeoutMs: 20_000,
      onAuditPlan: (_planID, planPath) => {
        capture.planID = _planID;
        path = planPath;
      },
    })(candidate());
    expect(check.ok).toBe(true);
    const doc = await client.planDocRead!({ planID: capture.planID });
    // The key the candidate carried is nowhere in the document.
    expect(doc.content).not.toContain("test-secret");
    expect(doc.content).toContain("[REDACTED]");
    // The document is still a readable, valid plan.
    expect(doc.content).toContain("## Config");
    expect(doc.content).toContain('"apiKey"');
  } finally {
    await cleanup();
  }
});

test("the audit document never carries the candidate's credentials (P0-1)", async () => {
  // The 2026-10-08 audit's P0-1: this face writes a Markdown document INTO
  // THE WORKSPACE, and the candidate's config carries the live providers'
  // keys. `security.redactToolOutput` had not saved it — that flag guards the
  // tool-output layer, not files on disk. The document is redacted before the
  // write, and gated after.
  const { client, capture, cleanup } = await attach("passed");
  let path = "";
  try {
    const check = await niaFace(client, {
      timeoutMs: 20_000,
      onAuditPlan: (_planID, planPath) => {
        capture.planID = _planID;
        path = planPath;
      },
    })(candidate());
    expect(check.ok).toBe(true);
    const doc = await client.planDocRead!({ planID: capture.planID });
    // The key the candidate carried is nowhere in the document.
    expect(doc.content).not.toContain("test-secret");
    expect(doc.content).toContain("[REDACTED]");
    // The document is still a readable, valid plan.
    expect(doc.content).toContain("## Config");
    expect(doc.content).toContain('"apiKey"');
  } finally {
    await cleanup();
  }
});

test("the audit document never carries the candidate's credentials (P0-1)", async () => {
  // The 2026-10-08 audit's P0-1: this face writes a Markdown document INTO
  // THE WORKSPACE, and the candidate's config carries the live providers'
  // keys. `security.redactToolOutput` had not saved it — that flag guards the
  // tool-output layer, not files on disk. The document is redacted before the
  // write, and gated after.
  const { client, capture, cleanup } = await attach("passed");
  let path = "";
  try {
    const check = await niaFace(client, {
      timeoutMs: 20_000,
      onAuditPlan: (_planID, planPath) => {
        capture.planID = _planID;
        path = planPath;
      },
    })(candidate());
    expect(check.ok).toBe(true);
    const doc = await client.planDocRead!({ planID: capture.planID });
    // The key the candidate carried is nowhere in the document.
    expect(doc.content).not.toContain("test-secret");
    expect(doc.content).toContain("[REDACTED]");
    // The document is still a readable, valid plan.
    expect(doc.content).toContain("## Config");
    expect(doc.content).toContain('"apiKey"');
  } finally {
    await cleanup();
  }
});
