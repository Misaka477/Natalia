import { describeRuntimeCapabilities } from "@anthelia/contracts";
import type {
  ApprovalResponse,
  QuestionResponse,
  RuntimeClient,
  RuntimeEvent,
  RuntimeReasoningEffort,
  SubmitInput,
  SubmittedTurn,
} from "@anthelia/contracts";

/**
 * The worker channel's route table, mirroring `handleWorkerRequest` below.
 * Same discipline as the RPC route table: reachability for the worker channel
 * is computed from this, and the channel's gaps (checkpoint, secure-input
 * control, MCP, work graph...) show up in the report instead of being silent.
 * A test asserts this table matches the handler dispatch.
 */
export const WORKER_ROUTE_MEMBERS = {
  submit: "submit",
  submitAndWait: "submitAndWait",
  "input.remove": "removeInput",
  "input.replace": "replaceInput",
  "input.promote": "promoteInput",
  cancel: "cancel",
  pause: "pause",
  resume: "resume",
  "runtime.status": "runtimeStatus",
  "runtime.availability": null,
  "command.catalog": "commandCatalog",
  "command.execute": "commandExecute",
  snapshot: "snapshot",
  diagnostic: "diagnostic",
  approval: "respondApproval",
  question: "respondQuestion",
  "interactive.pending": "pendingInteractive",
  "interactive.respond": "respondInteractive",
  "config.reload": "reloadConfig",
  "config.update": "updateConfig",
  "config.get": "configGet",
  dispose: "dispose",
  history: "history",
  diagnostics: "diagnostics",
  "diagnostics.operations": "operationRecords",
  "growth.propose": "growthPropose",
  "growth.proposals": "growthProposals",
  "ast.move": "astMove",
  "workspace.ast_move": "workspaceAstMove",
  "prompt.run_groups": "promptRunGroups",
  "eval.external_benchmark": "externalBenchmark",
  "eval.external_run": "recordExternalRun",
  "corrections.patterns": "correctionPatterns",
  "growth.promote": "promoteGrowthTrigger",
  "growth.promotions": "growthPromotions",
  "growth.triggers": "growthTriggers",
  "eval.joined_tasks": "externalJoinedTasks",
  messages: "messages",
  agents: "agents",
  "model.catalog": "modelCatalog",
  "model.selection": "modelSelection",
  "model.select": "selectModel",
  "model.setDefault": "setDefaultModel",
  "model.reasoning": "reasoningEffort",
  "model.reasoning.set": "setReasoningEffort",
  "permission.list": "permissionList",
  "permission.save": "permissionSave",
  "permission.delete": "permissionDelete",
  skills: "skills",
  "workspace.files": "workspaceFiles",
  "workspace.search": "workspaceSearch",
  "workspace.list": "workspaceList",
  "workspace.read": "workspaceRead",
  "resource.read": "resourceRead",
  "workspace.glob": "workspaceGlob",
  "workspace.write": "workspaceWrite",
  "workspace.create": "workspaceCreate",
  "workspace.rename": "workspaceRename",
  "workspace.delete": "workspaceDelete",
  "workspace.writeConflicts": "workspaceWriteConflicts",
  "mcp.catalog": "mcpCatalog",
  "mcp.prompt": "getMcpPrompt",
  "mcp.resource": "readMcpResource",
  "native-terminal.list": "nativeTerminalList",
  "native-terminal.read": "nativeTerminalRead",
  "native-terminal.open-hub": "nativeTerminalOpenHub",
  "native-terminal.release-human-control": "nativeTerminalReleaseHumanControl",
  "native-terminal.revoke-approval-scope": "nativeTerminalRevokeApprovalScope",
  "native-terminal.stop": "nativeTerminalStop",
  "native-terminal.begin-secure-input": "nativeTerminalBeginSecureInput",
  "native-terminal.end-secure-input": "nativeTerminalEndSecureInput",
  "checkpoint.list": "checkpointList",
  "checkpoint.preview": "checkpointPreview",
  "checkpoint.rollback": "checkpointRollback",
  "checkpoint.rename": "checkpointRename",
  "checkpoint.listByKind": "checkpointListByKind",
  "audit.rounds": "auditRounds",
  "workspace.round.diff": "roundDiff",
  "workspace.diff": "workspaceDiff",
  "workspace.git.diff": "workspaceGitDiff",
  "team.pr.list": "teamPRList",
  "git.refs": "gitRefs",
  "session.list": "sessionList",
  "session.touch": "sessionTouch",
  "session.rename": "sessionRename",
  "session.pin": "sessionPin",
  "session.duplicate": "sessionDuplicate",
  "session.delete": "sessionDelete",
  "session.attach": "sessionAttach",
  "session.fork": "sessionFork",
  "session.rollback.messages": "sessionRollbackMessages",
  "sandbox.list": "sandboxList",
  "sandbox.diff": "sandboxDiff",
  "sandbox.resources": "sandboxResources",
  "sandbox.resource-output": "sandboxResourceOutput",
  "sandbox.resource-stop": "sandboxResourceStop",
  "sandbox.merge": "sandboxMerge",
  "sandbox.delete": "sandboxDelete",
  "agent.select": "selectAgent",
  "session.snapshot": "sessionSnapshot",
  "session.subagents": "subagents",
  "subagent.history": "subagentHistory",
  "subagent.history.page": "subagentHistoryPage",
  "attachment.upload": "uploadAttachment",
  "attachment.dataUrl": "attachmentDataUrl",
  "planDoc.list": "planDocList",
  "planDoc.read": "planDocRead",
  "planDoc.write": "planDocWrite",
  "planDoc.mark": "planDocMark",
  "planDoc.delete": "planDocDelete",
  "planDoc.status": "planDocStatus",
  "planDoc.updateStatus": "planDocUpdateStatus",
  "planDoc.active": "planDocActive",
  "planDoc.activate": "planDocActivate",
  "planDoc.deactivate": "planDocDeactivate",
  "mailbox.list": "mailboxList",
  "mailbox.send": "mailboxSend",
  "mailbox.acknowledge": "mailboxAcknowledge",
  "drift.list": "driftFindings",
  completions: "completions",
  "completion.human_validation": "recordHumanValidation",
  "plan.task.states": "planTaskStates",
  "workgraph.integrity": "workGraphIntegrity",
  "workgraph.unattributed": "unattributedChanges",
  "constitution.list": "constitutionRules",
  "constitution.overrides": "constitutionOverrides",
  "decision.list": "decisionRecords",
  "evidence.list": "evidenceRecords",
  "projections.list": "projectionContributions",
  "constitution.override.request": "requestOverride",
  "constitution.override.approve": "approveOverride",
  "constitution.docRules": "constitutionDocRules",
  "constitution.docRule.promote": "promoteConstitutionDocRule",
  "constitution.docRule.update": "updateConstitutionDocRule",
  "navi.chat.submit": "naviChat",
  "navi.chat.abort": "naviChat",
  "navi.chat.messages": "naviChat",
  "navi.chat.messages.page": "naviChat",
  "navi.chat.rollback": "naviChat",
  "navi.chat.model.profile": "naviChat",
  "navi.chat.model.profile.set": "naviChat",
  "nia.chat.submit": "niaChat",
  "nia.chat.abort": "niaChat",
  "nia.chat.messages": "niaChat",
  "nia.chat.messages.page": "niaChat",
  "nia.chat.rollback": "niaChat",
  "nia.chat.model.profile": "niaChat",
  "nia.chat.model.profile.set": "niaChat",
} as const satisfies Readonly<Record<string, keyof RuntimeClient | null>>;

/** The member names this channel routes, for reachability reporting. */
export const WORKER_ROUTED_MEMBERS: ReadonlySet<string> = new Set(
  (Object.values(WORKER_ROUTE_MEMBERS) as Array<string | null>).filter(
    (member): member is string => typeof member === "string",
  ),
);

type WorkerRequest = {
  type: "runtime.request";
  id: string;
  method:
    | "submit"
    | "submitAndWait"
    | "input.remove"
    | "input.replace"
    | "input.promote"
    | "cancel"
    | "pause"
    | "resume"
    | "runtime.status"
    | "snapshot"
    | "diagnostic"
    | "approval"
    | "question"
    | "interactive.pending"
    | "interactive.respond"
    | "config.reload"
    | "config.update"
    | "config.get"
    | "dispose"
    | "history"
    | "diagnostics"
    | "diagnostics.operations"
    | "growth.propose"
    | "growth.proposals"
    | "ast.move"
    | "workspace.ast_move"
    | "prompt.run_groups"
    | "eval.external_benchmark"
    | "eval.external_run"
    | "corrections.patterns"
    | "growth.promote"
    | "growth.promotions"
    | "growth.triggers"
    | "eval.joined_tasks"
    | "messages"
    | "agents"
    | "model.catalog"
    | "model.selection"
    | "model.select"
    | "model.setDefault"
    | "model.reasoning"
    | "model.reasoning.set"
    | "permission.list"
    | "permission.save"
    | "permission.delete"
    | "skills"
    | "workspace.files"
    | "workspace.search"
    | "workspace.list"
    | "workspace.read"
    | "resource.read"
    | "workspace.glob"
    | "workspace.write"
    | "workspace.create"
    | "workspace.rename"
    | "workspace.delete"
    | "workspace.writeConflicts"
    | "mcp.catalog"
    | "mcp.prompt"
    | "mcp.resource"
    | "native-terminal.list"
    | "native-terminal.read"
    | "native-terminal.open-hub"
    | "native-terminal.release-human-control"
    | "native-terminal.revoke-approval-scope"
    | "native-terminal.stop"
    | "native-terminal.begin-secure-input"
    | "native-terminal.end-secure-input"
    | "checkpoint.list"
    | "checkpoint.preview"
    | "checkpoint.rollback"
    | "checkpoint.rename"
    | "checkpoint.listByKind"
    | "audit.rounds"
    | "workspace.round.diff"
    | "workspace.diff"
    | "workspace.git.diff"
    | "team.pr.list"
    | "git.refs"
    | "session.list"
    | "session.touch"
    | "session.rename"
    | "session.pin"
    | "session.duplicate"
    | "session.delete"
    | "session.attach"
    | "session.fork"
    | "session.rollback.messages"
    | "sandbox.list"
    | "sandbox.diff"
    | "sandbox.resources"
    | "sandbox.resource-output"
    | "sandbox.resource-stop"
    | "sandbox.merge"
    | "sandbox.delete"
    | "agent.select"
    | "runtime.availability"
    | "session.snapshot"
    | "session.subagents"
    | "subagent.history"
    | "subagent.history.page"
    | "attachment.upload"
    | "attachment.dataUrl"
    | "planDoc.list"
    | "planDoc.read"
    | "planDoc.write"
    | "planDoc.mark"
    | "planDoc.delete"
    | "planDoc.status"
    | "planDoc.updateStatus"
    | "planDoc.active"
    | "planDoc.activate"
    | "planDoc.deactivate"
    | "mailbox.list"
    | "mailbox.send"
    | "mailbox.acknowledge"
    | "drift.list"
    | "completions"
    | "completion.human_validation"
    | "plan.task.states"
    | "workgraph.integrity"
    | "workgraph.unattributed"
    | "constitution.list"
    | "constitution.overrides"
    | "decision.list"
    | "evidence.list"
    | "projections.list"
    | "constitution.override.request"
    | "constitution.override.approve"
    | "constitution.docRules"
    | "constitution.docRule.promote"
    | "constitution.docRule.update"
    | "chat.messages"
    | "chat.messages.page"
    | "chat.abort"
    | "chat.submit"
    | "chat.rollback"
    | "chat.model.profile"
    | "chat.model.profile.set"
    | "navi.chat.submit"
    | "navi.chat.abort"
    | "navi.chat.messages"
    | "navi.chat.messages.page"
    | "navi.chat.rollback"
    | "navi.chat.model.profile"
    | "navi.chat.model.profile.set"
    | "nia.chat.submit"
    | "nia.chat.abort"
    | "nia.chat.messages"
    | "nia.chat.messages.page"
    | "nia.chat.rollback"
    | "nia.chat.model.profile"
    | "nia.chat.model.profile.set"
    | "command.catalog"
    | "command.execute";
  value?: unknown;
};

type WorkerResponse = {
  type: "runtime.response";
  id: string;
  value?: unknown;
  error?: string;
};

type WorkerEvent = { type: "runtime.event"; event: RuntimeEvent };

export type RuntimeWorkerPort = {
  postMessage(value: unknown): void;
  start?(): void;
  close?(): void;
  addEventListener(
    type: "message",
    handler: (event: MessageEvent<unknown>) => void,
  ): void;
  addEventListener(type: "close", handler: (event: Event) => void): void;
  removeEventListener(
    type: "message",
    handler: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(type: "close", handler: (event: Event) => void): void;
};

export type WorkerRuntimeClient = RuntimeClient & {
  availability(): Promise<
    import("@anthelia/contracts").RuntimeCapabilityReport
  >;
};

export function createWorkerRuntimeClient(
  port: RuntimeWorkerPort,
): WorkerRuntimeClient {
  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  let sequence = 0;
  let sink: ((event: RuntimeEvent) => void) | undefined;
  const bufferedEvents: RuntimeEvent[] = [];
  const onMessage = (event: MessageEvent<unknown>) => {
    const message = event.data as WorkerResponse | WorkerEvent;
    if (message.type === "runtime.event") {
      if (sink) sink(message.event);
      else bufferedEvents.push(message.event);
      return;
    }
    if (message.type !== "runtime.response") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.value);
  };
  port.addEventListener("message", onMessage);
  // The worker can exit underneath the TUI (provider connection loss, crash,
  // dispose). Surface that through the event stream instead of leaving a
  // silently dead backend whose every next request fails.
  port.addEventListener("close", () => {
    if (!sink) return;
    sink({
      type: "diagnostic",
      level: "error",
      message: "runtime worker exited; the session backend is unavailable",
      at: new Date().toISOString(),
    });
  });
  port.start?.();
  /**
   * Notifications have no caller waiting on them, so a rejected worker request
   * would become an unhandled rejection and take down the host process. The
   * runtime already reports its own problems through the event stream, so a
   * failed notification is reported the same way instead of crashing.
   */
  const notify = (method: WorkerRequest["method"], value?: unknown) => {
    void request(method, value).catch((error: unknown) => {
      sink?.({
        type: "diagnostic",
        level: "warning",
        message: `runtime ${method} failed: ${error instanceof Error ? error.message : String(error)}`,
        at: new Date().toISOString(),
      });
    });
  };
  const request = (method: WorkerRequest["method"], value?: unknown) => {
    const id = `wrk_${(++sequence).toString(36)}`;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        port.postMessage({
          type: "runtime.request",
          id,
          method,
          value,
        } satisfies WorkerRequest);
      } catch (error) {
        // The worker can exit underneath the TUI (provider connection loss,
        // crash, dispose). Reject immediately and do not strand the pending
        // entry; callers that await receive the error, callers that fire and
        // forget must catch it themselves.
        pending.delete(id);
        reject(error);
      }
    });
  };
  const chatStreamSurface = (
    stream: "navi" | "nia",
  ): NonNullable<RuntimeClient["naviChat"]> => ({
    async submit(input) {
      return (await request(`${stream}.chat.submit`, input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["naviChat"]>["submit"]>
      >;
    },
    async abort(sessionID) {
      return (await request(`${stream}.chat.abort`, { sessionID })) as Awaited<
        ReturnType<NonNullable<NonNullable<RuntimeClient["naviChat"]>["abort"]>>
      >;
    },
    async messages(sessionID) {
      return (await request(`${stream}.chat.messages`, {
        sessionID,
      })) as Awaited<
        ReturnType<
          NonNullable<NonNullable<RuntimeClient["naviChat"]>["messages"]>
        >
      >;
    },
    async messagesPage(input) {
      return (await request(`${stream}.chat.messages.page`, input)) as Awaited<
        ReturnType<
          NonNullable<NonNullable<RuntimeClient["naviChat"]>["messagesPage"]>
        >
      >;
    },
    async rollback(input, sessionID) {
      return (await request(`${stream}.chat.rollback`, {
        input,
        sessionID,
      })) as Awaited<
        ReturnType<
          NonNullable<NonNullable<RuntimeClient["naviChat"]>["rollback"]>
        >
      >;
    },
    async modelProfile(sessionID) {
      return (await request(`${stream}.chat.model.profile`, {
        sessionID,
      })) as Awaited<
        ReturnType<
          NonNullable<NonNullable<RuntimeClient["naviChat"]>["modelProfile"]>
        >
      >;
    },
    async setModelProfile(profile, sessionID) {
      return (await request(`${stream}.chat.model.profile.set`, {
        profile,
        sessionID,
      })) as Awaited<
        ReturnType<
          NonNullable<NonNullable<RuntimeClient["naviChat"]>["setModelProfile"]>
        >
      >;
    },
  });

  return {
    start(onEvent) {
      sink = onEvent;
      for (const event of bufferedEvents.splice(0)) onEvent(event);
    },
    /** What this channel can reach: the worker route table intersected with the runtime. */
    async availability() {
      return (await request("runtime.availability")) as Awaited<
        ReturnType<typeof describeRuntimeCapabilities>
      >;
    },
    async submit(text) {
      return (await request("submit", { text })) as SubmittedTurn;
    },
    async submitAndWait(input) {
      return (await request(
        "submitAndWait",
        typeof input === "string" ? { text: input } : input,
      )) as SubmittedTurn;
    },
    async submitInput(input) {
      return (await request("submit", input)) as SubmittedTurn;
    },
    async removeInput(input) {
      return (await request("input.remove", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["removeInput"]>>
      >;
    },
    async replaceInput(input) {
      return (await request("input.replace", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["replaceInput"]>>
      >;
    },
    async promoteInput(input) {
      return (await request("input.promote", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["promoteInput"]>>
      >;
    },
    async pendingInteractive(input) {
      return (await request("interactive.pending", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["pendingInteractive"]>>
      >;
    },
    async respondInteractive(response) {
      return (await request("interactive.respond", response)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["respondInteractive"]>>
      >;
    },
    async reloadConfig() {
      return (await request("config.reload")) as Awaited<
        ReturnType<NonNullable<RuntimeClient["reloadConfig"]>>
      >;
    },
    async runtimeStatus(sessionID) {
      return (await request(
        "runtime.status",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<ReturnType<NonNullable<RuntimeClient["runtimeStatus"]>>>;
    },
    async history(options) {
      return (await request("history", options)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["history"]>>
      >;
    },
    async messages(options) {
      return (await request("messages", options)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["messages"]>>
      >;
    },
    async agents(input) {
      return (await request("agents", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["agents"]>>
      >;
    },
    async modelCatalog(input) {
      return (await request("model.catalog", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["modelCatalog"]>>
      >;
    },
    async modelSelection() {
      return (await request("model.selection")) as Awaited<
        ReturnType<NonNullable<RuntimeClient["modelSelection"]>>
      >;
    },
    async selectModel(modelID, variant) {
      await request("model.select", { modelID, variant });
    },
    async setDefaultModel(modelID) {
      return (await request("model.setDefault", {
        modelID,
      })) as Awaited<ReturnType<NonNullable<RuntimeClient["setDefaultModel"]>>>;
    },
    async reasoningEffort() {
      return (await request("model.reasoning")) as Awaited<
        ReturnType<NonNullable<RuntimeClient["reasoningEffort"]>>
      >;
    },
    async setReasoningEffort(effort) {
      await request("model.reasoning.set", { effort });
    },
    async permissionList() {
      return (await request("permission.list")) as Awaited<
        ReturnType<NonNullable<RuntimeClient["permissionList"]>>
      >;
    },
    async permissionSave(input) {
      return (await request("permission.save", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["permissionSave"]>>
      >;
    },
    async permissionDelete(name) {
      return (await request("permission.delete", name)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["permissionDelete"]>>
      >;
    },
    async skills(input) {
      return (await request("skills", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["skills"]>>
      >;
    },
    async workspaceFiles(input) {
      return (await request("workspace.files", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["workspaceFiles"]>>
      >;
    },
    async workspaceSearch(input) {
      return (await request("workspace.search", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["workspaceSearch"]>>
      >;
    },
    async workspaceList(input) {
      return (await request("workspace.list", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["workspaceList"]>>
      >;
    },
    async workspaceRead(input) {
      return (await request("workspace.read", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["workspaceRead"]>>
      >;
    },
    async resourceRead(input) {
      return (await request("resource.read", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["resourceRead"]>>
      >;
    },
    async workspaceGlob(input) {
      return (await request("workspace.glob", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["workspaceGlob"]>>
      >;
    },
    async workspaceWrite(input) {
      return (await request("workspace.write", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["workspaceWrite"]>>
      >;
    },
    async workspaceCreate(input) {
      return (await request("workspace.create", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["workspaceCreate"]>>
      >;
    },
    async workspaceRename(input) {
      return (await request("workspace.rename", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["workspaceRename"]>>
      >;
    },
    async workspaceDelete(input) {
      return (await request("workspace.delete", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["workspaceDelete"]>>
      >;
    },
    async workspaceWriteConflicts(input) {
      return (await request("workspace.writeConflicts", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["workspaceWriteConflicts"]>>
      >;
    },
    async mcpCatalog(input) {
      return (await request("mcp.catalog", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["mcpCatalog"]>>
      >;
    },
    async getMcpPrompt(server, name, arguments_, workspaceID) {
      return (await request("mcp.prompt", {
        server,
        name,
        arguments_,
        workspaceID,
      })) as Awaited<ReturnType<NonNullable<RuntimeClient["getMcpPrompt"]>>>;
    },
    async readMcpResource(server, uri, workspaceID) {
      return (await request("mcp.resource", {
        server,
        uri,
        workspaceID,
      })) as Awaited<ReturnType<NonNullable<RuntimeClient["readMcpResource"]>>>;
    },
    async commandCatalog(input) {
      return (await request("command.catalog", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["commandCatalog"]>>
      >;
    },
    async commandExecute(input) {
      await request("command.execute", input);
    },
    async updateConfig(input) {
      return (await request("config.update", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["updateConfig"]>>
      >;
    },
    async configGet() {
      return (await request("config.get")) as Awaited<
        ReturnType<NonNullable<RuntimeClient["configGet"]>>
      >;
    },

    async nativeTerminalList(sessionID) {
      return (await request(
        "native-terminal.list",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<
        ReturnType<NonNullable<RuntimeClient["nativeTerminalList"]>>
      >;
    },
    async nativeTerminalRead(id, sessionID) {
      return (await request("native-terminal.read", {
        id,
        sessionID,
      })) as Awaited<
        ReturnType<NonNullable<RuntimeClient["nativeTerminalRead"]>>
      >;
    },
    async nativeTerminalOpenHub() {
      return (await request("native-terminal.open-hub")) as Awaited<
        ReturnType<NonNullable<RuntimeClient["nativeTerminalOpenHub"]>>
      >;
    },
    async nativeTerminalReleaseHumanControl(id, sessionID) {
      return (await request("native-terminal.release-human-control", {
        id,
        sessionID,
      })) as Awaited<
        ReturnType<
          NonNullable<RuntimeClient["nativeTerminalReleaseHumanControl"]>
        >
      >;
    },
    async nativeTerminalRevokeApprovalScope(id, sessionID) {
      return (await request("native-terminal.revoke-approval-scope", {
        id,
        sessionID,
      })) as Awaited<
        ReturnType<
          NonNullable<RuntimeClient["nativeTerminalRevokeApprovalScope"]>
        >
      >;
    },
    async nativeTerminalStop(id, sessionID) {
      return (await request("native-terminal.stop", {
        id,
        sessionID,
      })) as Awaited<
        ReturnType<NonNullable<RuntimeClient["nativeTerminalStop"]>>
      >;
    },
    async nativeTerminalBeginSecureInput(id, sessionID) {
      return (await request("native-terminal.begin-secure-input", {
        id,
        sessionID,
      })) as Awaited<
        ReturnType<NonNullable<RuntimeClient["nativeTerminalBeginSecureInput"]>>
      >;
    },
    async nativeTerminalEndSecureInput(id) {
      return (await request("native-terminal.end-secure-input", id)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["nativeTerminalEndSecureInput"]>>
      >;
    },
    async checkpointList(sessionID) {
      return (await request(
        "checkpoint.list",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<ReturnType<NonNullable<RuntimeClient["checkpointList"]>>>;
    },
    async checkpointListByKind(kind, sessionID) {
      return (await request("checkpoint.listByKind", {
        kind,
        sessionID,
      })) as Awaited<
        ReturnType<NonNullable<RuntimeClient["checkpointListByKind"]>>
      >;
    },
    async auditRounds(planID, workspaceID) {
      return (await request("audit.rounds", {
        ...(planID ? { planID } : {}),
        ...(workspaceID ? { workspaceID } : {}),
      })) as Awaited<ReturnType<NonNullable<RuntimeClient["auditRounds"]>>>;
    },
    async roundDiff(input) {
      return (await request("workspace.round.diff", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["roundDiff"]>>
      >;
    },
    async workspaceDiff(input) {
      return (await request("workspace.diff", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["workspaceDiff"]>>
      >;
    },
    async workspaceGitDiff(input) {
      return (await request("workspace.git.diff", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["workspaceGitDiff"]>>
      >;
    },
    async gitRefs(input) {
      return (await request("git.refs", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["gitRefs"]>>
      >;
    },
    async teamPRList(sessionID) {
      return (await request(
        "team.pr.list",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<ReturnType<NonNullable<RuntimeClient["teamPRList"]>>>;
    },
    async checkpointPreview(id, sessionID, options) {
      return (await request("checkpoint.preview", {
        id,
        sessionID,
        options,
      })) as Awaited<
        ReturnType<NonNullable<RuntimeClient["checkpointPreview"]>>
      >;
    },
    async checkpointRollback(input) {
      return (await request("checkpoint.rollback", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["checkpointRollback"]>>
      >;
    },
    async checkpointRename(input) {
      return (await request("checkpoint.rename", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["checkpointRename"]>>
      >;
    },
    async sessionList() {
      return (await request("session.list")) as Awaited<
        ReturnType<NonNullable<RuntimeClient["sessionList"]>>
      >;
    },
    async sessionTouch(id) {
      await request("session.touch", id);
    },
    async sessionRename(id, title) {
      return (await request("session.rename", { id, title })) as Awaited<
        ReturnType<NonNullable<RuntimeClient["sessionRename"]>>
      >;
    },
    async sessionPin(id, pinned) {
      return (await request("session.pin", { id, pinned })) as Awaited<
        ReturnType<NonNullable<RuntimeClient["sessionPin"]>>
      >;
    },
    async sessionDuplicate(id, title) {
      return (await request("session.duplicate", { id, title })) as Awaited<
        ReturnType<NonNullable<RuntimeClient["sessionDuplicate"]>>
      >;
    },
    async sessionDelete(id) {
      return (await request("session.delete", id)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["sessionDelete"]>>
      >;
    },
    async sessionAttach(id) {
      return (await request("session.attach", id)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["sessionAttach"]>>
      >;
    },
    async sessionFork(id, turnID, title) {
      return (await request("session.fork", { id, turnID, title })) as Awaited<
        ReturnType<NonNullable<RuntimeClient["sessionFork"]>>
      >;
    },
    async sessionRollbackMessages(id, turnID) {
      return (await request("session.rollback.messages", {
        id,
        turnID,
      })) as Awaited<
        ReturnType<NonNullable<RuntimeClient["sessionRollbackMessages"]>>
      >;
    },
    async sandboxList(sessionID) {
      return (await request(
        "sandbox.list",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<ReturnType<NonNullable<RuntimeClient["sandboxList"]>>>;
    },
    async sandboxDiff(id, sessionID, options) {
      return (await request("sandbox.diff", {
        id,
        sessionID,
        options,
      })) as Awaited<ReturnType<NonNullable<RuntimeClient["sandboxDiff"]>>>;
    },
    async sandboxResources(id, sessionID) {
      return (await request("sandbox.resources", { id, sessionID })) as Awaited<
        ReturnType<NonNullable<RuntimeClient["sandboxResources"]>>
      >;
    },
    async sandboxResourceOutput(input) {
      return (await request("sandbox.resource-output", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["sandboxResourceOutput"]>>
      >;
    },
    async sandboxResourceStop(input) {
      return (await request("sandbox.resource-stop", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["sandboxResourceStop"]>>
      >;
    },
    async sandboxMerge(id, sessionID) {
      return (await request("sandbox.merge", { id, sessionID })) as Awaited<
        ReturnType<NonNullable<RuntimeClient["sandboxMerge"]>>
      >;
    },
    async sandboxDelete(id, sessionID) {
      return (await request("sandbox.delete", { id, sessionID })) as Awaited<
        ReturnType<NonNullable<RuntimeClient["sandboxDelete"]>>
      >;
    },
    async selectAgent(name) {
      return (await request("agent.select", name)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["selectAgent"]>>
      >;
    },
    async sessionSnapshot(sessionID) {
      return (await request(
        "session.snapshot",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<ReturnType<NonNullable<RuntimeClient["sessionSnapshot"]>>>;
    },
    async planDocList(sessionID) {
      return (await request(
        "planDoc.list",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<ReturnType<NonNullable<RuntimeClient["planDocList"]>>>;
    },
    async planDocRead(input) {
      return (await request("planDoc.read", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["planDocRead"]>>
      >;
    },
    async planDocWrite(input) {
      return (await request("planDoc.write", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["planDocWrite"]>>
      >;
    },
    async planDocMark(input) {
      return (await request("planDoc.mark", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["planDocMark"]>>
      >;
    },
    async planDocDelete(planID, sessionID) {
      return (await request("planDoc.delete", {
        planID,
        sessionID,
      })) as Awaited<ReturnType<NonNullable<RuntimeClient["planDocDelete"]>>>;
    },
    async planDocStatus(planID, sessionID) {
      return (await request("planDoc.status", {
        planID,
        sessionID,
      })) as Awaited<ReturnType<NonNullable<RuntimeClient["planDocStatus"]>>>;
    },
    async planDocUpdateStatus(input) {
      return (await request("planDoc.updateStatus", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["planDocUpdateStatus"]>>
      >;
    },
    async planDocActive(sessionID) {
      return (await request(
        "planDoc.active",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<ReturnType<NonNullable<RuntimeClient["planDocActive"]>>>;
    },
    async planDocActivate(planID, sessionID) {
      return (await request("planDoc.activate", {
        planID,
        sessionID,
      })) as Awaited<ReturnType<NonNullable<RuntimeClient["planDocActivate"]>>>;
    },
    async planDocDeactivate(sessionID) {
      return (await request(
        "planDoc.deactivate",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<
        ReturnType<NonNullable<RuntimeClient["planDocDeactivate"]>>
      >;
    },
    async mailboxList(sessionID) {
      return (await request(
        "mailbox.list",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<ReturnType<NonNullable<RuntimeClient["mailboxList"]>>>;
    },
    async mailboxSend(input) {
      return (await request("mailbox.send", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["mailboxSend"]>>
      >;
    },
    async mailboxAcknowledge(messageID, sessionID) {
      return (await request("mailbox.acknowledge", {
        messageID,
        sessionID,
      })) as Awaited<
        ReturnType<NonNullable<RuntimeClient["mailboxAcknowledge"]>>
      >;
    },
    async driftFindings(sessionID) {
      return (await request(
        "drift.list",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<ReturnType<NonNullable<RuntimeClient["driftFindings"]>>>;
    },
    async completions(sessionID) {
      return (await request(
        "completions",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<ReturnType<NonNullable<RuntimeClient["completions"]>>>;
    },
    async constitutionRules(sessionID) {
      return (await request(
        "constitution.list",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<
        ReturnType<NonNullable<RuntimeClient["constitutionRules"]>>
      >;
    },
    async constitutionOverrides(sessionID) {
      return (await request(
        "constitution.overrides",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<
        ReturnType<NonNullable<RuntimeClient["constitutionOverrides"]>>
      >;
    },
    async decisionRecords(sessionID) {
      return (await request(
        "decision.list",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<ReturnType<NonNullable<RuntimeClient["decisionRecords"]>>>;
    },
    async evidenceRecords(sessionID) {
      return (await request(
        "evidence.list",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<ReturnType<NonNullable<RuntimeClient["evidenceRecords"]>>>;
    },
    async projectionContributions(input) {
      return (await request("projections.list", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["projectionContributions"]>>
      >;
    },
    async requestOverride(input, sessionID) {
      return (await request("constitution.override.request", {
        ...input,
        sessionID,
      })) as Awaited<ReturnType<NonNullable<RuntimeClient["requestOverride"]>>>;
    },
    async approveOverride(input) {
      return (await request("constitution.override.approve", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["approveOverride"]>>
      >;
    },
    async subagents(sessionID) {
      return (await request(
        "session.subagents",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<ReturnType<NonNullable<RuntimeClient["subagents"]>>>;
    },
    async subagentHistory(sessionID) {
      return (await request("subagent.history", sessionID)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["subagentHistory"]>>
      >;
    },
    async subagentHistoryPage(input) {
      return (await request("subagent.history.page", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["subagentHistoryPage"]>>
      >;
    },
    async uploadAttachment(input) {
      return (await request("attachment.upload", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["uploadAttachment"]>>
      >;
    },
    async attachmentDataUrl(input) {
      return (await request("attachment.dataUrl", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["attachmentDataUrl"]>>
      >;
    },
    naviChat: chatStreamSurface("navi"),
    niaChat: chatStreamSurface("nia"),

    async dispose() {
      await request("dispose");
      port.removeEventListener("message", onMessage);
      port.close?.();
    },
    cancel(reason, sessionID) {
      notify("cancel", { reason, sessionID });
    },
    // A round trip rather than a notification: these answer whether the runtime
    // actually paused, and a channel that cannot see the answer would have to
    // make one up.
    async pause(reason, sessionID) {
      return (await request("pause", { reason, sessionID })) as Awaited<
        ReturnType<NonNullable<RuntimeClient["pause"]>>
      >;
    },
    async resume(sessionID) {
      return (await request(
        "resume",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<ReturnType<NonNullable<RuntimeClient["resume"]>>>;
    },
    snapshot() {
      const id = `snap_worker_${Date.now().toString(36)}`;
      notify("snapshot");
      return { type: "snapshot.created", id, files: [] };
    },
    async operationRecords(input?: {
      level?: import("@anthelia/contracts").OperationRecord["level"];
      component?: string;
      contains?: string;
      since?: string;
      limit?: number;
    }) {
      return (await request("diagnostics.operations", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["operationRecords"]>>
      >;
    },
    async astMove(input: {
      before: Array<{ path?: string; source: string; language: string }>;
      after: Array<{ path?: string; source: string; language: string }>;
    }) {
      return (await request("ast.move", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["astMove"]>>
      >;
    },
    async workspaceAstMove(input?: { paths?: string[]; from?: string }) {
      return (await request("workspace.ast_move", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["workspaceAstMove"]>>
      >;
    },
    async promoteGrowthTrigger(input: { capability: string }) {
      return (await request("growth.promote", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["promoteGrowthTrigger"]>>
      >;
    },
    async growthPromotions(sessionID?: string) {
      return (await request(
        "growth.promotions",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<ReturnType<NonNullable<RuntimeClient["growthPromotions"]>>>;
    },
    async growthTriggers(sessionID?: string) {
      return (await request(
        "growth.triggers",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<ReturnType<NonNullable<RuntimeClient["growthTriggers"]>>>;
    },
    async externalJoinedTasks(sessionID?: string) {
      return (await request(
        "eval.joined_tasks",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<
        ReturnType<NonNullable<RuntimeClient["externalJoinedTasks"]>>
      >;
    },
    async correctionPatterns(sessionID?: string) {
      return (await request(
        "corrections.patterns",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<
        ReturnType<NonNullable<RuntimeClient["correctionPatterns"]>>
      >;
    },
    async recordExternalRun(input: {
      dir?: string;
      taskID: string;
      turnID: string;
    }) {
      return (await request("eval.external_run", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["recordExternalRun"]>>
      >;
    },
    async externalBenchmark(input?: { dir?: string }) {
      return (await request("eval.external_benchmark", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["externalBenchmark"]>>
      >;
    },
    async promptRunGroups(sessionID?: string) {
      return (await request(
        "prompt.run_groups",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<ReturnType<NonNullable<RuntimeClient["promptRunGroups"]>>>;
    },
    async growthPropose(input?: { planID?: string }) {
      return (await request("growth.propose", input)) as Awaited<
        ReturnType<NonNullable<RuntimeClient["growthPropose"]>>
      >;
    },
    async growthProposals(sessionID?: string) {
      return (await request(
        "growth.proposals",
        sessionID ? { sessionID } : undefined,
      )) as Awaited<ReturnType<NonNullable<RuntimeClient["growthProposals"]>>>;
    },
    async diagnostics(limit, sessionID) {
      return (await request("diagnostics", { limit, sessionID })) as Awaited<
        ReturnType<NonNullable<RuntimeClient["diagnostics"]>>
      >;
    },
    diagnostic(message, level) {
      notify("diagnostic", { message, level });
    },
    lastSubmission() {
      return undefined;
    },
    async respondApproval(response) {
      return (await request("approval", response)) as Awaited<
        ReturnType<RuntimeClient["respondApproval"]>
      >;
    },
    async respondQuestion(response) {
      return (await request("question", response)) as Awaited<
        ReturnType<RuntimeClient["respondQuestion"]>
      >;
    },
  };
}

export function attachRuntimeClientWorker(
  port: RuntimeWorkerPort,
  client: RuntimeClient,
  options?: {
    reload?: () => RuntimeClient;
    disposeHost?: () => void | Promise<void>;
  },
) {
  let activeClient = client;
  const forwardEvent = (event: RuntimeEvent) => {
    port.postMessage({ type: "runtime.event", event } satisfies WorkerEvent);
  };
  activeClient.start(forwardEvent);
  port.addEventListener("message", (event: MessageEvent<unknown>) => {
    const request = event.data as WorkerRequest;
    if (request.type !== "runtime.request") return;
    void handlePortRequest(request);
  });
  port.start?.();

  async function handlePortRequest(request: WorkerRequest) {
    try {
      let value: unknown;
      if (request.method === "config.reload") {
        // Reload in this channel means rebuilding the runtime, so a refusal is
        // reported rather than thrown: being told "not now, a turn is running" is
        // an ordinary answer, and an exception would make callers treat it as a
        // transport failure.
        const rebuild = options?.reload;
        const precheck = rebuild
          ? await activeClient.canReloadConfig?.()
          : undefined;
        const blocked = !rebuild
          ? "this runtime host cannot rebuild the runtime"
          : precheck && !precheck.allowed
            ? (precheck.reason ?? "runtime config cannot be applied now")
            : undefined;
        if (blocked || !rebuild) {
          value = { applied: false, reason: blocked };
        } else {
          await activeClient.dispose?.();
          activeClient = rebuild();
          activeClient.start(forwardEvent, { replay: "none" });
          await activeClient.runtimeStatus?.();
          value = { applied: true };
        }
      } else if (request.method === "config.update") {
        // The write-apply path, unlike the rebuild path above: the patch lands
        // on disk and the runtime applies it in place.
        value = await activeClient.updateConfig?.(
          request.value as {
            patch: Record<string, unknown>;
            scope?: "project" | "global";
          },
        );
      } else if (request.method === "config.get") {
        value = await activeClient.configGet?.();
      } else if (request.method === "dispose") {
        value = await activeClient.dispose?.();
        await options?.disposeHost?.();
      } else {
        value = await handleWorkerRequest(activeClient, request);
      }
      port.postMessage({
        type: "runtime.response",
        id: request.id,
        value,
      } satisfies WorkerResponse);
    } catch (error) {
      port.postMessage({
        type: "runtime.response",
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies WorkerResponse);
    }
  }
}

export async function handleWorkerRequest(
  client: RuntimeClient,
  request: WorkerRequest,
) {
  if (request.method === "submit") {
    const input =
      request.value && typeof request.value === "object"
        ? (request.value as SubmitInput)
        : { text: String(request.value ?? "") };
    return client.submitInput
      ? await client.submitInput(input)
      : await client.submit(input.text);
  }
  if (request.method === "submitAndWait") {
    const input =
      request.value && typeof request.value === "object"
        ? (request.value as SubmitInput)
        : { text: String(request.value ?? "") };
    if (client.submitAndWait)
      return await client.submitAndWait(
        request.value && typeof request.value === "object"
          ? (request.value as SubmitInput)
          : input.text,
      );
    throw new Error("RuntimeClient does not support submitAndWait");
  }
  if (request.method === "input.remove") {
    if (!client.removeInput)
      throw new Error("RuntimeClient does not support input.remove");
    return await client.removeInput(
      request.value as import("@anthelia/contracts").InputTarget,
    );
  }
  if (request.method === "input.replace") {
    if (!client.replaceInput)
      throw new Error("RuntimeClient does not support input.replace");
    return await client.replaceInput(
      request.value as import("@anthelia/contracts").InputTarget & {
        text: string;
      },
    );
  }
  if (request.method === "input.promote") {
    if (!client.promoteInput)
      throw new Error("RuntimeClient does not support input.promote");
    return await client.promoteInput(
      request.value as import("@anthelia/contracts").InputTarget,
    );
  }
  if (request.method === "interactive.pending") {
    if (!client.pendingInteractive)
      throw new Error("RuntimeClient does not support interactive.pending");
    return await client.pendingInteractive(request.value as never);
  }
  if (request.method === "interactive.respond") {
    if (!client.respondInteractive)
      throw new Error("RuntimeClient does not support interactive.respond");
    return await client.respondInteractive(
      request.value as import("@anthelia/contracts").InteractiveResponse,
    );
  }
  if (request.method === "runtime.status")
    return await client.runtimeStatus?.(
      (request.value as { sessionID?: string } | undefined)?.sessionID,
    );
  if (request.method === "history")
    return await client.history?.(request.value as never);
  if (request.method === "messages")
    return await client.messages?.(request.value as never);
  if (request.method === "agents")
    return await client.agents?.(
      request.value as { workspaceID?: string } | undefined,
    );
  if (request.method === "model.catalog")
    return await client.modelCatalog?.(
      request.value as { workspaceID?: string } | undefined,
    );
  if (request.method === "model.selection")
    return await client.modelSelection?.();
  if (request.method === "model.setDefault") {
    const value = request.value as { modelID: string };
    return await client.setDefaultModel?.(value.modelID);
  }
  if (request.method === "model.select") {
    const input = request.value as { modelID?: string; variant?: string };
    return await client.selectModel?.(input.modelID, input.variant);
  }
  if (request.method === "model.reasoning")
    return await client.reasoningEffort?.();
  if (request.method === "model.reasoning.set") {
    const input = request.value as { effort?: RuntimeReasoningEffort };
    return await client.setReasoningEffort?.(input.effort);
  }
  if (request.method === "permission.list")
    return await client.permissionList?.();
  if (request.method === "permission.save")
    return await client.permissionSave?.(request.value as never);
  if (request.method === "permission.delete")
    return await client.permissionDelete?.(request.value as string);
  if (request.method === "skills")
    return await client.skills?.(
      request.value as { workspaceID?: string } | undefined,
    );
  if (request.method === "workspace.files")
    return await client.workspaceFiles?.(request.value as never);
  if (request.method === "workspace.search")
    return await client.workspaceSearch?.(request.value as never);
  if (request.method === "workspace.list")
    return await client.workspaceList?.(request.value as never);
  if (request.method === "workspace.read")
    return await client.workspaceRead?.(request.value as never);
  if (request.method === "resource.read")
    return await client.resourceRead?.(request.value as never);
  if (request.method === "workspace.glob")
    return await client.workspaceGlob?.(request.value as never);
  if (request.method === "workspace.write")
    return await client.workspaceWrite?.(request.value as never);
  if (request.method === "workspace.create")
    return await client.workspaceCreate?.(request.value as never);
  if (request.method === "workspace.rename")
    return await client.workspaceRename?.(request.value as never);
  if (request.method === "workspace.delete")
    return await client.workspaceDelete?.(request.value as never);
  if (request.method === "workspace.writeConflicts")
    return await client.workspaceWriteConflicts?.(
      request.value as { workspaceID?: string } | undefined,
    );
  if (request.method === "mcp.catalog")
    return await client.mcpCatalog?.(
      request.value as { workspaceID?: string } | undefined,
    );
  if (request.method === "mcp.prompt")
    return await client.getMcpPrompt?.(
      (request.value as { server: string }).server,
      (request.value as { name: string }).name,
      (request.value as { arguments_?: Record<string, string> }).arguments_,
      (request.value as { workspaceID?: string }).workspaceID,
    );
  if (request.method === "mcp.resource")
    return await client.readMcpResource?.(
      (request.value as { server: string }).server,
      (request.value as { uri: string }).uri,
      (request.value as { workspaceID?: string }).workspaceID,
    );
  if (request.method === "native-terminal.list")
    return await client.nativeTerminalList?.(
      (request.value as { sessionID?: string } | undefined)?.sessionID,
    );
  if (request.method === "native-terminal.read") {
    const value = request.value as { id: string; sessionID?: string };
    return await client.nativeTerminalRead?.(value.id, value.sessionID);
  }
  if (request.method === "native-terminal.open-hub")
    return await client.nativeTerminalOpenHub?.();
  if (request.method === "native-terminal.release-human-control") {
    const value = request.value as { id: string; sessionID?: string };
    return await client.nativeTerminalReleaseHumanControl?.(
      value.id,
      value.sessionID,
    );
  }
  if (request.method === "ast.move") {
    const value = request.value as {
      before: Array<{ path?: string; source: string; language: string }>;
      after: Array<{ path?: string; source: string; language: string }>;
    };
    return await client.astMove?.(value);
  }
  if (request.method === "workspace.ast_move") {
    const value = request.value as
      | { paths?: string[]; from?: string }
      | undefined;
    return await client.workspaceAstMove?.(value);
  }
  if (request.method === "growth.promote") {
    const value = request.value as { capability: string };
    return await client.promoteGrowthTrigger?.(value);
  }
  if (request.method === "growth.promotions") {
    const value = request.value as { sessionID?: string } | undefined;
    return await client.growthPromotions?.(value?.sessionID);
  }
  if (request.method === "growth.triggers") {
    const value = request.value as { sessionID?: string } | undefined;
    return await client.growthTriggers?.(value?.sessionID);
  }
  if (request.method === "eval.joined_tasks") {
    const value = request.value as { sessionID?: string } | undefined;
    return await client.externalJoinedTasks?.(value?.sessionID);
  }
  if (request.method === "corrections.patterns") {
    const value = request.value as { sessionID?: string } | undefined;
    return await client.correctionPatterns?.(value?.sessionID);
  }
  if (request.method === "eval.external_run") {
    const value = request.value as {
      dir?: string;
      taskID: string;
      turnID: string;
    };
    return await client.recordExternalRun?.(value);
  }
  if (request.method === "eval.external_benchmark") {
    const value = request.value as { dir?: string } | undefined;
    return await client.externalBenchmark?.(value);
  }
  if (request.method === "prompt.run_groups") {
    const value = request.value as { sessionID?: string } | undefined;
    return await client.promptRunGroups?.(value?.sessionID);
  }
  if (request.method === "growth.propose") {
    const value = request.value as { planID?: string } | undefined;
    return await client.growthPropose?.(value);
  }
  if (request.method === "growth.proposals") {
    const value = request.value as { sessionID?: string } | undefined;
    return await client.growthProposals?.(value?.sessionID);
  }
  if (request.method === "diagnostics.operations") {
    const value = request.value as
      | {
          level?: import("@anthelia/contracts").OperationRecord["level"];
          component?: string;
          contains?: string;
          since?: string;
          limit?: number;
        }
      | undefined;
    return await client.operationRecords?.(value);
  }
  if (request.method === "diagnostics") {
    const value = request.value as
      | { limit?: number; sessionID?: string }
      | number
      | undefined;
    return await client.diagnostics?.(
      typeof value === "number" ? value : value?.limit,
      typeof value === "number" ? undefined : value?.sessionID,
    );
  }
  if (request.method === "native-terminal.revoke-approval-scope") {
    const value = request.value as { id: string; sessionID?: string };
    return await client.nativeTerminalRevokeApprovalScope?.(
      value.id,
      value.sessionID,
    );
  }
  if (request.method === "native-terminal.stop") {
    const value = request.value as { id: string; sessionID?: string };
    return await client.nativeTerminalStop?.(value.id, value.sessionID);
  }
  if (request.method === "native-terminal.begin-secure-input") {
    const value = request.value as { id: string; sessionID?: string };
    return await client.nativeTerminalBeginSecureInput?.(
      value.id,
      value.sessionID,
    );
  }
  if (request.method === "native-terminal.end-secure-input") {
    const value = request.value as { id: string; sessionID?: string };
    return await client.nativeTerminalEndSecureInput?.(
      value.id,
      value.sessionID,
    );
  }
  if (request.method === "checkpoint.list")
    return await client.checkpointList?.(
      (request.value as { sessionID?: string } | undefined)?.sessionID,
    );
  if (request.method === "checkpoint.listByKind") {
    const value = request.value as { kind?: any; sessionID?: string };
    return await client.checkpointListByKind?.(value.kind, value.sessionID);
  }
  if (request.method === "audit.rounds") {
    const value = request.value as
      | { planID?: string; workspaceID?: string }
      | undefined;
    return await client.auditRounds?.(value?.planID, value?.workspaceID);
  }
  if (request.method === "workspace.round.diff")
    return await client.roundDiff?.(
      request.value as Parameters<NonNullable<RuntimeClient["roundDiff"]>>[0],
    );
  if (request.method === "workspace.diff")
    return await client.workspaceDiff?.(
      request.value as { includePatch?: boolean } | undefined,
    );
  if (request.method === "workspace.git.diff")
    return await client.workspaceGitDiff?.(
      request.value as
        | { from?: string; to?: string; path?: string; includePatch?: boolean }
        | undefined,
    );
  if (request.method === "git.refs")
    return await client.gitRefs?.(
      request.value as { workspaceID?: string } | undefined,
    );
  if (request.method === "team.pr.list")
    return await client.teamPRList?.(
      (request.value as { sessionID?: string } | undefined)?.sessionID,
    );
  if (request.method === "checkpoint.preview") {
    const value = request.value as {
      id: string;
      sessionID?: string;
      options?: { includePatch?: boolean };
    };
    return await client.checkpointPreview?.(
      value.id,
      value.sessionID,
      value.options,
    );
  }
  if (request.method === "checkpoint.rollback")
    return await client.checkpointRollback?.(
      request.value as { id: string; dryRun?: boolean; sessionID?: string },
    );
  if (request.method === "checkpoint.rename")
    return await client.checkpointRename?.(
      request.value as { id: string; name: string; sessionID?: string },
    );
  if (request.method === "cancel") {
    const value = request.value as
      | { reason?: unknown; sessionID?: string }
      | string
      | undefined;
    return client.cancel(
      typeof value === "string"
        ? value
        : typeof value?.reason === "string"
          ? value.reason
          : undefined,
      typeof value === "string" ? undefined : value?.sessionID,
    );
  }
  if (request.method === "pause") {
    const value = request.value as
      | { reason?: string; sessionID?: string }
      | string
      | undefined;
    return client.pause?.(
      typeof value === "string" ? value : value?.reason,
      typeof value === "string" ? undefined : value?.sessionID,
    );
  }
  if (request.method === "resume") {
    const value = request.value as { sessionID?: string } | undefined;
    return client.resume?.(value?.sessionID);
  }
  if (request.method === "snapshot") return client.snapshot();
  if (request.method === "diagnostic") {
    const input = request.value as { message?: unknown; level?: unknown };
    return client.diagnostic(
      typeof input.message === "string" ? input.message : "runtime diagnostic",
      input.level === "info" || input.level === "error"
        ? input.level
        : "warning",
    );
  }
  if (request.method === "dispose") return await client.dispose?.();
  if (request.method === "session.list") return await client.sessionList?.();
  if (request.method === "session.touch")
    return await client.sessionTouch?.(request.value as string);
  if (request.method === "session.rename") {
    const input = request.value as { id: string; title: string };
    return await client.sessionRename?.(input.id, input.title);
  }
  if (request.method === "session.pin") {
    const input = request.value as { id: string; pinned: boolean };
    return await client.sessionPin?.(input.id, input.pinned);
  }
  if (request.method === "session.duplicate") {
    const input = request.value as { id: string; title?: string };
    return await client.sessionDuplicate?.(input.id, input.title);
  }
  if (request.method === "session.delete")
    return await client.sessionDelete?.(request.value as string);
  if (request.method === "session.attach")
    return await client.sessionAttach?.(request.value as string);
  if (request.method === "session.fork") {
    const input = request.value as {
      id: string;
      turnID: string;
      title?: string;
    };
    return await client.sessionFork?.(input.id, input.turnID, input.title);
  }
  if (request.method === "session.rollback.messages") {
    const input = request.value as { id: string; turnID: string };
    return await client.sessionRollbackMessages?.(input.id, input.turnID);
  }
  if (request.method === "sandbox.list") return await client.sandboxList?.();
  if (request.method === "sandbox.diff") {
    const value = request.value as {
      id: string;
      sessionID?: string;
      options?: { includePatch?: boolean };
    };
    return await client.sandboxDiff?.(value.id, value.sessionID, value.options);
  }
  if (request.method === "sandbox.resources")
    return await client.sandboxResources?.(request.value as string);
  if (request.method === "sandbox.resource-output")
    return await client.sandboxResourceOutput?.(
      request.value as {
        id: string;
        resourceID: string;
        maxBytes?: number;
        sessionID?: string;
      },
    );
  if (request.method === "sandbox.resource-stop")
    return await client.sandboxResourceStop?.(
      request.value as { id: string; resourceID: string; sessionID?: string },
    );
  if (request.method === "sandbox.merge") {
    const value = request.value as { id: string; sessionID?: string };
    return await client.sandboxMerge?.(value.id, value.sessionID);
  }
  if (request.method === "sandbox.delete") {
    const value = request.value as { id: string; sessionID?: string };
    return await client.sandboxDelete?.(value.id, value.sessionID);
  }
  if (request.method === "agent.select")
    return await client.selectAgent?.(request.value as string);
  if (request.method === "session.snapshot")
    return await client.sessionSnapshot?.(
      (request.value as { sessionID?: string } | undefined)?.sessionID,
    );
  if (request.method === "planDoc.list")
    return await client.planDocList?.(
      (request.value as { sessionID?: string } | undefined)?.sessionID,
    );
  if (request.method === "planDoc.read")
    return await client.planDocRead?.(request.value as never);
  if (request.method === "planDoc.write")
    return await client.planDocWrite?.(request.value as never);
  if (request.method === "planDoc.mark")
    return await client.planDocMark?.(request.value as never);
  if (request.method === "planDoc.delete") {
    const value = request.value as { planID: string; sessionID?: string };
    return await client.planDocDelete?.(value.planID, value.sessionID);
  }
  if (request.method === "planDoc.status") {
    const value = request.value as { planID: string; sessionID?: string };
    return await client.planDocStatus?.(value.planID, value.sessionID);
  }
  if (request.method === "planDoc.updateStatus")
    return await client.planDocUpdateStatus?.(request.value as never);
  if (request.method === "planDoc.active")
    return await client.planDocActive?.(
      (request.value as { sessionID?: string } | undefined)?.sessionID,
    );
  if (request.method === "planDoc.activate") {
    const value = request.value as { planID: string; sessionID?: string };
    return await client.planDocActivate?.(value.planID, value.sessionID);
  }
  if (request.method === "planDoc.deactivate")
    return await client.planDocDeactivate?.(
      (request.value as { sessionID?: string } | undefined)?.sessionID,
    );
  if (request.method === "mailbox.list")
    return await client.mailboxList?.(
      (request.value as { sessionID?: string } | undefined)?.sessionID,
    );
  if (request.method === "mailbox.send")
    return await client.mailboxSend?.(request.value as never);
  if (request.method === "mailbox.acknowledge") {
    const value = request.value as { messageID: string; sessionID?: string };
    return await client.mailboxAcknowledge?.(value.messageID, value.sessionID);
  }
  if (request.method === "drift.list")
    return await client.driftFindings?.(
      request.value as
        | { sessionID?: string; limit?: number; cursor?: string }
        | undefined,
    );
  if (request.method === "completions")
    return await client.completions?.(
      request.value as
        | { sessionID?: string; limit?: number; cursor?: string }
        | undefined,
    );
  if (request.method === "completion.human_validation")
    return await client.recordHumanValidation?.(
      request.value as { taskID: string; validation: string },
    );
  if (request.method === "plan.task.states")
    return await client.planTaskStates?.(
      request.value as { planID?: string } | undefined,
    );
  if (request.method === "workgraph.integrity")
    return await client.workGraphIntegrity?.(
      (request.value as { sessionID?: string } | undefined)?.sessionID,
    );
  if (request.method === "workgraph.unattributed")
    return await client.unattributedChanges?.(
      (request.value as { sessionID?: string } | undefined)?.sessionID,
    );
  if (request.method === "constitution.list")
    return await client.constitutionRules?.(
      (request.value as { sessionID?: string } | undefined)?.sessionID,
    );
  if (request.method === "constitution.overrides")
    return await client.constitutionOverrides?.(
      (request.value as { sessionID?: string } | undefined)?.sessionID,
    );
  if (request.method === "decision.list")
    return await client.decisionRecords?.(
      (request.value as { sessionID?: string } | undefined)?.sessionID,
    );
  if (request.method === "evidence.list")
    return await client.evidenceRecords?.(
      request.value as
        | { sessionID?: string; limit?: number; cursor?: string }
        | undefined,
    );
  if (request.method === "projections.list")
    return await client.projectionContributions?.(
      request.value as { workspaceID?: string } | undefined,
    );
  if (request.method === "constitution.override.request")
    return await client.requestOverride?.(request.value as never);
  if (request.method === "constitution.override.approve")
    return await client.approveOverride?.(request.value as never);
  if (request.method === "constitution.docRules")
    return await client.constitutionDocRules?.(
      (request.value as { sessionID?: string } | undefined)?.sessionID,
    );
  if (request.method === "constitution.docRule.promote")
    return await client.promoteConstitutionDocRule?.(
      request.value as { id: string; sessionID?: string },
    );
  if (request.method === "constitution.docRule.update")
    return await client.updateConstitutionDocRule?.(
      request.value as {
        id: string;
        statement?: string;
        enforcement?: "deny" | "approval" | "warn";
        appliesTo?: {
          tools?: string[];
          paths?: string[];
          commandPattern?: string;
        };
        sessionID?: string;
      },
    );
  if (
    request.method === "navi.chat.submit" ||
    request.method === "nia.chat.submit"
  ) {
    const surface =
      request.method === "navi.chat.submit" ? client.naviChat : client.niaChat;
    return await surface?.submit?.(request.value as never);
  }
  if (
    request.method === "navi.chat.abort" ||
    request.method === "nia.chat.abort"
  ) {
    const surface =
      request.method === "navi.chat.abort" ? client.naviChat : client.niaChat;
    return await surface?.abort?.(
      (request.value as { sessionID?: string } | undefined)?.sessionID,
    );
  }
  if (
    request.method === "navi.chat.messages" ||
    request.method === "nia.chat.messages"
  ) {
    const surface =
      request.method === "navi.chat.messages"
        ? client.naviChat
        : client.niaChat;
    return await surface?.messages?.(
      (request.value as { sessionID?: string } | undefined)?.sessionID,
    );
  }
  if (
    request.method === "navi.chat.messages.page" ||
    request.method === "nia.chat.messages.page"
  ) {
    const surface =
      request.method === "navi.chat.messages.page"
        ? client.naviChat
        : client.niaChat;
    return await surface?.messagesPage?.(request.value as never);
  }
  if (
    request.method === "navi.chat.rollback" ||
    request.method === "nia.chat.rollback"
  ) {
    const surface =
      request.method === "navi.chat.rollback"
        ? client.naviChat
        : client.niaChat;
    const value = request.value as {
      input: { toMessageID: string };
      sessionID?: string;
    };
    return await surface?.rollback?.(value.input, value.sessionID);
  }
  if (
    request.method === "navi.chat.model.profile" ||
    request.method === "nia.chat.model.profile"
  ) {
    const surface =
      request.method === "navi.chat.model.profile"
        ? client.naviChat
        : client.niaChat;
    return await surface?.modelProfile?.(
      (request.value as { sessionID?: string } | undefined)?.sessionID,
    );
  }
  if (
    request.method === "navi.chat.model.profile.set" ||
    request.method === "nia.chat.model.profile.set"
  ) {
    const surface =
      request.method === "navi.chat.model.profile.set"
        ? client.naviChat
        : client.niaChat;
    const value = request.value as {
      profile: import("@anthelia/contracts").ChatModelProfile;
      sessionID?: string;
    };
    return await surface?.setModelProfile?.(value.profile, value.sessionID);
  }

  if (request.method === "approval")
    return client.respondApproval(request.value as ApprovalResponse);
  if (request.method === "question")
    return client.respondQuestion(request.value as QuestionResponse);
  if (request.method === "runtime.availability")
    return describeRuntimeCapabilities(client, {
      name: "worker",
      routedMembers: WORKER_ROUTED_MEMBERS,
    });
  if (request.method === "command.catalog")
    return await client.commandCatalog?.(
      request.value as { workspaceID?: string } | undefined,
    );
  if (request.method === "command.execute")
    return await client.commandExecute?.(request.value as never);
  if (request.method === "session.subagents")
    return await client.subagents?.(
      (request.value as { sessionID?: string } | undefined)?.sessionID,
    );
  if (request.method === "subagent.history")
    return await client.subagentHistory?.(request.value as string | undefined);
  if (request.method === "subagent.history.page")
    return await client.subagentHistoryPage?.(request.value as never);
  if (request.method === "attachment.upload")
    return await client.uploadAttachment?.(request.value as never);
  if (request.method === "attachment.dataUrl")
    return await client.attachmentDataUrl?.(request.value as never);
  throw new Error(`worker channel does not route ${request.method}`);
}
