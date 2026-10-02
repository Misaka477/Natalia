import { markRuntimeEventSessionSeq } from "@anthelia/contracts";
import { perfLog } from "./perf-log";
import type {
  ApprovalResponse,
  QuestionResponse,
  RuntimeEvent,
  RuntimeClient,
  RuntimeModelCatalogEntry,
  RuntimeModelSelection,
  RuntimeReasoningEffort,
  RuntimeSessionSummary,
  RuntimeWorkspaceMatch,
  RuntimeWorkspaceListPage,
  RuntimeWorkspaceContent,
  ConfigV3,
  WorkspaceSummary,
  WorkspacePermissionSettings,
  WorkspaceToolSettings,
} from "@anthelia/contracts";
import { callRuntimeRPC } from "@natalia/transport";

export const RPC_METHOD_ROUTES: Record<string, string> = {
  submit: "prompt",
  submitAndWait: "submit.andWait",
  cancel: "cancel",
  snapshot: "snapshot",
  respondApproval: "approval.respond",
  respondQuestion: "question.respond",
  pendingInteractive: "interactive.pending",
  respondInteractive: "interactive.respond",
  history: "session.history",
  eventWindow: "session.eventWindow",
  messages: "session.messages",
  pause: "pause",
  resume: "resume",
  canReloadConfig: "config.canReload",
  reloadConfig: "config.reload",
  updateConfig: "config.update",
  configGet: "config.get",
  settingsGet: "settings.get",
  settingsSet: "settings.set",
  agents: "agent.list",
  selectAgent: "agent.select",
  modelCatalog: "model.catalog",
  modelSelection: "model.selection",
  setDefaultModel: "model.setDefault",
  selectModel: "model.select",
  reasoningEffort: "model.reasoning",
  setReasoningEffort: "model.reasoning.set",
  skills: "skills.list",
  skillSetEnabled: "skill.setEnabled",
  skillRemove: "skill.remove",
  workspaceFiles: "workspace.files",
  workspaceSearch: "workspace.search",
  workspaceList: "workspace.list",
  workspaceRead: "workspace.read",
  workspaceGlob: "workspace.glob",
  workspaceWrite: "workspace.write",
  workspaceCreate: "workspace.create",
  workspaceRename: "workspace.rename",
  workspaceDelete: "workspace.delete",
  workspaceWriteConflicts: "workspace.writeConflicts",
  workspaceRoots: "workspace.roots",
  workspaceAdd: "workspace.add",
  workspaceRemove: "workspace.remove",
  workspaceActivate: "workspace.activate",
  workspacePermissionGet: "workspace.permission.get",
  workspacePermissionSet: "workspace.permission.set",
  workspaceToolGet: "workspace.tool.get",
  workspaceToolSet: "workspace.tool.set",
  checkpointList: "checkpoint.list",
  checkpointPreview: "checkpoint.preview",
  checkpointRollback: "checkpoint.rollback",
  checkpointRename: "checkpoint.rename",
  checkpointListByKind: "checkpoint.listByKind",
  auditRounds: "audit.rounds",
  roundDiff: "workspace.round.diff",
  sandboxList: "sandbox.list",
  sandboxDiff: "sandbox.diff",
  sandboxResources: "sandbox.resources",
  sandboxResourceOutput: "sandbox.resource.output",
  sandboxMerge: "sandbox.merge",
  sandboxDelete: "sandbox.delete",
  sandboxResourceStop: "sandbox.resource.stop",
  sessionList: "session.list",
  sessionTouch: "session.touch",
  sessionRename: "session.rename",
  sessionPin: "session.pin",
  sessionDuplicate: "session.duplicate",
  sessionFork: "session.fork",
  sessionRollbackMessages: "session.rollback.messages",
  sessionDelete: "session.delete",
  sessionNew: "session.new",
  sessionArchive: "session.archive",
  sessionRestore: "session.restore",
  sessionExport: "session.export",
  sessionAttach: "session.attach",
  mcpCatalog: "mcp.catalog",
  getMcpPrompt: "mcp.prompt",
  readMcpResource: "mcp.resource",
  mcpServerAdd: "mcp.server.add",
  mcpServerRemove: "mcp.server.remove",
  permissionList: "permission.list",
  permissionSave: "permission.save",
  permissionDelete: "permission.delete",
  agentCreate: "agent.create",
  agentUpdate: "agent.update",
  agentDelete: "agent.delete",
  providerDiscover: "provider.discover",
  providerAdd: "provider.add",
  providerRemove: "provider.remove",
  pluginUnload: "plugin.unload",
  pluginReload: "plugin.reload",
  pluginInstall: "plugin.install",
  pluginUninstall: "plugin.uninstall",
  pluginSetEnabled: "plugin.set-enabled",
  pluginCatalog: "plugin.catalog",
  toolFamilyReload: "tools.reload",
  plugins: "plugin.list",
  commandCatalog: "command.catalog",
  commandExecute: "command.execute",
  runtimeStatus: "runtime.status",
  diagnostics: "diagnostics.list",
  workGraphNodes: "workgraph.nodes",
  workGraphEdges: "workgraph.edges",
  nativeTerminalList: "nativeTerminal.list",
  nativeTerminalRead: "nativeTerminal.read",
  nativeTerminalStop: "nativeTerminal.stop",
  nativeTerminalClaimHumanInput: "nativeTerminal.claimHumanInput",
  nativeTerminalOpenHub: "nativeTerminal.openHub",
  nativeTerminalRevokeApprovalScope: "nativeTerminal.revokeApprovalScope",
  nativeTerminalReleaseHumanControl: "nativeTerminal.releaseHumanControl",
  nativeTerminalBeginSecureInput: "nativeTerminal.beginSecureInput",
  nativeTerminalEndSecureInput: "nativeTerminal.endSecureInput",
  nativeTerminalStart: "nativeTerminal.start",
  nativeTerminalWrite: "nativeTerminal.write",
  nativeTerminalResize: "nativeTerminal.resize",
  constitutionRules: "constitution.rules",
  updateConstitutionRule: "constitution.rule.update",
  createConstitutionRule: "constitution.rule.create",
  removeConstitutionRule: "constitution.rule.remove",
  constitutionDocRules: "constitution.docRules",
  promoteConstitutionDocRule: "constitution.docRule.promote",
  updateConstitutionDocRule: "constitution.docRule.update",
  decisionRecords: "decision.records",
  recordDecision: "decision.record",
  evidenceRecords: "evidence.records",
  recordValidation: "evidence.record",
  completions: "completion.records",
  recordHumanValidation: "completion.human_validation",
  planTaskStates: "plan.task.states",
  workGraphIntegrity: "workgraph.integrity",
  unattributedChanges: "workgraph.unattributed",
  recordCompletion: "completion.record",
  driftFindings: "drift.findings",
  evaluateDrift: "drift.evaluate",
  acknowledgeDriftFinding: "drift.acknowledge",
  reopenDriftFinding: "drift.reopen",
  confirmedWorkspaceChanges: "observation.confirmed",
  workspaceDiff: "workspace.diff",
  workspaceGitDiff: "workspace.git.diff",
  astDiff: "ast.diff",
  astDiffBatch: "ast.diff.batch",
  astRefactorPreview: "ast.refactor.preview",
  astService: "ast.service",
  astRefactorPlan: "ast.refactor.plan",
  astApplyRefactor: "ast.refactor.apply",
  gitRefs: "git.refs",
  teamPRList: "team.pr.list",
  registeredTools: "tools.registered",
  requestOverride: "constitution.override.request",
  approveOverride: "constitution.override.approve",
  projectionContributions: "projections.list",
  mailboxList: "mailbox.list",
  mailboxSend: "mailbox.send",
  mailboxDeliver: "mailbox.deliver",
  mailboxAcknowledge: "mailbox.acknowledge",
  mailboxDefer: "mailbox.defer",
  mailboxSupersede: "mailbox.supersede",
  planDocList: "planDoc.list",
  planDocRead: "planDoc.read",
  planDocWrite: "planDoc.write",
  planDocMark: "planDoc.mark",
  planDocDelete: "planDoc.delete",
  planDocStatus: "planDoc.status",
  planDocUpdateStatus: "planDoc.updateStatus",
  planDocActive: "planDoc.active",
  planDocActivate: "planDoc.activate",
  planDocDeactivate: "planDoc.deactivate",
  goalControl: "goal.control",
  goalEdit: "goal.edit",
  capabilities: "capabilities",
  sessionSnapshot: "session.snapshot",
  submitInput: "submit.input",
  removeInput: "input.remove",
  replaceInput: "input.replace",
  promoteInput: "input.promote",
  subagents: "session.subagents",
  subagentHistory: "subagent.history",
  subagentHistoryPage: "subagent.history.page",
  uploadAttachment: "attachment.upload",
  attachmentDataUrl: "attachment.dataUrl",
};

const RPC_PARAM_NAMES: Record<string, string[]> = {
  checkpointPreview: ["id", "sessionID", "options"],
  checkpointRename: ["id", "name", "sessionID"],
  subagentHistory: ["sessionID"],
  subagents: ["sessionID"],
  teamPRList: ["sessionID"],
  sessionTouch: ["id"],
  sessionRename: ["id", "title"],
  sessionPin: ["id", "pinned"],
  sessionDuplicate: ["id", "title"],
  sessionFork: ["id", "turnID", "title"],
  sessionRollbackMessages: ["id", "turnID"],
  sessionDelete: ["id"],
  sessionArchive: ["id"],
  sessionRestore: ["id"],
  sessionExport: ["id"],
  sessionAttach: ["id"],
  sandboxDiff: ["id", "sessionID", "options"],
  sandboxDelete: ["id", "sessionID"],
  sandboxResourceOutput: ["id", "resourceID", "maxBytes", "sessionID"],
  sandboxResourceStop: ["id", "resourceID", "sessionID"],
  sandboxList: ["sessionID"],
  sandboxResources: ["id", "sessionID"],
  sandboxMerge: ["id", "sessionID"],
  mcpServerRemove: ["name"],
  permissionDelete: ["name"],
  agentDelete: ["name"],
  providerRemove: ["name"],
  pluginUnload: ["id"],
  pluginReload: ["id"],
  nativeTerminalList: ["sessionID"],
  nativeTerminalRead: ["id", "sessionID"],
  nativeTerminalStop: ["id", "sessionID"],
  nativeTerminalClaimHumanInput: ["id", "sessionID"],
  nativeTerminalRevokeApprovalScope: ["id", "sessionID"],
  nativeTerminalReleaseHumanControl: ["id", "sessionID"],
  nativeTerminalBeginSecureInput: ["id", "sessionID"],
  nativeTerminalEndSecureInput: ["id", "sessionID"],
  nativeTerminalWrite: ["id", "input", "idempotencyKey", "sessionID"],
  nativeTerminalResize: ["id", "rows", "cols", "sessionID"],
  nativeTerminalStart: ["command", "cwd", "id", "sessionID", "agentID"],
  runtimeStatus: ["sessionID"],
  constitutionRules: ["sessionID"],
  updateConstitutionRule: ["ruleID", "enabled", "sessionID"],
  removeConstitutionRule: ["ruleID", "sessionID"],
  constitutionDocRules: ["sessionID"],
  promoteConstitutionDocRule: ["id", "sessionID"],
  updateConstitutionDocRule: ["id", "sessionID"],
  decisionRecords: ["sessionID"],
  evidenceRecords: ["sessionID"],
  completions: ["sessionID"],
  recordHumanValidation: ["taskID"],
  driftFindings: ["sessionID"],
  confirmedWorkspaceChanges: ["sessionID"],
  registeredTools: ["sessionID"],
  diagnostics: ["limit", "sessionID"],
  diagnosticsList: ["limit", "sessionID"],
  getMcpPrompt: ["server", "prompt"],
  readMcpResource: ["server", "resource"],
  selectAgent: ["name", "sessionID"],
  modelSelection: ["sessionID"],
  selectModel: ["modelID", "variant", "sessionID"],
  reasoningEffort: ["sessionID"],
  setReasoningEffort: ["effort", "sessionID"],
  providerAdd: ["name", "type", "baseURL", "apiKey"],
  agentCreate: ["name", "config"],
  agentUpdate: ["name", "config"],
  permissionSave: ["name", "profile"],
  mcpServerAdd: ["name", "config"],
  commandExecute: ["command", "args"],
  pause: ["reason", "sessionID"],
  resume: ["sessionID"],
  recordDecision: ["decision"],
  recordValidation: ["evidence"],
  recordCompletion: ["completion"],
  evaluateDrift: ["findingID"],
  acknowledgeDriftFinding: ["findingID"],
  reopenDriftFinding: ["findingID"],
  requestOverride: ["request"],
  approveOverride: ["approval"],
  mailboxSend: ["message"],
  sessionSnapshot: ["sessionID"],
  mailboxDeliver: ["messageID"],
  mailboxAcknowledge: ["messageID"],
  mailboxDefer: ["messageID"],
  mailboxSupersede: ["messageID"],
  planDocDelete: ["planID"],
  planDocStatus: ["planID"],
  planDocActive: ["sessionID"],
  planDocActivate: ["planID", "sessionID"],
  planDocDeactivate: ["sessionID"],
  goalControl: ["action", "sessionID"],
  goalEdit: ["input", "sessionID"],
};

export function buildParams(member: string, args: unknown[]) {
  const names = RPC_PARAM_NAMES[member];
  if (!names) {
    if (args.length === 0) return undefined;
    const first = args[0];
    if (typeof first === "object" && first !== null)
      return first as Record<string, unknown>;
    return { value: first };
  }
  const first = args[0];
  // Object-style surfaces are declared with a single parameter name in the
  // table above (e.g. driftFindings({ sessionID })). Returning the object
  // directly keeps JSON-RPC params flat instead of nesting it as
  // `{ sessionID: { sessionID } }`.
  if (names.length === 1 && typeof first === "object" && first !== null)
    return first as Record<string, unknown>;
  const params: Record<string, unknown> = {};
  for (let index = 0; index < names.length; index++)
    params[names[index]] = args[index];
  return params;
}

export type WebRuntimeOptions = {
  url: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
};

/**
 * Real browser runtime client.
 *
 * The web shell speaks the framework RPC protocol to a running Natalia
 * runtime/daemon and consumes the /events SSE stream.
 */
export function createWebRuntimeClient(
  options: WebRuntimeOptions,
): RuntimeClient {
  const call = <T>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> => {
    const callStart = performance.now();
    const startupBase =
      (globalThis as unknown as { __nataliaStartupStart?: number })
        .__nataliaStartupStart ?? callStart;
    perfLog(
      `[perf] rpc start ${method} +${(callStart - startupBase).toFixed(1)}ms`,
    );
    return callRuntimeRPC<T>({
      url: options.url,
      token: options.token,
      method,
      params,
      fetch: options.fetch,
    }).finally(() => {
      perfLog(
        `[perf] rpc ${method} ${(performance.now() - callStart).toFixed(1)}ms`,
      );
    });
  };

  function markStartup(phase: string) {
    const global = globalThis as unknown as {
      __nataliaStartupStart?: number;
      __nataliaStartupTimings?: Record<string, number>;
    };
    global.__nataliaStartupStart ??= performance.now();
    const timings = (global.__nataliaStartupTimings ??= {});
    const elapsed = performance.now() - global.__nataliaStartupStart;
    timings[phase] = elapsed;
    perfLog(`[startup] ${phase} +${elapsed.toFixed(1)}ms`);
  }

  const starts: Array<(event: RuntimeEvent) => void> = [];
  let started = false;
  let sessionLoadToken = 0;
  let activeSessionID: string | undefined;
  const liveBuffer: RuntimeEvent[] = [];

  type SessionLoadGlobal = {
    __nataliaReplayingHistory?: boolean;
    __nataliaSessionLoadToken?: number;
  };

  function sessionLoadGlobal(): SessionLoadGlobal {
    return globalThis as SessionLoadGlobal;
  }

  function isCurrentSessionLoad(token: number) {
    return token === sessionLoadToken;
  }

  function beginSessionLoad(sessionID?: string) {
    const token = ++sessionLoadToken;
    const load = sessionLoadGlobal();
    load.__nataliaSessionLoadToken = token;
    load.__nataliaReplayingHistory = true;
    if (typeof window !== "undefined")
      window.dispatchEvent(new Event("natalia:session-switch-reset"));
    return token;
  }

  function emitLive(event: RuntimeEvent) {
    if (sessionLoadGlobal().__nataliaReplayingHistory) {
      // Buffer every session while attach/hydration is in progress. The host
      // projects each event into its session cache; filtering here would make a
      // background turn invisible when its session is activated again.
      liveBuffer.push(event);
      return;
    }
    for (const listener of starts) listener(event);
  }

  function flushLiveBuffer(token: number) {
    const buffered = liveBuffer.splice(0);
    if (!isCurrentSessionLoad(token)) return;
    for (const event of buffered) emitLive(event);
  }

  function finishSessionLoad(token: number, sessionID?: string) {
    if (!isCurrentSessionLoad(token)) return;
    sessionLoadGlobal().__nataliaReplayingHistory = false;
    flushLiveBuffer(token);
    markStartup("session.loaded");
    if (typeof window !== "undefined")
      window.dispatchEvent(
        new CustomEvent("natalia:history-replay-complete", {
          detail: { token, sessionID },
        }),
      );
  }

  function sessionRecency(session: RuntimeSessionSummary) {
    return new Date(session.lastAccessedAt ?? session.createdAt).getTime();
  }

  let attachChain = Promise.resolve();

  async function attachAndReplay(id: string) {
    const token = beginSessionLoad(id);
    const run = async () => {
      if (!isCurrentSessionLoad(token)) return undefined;
      try {
        const result = await call<{ sessionID: string }>("session.attach", {
          id,
        });
        if (!isCurrentSessionLoad(token)) return undefined;
        activeSessionID = result?.sessionID ?? id;
        markStartup("session.attach");
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("natalia:session-attached", {
              detail: { sessionID: activeSessionID, token },
            }),
          );
        }
        try {
          await call("session.touch", { id });
        } catch {
          // Touch is best-effort so the next boot can pick this session as recent.
        }
        if (!isCurrentSessionLoad(token)) return undefined;
        // Deliberately do not replay the full durable event log on attach.
        // The UI hydrates the transcript from session.messages + the
        // message-first view-store path; this keeps long-session startup
        // proportional to the latest page rather than the whole log.
        finishSessionLoad(token, id);
        return isCurrentSessionLoad(token) ? result : undefined;
      } catch (error) {
        if (isCurrentSessionLoad(token)) finishSessionLoad(token, id);
        throw error;
      }
    };
    const pending = attachChain.then(run, run);
    attachChain = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async function restoreRecentSession() {
    // The workspace runtime restores its selected session before publishing.
    // A browser-global localStorage key must not override that selection.
    let newest: RuntimeSessionSummary | undefined;
    try {
      const sessions = await call<RuntimeSessionSummary[]>("session.list");
      markStartup("session.list");
      const recent = sessions
        .filter((session) => !session.archived)
        .sort((a, b) => sessionRecency(b) - sessionRecency(a));
      const snapshot = await call<RuntimeEvent>("runtime.status").catch(
        () => undefined,
      );
      const persisted = snapshot?.sessionID;
      const persistedTarget =
        persisted === undefined
          ? undefined
          : sessions.find(
              (session) => session.id === persisted && !session.archived,
            );
      const target = persistedTarget ?? recent[0];
      newest = target;
      if (newest) {
        if (sessionLoadToken !== 0) return newest;
        const attached = await attachAndReplay(newest.id);
        if (attached && typeof window !== "undefined")
          window.dispatchEvent(
            new CustomEvent("natalia:recent-session-restored", {
              detail: { sessionID: newest.id },
            }),
          );
      } else if (sessionLoadToken === 0) {
        // No session to restore. End the startup replay-guard so live events
        // are delivered normally instead of buffering forever.
        const token = beginSessionLoad();
        finishSessionLoad(token);
      }
    } catch (error) {
      console.log("[web-runtime] recent session restore failed", error);
      if (sessionLoadToken === 0) {
        const token = beginSessionLoad();
        finishSessionLoad(token);
      }
    }
    return newest;
  }

  async function start(onEvent: (event: RuntimeEvent) => void) {
    starts.push(onEvent);
    if (started) return;
    started = true;

    // The /events endpoint replays the server-side event ring buffer on
    // connect. Hold them until restoreRecentSession has chosen the startup
    // session, but retain all sessions so background projections stay current.
    sessionLoadGlobal().__nataliaReplayingHistory = true;
    liveBuffer.length = 0;

    void runWebSSE();
  }

  async function runWebSSE() {
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    while (true) {
      if (
        (globalThis as { __NATALIA_ABORT?: AbortController }).__NATALIA_ABORT
          ?.signal.aborted
      )
        return;
      try {
        // Before every /events connection, enter the startup/reconnect guard.
        // The server may replay its event ring buffer on connect; those events
        // are only live transport history, not session content. They must never
        // be applied before the current session has been re-attached/resynced.
        sessionLoadGlobal().__nataliaReplayingHistory = true;
        liveBuffer.length = 0;

        const response = await (options.fetch ?? globalThis.fetch)(
          new URL("/events", options.url),
          {
            headers: options.token
              ? { authorization: `Bearer ${options.token}` }
              : undefined,
            signal: (globalThis as { __NATALIA_ABORT?: AbortController })
              .__NATALIA_ABORT?.signal,
          },
        );
        if (!response.ok || !response.body)
          throw new Error(
            `[web-runtime] sse connect failed: ${response.status}`,
          );
        markStartup("sse.connected");

        const decoder = new TextDecoder();
        let buffer = "";
        let current: RuntimeEvent | null = null;
        let currentSessionSeq: number | undefined;
        const reader = response.body.getReader();
        let resolveStreamEnd!: () => void;
        const streamEnd = new Promise<void>((resolve) => {
          resolveStreamEnd = resolve;
        });
        void (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                if (line.startsWith("data: ")) {
                  try {
                    current = JSON.parse(line.slice(6)) as RuntimeEvent;
                  } catch {
                    current = null;
                    currentSessionSeq = undefined;
                  }
                } else if (line.startsWith("seq: ")) {
                  const parsed = Number(line.slice(5));
                  currentSessionSeq = Number.isFinite(parsed)
                    ? parsed
                    : undefined;
                } else if (line === "" && current) {
                  if (currentSessionSeq !== undefined)
                    markRuntimeEventSessionSeq(current, currentSessionSeq);
                  emitLive(current);
                  current = null;
                  currentSessionSeq = undefined;
                }
              }
            }
          } catch (error) {
            // A dropped SSE socket surfaces here (the browser reports it as a
            // `network error` rejection). Keep it from becoming an unhandled
            // rejection; the outer loop reconnects below.
            console.log("[web-runtime] sse reader error", error);
          } finally {
            resolveStreamEnd();
          }
        })();

        // On the first connection this restores the most recent session. On a
        // reconnect it re-attaches the already-active session and lets the UI
        // re-hydrate the latest message page, closing any history gap.
        if (activeSessionID) await attachAndReplay(activeSessionID);
        else await restoreRecentSession();

        await streamEnd;
        if (
          (globalThis as { __NATALIA_ABORT?: AbortController }).__NATALIA_ABORT
            ?.signal.aborted
        )
          return;
        console.log("[web-runtime] sse stream closed; reconnecting");
      } catch (error) {
        if (
          (globalThis as { __NATALIA_ABORT?: AbortController }).__NATALIA_ABORT
            ?.signal.aborted
        )
          return;
        // A failed connect must not leave the replay guard latched: the host
        // projection would stop receiving live events until the next successful
        // attach, which looks like a frozen or emptied transcript.
        sessionLoadGlobal().__nataliaReplayingHistory = false;
        liveBuffer.length = 0;
        console.log("[web-runtime] sse error", error);
      }
      await sleep(1000);
    }
  }

  const chatStream = (
    stream: "navi" | "nia",
  ): NonNullable<RuntimeClient["naviChat"]> => ({
    async submit(input) {
      return (await call(`${stream}.chat.submit`, input)) as never;
    },
    async abort(sessionID) {
      return (await call(`${stream}.chat.abort`, { sessionID })) as never;
    },
    async messages(sessionID) {
      return (await call(`${stream}.chat.messages`, { sessionID })) as never;
    },
    async messagesPage(input) {
      return (await call(`${stream}.chat.messages.page`, input)) as never;
    },
    async rollback(input, sessionID) {
      return (await call(`${stream}.chat.rollback`, {
        input,
        sessionID,
      })) as never;
    },
    async modelProfile(sessionID) {
      return (await call(`${stream}.chat.model.profile`, {
        sessionID,
      })) as never;
    },
    async setModelProfile(profile, sessionID) {
      return (await call(`${stream}.chat.model.profile.set`, {
        profile,
        sessionID,
      })) as never;
    },
  });

  const impl: RuntimeClient = {
    start,
    async eventWindow(options) {
      return (await call("session.eventWindow", {
        ...options,
      })) as never;
    },
    async submit(text, sessionID) {
      console.log("[web-runtime] submit", { text, sessionID });
      return (await call("prompt", {
        text,
        ...(sessionID ? { sessionID } : {}),
      })) as never;
    },
    async submitInput(input) {
      console.log("[web-runtime] submitInput", input);
      try {
        return (await call("submit.input", {
          ...(input as Record<string, unknown>),
        })) as never;
      } catch (cause) {
        console.error("[web-runtime] submitInput failed", cause);
        throw cause;
      }
    },
    async submitAndWait(input) {
      console.log("[web-runtime] submitAndWait", input);
      try {
        return (await call(
          "submit.andWait",
          typeof input === "string"
            ? { text: input }
            : { ...(input as Record<string, unknown>) },
        )) as never;
      } catch (cause) {
        console.error("[web-runtime] submitAndWait failed", cause);
        throw cause;
      }
    },
    naviChat: chatStream("navi"),
    niaChat: chatStream("nia"),
    cancel(reason, sessionID) {
      void call("cancel", { reason, ...(sessionID ? { sessionID } : {}) });
    },
    async modelCatalog() {
      return (await call<RuntimeModelCatalogEntry[]>("model.catalog")) as never;
    },
    async modelSelection(sessionID?) {
      return (await call<RuntimeModelSelection>(
        "model.selection",
        sessionID ? { sessionID } : undefined,
      )) as never;
    },
    async selectModel(modelID, variant, sessionID?) {
      await call("model.select", {
        ...(modelID === undefined ? {} : { modelID }),
        ...(variant === undefined ? {} : { variant }),
        ...(sessionID ? { sessionID } : {}),
      });
    },
    // The settings panel's 设为默认: writes the config's defaultModel (the
    // ModelRef object) and reloads. The route table alone is not enough —
    // without this method on the client the click resolves to undefined and
    // the button looks wired but does nothing.
    async setDefaultModel(modelID: string) {
      return (await call("model.setDefault", { modelID })) as never;
    },
    async reasoningEffort(sessionID?) {
      return (await call<RuntimeReasoningEffort>(
        "model.reasoning",
        sessionID ? { sessionID } : undefined,
      )) as never;
    },
    async setReasoningEffort(effort, sessionID?) {
      await call("model.reasoning.set", {
        ...(effort === undefined ? {} : { effort }),
        ...(sessionID ? { sessionID } : {}),
      });
    },
    async recordDecision(input, sessionID?) {
      return (await call("decision.record", {
        ...(input as Record<string, unknown>),
        ...(sessionID ? { sessionID } : {}),
      })) as never;
    },
    // The constitution actions take an object + a sessionID; without an
    // explicit override the positional RPC_PARAM_NAMES map would put the whole
    // object into `params.ruleID` and drop the sessionID.
    async updateConstitutionRule(input, sessionID?) {
      return (await call("constitution.rule.update", {
        ...(input as Record<string, unknown>),
        ...(sessionID ? { sessionID } : {}),
      })) as never;
    },
    async removeConstitutionRule(input, sessionID?) {
      return (await call("constitution.rule.remove", {
        ...(input as Record<string, unknown>),
        ...(sessionID ? { sessionID } : {}),
      })) as never;
    },
    async createConstitutionRule(input, sessionID?) {
      return (await call("constitution.rule.create", {
        ...(input as Record<string, unknown>),
        ...(sessionID ? { sessionID } : {}),
      })) as never;
    },
    async updateConstitutionDocRule(input, sessionID?) {
      return (await call("constitution.docRule.update", {
        ...(input as Record<string, unknown>),
        ...(sessionID ? { sessionID } : {}),
      })) as never;
    },
    async recordValidation(input, sessionID?) {
      return (await call("evidence.record", {
        ...(input as Record<string, unknown>),
        ...(sessionID ? { sessionID } : {}),
      })) as never;
    },
    async recordCompletion(input, sessionID?) {
      return (await call("completion.record", {
        ...(input as Record<string, unknown>),
        ...(sessionID ? { sessionID } : {}),
      })) as never;
    },
    async evaluateDrift(input, sessionID?) {
      return (await call("drift.evaluate", {
        ...(input as Record<string, unknown>),
        ...(sessionID ? { sessionID } : {}),
      })) as never;
    },
    async acknowledgeDriftFinding(input, sessionID?) {
      return (await call("drift.acknowledge", {
        ...(input as Record<string, unknown>),
        ...(sessionID ? { sessionID } : {}),
      })) as never;
    },
    async reopenDriftFinding(input, sessionID?) {
      return (await call("drift.reopen", {
        ...(input as Record<string, unknown>),
        ...(sessionID ? { sessionID } : {}),
      })) as never;
    },
    async requestOverride(input, sessionID?) {
      return (await call("constitution.override.request", {
        ...(input as Record<string, unknown>),
        ...(sessionID ? { sessionID } : {}),
      })) as never;
    },
    async checkpointList(sessionID) {
      return (await call(
        "checkpoint.list",
        sessionID ? { sessionID } : undefined,
      )) as never;
    },
    async checkpointRollback(input) {
      return (await call("checkpoint.rollback", {
        ...(input as Record<string, unknown>),
      })) as never;
    },
    snapshot() {
      void call("snapshot");
      return {
        type: "snapshot.created",
        id: "snap_web",
        files: [],
      } as never;
    },
    diagnostic(message, level) {
      const event: RuntimeEvent = {
        type: "diagnostic",
        level: level ?? "warning",
        message,
        at: new Date().toISOString(),
      };
      for (const listener of starts) listener(event);
    },
    lastSubmission() {
      return undefined;
    },
    // Await the runtime's real outcome: `{ accepted: false }` means the request
    // was already answered/expired, and the caller must not claim success.
    async respondApproval(response: ApprovalResponse) {
      return (await call("approval.respond", { ...response })) as Awaited<
        ReturnType<NonNullable<RuntimeClient["respondApproval"]>>
      >;
    },
    async respondQuestion(response: QuestionResponse) {
      return (await call("question.respond", { ...response })) as Awaited<
        ReturnType<NonNullable<RuntimeClient["respondQuestion"]>>
      >;
    },
    async sessionList() {
      return (await call<RuntimeSessionSummary[]>("session.list")) as never;
    },
    async sessionNew(input) {
      return (await call("session.new", {
        ...(input as Record<string, unknown>),
      })) as never;
    },
    async sessionAttach(id) {
      const result = await attachAndReplay(id);
      return (result ?? { sessionID: id }) as never;
    },
    async sessionDuplicate(id, title) {
      return (await call("session.duplicate", { id, title })) as never;
    },
    async workspaceRoots() {
      return (await call<WorkspaceSummary[]>("workspace.roots")) as never;
    },
    async workspaceAdd(input) {
      return (await call<WorkspaceSummary>("workspace.add", {
        ...input,
      })) as never;
    },
    async workspaceRemove(workspaceID) {
      return (await call("workspace.remove", { workspaceID })) as {
        removed: boolean;
      };
    },
    async workspaceActivate(workspaceID) {
      return (await call<WorkspaceSummary>("workspace.activate", {
        workspaceID,
      })) as never;
    },
    async workspacePermissionGet(workspaceID) {
      return (await call<WorkspacePermissionSettings>(
        "workspace.permission.get",
        { workspaceID },
      )) as never;
    },
    async workspacePermissionSet(workspaceID, settings) {
      return (await call<WorkspacePermissionSettings>(
        "workspace.permission.set",
        { workspaceID, settings },
      )) as never;
    },
    async workspaceToolGet(workspaceID) {
      return (await call<WorkspaceToolSettings>("workspace.tool.get", {
        workspaceID,
      })) as never;
    },
    async workspaceToolSet(workspaceID, settings) {
      return (await call<WorkspaceToolSettings>("workspace.tool.set", {
        workspaceID,
        settings,
      })) as never;
    },
    async workspaceSearch(input) {
      return (await call<RuntimeWorkspaceMatch[]>("workspace.search", {
        ...input,
      })) as never;
    },
    async workspaceList(input) {
      return (await call<RuntimeWorkspaceListPage>("workspace.list", {
        ...input,
      })) as never;
    },
    async workspaceRead(input) {
      return (await call<RuntimeWorkspaceContent>("workspace.read", {
        ...input,
      })) as never;
    },
    async workspaceWrite(input) {
      return (await call("workspace.write", { ...input })) as never;
    },
    async workspaceCreate(input) {
      return (await call("workspace.create", { ...input })) as never;
    },
    async workspaceRename(input) {
      return (await call("workspace.rename", { ...input })) as never;
    },
    async workspaceDelete(input) {
      return (await call("workspace.delete", { ...input })) as never;
    },
    async configGet() {
      return (await call<ConfigV3>("config.get")) as never;
    },
    async updateConfig(input) {
      return (await call("config.update", { ...input })) as never;
    },
    async mcpServerAdd(input) {
      return (await call("mcp.server.add", { ...input })) as never;
    },
    async mcpServerRemove(name) {
      return (await call("mcp.server.remove", { name })) as never;
    },
    async providerAdd(input) {
      return (await call("provider.add", { ...input })) as never;
    },
    async providerDiscover(input) {
      return (await call("provider.discover", { ...input })) as never;
    },
    async astDiff(input) {
      return (await call("ast.diff", { ...input })) as never;
    },
    async dispose() {},
  };

  return new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return (target as Record<PropertyKey, unknown>)[prop];
      const member = String(prop);
      const route = RPC_METHOD_ROUTES[member];
      if (!route) return undefined;
      return async (...args: unknown[]) =>
        call<unknown>(route, buildParams(member, args));
    },
  }) as RuntimeClient;
}
