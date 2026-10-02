import { expect, test } from "bun:test";
import { RUNTIME_RPC_ERROR_CODES } from "@anthelia/contracts";
import type {
  RuntimeClient,
  RuntimeEvent,
  RuntimeCapabilityReport,
} from "@anthelia/contracts";
import { createRuntimeHttpServer } from "../src/host";
import { RPC_WRITE_METHODS } from "../src/rpc";

/**
 * P0-D: scoped authorization.
 *
 * Before this, a server with a token was all-or-nothing and a server without
 * one was wide open. Now: a configured credential reaches only what its grant
 * names (capability groups + a single write dimension), a request without a
 * credential is refused, and the availability report is culled to the grant —
 * a read-only integration sees the write surface as unreachable *by
 * authorization*, not as unimplemented, so the report cannot over-promise
 * again (the G2 mistake, at a second layer).
 */

function controllableClient() {
  let sink: ((event: RuntimeEvent) => void) | undefined;
  // Every member implemented, so the authorization culling is what the
  // availability tests exercise — not the stub's own gaps.
  const client: Record<string, unknown> = {};
  for (const member of [
    "start",
    "submit",
    "cancel",
    "snapshot",
    "diagnostic",
    "lastSubmission",
    "respondApproval",
    "respondQuestion",
    "history",
    "messages",
    "pendingInteractive",
    "submitInput",
    "pause",
    "resume",
    "dispose",
    "canReloadConfig",
    "reloadConfig",
    "agents",
    "selectAgent",
    "modelCatalog",
    "modelSelection",
    "selectModel",
    "skills",
    "workspaceFiles",
    "workspaceSearch",
    "workspaceList",
    "workspaceRead",
    "workspaceGlob",
    "checkpointList",
    "checkpointPreview",
    "checkpointRollback",
    "checkpointRename",
    "sandboxList",
    "sandboxDiff",
    "sandboxResources",
    "sandboxResourceOutput",
    "sandboxMerge",
    "sandboxDelete",
    "sandboxResourceStop",
    "sessionList",
    "sessionTouch",
    "sessionRename",
    "sessionPin",
    "sessionDuplicate",
    "sessionFork",
    "sessionDelete",
    "sessionNew",
    "sessionArchive",
    "sessionExport",
    "permissionList",
    "permissionSave",
    "permissionDelete",
    "agentCreate",
    "agentUpdate",
    "agentDelete",
    "providerDiscover",
    "providerAdd",
    "providerRemove",
    "pluginUnload",
    "pluginReload",
    "mcpServerAdd",
    "mcpServerRemove",
    "mcpCatalog",
    "getMcpPrompt",
    "readMcpResource",
    "plugins",
    "commandCatalog",
    "commandExecute",
    "capabilities",
    "taskOverview",
    "flowOverview",
    "documentCatalog",
    "runtimeStatus",
    "diagnostics",
    "operationRecords",
    "sessionSnapshot",
    "workGraphNodes",
    "workGraphEdges",
    "nativeTerminalList",
    "nativeTerminalRead",
    "nativeTerminalOpenHub",
    "nativeTerminalRevokeApprovalScope",
    "nativeTerminalReleaseHumanControl",
    "nativeTerminalBeginSecureInput",
    "nativeTerminalEndSecureInput",
    "nativeTerminalStop",
    "nativeTerminalStart",
    "nativeTerminalWrite",
    "nativeTerminalResize",
    "constitutionRules",
    "constitutionOverrides",
    "decisionRecords",
    "recordDecision",
    "evidenceRecords",
    "recordValidation",
    "completions",
    "recordCompletion",
    "driftFindings",
    "evaluateDrift",
    "acknowledgeDriftFinding",
    "confirmedWorkspaceChanges",
    "registeredTools",
    "projectionContributions",
    "requestOverride",
    "approveOverride",
    "mailboxList",
    "mailboxSend",
    "mailboxDeliver",
    "mailboxAcknowledge",
    "mailboxDefer",
    "mailboxSupersede",
    "planDocList",
    "planDocRead",
    "planDocWrite",
    "planDocMark",
    "planDocDelete",
    "planDocStatus",
    "settingsGet",
  ])
    client[member] = () => undefined;
  client.start = (handler: (event: RuntimeEvent) => void) => {
    sink = handler;
  };
  client.submit = async (text: string) => ({
    type: "turn.submitted",
    id: "turn_1",
    text,
    byteLength: text.length,
    lineCount: 1,
    sha256: "stub",
  });
  client.snapshot = (): RuntimeEvent => ({
    type: "diagnostic",
    level: "info",
    message: "stub",
  });
  client.publish = (event: RuntimeEvent) => sink?.(event);
  client.workspaceList = async () => [];
  client.sessionList = async () => [];
  client.settingsGet = async () => ({ config: {}, sources: [] });
  return client as RuntimeClient & {
    publish(event: RuntimeEvent): void;
  };
}

async function readSSE(
  response: Promise<Response>,
  onEvent: (event: RuntimeEvent) => void,
  onConnected?: () => void,
  timeoutMs = 500,
): Promise<void> {
  const body = await response;
  const reader = body.body!.getReader();
  onConnected?.();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = setTimeout(() => reader.cancel(), timeoutMs);
  try {
    while (true) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        onEvent(JSON.parse(line.slice(6)) as RuntimeEvent);
      }
    }
  } catch {
    // abort cancels the read; the caller collected what it needed
  } finally {
    clearTimeout(deadline);
  }
}

async function rpc(
  server: { url: string },
  token: string | undefined,
  method: string,
  params?: Record<string, unknown>,
) {
  const response = await fetch(new URL("/rpc", server.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await response.json()) as {
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  };
}

function fullServer(
  client: ReturnType<typeof controllableClient>,
  events = true,
) {
  return createRuntimeHttpServer({
    client,
    events,
    authorization: {
      credentials: [
        { token: "full", write: true },
        { token: "readonly", write: false },
        { token: "workspace-only", write: false, groups: ["workspace"] },
        { token: "ses-a", write: false, sessions: ["ses_A"] },
      ],
    },
  });
}

test("a request without a credential is refused when the server is configured", async () => {
  const client = controllableClient();
  const server = fullServer(client, false);
  try {
    const response = await fetch(new URL("/rpc", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.list" }),
    });
    expect(response.status).toBe(401);
    // The refusal is identical to a wrong token: no token can be probed.
    const wrong = await fetch(new URL("/rpc", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer nope",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.list" }),
    });
    expect(wrong.status).toBe(401);
  } finally {
    server.stop();
  }
});

test("a read-only credential cannot write, and the refusal does not leak existence", async () => {
  const client = controllableClient();
  const server = fullServer(client, false);
  try {
    // One write per write family: submission, turn control, approvals, config,
    // checkpoints, sandboxes, sessions, native terminal control.
    for (const method of [
      "prompt",
      "cancel",
      "submit.input",
      "approval.respond",
      "pause",
      "config.reload",
      "checkpoint.rollback",
      "sandbox.merge",
      "session.delete",
      "session.new",
      "session.archive",
      "session.attach",
      "mcp.server.add",
      "mcp.server.remove",
      "permission.save",
      "permission.delete",
      "agent.create",
      "agent.update",
      "agent.delete",
      "provider.add",
      "provider.remove",
      "plugin.unload",
      "plugin.reload",
      "command.execute",
      "nativeTerminal.stop",
      "nativeTerminal.start",
      "nativeTerminal.write",
      "nativeTerminal.resize",
    ]) {
      const { error } = await rpc(server, "readonly", method, { id: "x" });
      expect(error?.code, `${method} must be refused`).toBe(
        RUNTIME_RPC_ERROR_CODES.refused,
      );
      expect(error?.message).toContain("no write scope");
      // The refusal names the rule, never the method's existence: the same
      // answer would come for a method that does not exist at all.
      expect(error?.message).not.toContain("not found");
    }

    // Reads still work with the same credential.
    const { result } = await rpc(server, "readonly", "session.list");
    expect(result).toEqual([]);
    const settings = await rpc(server, "readonly", "settings.get");
    expect(settings.error).toBeUndefined();
    expect(settings.result).toEqual({ config: {}, sources: [] });
  } finally {
    server.stop();
  }
});

test("the write surface is an enumerated, test-pinned list", () => {
  // Removing an entry makes a write reachable by a read-only credential and
  // fails the test above; adding one needs this list on purpose. Each entry
  // must be a real route.
  expect(RPC_WRITE_METHODS.size).toBeGreaterThanOrEqual(26);
  for (const method of RPC_WRITE_METHODS)
    expect(method.length).toBeGreaterThan(0);
  expect(RPC_WRITE_METHODS.has("sandbox.merge")).toBe(true);
  expect(RPC_WRITE_METHODS.has("config.reload")).toBe(true);
  expect(RPC_WRITE_METHODS.has("settings.get")).toBe(false);
  expect(RPC_WRITE_METHODS.has("settings.set")).toBe(true);
  // The response cache was removed; its route must not come back as a write
  // without an explicit decision (and an entry here).
  expect(RPC_WRITE_METHODS.has("cache.response")).toBe(false);
  expect(RPC_WRITE_METHODS.has("growth.propose")).toBe(true);
  expect(RPC_WRITE_METHODS.has("eval.external_run")).toBe(true);
  expect(RPC_WRITE_METHODS.has("checkpoint.rollback")).toBe(true);
  expect(RPC_WRITE_METHODS.has("session.delete")).toBe(true);
  expect(RPC_WRITE_METHODS.has("session.new")).toBe(true);
  expect(RPC_WRITE_METHODS.has("session.archive")).toBe(true);
  expect(RPC_WRITE_METHODS.has("session.attach")).toBe(true);
  expect(RPC_WRITE_METHODS.has("session.export")).toBe(false);
  expect(RPC_WRITE_METHODS.has("permission.save")).toBe(true);
  expect(RPC_WRITE_METHODS.has("permission.delete")).toBe(true);
  expect(RPC_WRITE_METHODS.has("permission.list")).toBe(false);
  expect(RPC_WRITE_METHODS.has("mcp.server.add")).toBe(true);
  expect(RPC_WRITE_METHODS.has("mcp.server.remove")).toBe(true);
  expect(RPC_WRITE_METHODS.has("agent.create")).toBe(true);
  expect(RPC_WRITE_METHODS.has("agent.update")).toBe(true);
  expect(RPC_WRITE_METHODS.has("agent.delete")).toBe(true);
  expect(RPC_WRITE_METHODS.has("provider.discover")).toBe(false);
  expect(RPC_WRITE_METHODS.has("provider.add")).toBe(true);
  expect(RPC_WRITE_METHODS.has("provider.remove")).toBe(true);
  expect(RPC_WRITE_METHODS.has("plugin.unload")).toBe(true);
  expect(RPC_WRITE_METHODS.has("plugin.reload")).toBe(true);
  expect(RPC_WRITE_METHODS.has("command.execute")).toBe(true);
  expect(RPC_WRITE_METHODS.has("nativeTerminal.write")).toBe(true);
  expect(RPC_WRITE_METHODS.has("nativeTerminal.start")).toBe(true);
  expect(RPC_WRITE_METHODS.has("nativeTerminal.resize")).toBe(true);
  expect(RPC_WRITE_METHODS.has("history")).toBe(false);
});

test("a group-scoped credential cannot reach other groups", async () => {
  const client = controllableClient();
  const server = fullServer(client, false);
  try {
    const { error } = await rpc(server, "workspace-only", "session.list");
    expect(error?.code).toBe(RUNTIME_RPC_ERROR_CODES.refused);
    expect(error?.message).toContain("sessions group");
    const { result } = await rpc(server, "workspace-only", "workspace.list", {
      path: ".",
    });
    expect(result).toBeDefined();
  } finally {
    server.stop();
  }
});

test("a read-only credential's availability report is culled, with authorization reasons", async () => {
  const client = controllableClient();
  const server = fullServer(client, false);
  try {
    const { result } = await rpc(server, "readonly", "runtime.availability");
    const report = result as RuntimeCapabilityReport;
    const byMember = new Map(
      report.channel!.groups.flatMap((group) =>
        group.members.map((member) => [member.member, member] as const),
      ),
    );
    // The write surface reads as unreachable *by authorization* — never as
    // unimplemented, and never as reachable.
    expect(byMember.get("reloadConfig")?.state).toBe("implemented_unreachable");
    expect(byMember.get("reloadConfig")?.reason).toContain("no write scope");
    expect(byMember.get("sessionDelete")?.state).toBe(
      "implemented_unreachable",
    );
    // Reads stay reachable for the same credential.
    expect(byMember.get("history")?.state).toBe("implemented_reachable");
    expect(byMember.get("sessionList")?.state).toBe("implemented_reachable");
  } finally {
    server.stop();
  }
});

test("a full credential sees everything reachable", async () => {
  const client = controllableClient();
  const server = fullServer(client, false);
  try {
    const { result } = await rpc(server, "full", "runtime.availability");
    const report = result as RuntimeCapabilityReport;
    const byMember = new Map(
      report.channel!.groups.flatMap((group) =>
        group.members.map((member) => [member.member, member.state] as const),
      ),
    );
    expect(byMember.get("reloadConfig")).toBe("implemented_reachable");
  } finally {
    server.stop();
  }
});

test("events are filtered server-side by session grant", async () => {
  const client = controllableClient();
  const server = fullServer(client, true);
  try {
    const received: RuntimeEvent[] = [];
    // Feed after the subscription is live: one event for the granted session,
    // one for another. The other must never arrive — not its type, not a
    // count, nothing.
    await readSSE(
      fetch(new URL("/events?session=ses_A", server.url), {
        headers: { authorization: "Bearer ses-a" },
      }),
      (event) => received.push(event),
      () => {
        client.publish({
          type: "session.created",
          sessionID: "ses_A",
          title: "granted",
        });
        client.publish({
          type: "session.created",
          sessionID: "ses_B",
          title: "other",
        });
      },
    );
    expect(received.map((event) => event.type)).toEqual(["session.created"]);
    expect(
      received.map((event) => (event as { sessionID?: string }).sessionID),
    ).toEqual(["ses_A"]);
  } finally {
    server.stop();
  }
});

test("subscribing to a session outside the grant is refused at the subscription", async () => {
  const client = controllableClient();
  const server = fullServer(client, true);
  try {
    const response = await fetch(new URL("/events?session=ses_B", server.url), {
      headers: { authorization: "Bearer ses-a" },
    });
    expect(response.status).toBe(403);
    await response.body?.cancel();
  } finally {
    server.stop();
  }
});

test("an unconstrained credential sees runtime-level events of every session", async () => {
  // sanity: without a session grant, filtering is off and events flow
  const client = controllableClient();
  const server = fullServer(client, true);
  try {
    const received: RuntimeEvent[] = [];
    await readSSE(
      fetch(new URL("/events", server.url), {
        headers: { authorization: "Bearer readonly" },
      }),
      (event) => received.push(event),
      () => {
        client.publish({
          type: "session.created",
          sessionID: "ses_B",
          title: "any",
        });
      },
    );
    expect(received.map((event) => event.type)).toEqual(["session.created"]);
  } finally {
    server.stop();
  }
});

test("healthz carries the API version without a credential", async () => {
  const client = controllableClient();
  const server = fullServer(client, false);
  try {
    const response = await fetch(new URL("/healthz", server.url));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; apiVersion: number };
    expect(body.ok).toBe(true);
    expect(body.apiVersion).toBe(1);
  } finally {
    server.stop();
  }
});

test("the availability report carries the API version", async () => {
  const client = controllableClient();
  const server = fullServer(client, false);
  try {
    const { result } = await rpc(server, "readonly", "runtime.availability");
    const report = result as RuntimeCapabilityReport;
    expect(report.apiVersion).toBe(1);
  } finally {
    server.stop();
  }
});
