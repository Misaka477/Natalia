/**
 * Server side of the runtime RPC protocol: it decides what a failure *is*.
 *
 * Every failure here used to collapse into `-32602` with a message, which told a
 * remote consumer nothing it could act on. Now each failure leaves as one of five
 * kinds (`@anthelia/contracts` `failures.ts`), classified from typed errors rather
 * than from message text:
 *
 *   - a name with no route            -> `-32601`, with the method
 *   - a route whose member is absent  -> `-32000`, with the member and its capability
 *   - bad arguments                   -> `-32602`, and only that
 *   - policy or state says no         -> `-32001`, with a reason
 *   - anything else                   -> `-32603`, with an ID and no detail
 *
 * The last one is deliberate: an unclassified error's message can contain an
 * absolute path, a command line or a secret, so it is replaced with an ID and the
 * detail is published as a durable diagnostic. A caller authorized to read
 * diagnostics can still get it from `diagnostics.list`; the RPC reply cannot leak
 * it to a caller who is not.
 */
import {
  RuntimeInvalidParams,
  RuntimeInvalidRequest,
  RuntimeMethodNotFound,
  RuntimeNotSupported,
  RuntimeRefusal,
  RUNTIME_RPC_ERROR_CODES,
  capabilityGroupOf,
  describeRuntimeCapabilities,
  runtimeFailureData,
} from "@anthelia/contracts";
import type { RuntimeClient, RuntimeFailureData } from "@anthelia/contracts";
import type { RPCRequest, RPCResponse } from "./rpc-client";

/**
 * Every param check in this file goes through here, so "the caller sent the wrong
 * thing" can never again be indistinguishable from "the runtime broke".
 */
function invalidParams(message: string): Error {
  return new RuntimeInvalidParams(message);
}

export function stringParam(
  params: Record<string, unknown> | undefined,
  name: string,
): string {
  const value = params?.[name];
  if (typeof value !== "string")
    throw invalidParams(`${name} must be a string`);
  return value;
}

/** A string array param, or undefined when absent (and a non-array is a
 * refusal rather than a coercion). */
function stringArrayParam(params: unknown, key: string): string[] | undefined {
  const record = (params ?? {}) as Record<string, unknown>;
  const raw = record[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string"))
    throw invalidParams(`invalid_parameter_value: ${key}`);
  return raw as string[];
}

function optionalStringParam(
  params: Record<string, unknown> | undefined,
  name: string,
) {
  const value = params?.[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw invalidParams(`${name} must be a string`);
  return value;
}

/** An optional integer parameter (a geometry), rejected when it is not one. */
function intParam(params: Record<string, unknown> | undefined, name: string) {
  const value = params?.[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value))
    throw invalidParams(`${name} must be an integer`);
  return value;
}

export function arrayParam(
  params: Record<string, unknown> | undefined,
  name: string,
): string[][] {
  const value = params?.[name];
  if (!Array.isArray(value) || !value.every((item) => Array.isArray(item)))
    throw invalidParams(`${name} must be an array of arrays`);
  return value.map((item) => item.map((entry) => String(entry)));
}

/** Members the contract marks optional, i.e. the ones a runtime may not have. */
type OptionalRuntimeMember = {
  [K in keyof RuntimeClient]-?: undefined extends RuntimeClient[K] ? K : never;
}[keyof RuntimeClient];

/**
 * The route exists but this runtime does not implement the member behind it.
 * That is `-32000 not supported`, never `-32602`: the caller's arguments were
 * fine and changing them will not help. The capability group travels with it so
 * a consumer can hide the whole group in one step.
 */
function requireMember<K extends OptionalRuntimeMember>(
  client: RuntimeClient,
  member: K,
): NonNullable<RuntimeClient[K]> {
  const value = client[member];
  if (typeof value !== "function")
    throw new RuntimeNotSupported(member, capabilityGroupOf(member));
  return value as NonNullable<RuntimeClient[K]>;
}

/** `requireMember` as a narrowing assertion, for the routes that call `client.x()`. */
function optionsGuard<K extends OptionalRuntimeMember>(
  client: RuntimeClient,
  member: K,
): asserts client is RuntimeClient & Required<Pick<RuntimeClient, K>> {
  requireMember(client, member);
}

/**
 * The route table: every JSON-RPC method this transport serves, and the
 * `RuntimeClient` member behind it. This is the single fact source for
 * per-channel reachability — the availability report intersects what the
 * runtime implements with this table, so "I can call it" is computed from the
 * dispatch code itself and cannot drift from it. A test scans this file and
 * fails when a route block appears without a row here, or a row has no block.
 */
export const RPC_ROUTE_MEMBERS = {
  prompt: "submit",
  "submit.andWait": "submitAndWait",
  cancel: "cancel",
  snapshot: "snapshot",
  "approval.respond": "respondApproval",
  "question.respond": "respondQuestion",
  "interactive.pending": "pendingInteractive",
  "interactive.respond": "respondInteractive",
  "session.history": "history",
  "feedback.record": "feedback",
  "daemon.drain": "drainForUpdate",
  "session.eventWindow": "eventWindow",
  "session.messages": "messages",
  pause: "pause",
  resume: "resume",
  "config.canReload": "canReloadConfig",
  "config.reload": "reloadConfig",
  "config.update": "updateConfig",
  "config.get": "configGet",
  "settings.get": "settingsGet",
  "settings.set": "settingsSet",
  "cache.response": "responseCache",
  "skill.setEnabled": "skillSetEnabled",
  "skill.remove": "skillRemove",
  "agent.list": "agents",
  "agent.select": "selectAgent",
  "model.catalog": "modelCatalog",
  "model.selection": "modelSelection",
  "model.select": "selectModel",
  "model.setDefault": "setDefaultModel",
  "model.reasoning": "reasoningEffort",
  "model.reasoning.set": "setReasoningEffort",
  "skills.list": "skills",
  "workspace.files": "workspaceFiles",
  "workspace.search": "workspaceSearch",
  "workspace.list": "workspaceList",
  "workspace.read": "workspaceRead",
  "resource.read": "resourceRead",
  "workspace.write": "workspaceWrite",
  "workspace.create": "workspaceCreate",
  "workspace.rename": "workspaceRename",
  "workspace.delete": "workspaceDelete",
  "workspace.writeConflicts": "workspaceWriteConflicts",
  "workspace.glob": "workspaceGlob",
  "workspace.roots": "workspaceRoots",
  "workspace.add": "workspaceAdd",
  "workspace.remove": "workspaceRemove",
  "workspace.activate": "workspaceActivate",
  "workspace.permission.get": "workspacePermissionGet",
  "workspace.permission.set": "workspacePermissionSet",
  "workspace.tool.get": "workspaceToolGet",
  "workspace.tool.set": "workspaceToolSet",
  "checkpoint.list": "checkpointList",
  "checkpoint.preview": "checkpointPreview",
  "checkpoint.rollback": "checkpointRollback",
  "checkpoint.rename": "checkpointRename",
  "checkpoint.listByKind": "checkpointListByKind",
  "audit.rounds": "auditRounds",
  "workspace.round.diff": "roundDiff",
  "sandbox.list": "sandboxList",
  "sandbox.diff": "sandboxDiff",
  "sandbox.resources": "sandboxResources",
  "sandbox.resource.output": "sandboxResourceOutput",
  "sandbox.merge": "sandboxMerge",
  "sandbox.delete": "sandboxDelete",
  "sandbox.rollback": "sandboxRollback",
  "sandbox.resource.stop": "sandboxResourceStop",
  "session.list": "sessionList",
  "session.touch": "sessionTouch",
  "session.rename": "sessionRename",
  "session.pin": "sessionPin",
  "session.duplicate": "sessionDuplicate",
  "session.fork": "sessionFork",
  "session.rollback.messages": "sessionRollbackMessages",
  "session.delete": "sessionDelete",
  "session.new": "sessionNew",
  "session.archive": "sessionArchive",
  "session.restore": "sessionRestore",
  "session.export": "sessionExport",
  "session.attach": "sessionAttach",
  "mcp.catalog": "mcpCatalog",
  "mcp.prompt": "getMcpPrompt",
  "mcp.resource": "readMcpResource",
  "mcp.server.add": "mcpServerAdd",
  "mcp.server.remove": "mcpServerRemove",
  "permission.list": "permissionList",
  "permission.save": "permissionSave",
  "permission.delete": "permissionDelete",
  "agent.create": "agentCreate",
  "agent.update": "agentUpdate",
  "agent.delete": "agentDelete",
  "provider.discover": "providerDiscover",
  "provider.add": "providerAdd",
  "provider.remove": "providerRemove",
  "plugin.unload": "pluginUnload",
  "plugin.reload": "pluginReload",
  "plugin.install": "pluginInstall",
  "plugin.uninstall": "pluginUninstall",
  "plugin.set-enabled": "pluginSetEnabled",
  "plugin.catalog": "pluginCatalog",
  "tools.reload": "toolFamilyReload",
  "plugin.list": "plugins",
  "command.catalog": "commandCatalog",
  "command.execute": "commandExecute",
  "runtime.availability": null,
  "runtime.status": "runtimeStatus",
  "diagnostics.list": "diagnostics",
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
  "workgraph.nodes": "workGraphNodes",
  "workgraph.edges": "workGraphEdges",
  // --- P0-C: the reachability gap closed (audit list in the API plan §8.10) ---
  "nativeTerminal.list": "nativeTerminalList",
  "nativeTerminal.read": "nativeTerminalRead",
  "nativeTerminal.stop": "nativeTerminalStop",
  "nativeTerminal.openHub": "nativeTerminalOpenHub",
  "nativeTerminal.claimHumanInput": "nativeTerminalClaimHumanInput",
  "nativeTerminal.revokeApprovalScope": "nativeTerminalRevokeApprovalScope",
  "nativeTerminal.releaseHumanControl": "nativeTerminalReleaseHumanControl",
  "nativeTerminal.beginSecureInput": "nativeTerminalBeginSecureInput",
  "nativeTerminal.endSecureInput": "nativeTerminalEndSecureInput",
  "nativeTerminal.start": "nativeTerminalStart",
  "nativeTerminal.write": "nativeTerminalWrite",
  "nativeTerminal.resize": "nativeTerminalResize",
  "constitution.rules": "constitutionRules",
  "constitution.overrides": "constitutionOverrides",
  "constitution.rule.update": "updateConstitutionRule",
  "constitution.rule.create": "createConstitutionRule",
  "constitution.rule.remove": "removeConstitutionRule",
  "constitution.docRules": "constitutionDocRules",
  "constitution.docRule.promote": "promoteConstitutionDocRule",
  "constitution.docRule.update": "updateConstitutionDocRule",
  "context.notices": "notices",
  "decision.records": "decisionRecords",
  "decision.record": "recordDecision",
  "evidence.records": "evidenceRecords",
  "evidence.record": "recordValidation",
  "completion.records": "completions",
  "completion.human_validation": "recordHumanValidation",
  "plan.task.states": "planTaskStates",
  "workgraph.integrity": "workGraphIntegrity",
  "workgraph.unattributed": "unattributedChanges",
  "completion.record": "recordCompletion",
  "drift.findings": "driftFindings",
  "drift.evaluate": "evaluateDrift",
  "drift.acknowledge": "acknowledgeDriftFinding",
  "drift.reopen": "reopenDriftFinding",
  "observation.confirmed": "confirmedWorkspaceChanges",
  "workspace.diff": "workspaceDiff",
  "workspace.git.diff": "workspaceGitDiff",
  "ast.diff": "astDiff",
  "ast.diff.batch": "astDiffBatch",
  "ast.refactor.preview": "astRefactorPreview",
  "ast.service": "astService",
  "ast.refactor.plan": "astRefactorPlan",
  "ast.refactor.apply": "astApplyRefactor",
  "git.refs": "gitRefs",
  "team.pr.list": "teamPRList",
  "tools.registered": "registeredTools",
  "constitution.override.request": "requestOverride",
  "constitution.override.approve": "approveOverride",
  "projections.list": "projectionContributions",
  // P8 C3: durable Live Work Chat mailbox.
  "mailbox.list": "mailboxList",
  "mailbox.send": "mailboxSend",
  "mailbox.deliver": "mailboxDeliver",
  "mailbox.acknowledge": "mailboxAcknowledge",
  "mailbox.defer": "mailboxDefer",
  "mailbox.supersede": "mailboxSupersede",
  // Lightweight Markdown plan document registry (replaces P8 C4).
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
  "goal.control": "goalControl",
  "goal.edit": "goalEdit",
  capabilities: "capabilities",
  "session.snapshot": "sessionSnapshot",
  "session.subagents": "subagents",
  "subagent.history": "subagentHistory",
  "subagent.history.page": "subagentHistoryPage",
  "attachment.upload": "uploadAttachment",
  "attachment.dataUrl": "attachmentDataUrl",
  "submit.input": "submitInput",
  "input.remove": "removeInput",
  "input.replace": "replaceInput",
  "input.promote": "promoteInput",
  // P8 C2: the always-available Live Work Chat conversation (read + rollback).
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
  // P0-G: the flow write surface, previously CLI-only.
} as const satisfies Readonly<Record<string, keyof RuntimeClient | null>>;

/**
 * Members a remote caller must not reach, and why. These are routed *away* on
 * purpose: a member here is reported as `implemented_unreachable` with this
 * reason, so the availability report distinguishes "forgotten" from
 * "intentionally local" — the P0-C invariant is that every unreachable member
 * has a row in this table or does not exist on the runtime.
 */
export const RPC_INTENTIONALLY_LOCAL: Readonly<Record<string, string>> = {
  dispose:
    "intentionally local: a remote caller must not dispose another party's runtime",
  start:
    "intentionally local: remote consumers subscribe to /events instead of calling start",
  lastSubmission:
    "intentionally local: a local read of the most recent submission",
  diagnostic:
    "intentionally local: one-way publishing from a local caller, not a query",
};

/** The member names this transport routes. `null` rows (availability itself) excluded. */
export const RPC_ROUTED_MEMBERS: ReadonlySet<string> = new Set(
  (Object.values(RPC_ROUTE_MEMBERS) as Array<string | null>).filter(
    (member): member is string => typeof member === "string",
  ),
);

/**
 * The write surface, as route names. A credential without the `write`
 * dimension may call anything not on this list and nothing on it. The list is
 * code and is pinned by a test: removing an entry makes a write reachable by a
 * read-only credential, which fails.
 *
 * The xterm-era terminal writes are gone with the line that hosted them; the
 * live write surface is submissions, turn control, approvals, config,
 * checkpoints, sandboxes, session management and the native terminal controls
 * (whose security note from P0-C still stands: ending a human's secure input
 * remotely is a write of the strongest kind).
 */
export const RPC_WRITE_METHODS: ReadonlySet<string> = new Set([
  "prompt",
  "submit.andWait",
  "cancel",
  "submit.input",
  "input.remove",
  "input.replace",
  "input.promote",
  "approval.respond",
  "question.respond",
  "interactive.respond",
  "pause",
  "resume",
  "agent.select",
  "model.select",
  "model.setDefault",
  "model.reasoning.set",
  "config.reload",
  "config.update",
  "settings.set",
  // Both faces: the same route reads (no params) and flips (`enabled`), so
  // it is a write for a read-only credential.
  "cache.response",
  "skill.setEnabled",
  "skill.remove",
  // growth.propose journals the proposal fact (proposals are records).
  "growth.propose",
  // eval.external_run journals the join fact.
  "eval.external_run",
  "checkpoint.rollback",
  "checkpoint.rename",
  "sandbox.merge",
  "sandbox.delete",
  "sandbox.rollback",
  "sandbox.resource.stop",
  "session.touch",
  "session.rename",
  "session.pin",
  "session.duplicate",
  "session.fork",
  "session.rollback.messages",
  "session.delete",
  "session.new",
  "session.archive",
  "session.restore",
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
  "nativeTerminal.revokeApprovalScope",
  "nativeTerminal.releaseHumanControl",
  "nativeTerminal.beginSecureInput",
  "nativeTerminal.endSecureInput",
  "nativeTerminal.openHub",
  "nativeTerminal.start",
  "nativeTerminal.write",
  "nativeTerminal.resize",
  "flow.save",
  "flow.delete",
  "task.save",
  "task.delete",
  "task.schedule",
  "task.unschedule",
  "flow.install-examples",
  "ast.refactor.apply",
  "planDoc.activate",
  "planDoc.deactivate",
  "goal.control",
  "goal.edit",
]);

/**
 * Who is calling, resolved by the transport from the credential. Absent means
 * an unrestricted in-process caller (or an explicitly opened server).
 */
export type RuntimeAuthorizationContext = {
  /** May the caller use the write surface? */
  write: boolean;
  /** Capability groups the caller may reach; absent = every group. */
  groups?: ReadonlySet<string>;
  /** Sessions the caller may subscribe events for; absent = unrestricted. */
  sessions?: ReadonlySet<string>;
};

/**
 * The sessions a credential may see events for. Undefined means unrestricted.
 */
export function credentialSessions(
  context: RuntimeAuthorizationContext | undefined,
): ReadonlySet<string> | undefined {
  return context?.sessions;
}

/**
 * Whether a route is inside the caller's grant. Checked before the route
 * table, so a credential that cannot call a method gets `-32001 refused`
 * whether or not the method exists — an authorization error must not double
 * as an existence probe.
 */
export function isAuthorized(
  context: RuntimeAuthorizationContext | undefined,
  method: string,
): boolean {
  if (!context) return true;
  if (!context.write && RPC_WRITE_METHODS.has(method)) return false;
  if (context.groups) {
    const member = (RPC_ROUTE_MEMBERS as Record<string, string | null>)[method];
    const group =
      typeof member === "string" ? capabilityGroupOf(member) : undefined;
    if (group && !context.groups.has(group)) return false;
  }
  return true;
}

/**
 * The reason a granted-but-denied call should carry. Kept separate from
 * `isAuthorized` so the refusal path can name the rule that fired.
 */
export function authorizationRefusalReason(
  context: RuntimeAuthorizationContext,
  method: string,
): string {
  if (!context.write && RPC_WRITE_METHODS.has(method))
    return "authorization refused: this credential has no write scope";
  const member = (RPC_ROUTE_MEMBERS as Record<string, string | null>)[method];
  const group =
    typeof member === "string" ? capabilityGroupOf(member) : undefined;
  if (group && context.groups && !context.groups.has(group))
    return `authorization refused: this credential has no access to the ${group} group`;
  return "authorization refused";
}

/**
 * A report the caller can act on: reachable members outside the credential's
 * grant are marked unreachable with an authorization reason, never with "not
 * implemented". The report must not over-promise to a read-only integration —
 * the same mistake G2 made, at a different layer.
 */
export function cullAvailabilityReport(
  report: import("@anthelia/contracts").RuntimeCapabilityReport,
  authorization: RuntimeAuthorizationContext | undefined,
): import("@anthelia/contracts").RuntimeCapabilityReport {
  if (!authorization || !report.channel) return report;
  const cullMember = (
    member: import("@anthelia/contracts").ChannelCapabilityMember,
  ) => {
    if (member.state !== "implemented_reachable") return member;
    const method = Object.keys(RPC_ROUTE_MEMBERS).find(
      (name) =>
        (RPC_ROUTE_MEMBERS as Record<string, string | null>)[name] ===
        member.member,
    );
    if (!method) return member;
    if (!isAuthorized(authorization, method))
      return {
        ...member,
        state: "implemented_unreachable" as const,
        reason: authorizationRefusalReason(authorization, method),
      };
    return member;
  };
  return {
    ...report,
    channel: {
      ...report.channel,
      groups: report.channel.groups.map((group) => {
        const members = group.members.map(cullMember);
        const reachable = members.every(
          (member) => member.state === "implemented_reachable",
        );
        const unreachableCount = members.filter(
          (member) => member.state === "implemented_unreachable",
        ).length;
        return {
          ...group,
          members,
          reachable,
          partial: unreachableCount > 0 && unreachableCount < members.length,
        };
      }),
      requiredMembers: report.channel.requiredMembers.map(cullMember),
    },
  };
}

export async function handleRPCMessage(
  raw: unknown,
  client: RuntimeClient,
  signal?: AbortSignal,
  authorization?: RuntimeAuthorizationContext,
): Promise<RPCResponse> {
  const request =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as RPCRequest)
      : undefined;
  try {
    if (!request) throw new RuntimeInvalidRequest();
    const body = request;
    // Authorization before existence: a credential outside its grant gets
    // `-32001 refused` whether or not the method exists, so an authorization
    // error can never be used to probe the surface.
    if (body.method && !isAuthorized(authorization, body.method))
      throw new RuntimeRefusal(
        authorizationRefusalReason(authorization!, body.method),
      );
    // The route table is the authority for what a method is: a name with no row
    // here is `-32601 method not found`, before any dispatch block runs. The
    // table also feeds the availability report, so reachability is computed from
    // the same fact.
    if (!(body.method && body.method in RPC_ROUTE_MEMBERS))
      throw new RuntimeMethodNotFound(body.method ?? "");
    if (request.method === "prompt") {
      const text = request.params?.text;
      if (typeof text !== "string")
        throw invalidParams("prompt.params.text must be a string");
      const rawDelivery = request.params?.delivery;
      if (
        rawDelivery !== undefined &&
        rawDelivery !== "next-turn" &&
        rawDelivery !== "next-step" &&
        rawDelivery !== "steer" &&
        rawDelivery !== "queue"
      )
        throw invalidParams(
          "prompt.params.delivery must be next-turn or next-step",
        );
      // Legacy `steer`/`queue` both meant "a separate turn"; only `next-step`
      // injects into the running turn.
      const delivery =
        rawDelivery === undefined
          ? undefined
          : rawDelivery === "next-step"
            ? ("next-step" as const)
            : ("next-turn" as const);
      const attachments = request.params?.attachments;
      if (
        attachments !== undefined &&
        (!Array.isArray(attachments) ||
          !attachments.every((attachment) => typeof attachment === "string"))
      )
        throw invalidParams(
          "prompt.params.attachments must be an array of strings",
        );
      const resources = request.params?.resources;
      if (
        resources !== undefined &&
        (!Array.isArray(resources) ||
          !resources.every(
            (resource) =>
              resource &&
              typeof resource === "object" &&
              typeof (resource as Record<string, unknown>).server ===
                "string" &&
              typeof (resource as Record<string, unknown>).uri === "string" &&
              typeof (resource as Record<string, unknown>).name === "string",
          ))
      )
        throw invalidParams(
          "prompt.params.resources must be resource mentions",
        );
      const agents = request.params?.agents;
      if (
        agents !== undefined &&
        (!Array.isArray(agents) ||
          !agents.every(
            (agent) =>
              agent &&
              typeof agent === "object" &&
              typeof (agent as Record<string, unknown>).name === "string",
          ))
      )
        throw invalidParams("prompt.params.agents must be agent mentions");
      const sessionID = request.params?.sessionID;
      if (sessionID !== undefined && typeof sessionID !== "string")
        throw invalidParams("prompt.params.sessionID must be a string");
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: client.submitInput
          ? await client.submitInput({
              text,
              delivery,
              attachments: attachments as string[] | undefined,
              resources: resources as
                | import("@anthelia/contracts").PromptResourceMention[]
                | undefined,
              agents: agents as
                | import("@anthelia/contracts").PromptAgentMention[]
                | undefined,
              ...(sessionID ? { sessionID } : {}),
            })
          : await client.submit(text, sessionID),
      };
    }
    if (request.method === "submit.andWait") {
      const text = request.params?.text;
      if (typeof text !== "string")
        throw invalidParams("submit.andWait.params.text must be a string");
      const sessionID = request.params?.sessionID;
      if (sessionID !== undefined && typeof sessionID !== "string")
        throw invalidParams("submit.andWait.params.sessionID must be a string");
      optionsGuard(client, "submitAndWait");
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: await client.submitAndWait(
          sessionID ? { text, sessionID } : text,
        ),
      };
    }
    if (request.method === "feedback.record") {
      const scope = request.params?.scope;
      if (scope !== "session" && scope !== "message")
        throw invalidParams(
          "feedback.record.params.scope must be session or message",
        );
      const sessionID = request.params?.sessionID;
      if (typeof sessionID !== "string" || !sessionID)
        throw invalidParams(
          "feedback.record.params.sessionID must be a non-empty string",
        );
      const verdict = request.params?.verdict;
      if (verdict !== "up" && verdict !== "down")
        throw invalidParams(
          "feedback.record.params.verdict must be up or down",
        );
      const messageID = request.params?.messageID;
      if (scope === "message" && (typeof messageID !== "string" || !messageID))
        throw invalidParams(
          "feedback.record.params.messageID required for message scope",
        );
      const category = request.params?.category;
      if (category !== undefined && typeof category !== "string")
        throw invalidParams("feedback.record.params.category must be a string");
      const note = request.params?.note;
      if (note !== undefined && typeof note !== "string")
        throw invalidParams("feedback.record.params.note must be a string");
      optionsGuard(client, "feedback");
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: await client.feedback({
          scope,
          sessionID,
          verdict,
          ...(messageID !== undefined
            ? { messageID: messageID as string }
            : {}),
          ...(category !== undefined ? { category: category as string } : {}),
          ...(note !== undefined ? { note: note as string } : {}),
        }),
      };
    }
    if (request.method === "daemon.drain") {
      const timeoutMs = request.params?.timeoutMs;
      if (timeoutMs !== undefined && typeof timeoutMs !== "number")
        throw invalidParams("daemon.drain.params.timeoutMs must be a number");
      optionsGuard(client, "drainForUpdate");
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: await client.drainForUpdate?.(
          timeoutMs === undefined ? undefined : { timeoutMs },
        ),
      };
    }
    if (request.method === "cancel") {
      client.cancel(
        typeof request.params?.reason === "string"
          ? request.params.reason
          : undefined,
        typeof request.params?.sessionID === "string"
          ? request.params.sessionID
          : undefined,
      );
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: { cancelled: true },
      };
    }
    if (body.method === "pause") {
      optionsGuard(client, "pause");
      // The runtime's answer, not an assumption. This route used to reply
      // `paused: true` even when nothing was running and the runtime had done
      // nothing at all.
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.pause(
          typeof body.params?.reason === "string"
            ? body.params.reason
            : undefined,
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "resume") {
      optionsGuard(client, "resume");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.resume?.(
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "agent.select") {
      optionsGuard(client, "selectAgent");
      const name = body.params?.name;
      if (name !== undefined && typeof name !== "string")
        throw invalidParams("agent.select.params.name must be a string");
      // Reports whether the selection applied, was deferred to the end of the
      // running turn, or was rejected — all three happen, and the old reply
      // claimed the first one every time.
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.selectAgent(
          name,
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "agent.list") {
      optionsGuard(client, "agents");
      const workspaceID = optionalStringParam(body.params, "workspaceID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.agents(workspaceID ? { workspaceID } : undefined),
      };
    }
    if (body.method === "model.catalog") {
      optionsGuard(client, "modelCatalog");
      const workspaceID = optionalStringParam(body.params, "workspaceID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.modelCatalog(
          workspaceID ? { workspaceID } : undefined,
        ),
      };
    }
    if (body.method === "model.selection") {
      optionsGuard(client, "modelSelection");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.modelSelection(
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "model.select") {
      optionsGuard(client, "selectModel");
      const modelID = body.params?.modelID;
      const variant = body.params?.variant;
      if (modelID !== undefined && typeof modelID !== "string")
        throw invalidParams("model.select.params.modelID must be a string");
      if (variant !== undefined && typeof variant !== "string")
        throw invalidParams("model.select.params.variant must be a string");
      await client.selectModel(
        modelID,
        variant,
        optionalStringParam(body.params, "sessionID"),
      );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: { modelID: modelID ?? null, variant: variant ?? null },
      };
    }
    if (body.method === "model.setDefault") {
      optionsGuard(client, "setDefaultModel");
      const modelID = body.params?.modelID;
      if (typeof modelID !== "string")
        throw invalidParams("model.setDefault.params.modelID must be a string");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.setDefaultModel?.(modelID),
      };
    }
    if (body.method === "model.reasoning") {
      optionsGuard(client, "reasoningEffort");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result:
          (await client.reasoningEffort(
            optionalStringParam(body.params, "sessionID"),
          )) ?? null,
      };
    }
    if (body.method === "model.reasoning.set") {
      optionsGuard(client, "setReasoningEffort");
      const effort = body.params?.effort;
      if (
        effort !== undefined &&
        !["minimal", "low", "medium", "high", "xhigh"].includes(String(effort))
      )
        throw invalidParams(
          "model.reasoning.set.params.effort must be minimal, low, medium, high, or xhigh",
        );
      await client.setReasoningEffort(
        effort as "minimal" | "low" | "medium" | "high" | "xhigh" | undefined,
        optionalStringParam(body.params, "sessionID"),
      );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: { effort: effort ?? null },
      };
    }
    if (body.method === "skills.list") {
      optionsGuard(client, "skills");
      const workspaceID = optionalStringParam(body.params, "workspaceID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.skills(workspaceID ? { workspaceID } : undefined),
      };
    }
    if (body.method === "workspace.files") {
      optionsGuard(client, "workspaceFiles");
      const query = body.params?.query;
      const type = body.params?.type;
      const limit = body.params?.limit;
      if (query !== undefined && typeof query !== "string")
        throw invalidParams("workspace.files.params.query must be a string");
      if (type !== undefined && type !== "file" && type !== "directory")
        throw invalidParams(
          "workspace.files.params.type must be file or directory",
        );
      if (
        limit !== undefined &&
        (typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 200)
      )
        throw invalidParams(
          "workspace.files.params.limit must be an integer between 1 and 200",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workspaceFiles({
          query: typeof query === "string" ? query : undefined,
          type: type as "file" | "directory" | undefined,
          limit: typeof limit === "number" ? limit : undefined,
        }),
      };
    }
    if (body.method === "workspace.search") {
      optionsGuard(client, "workspaceSearch");
      const query = stringParam(body.params, "query");
      const include = body.params?.include;
      const limit = body.params?.limit;
      if (include !== undefined && typeof include !== "string")
        throw invalidParams("workspace.search.params.include must be a string");
      if (
        limit !== undefined &&
        (typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 200)
      )
        throw invalidParams(
          "workspace.search.params.limit must be an integer between 1 and 200",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workspaceSearch({
          query,
          include: typeof include === "string" ? include : undefined,
          limit: typeof limit === "number" ? limit : undefined,
        }),
      };
    }
    if (body.method === "workspace.list") {
      optionsGuard(client, "workspaceList");
      const path = body.params?.path;
      const offset = body.params?.offset;
      const limit = body.params?.limit;
      if (path !== undefined && typeof path !== "string")
        throw invalidParams("workspace.list.params.path must be a string");
      if (
        offset !== undefined &&
        (typeof offset !== "number" || !Number.isInteger(offset) || offset < 1)
      )
        throw invalidParams(
          "workspace.list.params.offset must be a positive integer",
        );
      if (
        limit !== undefined &&
        (typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 200)
      )
        throw invalidParams(
          "workspace.list.params.limit must be an integer between 1 and 200",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workspaceList({
          path: typeof path === "string" ? path : undefined,
          offset: typeof offset === "number" ? offset : undefined,
          limit: typeof limit === "number" ? limit : undefined,
        }),
      };
    }
    if (body.method === "workspace.read") {
      optionsGuard(client, "workspaceRead");
      const offset = body.params?.offset;
      const limit = body.params?.limit;
      if (
        offset !== undefined &&
        (typeof offset !== "number" || !Number.isInteger(offset) || offset < 1)
      )
        throw invalidParams(
          "workspace.read.params.offset must be a positive integer",
        );
      if (
        limit !== undefined &&
        (typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 2000)
      )
        throw invalidParams(
          "workspace.read.params.limit must be an integer between 1 and 2000",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workspaceRead({
          path: stringParam(body.params, "path"),
          offset: typeof offset === "number" ? offset : undefined,
          limit: typeof limit === "number" ? limit : undefined,
        }),
      };
    }
    if (body.method === "resource.read") {
      optionsGuard(client, "resourceRead");
      const resource = stringParam(body.params, "resource");
      const rawParams = body.params?.params;
      if (
        rawParams !== undefined &&
        (!rawParams ||
          typeof rawParams !== "object" ||
          Array.isArray(rawParams))
      )
        throw invalidParams("resource.read.params.params must be an object");
      const params = rawParams
        ? Object.fromEntries(
            Object.entries(rawParams).map(([key, value]) => {
              if (typeof value !== "string")
                throw invalidParams(
                  "resource.read.params.params values must be strings",
                );
              return [key, value];
            }),
          )
        : undefined;
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.resourceRead({
          resource,
          ...(params ? { params } : {}),
          ...(optionalStringParam(body.params, "reader")
            ? { reader: optionalStringParam(body.params, "reader")! }
            : {}),
        }),
      };
    }
    if (body.method === "workspace.write") {
      optionsGuard(client, "workspaceWrite");
      const params = body.params;
      if (!params || typeof params !== "object")
        throw invalidParams("workspace.write.params must be an object");
      const path = (params as { path?: unknown }).path;
      const content = (params as { content?: unknown }).content;
      if (typeof path !== "string")
        throw invalidParams("workspace.write.params.path must be a string");
      if (typeof content !== "string")
        throw invalidParams("workspace.write.params.content must be a string");
      const encoding = (params as { encoding?: unknown }).encoding;
      if (
        encoding !== undefined &&
        encoding !== "utf8" &&
        encoding !== "base64"
      )
        throw invalidParams(
          "workspace.write.params.encoding must be utf8 or base64",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workspaceWrite?.({
          path,
          content,
          ...(encoding ? { encoding: encoding as "utf8" | "base64" } : {}),
        }),
      };
    }
    if (body.method === "workspace.create") {
      optionsGuard(client, "workspaceCreate");
      const params = body.params;
      if (!params || typeof params !== "object")
        throw invalidParams("workspace.create.params must be an object");
      const path = (params as { path?: unknown }).path;
      if (typeof path !== "string")
        throw invalidParams("workspace.create.params.path must be a string");
      const content = (params as { content?: unknown }).content;
      if (content !== undefined && typeof content !== "string")
        throw invalidParams("workspace.create.params.content must be a string");
      const directory = (params as { directory?: unknown }).directory;
      if (directory !== undefined && typeof directory !== "boolean")
        throw invalidParams(
          "workspace.create.params.directory must be a boolean",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workspaceCreate?.({
          path,
          ...(typeof content === "string" ? { content } : {}),
          ...(typeof directory === "boolean" ? { directory } : {}),
        }),
      };
    }
    if (body.method === "workspace.rename") {
      optionsGuard(client, "workspaceRename");
      const params = body.params;
      if (!params || typeof params !== "object")
        throw invalidParams("workspace.rename.params must be an object");
      const path = (params as { path?: unknown }).path;
      const newPath = (params as { newPath?: unknown }).newPath;
      if (typeof path !== "string")
        throw invalidParams("workspace.rename.params.path must be a string");
      if (typeof newPath !== "string")
        throw invalidParams("workspace.rename.params.newPath must be a string");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workspaceRename?.({
          path,
          newPath,
        }),
      };
    }
    if (body.method === "workspace.delete") {
      optionsGuard(client, "workspaceDelete");
      const params = body.params;
      if (!params || typeof params !== "object")
        throw invalidParams("workspace.delete.params must be an object");
      const path = (params as { path?: unknown }).path;
      if (typeof path !== "string")
        throw invalidParams("workspace.delete.params.path must be a string");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workspaceDelete?.({
          path,
        }),
      };
    }
    if (body.method === "workspace.writeConflicts") {
      optionsGuard(client, "workspaceWriteConflicts");
      const workspaceID = optionalStringParam(body.params, "workspaceID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result:
          (await client.workspaceWriteConflicts?.(
            workspaceID ? { workspaceID } : undefined,
          )) ?? [],
      };
    }
    if (body.method === "workspace.glob") {
      optionsGuard(client, "workspaceGlob");
      const path = body.params?.path;
      const limit = body.params?.limit;
      if (path !== undefined && typeof path !== "string")
        throw invalidParams("workspace.glob.params.path must be a string");
      if (
        limit !== undefined &&
        (typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 200)
      )
        throw invalidParams(
          "workspace.glob.params.limit must be an integer between 1 and 200",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workspaceGlob({
          pattern: stringParam(body.params, "pattern"),
          path: typeof path === "string" ? path : undefined,
          limit: typeof limit === "number" ? limit : undefined,
        }),
      };
    }
    if (body.method === "workspace.roots") {
      optionsGuard(client, "workspaceRoots");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workspaceRoots?.(),
      };
    }
    if (body.method === "workspace.add") {
      optionsGuard(client, "workspaceAdd");
      const path = stringParam(body.params, "path");
      const title = optionalStringParam(body.params, "title");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workspaceAdd?.({
          path,
          ...(title !== undefined ? { title } : {}),
        }),
      };
    }
    if (body.method === "workspace.remove") {
      optionsGuard(client, "workspaceRemove");
      const workspaceID = stringParam(body.params, "workspaceID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workspaceRemove?.(workspaceID),
      };
    }
    if (body.method === "workspace.activate") {
      optionsGuard(client, "workspaceActivate");
      const workspaceID = stringParam(body.params, "workspaceID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workspaceActivate?.(workspaceID),
      };
    }

    if (body.method === "workspace.permission.get") {
      optionsGuard(client, "workspacePermissionGet");
      const workspaceID = stringParam(body.params, "workspaceID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workspacePermissionGet?.(workspaceID),
      };
    }
    if (body.method === "workspace.permission.set") {
      optionsGuard(client, "workspacePermissionSet");
      const workspaceID = stringParam(body.params, "workspaceID");
      if (
        !body.params ||
        typeof body.params.settings !== "object" ||
        body.params.settings === null
      )
        throw invalidParams(
          "workspace.permission.set.params.settings must be an object",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workspacePermissionSet?.(
          workspaceID,
          body.params.settings as never,
        ),
      };
    }
    if (body.method === "workspace.tool.get") {
      optionsGuard(client, "workspaceToolGet");
      const workspaceID = stringParam(body.params, "workspaceID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workspaceToolGet?.(workspaceID),
      };
    }
    if (body.method === "workspace.tool.set") {
      optionsGuard(client, "workspaceToolSet");
      const workspaceID = stringParam(body.params, "workspaceID");
      if (
        !body.params ||
        typeof body.params.settings !== "object" ||
        body.params.settings === null
      )
        throw invalidParams(
          "workspace.tool.set.params.settings must be an object",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workspaceToolSet?.(
          workspaceID,
          body.params.settings as never,
        ),
      };
    }

    if (body.method === "checkpoint.list") {
      optionsGuard(client, "checkpointList");
      const sessionID = optionalStringParam(body.params, "sessionID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.checkpointList?.(sessionID),
      };
    }
    if (body.method === "checkpoint.preview") {
      optionsGuard(client, "checkpointPreview");
      const checkpointOptions = (
        body.params as
          | {
              options?: { includePatch?: boolean };
            }
          | undefined
      )?.options;
      const includePatch = checkpointOptions?.includePatch;
      if (includePatch !== undefined && typeof includePatch !== "boolean")
        throw invalidParams(
          "checkpoint.preview.params.options.includePatch must be a boolean",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.checkpointPreview(
          stringParam(body.params, "id"),
          optionalStringParam(body.params, "sessionID"),
          includePatch === undefined ? undefined : { includePatch },
        ),
      };
    }
    if (body.method === "checkpoint.rollback") {
      optionsGuard(client, "checkpointRollback");
      const dryRun = body.params?.dryRun;
      if (dryRun !== undefined && typeof dryRun !== "boolean")
        throw invalidParams(
          "checkpoint.rollback.params.dryRun must be a boolean",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.checkpointRollback({
          id: stringParam(body.params, "id"),
          dryRun: typeof dryRun === "boolean" ? dryRun : undefined,
          ...(optionalStringParam(body.params, "sessionID")
            ? { sessionID: optionalStringParam(body.params, "sessionID") }
            : {}),
        }),
      };
    }
    if (body.method === "checkpoint.rename") {
      optionsGuard(client, "checkpointRename");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.checkpointRename({
          id: stringParam(body.params, "id"),
          name: stringParam(body.params, "name"),
          ...(optionalStringParam(body.params, "sessionID")
            ? { sessionID: optionalStringParam(body.params, "sessionID") }
            : {}),
        }),
      };
    }
    if (body.method === "checkpoint.listByKind") {
      optionsGuard(client, "checkpointListByKind");
      const kind = optionalStringParam(body.params, "kind") as
        | "audit"
        | "manual"
        | "auto_safety"
        | "rollback_safety"
        | undefined;
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.checkpointListByKind?.(
          kind,
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "audit.rounds") {
      optionsGuard(client, "auditRounds");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.auditRounds?.(
          optionalStringParam(body.params, "planID"),
          optionalStringParam(body.params, "workspaceID"),
        ),
      };
    }
    if (body.method === "workspace.round.diff") {
      optionsGuard(client, "roundDiff");
      const input = body.params as
        | Parameters<NonNullable<RuntimeClient["roundDiff"]>>[0]
        | undefined;
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.roundDiff?.(input as never),
      };
    }
    if (body.method === "sandbox.list") {
      optionsGuard(client, "sandboxList");
      const sessionID = optionalStringParam(body.params, "sessionID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sandboxList?.(sessionID),
      };
    }
    if (body.method === "sandbox.diff") {
      optionsGuard(client, "sandboxDiff");
      const sandboxOptions = (
        body.params as
          | {
              options?: { includePatch?: boolean };
            }
          | undefined
      )?.options;
      const includePatch = sandboxOptions?.includePatch;
      if (includePatch !== undefined && typeof includePatch !== "boolean")
        throw invalidParams(
          "sandbox.diff.params.options.includePatch must be a boolean",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sandboxDiff?.(
          stringParam(body.params, "id"),
          optionalStringParam(body.params, "sessionID"),
          includePatch === undefined ? undefined : { includePatch },
        ),
      };
    }
    if (body.method === "sandbox.resources") {
      optionsGuard(client, "sandboxResources");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sandboxResources?.(
          stringParam(body.params, "id"),
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "sandbox.resource.output") {
      optionsGuard(client, "sandboxResourceOutput");
      const maxBytes = body.params?.maxBytes;
      if (
        maxBytes !== undefined &&
        (typeof maxBytes !== "number" ||
          !Number.isInteger(maxBytes) ||
          maxBytes < 1 ||
          maxBytes > 20000)
      )
        throw invalidParams(
          "sandbox.resource.output.params.maxBytes must be an integer between 1 and 20000",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sandboxResourceOutput({
          id: stringParam(body.params, "id"),
          resourceID: stringParam(body.params, "resourceID"),
          maxBytes: typeof maxBytes === "number" ? maxBytes : undefined,
          ...(optionalStringParam(body.params, "sessionID")
            ? { sessionID: optionalStringParam(body.params, "sessionID") }
            : {}),
        }),
      };
    }
    if (body.method === "sandbox.merge") {
      optionsGuard(client, "sandboxMerge");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sandboxMerge?.(
          stringParam(body.params, "id"),
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "sandbox.delete") {
      optionsGuard(client, "sandboxDelete");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sandboxDelete?.(
          stringParam(body.params, "id"),
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "sandbox.rollback") {
      optionsGuard(client, "sandboxRollback");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sandboxRollback?.(
          stringParam(body.params, "id"),
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "sandbox.resource.stop") {
      optionsGuard(client, "sandboxResourceStop");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sandboxResourceStop({
          id: stringParam(body.params, "id"),
          resourceID: stringParam(body.params, "resourceID"),
          ...(optionalStringParam(body.params, "sessionID")
            ? { sessionID: optionalStringParam(body.params, "sessionID") }
            : {}),
        }),
      };
    }
    if (body.method === "approval.respond") {
      const requestID = stringParam(body.params, "requestID");
      const decision = stringParam(body.params, "decision");
      if (!["once", "session", "reject"].includes(decision))
        throw invalidParams("approval.respond.params.decision is invalid");
      // An answer to a request that already timed out is dropped by the runtime,
      // and an external UI has to be told: it used to get `responded: true`.
      // Routing hints must survive the hop: without them the runtime falls back
      // to the attached session and can journal the answer to the wrong one.
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.respondApproval({
          requestID,
          decision: decision as "once" | "session" | "reject",
          feedback:
            typeof body.params?.feedback === "string"
              ? body.params.feedback
              : undefined,
          ...(optionalStringParam(body.params, "sessionID")
            ? { sessionID: optionalStringParam(body.params, "sessionID") }
            : {}),
          ...(optionalStringParam(body.params, "workspaceID")
            ? { workspaceID: optionalStringParam(body.params, "workspaceID") }
            : {}),
        }),
      };
    }
    if (body.method === "interactive.respond") {
      const params = body.params;
      if (!params || typeof params !== "object")
        throw invalidParams("interactive.respond.params must be an object");
      const record = params as Record<string, unknown>;
      if (typeof record.requestID !== "string" || !record.requestID)
        throw invalidParams(
          "interactive.respond.params.requestID must be a non-empty string",
        );
      if (typeof record.kind !== "string" || !record.kind)
        throw invalidParams(
          "interactive.respond.params.kind must be a non-empty string",
        );
      if (record.response === undefined)
        throw invalidParams("interactive.respond.params.response is required");
      if (
        record.sessionID !== undefined &&
        typeof record.sessionID !== "string"
      )
        throw invalidParams(
          "interactive.respond.params.sessionID must be a string",
        );
      optionsGuard(client, "respondInteractive");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.respondInteractive({
          requestID: record.requestID,
          kind: record.kind,
          response: record.response as never,
          ...(record.rejected === true ? { rejected: true } : {}),
          ...(record.sessionID
            ? { sessionID: record.sessionID as string }
            : {}),
        }),
      };
    }
    if (body.method === "question.respond") {
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.respondQuestion({
          requestID: stringParam(body.params, "requestID"),
          answers: arrayParam(body.params, "answers"),
          rejected: Boolean(body.params?.rejected),
          ...(optionalStringParam(body.params, "sessionID")
            ? { sessionID: optionalStringParam(body.params, "sessionID") }
            : {}),
          ...(optionalStringParam(body.params, "workspaceID")
            ? { workspaceID: optionalStringParam(body.params, "workspaceID") }
            : {}),
        }),
      };
    }
    if (body.method === "interactive.pending") {
      optionsGuard(client, "pendingInteractive");
      const sessionID = optionalStringParam(body.params, "sessionID");
      const workspaceID = optionalStringParam(body.params, "workspaceID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.pendingInteractive({
          ...(sessionID ? { sessionID } : {}),
          ...(workspaceID ? { workspaceID } : {}),
        }),
      };
    }
    if (body.method === "snapshot")
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: client.snapshot(),
      };
    if (body.method === "session.history") {
      optionsGuard(client, "history");
      const sessionID = optionalStringParam(body.params, "sessionID");
      const after = body.params?.after;
      const offset = body.params?.offset;
      const limit = body.params?.limit;
      if (
        after !== undefined &&
        (typeof after !== "number" || !Number.isInteger(after) || after < 0)
      )
        throw invalidParams(
          "session.history.params.after must be a non-negative integer",
        );
      if (
        offset !== undefined &&
        (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
      )
        throw invalidParams(
          "session.history.params.offset must be a non-negative integer",
        );
      if (
        limit !== undefined &&
        (typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 2000)
      )
        throw invalidParams(
          "session.history.params.limit must be an integer between 1 and 2000",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.history({
          sessionID,
          after: typeof after === "number" ? after : undefined,
          offset: typeof offset === "number" ? offset : undefined,
          limit: typeof limit === "number" ? limit : undefined,
        }),
      };
    }
    if (body.method === "session.eventWindow") {
      optionsGuard(client, "eventWindow");
      const sessionID = optionalStringParam(body.params, "sessionID");
      const beforeSeq = body.params?.beforeSeq;
      const limit = body.params?.limit;
      if (
        beforeSeq !== undefined &&
        (typeof beforeSeq !== "number" ||
          !Number.isInteger(beforeSeq) ||
          beforeSeq < 1)
      )
        throw invalidParams(
          "session.eventWindow.params.beforeSeq must be a positive integer",
        );
      if (
        limit !== undefined &&
        (typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 2000)
      )
        throw invalidParams(
          "session.eventWindow.params.limit must be an integer between 1 and 2000",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.eventWindow({
          sessionID,
          beforeSeq: typeof beforeSeq === "number" ? beforeSeq : undefined,
          limit: typeof limit === "number" ? limit : undefined,
        }),
      };
    }
    if (body.method === "session.messages") {
      optionsGuard(client, "messages");
      const sessionID = optionalStringParam(body.params, "sessionID");
      const limit = body.params?.limit;
      const order = body.params?.order;
      const cursor = body.params?.cursor;
      if (
        limit !== undefined &&
        (typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 200)
      )
        throw invalidParams(
          "session.messages.params.limit must be an integer between 1 and 200",
        );
      if (order !== undefined && order !== "asc" && order !== "desc")
        throw invalidParams(
          "session.messages.params.order must be asc or desc",
        );
      if (cursor !== undefined && typeof cursor !== "string")
        throw invalidParams("session.messages.params.cursor must be a string");
      if (cursor !== undefined && order !== undefined)
        throw invalidParams(
          "session.messages.params.cursor cannot be combined with order",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.messages({
          sessionID,
          limit: typeof limit === "number" ? limit : undefined,
          order: order as "asc" | "desc" | undefined,
          cursor: typeof cursor === "string" ? cursor : undefined,
        }),
      };
    }
    if (body.method === "session.list") {
      optionsGuard(client, "sessionList");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sessionList(),
      };
    }
    if (body.method === "session.touch") {
      optionsGuard(client, "sessionTouch");
      await client.sessionTouch(stringParam(body.params, "id"));
      return { jsonrpc: "2.0", id: body.id ?? null, result: { touched: true } };
    }
    if (body.method === "session.rename") {
      optionsGuard(client, "sessionRename");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sessionRename(
          stringParam(body.params, "id"),
          stringParam(body.params, "title"),
        ),
      };
    }
    if (body.method === "session.pin") {
      optionsGuard(client, "sessionPin");
      if (typeof body.params?.pinned !== "boolean")
        throw invalidParams("session.pin.params.pinned must be a boolean");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sessionPin(
          stringParam(body.params, "id"),
          body.params.pinned,
        ),
      };
    }
    if (body.method === "session.duplicate") {
      optionsGuard(client, "sessionDuplicate");
      const title = body.params?.title;
      if (title !== undefined && typeof title !== "string")
        throw invalidParams("session.duplicate.params.title must be a string");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sessionDuplicate(
          stringParam(body.params, "id"),
          typeof title === "string" ? title : undefined,
        ),
      };
    }
    if (body.method === "session.fork") {
      optionsGuard(client, "sessionFork");
      const title = body.params?.title;
      if (title !== undefined && typeof title !== "string")
        throw invalidParams("session.fork.params.title must be a string");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sessionFork(
          stringParam(body.params, "id"),
          stringParam(body.params, "turnID"),
          typeof title === "string" ? title : undefined,
        ),
      };
    }
    if (body.method === "session.rollback.messages") {
      optionsGuard(client, "sessionRollbackMessages");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sessionRollbackMessages?.(
          stringParam(body.params, "id"),
          stringParam(body.params, "turnID"),
        ),
      };
    }
    if (body.method === "session.delete") {
      optionsGuard(client, "sessionDelete");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sessionDelete(stringParam(body.params, "id")),
      };
    }
    if (body.method === "session.new") {
      optionsGuard(client, "sessionNew");
      const params = body.params;
      const id =
        params &&
        typeof params === "object" &&
        typeof (params as { id?: unknown }).id === "string"
          ? (params as { id: string }).id
          : undefined;
      const title =
        params &&
        typeof params === "object" &&
        typeof (params as { title?: unknown }).title === "string"
          ? (params as { title: string }).title
          : undefined;
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sessionNew?.({ id, title }),
      };
    }
    if (body.method === "session.archive") {
      optionsGuard(client, "sessionArchive");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sessionArchive(stringParam(body.params, "id")),
      };
    }
    if (body.method === "session.restore") {
      optionsGuard(client, "sessionRestore");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sessionRestore(stringParam(body.params, "id")),
      };
    }
    if (body.method === "session.export") {
      optionsGuard(client, "sessionExport");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sessionExport(stringParam(body.params, "id")),
      };
    }
    if (body.method === "session.attach") {
      optionsGuard(client, "sessionAttach");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sessionAttach(stringParam(body.params, "id")),
      };
    }
    if (body.method === "mcp.catalog") {
      optionsGuard(client, "mcpCatalog");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.mcpCatalog(),
      };
    }
    if (body.method === "plugin.list") {
      optionsGuard(client, "plugins");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.plugins(),
      };
    }
    if (body.method === "command.catalog") {
      optionsGuard(client, "commandCatalog");
      const workspaceID = optionalStringParam(body.params, "workspaceID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.commandCatalog(
          workspaceID ? { workspaceID } : undefined,
        ),
      };
    }
    if (body.method === "command.execute") {
      optionsGuard(client, "commandExecute");
      const name = body.params?.name;
      const raw = body.params?.raw;
      const args = body.params?.args;
      if (typeof name !== "string")
        throw invalidParams("command.execute.params.name must be a string");
      if (typeof raw !== "string")
        throw invalidParams("command.execute.params.raw must be a string");
      if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))
        throw invalidParams(
          "command.execute.params.args must be an array of strings",
        );
      const sessionID = optionalStringParam(body.params, "sessionID");
      const workspaceID = optionalStringParam(body.params, "workspaceID");
      await client.commandExecute({
        name,
        raw,
        args,
        ...(sessionID ? { sessionID } : {}),
        ...(workspaceID ? { workspaceID } : {}),
      });
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: null,
      };
    }
    if (body.method === "workgraph.nodes") {
      optionsGuard(client, "workGraphNodes");
      const sessionID = optionalStringParam(body.params, "sessionID");
      const workspaceID = optionalStringParam(body.params, "workspaceID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workGraphNodes({
          ...(sessionID ? { sessionID } : {}),
          ...(workspaceID ? { workspaceID } : {}),
        }),
      };
    }
    if (body.method === "workgraph.edges") {
      optionsGuard(client, "workGraphEdges");
      const sessionID = optionalStringParam(body.params, "sessionID");
      const workspaceID = optionalStringParam(body.params, "workspaceID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workGraphEdges({
          ...(sessionID ? { sessionID } : {}),
          ...(workspaceID ? { workspaceID } : {}),
        }),
      };
    }
    // --- P0-C: native terminal host ---
    // Secure-input control and human-control release are authorization
    // semantics: ending a human's secure input remotely is as strong as writing
    // to the terminal. P0-D must scope them; until then they are routed but a
    // no-host runtime refuses them anyway.
    if (body.method === "nativeTerminal.list") {
      optionsGuard(client, "nativeTerminalList");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.nativeTerminalList?.(
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "nativeTerminal.read") {
      optionsGuard(client, "nativeTerminalRead");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.nativeTerminalRead?.(
          stringParam(body.params, "id"),
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "nativeTerminal.stop") {
      optionsGuard(client, "nativeTerminalStop");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.nativeTerminalStop?.(
          stringParam(body.params, "id"),
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "nativeTerminal.openHub") {
      optionsGuard(client, "nativeTerminalOpenHub");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.nativeTerminalOpenHub(),
      };
    }
    if (body.method === "nativeTerminal.claimHumanInput") {
      optionsGuard(client, "nativeTerminalClaimHumanInput");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.nativeTerminalClaimHumanInput?.(
          stringParam(body.params, "id"),
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "nativeTerminal.revokeApprovalScope") {
      optionsGuard(client, "nativeTerminalRevokeApprovalScope");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.nativeTerminalRevokeApprovalScope?.(
          stringParam(body.params, "id"),
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "nativeTerminal.releaseHumanControl") {
      optionsGuard(client, "nativeTerminalReleaseHumanControl");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.nativeTerminalReleaseHumanControl?.(
          stringParam(body.params, "id"),
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "nativeTerminal.beginSecureInput") {
      optionsGuard(client, "nativeTerminalBeginSecureInput");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.nativeTerminalBeginSecureInput?.(
          stringParam(body.params, "id"),
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "nativeTerminal.endSecureInput") {
      optionsGuard(client, "nativeTerminalEndSecureInput");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.nativeTerminalEndSecureInput?.(
          stringParam(body.params, "id"),
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    // --- P0-H: the terminal write surface (host-gated, see http.ts) ---
    if (body.method === "nativeTerminal.start") {
      optionsGuard(client, "nativeTerminalStart");
      const params = body.params;
      if (!params || typeof params !== "object")
        throw invalidParams("nativeTerminal.start.params must be an object");
      const command = (params as { command?: unknown }).command;
      if (typeof command !== "string" || !command)
        throw invalidParams(
          "nativeTerminal.start.params.command must be a non-empty string",
        );
      const cwd =
        typeof (params as { cwd?: unknown }).cwd === "string"
          ? (params as { cwd: string }).cwd
          : undefined;
      const id =
        typeof (params as { id?: unknown }).id === "string"
          ? (params as { id: string }).id
          : undefined;
      const sessionID =
        typeof (params as { sessionID?: unknown }).sessionID === "string"
          ? (params as { sessionID: string }).sessionID
          : undefined;
      const agentID =
        typeof (params as { agentID?: unknown }).agentID === "string"
          ? (params as { agentID: string }).agentID
          : undefined;
      // The spawn geometry: a caller (a tool call that knows it is about to run
      // a TUI) asks for a big grid up front instead of resizing afterwards.
      const rows = intParam(body.params, "rows");
      const cols = intParam(body.params, "cols");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.nativeTerminalStart?.({
          command,
          cwd,
          id,
          sessionID,
          ...(agentID ? { agentID } : {}),
          ...(rows !== undefined ? { rows } : {}),
          ...(cols !== undefined ? { cols } : {}),
        }),
      };
    }
    if (body.method === "nativeTerminal.write") {
      optionsGuard(client, "nativeTerminalWrite");
      const params = body.params;
      if (!params || typeof params !== "object")
        throw invalidParams("nativeTerminal.write.params must be an object");
      const id = (params as { id?: unknown }).id;
      const input = (params as { input?: unknown }).input;
      if (typeof id !== "string" || !id)
        throw invalidParams(
          "nativeTerminal.write.params.id must be a non-empty string",
        );
      if (typeof input !== "string")
        throw invalidParams(
          "nativeTerminal.write.params.input must be a string",
        );
      const idempotencyKey =
        typeof (params as { idempotencyKey?: unknown }).idempotencyKey ===
        "string"
          ? (params as { idempotencyKey: string }).idempotencyKey
          : undefined;
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.nativeTerminalWrite?.({
          id,
          input,
          idempotencyKey,
          ...(optionalStringParam(body.params, "sessionID")
            ? { sessionID: optionalStringParam(body.params, "sessionID") }
            : {}),
          // A human pane's keystrokes state their own actor; absent stays the
          // model (a tool call writing into a terminal).
          ...((params as { actor?: unknown }).actor === "human"
            ? { actor: "human" as const }
            : {}),
        }),
      };
    }
    if (body.method === "nativeTerminal.resize") {
      optionsGuard(client, "nativeTerminalResize");
      const params = body.params;
      if (!params || typeof params !== "object")
        throw invalidParams("nativeTerminal.resize.params must be an object");
      const id = (params as { id?: unknown }).id;
      const rows = (params as { rows?: unknown }).rows;
      const cols = (params as { cols?: unknown }).cols;
      if (typeof id !== "string" || !id)
        throw invalidParams(
          "nativeTerminal.resize.params.id must be a non-empty string",
        );
      if (typeof rows !== "number" || !Number.isInteger(rows))
        throw invalidParams(
          "nativeTerminal.resize.params.rows must be an integer",
        );
      if (typeof cols !== "number" || !Number.isInteger(cols))
        throw invalidParams(
          "nativeTerminal.resize.params.cols must be an integer",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.nativeTerminalResize?.({
          id,
          rows,
          cols,
          ...(optionalStringParam(body.params, "sessionID")
            ? { sessionID: optionalStringParam(body.params, "sessionID") }
            : {}),
        }),
      };
    }
    // --- P0-C: intelligence queries and capability records ---
    // These exist on the runtime, are routed now, and answer with nothing
    // until there are writers — the report says so via `unimplemented`.
    if (body.method === "constitution.rules") {
      optionsGuard(client, "constitutionRules");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.constitutionRules?.(
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "constitution.overrides") {
      optionsGuard(client, "constitutionOverrides");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.constitutionOverrides?.(
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "constitution.rule.update") {
      optionsGuard(client, "updateConstitutionRule");
      const params = body.params as Record<string, unknown> | undefined;
      if (!params || typeof params.ruleID !== "string" || !params.ruleID.trim())
        throw invalidParams(
          "constitution.rule.update requires a ruleID string",
        );
      if (params.enabled !== undefined && typeof params.enabled !== "boolean")
        throw invalidParams(
          "constitution.rule.update.enabled must be a boolean when provided",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.updateConstitutionRule?.(
          {
            ruleID: params.ruleID,
            ...(typeof params.enabled === "boolean"
              ? { enabled: params.enabled }
              : {}),
            ...(typeof params.statement === "string"
              ? { statement: params.statement }
              : {}),
            ...(params.enforcement === "deny" ||
            params.enforcement === "approval" ||
            params.enforcement === "warn"
              ? { enforcement: params.enforcement }
              : {}),
            ...(params.priority === "critical" ||
            params.priority === "high" ||
            params.priority === "medium" ||
            params.priority === "low"
              ? { priority: params.priority }
              : {}),
            ...(params.appliesTo &&
            typeof params.appliesTo === "object" &&
            !Array.isArray(params.appliesTo)
              ? {
                  appliesTo: params.appliesTo as {
                    tools?: string[];
                    paths?: string[];
                    commandPattern?: string;
                  },
                }
              : {}),
          },
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "constitution.rule.create") {
      optionsGuard(client, "createConstitutionRule");
      const params = body.params as Record<string, unknown> | undefined;
      if (
        !params ||
        typeof params.statement !== "string" ||
        !params.statement.trim()
      )
        throw invalidParams(
          "constitution.rule.create requires a statement string",
        );
      if (
        params.enforcement !== "deny" &&
        params.enforcement !== "approval" &&
        params.enforcement !== "warn"
      )
        throw invalidParams(
          "constitution.rule.create requires enforcement deny|approval|warn",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.createConstitutionRule?.(
          {
            statement: params.statement,
            enforcement: params.enforcement,
            ...(params.scope === "project" || params.scope === "package"
              ? { scope: params.scope }
              : {}),
            ...(params.appliesTo &&
            typeof params.appliesTo === "object" &&
            !Array.isArray(params.appliesTo)
              ? {
                  appliesTo: params.appliesTo as {
                    tools?: string[];
                    paths?: string[];
                    commandPattern?: string;
                  },
                }
              : {}),
            ...(params.priority === "critical" ||
            params.priority === "high" ||
            params.priority === "medium" ||
            params.priority === "low"
              ? { priority: params.priority }
              : {}),
          },
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "constitution.rule.remove") {
      optionsGuard(client, "removeConstitutionRule");
      const params = body.params as Record<string, unknown> | undefined;
      if (!params || typeof params.ruleID !== "string" || !params.ruleID.trim())
        throw invalidParams(
          "constitution.rule.remove requires a ruleID string",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.removeConstitutionRule?.(
          { ruleID: params.ruleID },
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "constitution.docRules") {
      optionsGuard(client, "constitutionDocRules");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.constitutionDocRules?.(
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "constitution.docRule.promote") {
      optionsGuard(client, "promoteConstitutionDocRule");
      const params = body.params as Record<string, unknown> | undefined;
      if (!params || typeof params.id !== "string" || !params.id.trim())
        throw invalidParams(
          "constitution.docRule.promote requires an id string",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.promoteConstitutionDocRule?.(
          { id: params.id },
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "constitution.docRule.update") {
      optionsGuard(client, "updateConstitutionDocRule");
      const params = body.params as Record<string, unknown> | undefined;
      if (!params || typeof params.id !== "string" || !params.id.trim())
        throw invalidParams(
          "constitution.docRule.update requires an id string",
        );
      if (
        params.statement !== undefined &&
        (typeof params.statement !== "string" || !params.statement.trim())
      )
        throw invalidParams(
          "constitution.docRule.update statement must be a non-empty string",
        );
      if (
        params.enforcement !== undefined &&
        params.enforcement !== "deny" &&
        params.enforcement !== "approval" &&
        params.enforcement !== "warn"
      )
        throw invalidParams(
          "constitution.docRule.update enforcement must be deny|approval|warn",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.updateConstitutionDocRule?.(
          {
            id: params.id,
            ...(typeof params.statement === "string"
              ? { statement: params.statement }
              : {}),
            ...(params.enforcement === "deny" ||
            params.enforcement === "approval" ||
            params.enforcement === "warn"
              ? { enforcement: params.enforcement }
              : {}),
            ...(params.appliesTo &&
            typeof params.appliesTo === "object" &&
            !Array.isArray(params.appliesTo)
              ? {
                  appliesTo: params.appliesTo as {
                    tools?: string[];
                    paths?: string[];
                    commandPattern?: string;
                  },
                }
              : {}),
          },
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "context.notices") {
      optionsGuard(client, "notices");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.notices?.(
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "completion.human_validation") {
      optionsGuard(client, "recordHumanValidation");
      const params = body.params as Record<string, unknown> | undefined;
      if (
        !params ||
        typeof params.taskID !== "string" ||
        params.taskID.trim().length === 0 ||
        typeof params.validation !== "string" ||
        params.validation.trim().length === 0
      )
        throw invalidParams(
          "completion.human_validation requires taskID and validation strings",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.recordHumanValidation?.(
          {
            taskID: params.taskID,
            validation: params.validation,
          },
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "decision.records") {
      optionsGuard(client, "decisionRecords");
      const params = body.params as Record<string, unknown> | undefined;
      const scope = params?.scope;
      if (
        scope !== undefined &&
        scope !== "session" &&
        scope !== "workspace" &&
        scope !== "all"
      )
        throw invalidParams(
          "decision.records.scope must be session, workspace or all",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.decisionRecords?.({
          ...(optionalStringParam(body.params, "sessionID")
            ? { sessionID: optionalStringParam(body.params, "sessionID")! }
            : {}),
          ...(scope ? { scope: scope as "session" | "workspace" | "all" } : {}),
        }),
      };
    }
    if (body.method === "decision.record") {
      optionsGuard(client, "recordDecision");
      const params = body.params as Record<string, unknown> | undefined;
      if (
        !params ||
        typeof params.decision !== "string" ||
        params.decision.trim().length === 0
      )
        throw invalidParams("decision.record requires a decision string");
      if (
        params.scope !== undefined &&
        params.scope !== "session" &&
        params.scope !== "workspace"
      )
        throw invalidParams(
          "decision.record.scope must be session or workspace",
        );
      const result = await client.recordDecision?.(
        {
          decision: params.decision,
          ...(params.scope === "workspace"
            ? { scope: "workspace" as const }
            : {}),
          ...(Array.isArray(params.rationale)
            ? { rationale: params.rationale.map(String) }
            : {}),
          ...(Array.isArray(params.alternatives)
            ? {
                alternatives: params.alternatives as {
                  option: string;
                  rejectedReason?: string;
                }[],
              }
            : {}),
          ...(Array.isArray(params.consequences)
            ? { consequences: params.consequences.map(String) }
            : {}),
          ...(Array.isArray(params.linkedPlans)
            ? { linkedPlans: params.linkedPlans.map(String) }
            : {}),
          ...(Array.isArray(params.linkedConstraints)
            ? { linkedConstraints: params.linkedConstraints.map(String) }
            : {}),
        },
        optionalStringParam(body.params, "sessionID"),
      );
      if (!result)
        throw invalidParams(
          "decision.record is not implemented by this runtime",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result,
      };
    }
    if (body.method === "evidence.records") {
      optionsGuard(client, "evidenceRecords");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.evidenceRecords?.(
          body.params as
            | { sessionID?: string; limit?: number; cursor?: string }
            | undefined,
        ),
      };
    }
    if (body.method === "evidence.record") {
      optionsGuard(client, "recordValidation");
      const params = body.params as Record<string, unknown> | undefined;
      if (
        !params ||
        typeof params.taskID !== "string" ||
        params.taskID.trim().length === 0 ||
        typeof params.command !== "string" ||
        params.command.trim().length === 0
      )
        throw invalidParams(
          "evidence.record requires a taskID and a command string",
        );
      const result = await client.recordValidation?.(
        {
          taskID: params.taskID,
          objective:
            typeof params.objective === "string" ? params.objective : "",
          command: params.command,
          ...(typeof params.timeoutSec === "number"
            ? { timeoutSec: params.timeoutSec }
            : {}),
          ...(Array.isArray(params.knownGaps)
            ? { knownGaps: params.knownGaps.map(String) }
            : {}),
        },
        optionalStringParam(body.params, "sessionID"),
      );
      if (!result)
        throw invalidParams(
          "evidence.record is not implemented by this runtime",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result,
      };
    }
    if (body.method === "completion.records") {
      optionsGuard(client, "completions");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.completions?.(
          body.params as
            | { sessionID?: string; limit?: number; cursor?: string }
            | undefined,
        ),
      };
    }
    if (body.method === "plan.task.states") {
      optionsGuard(client, "planTaskStates");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.planTaskStates?.(
          body.params as { planID?: string } | undefined,
        ),
      };
    }
    if (body.method === "workgraph.integrity") {
      optionsGuard(client, "workGraphIntegrity");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workGraphIntegrity?.(
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "workgraph.unattributed") {
      optionsGuard(client, "unattributedChanges");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.unattributedChanges?.(
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "completion.record") {
      optionsGuard(client, "recordCompletion");
      const params = body.params as Record<string, unknown> | undefined;
      if (
        !params ||
        typeof params.taskID !== "string" ||
        params.taskID.trim().length === 0 ||
        typeof params.changeSummary !== "string" ||
        params.changeSummary.trim().length === 0
      )
        throw invalidParams(
          "completion.record requires a taskID and a changeSummary string",
        );
      const result = await client.recordCompletion?.(
        {
          taskID: params.taskID,
          objective:
            typeof params.objective === "string" ? params.objective : "",
          changeSummary: params.changeSummary,
          ...(typeof params.behaviorImpact === "string"
            ? { behaviorImpact: params.behaviorImpact }
            : {}),
          ...(Array.isArray(params.validations)
            ? { validations: params.validations }
            : {}),
          ...(typeof params.humanValidation === "string"
            ? { humanValidation: params.humanValidation }
            : {}),
          ...(Array.isArray(params.knownGaps)
            ? { knownGaps: params.knownGaps.map(String) }
            : {}),
          ...(Array.isArray(params.externalSideEffects)
            ? { externalSideEffects: params.externalSideEffects.map(String) }
            : {}),
          ...(typeof params.rollbackState === "string"
            ? {
                rollbackState: params.rollbackState as
                  | "clean"
                  | "available"
                  | "none"
                  | "needs_promotion",
              }
            : {}),
          ...(Array.isArray(params.evidenceIDs)
            ? { evidenceIDs: params.evidenceIDs.map(String) }
            : {}),
          ...(Array.isArray(params.changePaths)
            ? { changePaths: params.changePaths.map(String) }
            : {}),
        },
        optionalStringParam(body.params, "sessionID"),
      );
      if (!result)
        throw invalidParams(
          "completion.record is not implemented by this runtime",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result,
      };
    }
    if (body.method === "drift.findings") {
      optionsGuard(client, "driftFindings");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.driftFindings?.(
          body.params as
            | { sessionID?: string; limit?: number; cursor?: string }
            | undefined,
        ),
      };
    }
    if (body.method === "drift.evaluate") {
      optionsGuard(client, "evaluateDrift");
      const params = body.params as Record<string, unknown> | undefined;
      if (
        !params ||
        typeof params.objective !== "string" ||
        params.objective.trim().length === 0 ||
        typeof params.currentActivity !== "string" ||
        params.currentActivity.trim().length === 0
      )
        throw invalidParams(
          "drift.evaluate requires an objective and a currentActivity string",
        );
      const result = await client.evaluateDrift?.(
        {
          objective: params.objective,
          currentActivity: params.currentActivity,
          ...(Array.isArray(params.applicableConstraints)
            ? {
                applicableConstraints: params.applicableConstraints.map(String),
              }
            : {}),
          ...(Array.isArray(params.changes) ? { changes: params.changes } : {}),
          ...(Array.isArray(params.evidenceRefs)
            ? { evidenceRefs: params.evidenceRefs.map(String) }
            : {}),
        },
        optionalStringParam(body.params, "sessionID"),
      );
      if (!result)
        throw invalidParams(
          "drift.evaluate is not implemented by this runtime",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result,
      };
    }
    if (body.method === "drift.acknowledge") {
      optionsGuard(client, "acknowledgeDriftFinding");
      const params = body.params as Record<string, unknown> | undefined;
      if (
        !params ||
        typeof params.findingID !== "string" ||
        !params.findingID.trim()
      )
        throw invalidParams("drift.acknowledge requires a findingID string");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.acknowledgeDriftFinding?.(
          {
            findingID: params.findingID,
            status: params.status as "explained" | "dismissed" | "corrected",
            ...(typeof params.rationale === "string"
              ? { rationale: params.rationale }
              : {}),
          },
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "drift.reopen") {
      optionsGuard(client, "reopenDriftFinding");
      const params = body.params as Record<string, unknown> | undefined;
      if (
        !params ||
        typeof params.findingID !== "string" ||
        !params.findingID.trim()
      )
        throw invalidParams("drift.reopen requires a findingID string");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.reopenDriftFinding?.(
          { findingID: params.findingID },
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "observation.confirmed") {
      optionsGuard(client, "confirmedWorkspaceChanges");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.confirmedWorkspaceChanges?.(
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "workspace.diff") {
      optionsGuard(client, "workspaceDiff");
      const includePatch = body.params?.includePatch;
      if (includePatch !== undefined && typeof includePatch !== "boolean")
        throw invalidParams(
          "workspace.diff.params.includePatch must be a boolean",
        );
      const workspaceID = optionalStringParam(body.params, "workspaceID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workspaceDiff?.({
          ...(workspaceID ? { workspaceID } : {}),
          ...(includePatch === undefined ? {} : { includePatch }),
        }),
      };
    }
    if (body.method === "workspace.git.diff") {
      optionsGuard(client, "workspaceGitDiff");
      const input = body.params as
        | {
            workspaceID?: string;
            from?: string;
            to?: string;
            path?: string;
            includePatch?: boolean;
            includeContent?: boolean;
          }
        | undefined;
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.workspaceGitDiff?.(input),
      };
    }
    if (body.method === "ast.diff") {
      optionsGuard(client, "astDiff");
      const input = body.params as
        | { oldText: string; newText: string; language: string }
        | undefined;
      if (
        !input ||
        typeof input.oldText !== "string" ||
        typeof input.newText !== "string" ||
        typeof input.language !== "string"
      )
        throw invalidParams(
          "ast.diff.params.oldText, newText and language are required strings",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.astDiff?.(input),
      };
    }
    if (body.method === "ast.diff.batch") {
      optionsGuard(client, "astDiffBatch");
      const input = body.params as
        | {
            files?: Array<{
              path?: string;
              oldText: string;
              newText: string;
              language: string;
            }>;
            options?: { maxChangesPerFile?: number };
          }
        | undefined;
      if (!input || !Array.isArray(input.files) || input.files.length === 0)
        throw invalidParams(
          "ast.diff.batch.params.files must be a non-empty array",
        );
      const files = input.files;
      for (const file of files) {
        if (
          !file ||
          typeof file.oldText !== "string" ||
          typeof file.newText !== "string" ||
          typeof file.language !== "string"
        )
          throw invalidParams(
            "ast.diff.batch.params.files requires oldText/newText/language strings",
          );
      }
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.astDiffBatch?.({
          files,
          ...(input.options ? { options: input.options } : {}),
        }),
      };
    }
    if (body.method === "ast.refactor.preview") {
      optionsGuard(client, "astRefactorPreview");
      const input = body.params as
        | {
            operation: "rename" | "extract" | "inline" | "move" | "custom";
            files?: Array<{
              path?: string;
              oldText: string;
              newText: string;
              language: string;
            }>;
          }
        | undefined;
      if (
        !input ||
        typeof input.operation !== "string" ||
        !Array.isArray(input.files) ||
        input.files.length === 0
      )
        throw invalidParams(
          "ast.refactor.preview.params.operation and files are required",
        );
      for (const file of input.files) {
        if (
          !file ||
          typeof file.oldText !== "string" ||
          typeof file.newText !== "string" ||
          typeof file.language !== "string"
        )
          throw invalidParams(
            "ast.refactor.preview.params.files requires oldText/newText/language strings",
          );
      }
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.astRefactorPreview?.({
          operation: input.operation as
            | "rename"
            | "extract"
            | "inline"
            | "move"
            | "custom",
          files: input.files,
        }),
      };
    }
    if (body.method === "ast.service") {
      optionsGuard(client, "astService");
      const input = body.params as
        | {
            operation: "index" | "query";
            files?: Array<{
              path?: string;
              source: string;
              language: string;
            }>;
            query?: { nodeKind?: string; textIncludes?: string };
          }
        | undefined;
      if (
        !input ||
        (input.operation !== "index" && input.operation !== "query") ||
        !Array.isArray(input.files) ||
        input.files.length === 0
      )
        throw invalidParams(
          "ast.service.params.operation and files are required",
        );
      for (const file of input.files) {
        if (
          !file ||
          typeof file.source !== "string" ||
          typeof file.language !== "string"
        )
          throw invalidParams(
            "ast.service.params.files requires source/language strings",
          );
      }
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.astService?.({
          operation: input.operation,
          files: input.files,
          ...(input.query ? { query: input.query } : {}),
        }),
      };
    }
    if (body.method === "ast.refactor.plan") {
      optionsGuard(client, "astRefactorPlan");
      const input = body.params as
        | {
            operation: "rename" | "extract" | "inline" | "move" | "custom";
            files?: Array<{
              path?: string;
              source: string;
              language: string;
            }>;
            rename?: { from: string; to: string };
            query?: { nodeKind?: string; textIncludes?: string };
          }
        | undefined;
      if (
        !input ||
        typeof input.operation !== "string" ||
        !Array.isArray(input.files) ||
        input.files.length === 0
      )
        throw invalidParams(
          "ast.refactor.plan.params.operation and files are required",
        );
      for (const file of input.files) {
        if (
          !file ||
          typeof file.source !== "string" ||
          typeof file.language !== "string"
        )
          throw invalidParams(
            "ast.refactor.plan.params.files requires source/language strings",
          );
      }
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.astRefactorPlan?.({
          operation: input.operation,
          files: input.files,
          ...(input.rename ? { rename: input.rename } : {}),
          ...(input.query ? { query: input.query } : {}),
        }),
      };
    }
    if (body.method === "ast.refactor.apply") {
      optionsGuard(client, "astApplyRefactor");
      const input = body.params as
        | {
            operation: "rename" | "extract" | "inline" | "move" | "custom";
            files?: Array<{
              path?: string;
              source: string;
              language: string;
            }>;
            rename?: { from: string; to: string };
            dryRun?: boolean;
          }
        | undefined;
      if (
        !input ||
        typeof input.operation !== "string" ||
        !Array.isArray(input.files) ||
        input.files.length === 0
      )
        throw invalidParams(
          "ast.refactor.apply.params.operation and files are required",
        );
      for (const file of input.files) {
        if (
          !file ||
          typeof file.source !== "string" ||
          typeof file.language !== "string"
        )
          throw invalidParams(
            "ast.refactor.apply.params.files requires source/language strings",
          );
      }
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.astApplyRefactor?.({
          operation: input.operation,
          files: input.files,
          ...(input.rename ? { rename: input.rename } : {}),
          ...(input.dryRun ? { dryRun: input.dryRun } : {}),
        }),
      };
    }
    if (body.method === "git.refs") {
      optionsGuard(client, "gitRefs");
      const workspaceID = optionalStringParam(body.params, "workspaceID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.gitRefs?.(
          workspaceID ? { workspaceID } : undefined,
        ),
      };
    }
    if (body.method === "team.pr.list") {
      optionsGuard(client, "teamPRList");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.teamPRList?.(
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "tools.registered") {
      optionsGuard(client, "registeredTools");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.registeredTools?.(
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "projections.list") {
      optionsGuard(client, "projectionContributions");
      const workspaceID = optionalStringParam(body.params, "workspaceID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.projectionContributions(
          workspaceID ? { workspaceID } : undefined,
        ),
      };
    }
    if (body.method === "constitution.override.request") {
      optionsGuard(client, "requestOverride");
      const params = body.params as Record<string, unknown> | undefined;
      if (!params || typeof params.ruleID !== "string" || !params.ruleID.trim())
        throw invalidParams("ruleID is required");
      if (typeof params.reason !== "string" || !params.reason.trim())
        throw invalidParams("reason is required");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.requestOverride?.(
          {
            ruleID: params.ruleID,
            reason: params.reason,
            ...(Array.isArray(params.paths)
              ? {
                  paths: params.paths.filter(
                    (path): path is string => typeof path === "string",
                  ),
                }
              : {}),
            ...(typeof params.taskID === "string"
              ? { taskID: params.taskID }
              : {}),
            ...(typeof params.expiresAt === "string"
              ? { expiresAt: params.expiresAt }
              : {}),
          },
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "constitution.override.approve") {
      optionsGuard(client, "approveOverride");
      const params = body.params as Record<string, unknown> | undefined;
      if (
        !params ||
        typeof params.requestID !== "string" ||
        !params.requestID.trim()
      )
        throw invalidParams("requestID is required");
      if (params.decision !== "once" && params.decision !== "reject")
        throw invalidParams("decision must be once or reject");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.approveOverride({
          requestID: params.requestID,
          decision: params.decision,
        }),
      };
    }
    if (body.method === "mailbox.list") {
      optionsGuard(client, "mailboxList");
      const sessionID = (body.params as { sessionID?: string } | undefined)
        ?.sessionID;
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.mailboxList?.(sessionID),
      };
    }
    if (body.method === "mailbox.send") {
      optionsGuard(client, "mailboxSend");
      const params = body.params as Record<string, unknown> | undefined;
      if (
        !params ||
        typeof params.intent !== "string" ||
        params.intent.trim().length === 0 ||
        typeof params.text !== "string" ||
        params.text.trim().length === 0
      )
        throw invalidParams(
          "mailbox.send requires an intent and a text string",
        );
      const result = await client.mailboxSend?.({
        ...(typeof params.source === "string"
          ? {
              source: params.source as "user_via_live_chat" | "system",
            }
          : {}),
        ...(typeof params.priority === "string"
          ? {
              priority: params.priority as "normal" | "high" | "urgent",
            }
          : {}),
        intent: params.intent,
        text: params.text,
        ...(typeof params.safeSummary === "string"
          ? { safeSummary: params.safeSummary }
          : {}),
        ...(typeof params.relatedPlanID === "string"
          ? { relatedPlanID: params.relatedPlanID }
          : {}),
        ...(typeof params.deliveryPolicy === "string"
          ? { deliveryPolicy: params.deliveryPolicy }
          : {}),
        ...(typeof params.sessionID === "string"
          ? { sessionID: params.sessionID }
          : {}),
      });
      if (!result)
        throw invalidParams("mailbox.send is not implemented by this runtime");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result,
      };
    }
    if (body.method === "mailbox.deliver") {
      optionsGuard(client, "mailboxDeliver");
      const params = body.params as Record<string, unknown> | undefined;
      const messageID = params?.messageID;
      if (typeof messageID !== "string" || !messageID)
        throw invalidParams("mailbox.deliver requires a messageID string");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.mailboxDeliver?.(
          messageID,
          typeof params?.sessionID === "string" ? params.sessionID : undefined,
        ),
      };
    }
    if (body.method === "mailbox.acknowledge") {
      optionsGuard(client, "mailboxAcknowledge");
      const params = body.params as Record<string, unknown> | undefined;
      const messageID = params?.messageID;
      if (typeof messageID !== "string" || !messageID)
        throw invalidParams("mailbox.acknowledge requires a messageID string");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.mailboxAcknowledge?.(
          messageID,
          typeof params?.sessionID === "string" ? params.sessionID : undefined,
        ),
      };
    }
    if (body.method === "mailbox.defer") {
      optionsGuard(client, "mailboxDefer");
      const params = body.params as Record<string, unknown> | undefined;
      const messageID = params?.messageID;
      if (typeof messageID !== "string" || !messageID)
        throw invalidParams("mailbox.defer requires a messageID string");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.mailboxDefer?.(
          messageID,
          typeof params.reason === "string" ? params.reason : undefined,
          typeof params.sessionID === "string" ? params.sessionID : undefined,
        ),
      };
    }
    if (body.method === "mailbox.supersede") {
      optionsGuard(client, "mailboxSupersede");
      const params = body.params as Record<string, unknown> | undefined;
      const messageID = params?.messageID;
      if (typeof messageID !== "string" || !messageID)
        throw invalidParams("mailbox.supersede requires a messageID string");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.mailboxSupersede?.(
          messageID,
          typeof params.reason === "string" ? params.reason : undefined,
          typeof params.sessionID === "string" ? params.sessionID : undefined,
        ),
      };
    }
    if (body.method === "planDoc.list") {
      optionsGuard(client, "planDocList");
      const sessionID = (body.params as { sessionID?: string } | undefined)
        ?.sessionID;
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.planDocList?.(sessionID),
      };
    }
    if (body.method === "planDoc.read") {
      optionsGuard(client, "planDocRead");
      const params = body.params as Record<string, unknown> | undefined;
      const planID = params?.planID;
      const path = params?.path;
      if (typeof planID !== "string" && typeof path !== "string")
        throw invalidParams("planDoc.read requires planID or path");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.planDocRead?.({
          ...(typeof planID === "string" ? { planID } : {}),
          ...(typeof path === "string" ? { path } : {}),
          ...(typeof params?.sessionID === "string"
            ? { sessionID: params.sessionID }
            : {}),
        }),
      };
    }
    if (body.method === "planDoc.write") {
      optionsGuard(client, "planDocWrite");
      const params = body.params as Record<string, unknown> | undefined;
      if (
        !params ||
        typeof params.path !== "string" ||
        params.path.trim().length === 0 ||
        typeof params.content !== "string"
      )
        throw invalidParams("planDoc.write requires path and content");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.planDocWrite?.({
          path: params.path,
          content: params.content,
          ...(typeof params.title === "string" ? { title: params.title } : {}),
          ...(typeof params.planID === "string"
            ? { planID: params.planID }
            : {}),
          ...(typeof params.sessionID === "string"
            ? { sessionID: params.sessionID }
            : {}),
        }),
      };
    }
    if (body.method === "planDoc.mark") {
      optionsGuard(client, "planDocMark");
      const params = body.params as Record<string, unknown> | undefined;
      if (
        !params ||
        typeof params.path !== "string" ||
        params.path.trim().length === 0
      )
        throw invalidParams("planDoc.mark requires a path string");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.planDocMark?.({
          path: params.path,
          ...(typeof params.title === "string" ? { title: params.title } : {}),
          ...(typeof params.sessionID === "string"
            ? { sessionID: params.sessionID }
            : {}),
        }),
      };
    }
    if (body.method === "planDoc.delete") {
      optionsGuard(client, "planDocDelete");
      const params = body.params as Record<string, unknown> | undefined;
      const planID = params?.planID;
      if (typeof planID !== "string" || !planID)
        throw invalidParams("planDoc.delete requires a planID string");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.planDocDelete?.(
          planID,
          typeof params?.sessionID === "string" ? params.sessionID : undefined,
        ),
      };
    }
    if (body.method === "planDoc.status") {
      optionsGuard(client, "planDocStatus");
      const params = body.params as Record<string, unknown> | undefined;
      const planID = params?.planID;
      if (typeof planID !== "string" || !planID)
        throw invalidParams("planDoc.status requires a planID string");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.planDocStatus?.(
          planID,
          typeof params?.sessionID === "string" ? params.sessionID : undefined,
        ),
      };
    }
    if (body.method === "planDoc.updateStatus") {
      optionsGuard(client, "planDocUpdateStatus");
      const params = body.params as Record<string, unknown> | undefined;
      const planID = params?.planID;
      const status = params?.status;
      if (typeof planID !== "string" || !planID)
        throw invalidParams("planDoc.updateStatus requires a planID string");
      if (typeof status !== "string" || !status)
        throw invalidParams("planDoc.updateStatus requires a status string");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.planDocUpdateStatus?.({
          planID,
          status,
          ...(typeof params?.sessionID === "string"
            ? { sessionID: params.sessionID }
            : {}),
        }),
      };
    }
    if (body.method === "planDoc.active") {
      optionsGuard(client, "planDocActive");
      const params = body.params as Record<string, unknown> | undefined;
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.planDocActive?.(
          typeof params?.sessionID === "string" ? params.sessionID : undefined,
        ),
      };
    }
    if (body.method === "planDoc.activate") {
      optionsGuard(client, "planDocActivate");
      const params = body.params as Record<string, unknown> | undefined;
      const planID = params?.planID;
      if (typeof planID !== "string" || !planID)
        throw invalidParams("planDoc.activate requires a planID string");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.planDocActivate?.(
          planID,
          typeof params?.sessionID === "string" ? params.sessionID : undefined,
        ),
      };
    }
    if (body.method === "planDoc.deactivate") {
      optionsGuard(client, "planDocDeactivate");
      const params = body.params as Record<string, unknown> | undefined;
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.planDocDeactivate?.(
          typeof params?.sessionID === "string" ? params.sessionID : undefined,
        ),
      };
    }
    if (body.method === "goal.control") {
      optionsGuard(client, "goalControl");
      const params = body.params as Record<string, unknown> | undefined;
      const action = params?.action;
      if (action !== "pause" && action !== "resume" && action !== "clear")
        throw invalidParams(
          "goal.control requires action: pause | resume | clear",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.goalControl?.(
          action,
          typeof params?.sessionID === "string" ? params.sessionID : undefined,
        ),
      };
    }
    if (body.method === "goal.edit") {
      optionsGuard(client, "goalEdit");
      const params = body.params as Record<string, unknown> | undefined;
      const input = params?.input;
      if (typeof input !== "object" || input === null)
        throw invalidParams("goal.edit requires an input object");
      const goalID = (input as { goalID?: unknown }).goalID;
      const revision = (input as { revision?: unknown }).revision;
      if (typeof goalID !== "string" || !goalID.trim())
        throw invalidParams("goal.edit requires input.goalID");
      if (typeof revision !== "number" || !Number.isInteger(revision))
        throw invalidParams("goal.edit requires an integer input.revision");
      const objective = (input as { objective?: unknown }).objective;
      const maxGoalRounds = (input as { maxGoalRounds?: unknown })
        .maxGoalRounds;
      const planID = (input as { planID?: unknown }).planID;
      if (
        objective !== undefined &&
        (typeof objective !== "string" || !objective.trim())
      )
        throw invalidParams(
          "goal.edit input.objective must be a non-empty string",
        );
      if (
        maxGoalRounds !== undefined &&
        (typeof maxGoalRounds !== "number" ||
          !Number.isInteger(maxGoalRounds) ||
          maxGoalRounds < 0)
      )
        throw invalidParams(
          "goal.edit input.maxGoalRounds must be a non-negative integer",
        );
      if (planID !== undefined && typeof planID !== "string")
        throw invalidParams("goal.edit input.planID must be a string");
      if (
        objective === undefined &&
        maxGoalRounds === undefined &&
        planID === undefined
      )
        throw invalidParams(
          "goal.edit requires at least one of objective, maxGoalRounds, planID",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.goalEdit?.(
          {
            goalID,
            revision,
            ...(objective !== undefined ? { objective } : {}),
            ...(maxGoalRounds !== undefined ? { maxGoalRounds } : {}),
            ...(planID !== undefined ? { planID } : {}),
          },
          typeof params?.sessionID === "string" ? params.sessionID : undefined,
        ),
      };
    }
    if (body.method === "capabilities") {
      optionsGuard(client, "capabilities");
      const workspaceID = optionalStringParam(body.params, "workspaceID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.capabilities(
          workspaceID ? { workspaceID } : undefined,
        ),
      };
    }
    if (body.method === "session.snapshot") {
      optionsGuard(client, "sessionSnapshot");
      const sessionID = optionalStringParam(body.params, "sessionID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.sessionSnapshot?.(sessionID),
      };
    }
    if (body.method === "session.subagents") {
      optionsGuard(client, "subagents");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.subagents?.(
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "subagent.history") {
      optionsGuard(client, "subagentHistory");
      const sessionID = body.params?.sessionID;
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.subagentHistory?.(
          typeof sessionID === "string" ? sessionID : undefined,
        ),
      };
    }
    if (body.method === "subagent.history.page") {
      optionsGuard(client, "subagentHistoryPage");
      const params = body.params;
      if (
        params !== undefined &&
        (typeof params !== "object" || Array.isArray(params))
      )
        throw invalidParams("subagent.history.page.params must be an object");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.subagentHistoryPage?.(
          (params ?? {}) as {
            sessionID?: string;
            cursor?: string;
            limit?: number;
          },
        ),
      };
    }
    if (body.method === "attachment.upload") {
      optionsGuard(client, "uploadAttachment");
      const params = body.params ?? {};
      const name = params.name;
      const mediaType = params.mediaType;
      const data = params.data;
      if (typeof name !== "string" || !name)
        throw invalidParams("attachment.upload.params.name must be a string");
      if (typeof mediaType !== "string" || !mediaType)
        throw invalidParams(
          "attachment.upload.params.mediaType must be a string",
        );
      if (typeof data !== "string" || !data)
        throw invalidParams(
          "attachment.upload.params.data must be a base64 string",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.uploadAttachment?.({
          name,
          mediaType,
          data,
          ...(optionalStringParam(body.params, "workspaceID")
            ? { workspaceID: optionalStringParam(body.params, "workspaceID")! }
            : {}),
        }),
      };
    }
    if (body.method === "attachment.dataUrl") {
      optionsGuard(client, "attachmentDataUrl");
      const path = optionalStringParam(body.params, "path");
      const mediaType = optionalStringParam(body.params, "mediaType");
      const attachmentID = optionalStringParam(body.params, "attachmentID");
      const sessionID = optionalStringParam(body.params, "sessionID");
      if (attachmentID || sessionID) {
        if (!attachmentID || !sessionID)
          throw invalidParams(
            "attachment.dataUrl.params requires attachmentID and sessionID together",
          );
      } else if (!path || !mediaType) {
        throw invalidParams(
          "attachment.dataUrl.params requires path+mediaType or attachmentID+sessionID",
        );
      }
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.attachmentDataUrl?.({
          ...(path ? { path } : {}),
          ...(mediaType ? { mediaType } : {}),
          ...(attachmentID ? { attachmentID } : {}),
          ...(sessionID ? { sessionID } : {}),
          ...(optionalStringParam(body.params, "workspaceID")
            ? { workspaceID: optionalStringParam(body.params, "workspaceID")! }
            : {}),
        }),
      };
    }
    if (
      body.method.startsWith("navi.chat.") ||
      body.method.startsWith("nia.chat.")
    ) {
      const stream = body.method.startsWith("navi.") ? "navi" : "nia";
      const operation = body.method.slice(`${stream}.chat.`.length);
      // naviChat / niaChat are object surfaces with methods, not functions, so
      // the function-only requireMember guard does not apply. The surface-presence
      // check below is the correct guard (and returns -32601 when missing).
      const surface = stream === "navi" ? client.naviChat : client.niaChat;
      if (!surface)
        return {
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: {
            code: -32601,
            message: `${stream}.chat surface is not available`,
          },
        };
      const params = body.params;
      let result: unknown;
      switch (operation) {
        case "submit": {
          if (!params || typeof params !== "object")
            throw invalidParams(`${body.method}.params must be an object`);
          const text = (params as { text?: unknown }).text;
          if (typeof text !== "string")
            throw invalidParams(`${body.method}.params.text must be a string`);
          result = await surface.submit({
            text,
            ...(typeof (params as { model?: unknown }).model === "object"
              ? {
                  model: (
                    params as { model?: { modelID?: string; variant?: string } }
                  ).model,
                }
              : {}),
            ...(typeof (
              params as {
                reasoningEffort?: import("@anthelia/contracts").RuntimeReasoningEffort;
              }
            ).reasoningEffort !== "undefined"
              ? {
                  reasoningEffort: (
                    params as {
                      reasoningEffort?: import("@anthelia/contracts").RuntimeReasoningEffort;
                    }
                  ).reasoningEffort,
                }
              : {}),
            ...(typeof (params as { sessionID?: string }).sessionID === "string"
              ? { sessionID: (params as { sessionID?: string }).sessionID }
              : {}),
          });
          break;
        }
        case "abort":
          result = await surface.abort?.(
            (params as { sessionID?: string } | undefined)?.sessionID,
          );
          break;
        case "messages":
          result = await surface.messages?.(
            (params as { sessionID?: string } | undefined)?.sessionID,
          );
          break;
        case "messages.page":
          if (
            params !== undefined &&
            (typeof params !== "object" || Array.isArray(params))
          )
            throw invalidParams(`${body.method}.params must be an object`);
          result = await surface.messagesPage?.(
            (params ?? {}) as {
              sessionID?: string;
              cursor?: string;
              limit?: number;
            },
          );
          break;
        case "rollback": {
          if (!params || typeof params !== "object")
            throw invalidParams(`${body.method}.params must be an object`);
          const input = (params as { input?: unknown }).input;
          const toMessageID =
            input && typeof input === "object"
              ? (input as { toMessageID?: unknown }).toMessageID
              : undefined;
          if (typeof toMessageID !== "string")
            throw invalidParams(
              `${body.method}.params.input.toMessageID must be a string`,
            );
          result = await surface.rollback?.(
            { toMessageID },
            (params as { sessionID?: string }).sessionID,
          );
          break;
        }
        case "model.profile":
          result = await surface.modelProfile?.(
            (params as { sessionID?: string } | undefined)?.sessionID,
          );
          break;
        case "model.profile.set": {
          if (!params || typeof params !== "object")
            throw invalidParams(`${body.method}.params must be an object`);
          const profile = (params as { profile?: unknown }).profile;
          if (!profile || typeof profile !== "object")
            throw invalidParams(
              `${body.method}.params.profile must be an object`,
            );
          result = await surface.setModelProfile?.(
            profile as import("@anthelia/contracts").ChatModelProfile,
            (params as { sessionID?: string }).sessionID,
          );
          break;
        }
        default:
          return {
            jsonrpc: "2.0",
            id: body.id ?? null,
            error: {
              code: -32601,
              message: `unknown ${stream}.chat method: ${operation}`,
            },
          };
      }
      return { jsonrpc: "2.0", id: body.id ?? null, result };
    }

    // --- P0-G follow-up: the config write surface (previously TUI-only) ---
    if (body.method === "config.update") {
      const params = body.params;
      if (!params || typeof params !== "object")
        throw invalidParams("config.update.params must be an object");
      const patch = (params as { patch?: unknown }).patch;
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        throw invalidParams("config.update.params.patch must be an object");
      const scope = (params as { scope?: unknown }).scope;
      if (scope !== undefined && scope !== "project" && scope !== "global")
        throw invalidParams(
          'config.update.params.scope must be "project" or "global"',
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.updateConfig?.({
          patch: patch as Record<string, unknown>,
          scope: scope as "project" | "global" | undefined,
        }),
      };
    }
    if (body.method === "config.get") {
      optionsGuard(client, "configGet");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.configGet?.(),
      };
    }
    if (body.method === "settings.get") {
      optionsGuard(client, "settingsGet");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.settingsGet?.(),
      };
    }
    if (body.method === "skill.setEnabled") {
      optionsGuard(client, "skillSetEnabled");
      const params = body.params;
      if (!params || typeof params !== "object")
        throw invalidParams("skill.setEnabled.params must be an object");
      const name = (params as { name?: unknown }).name;
      const enabled = (params as { enabled?: unknown }).enabled;
      if (typeof name !== "string" || !name)
        throw invalidParams("skill.setEnabled.params.name must be a string");
      if (typeof enabled !== "boolean")
        throw invalidParams(
          "skill.setEnabled.params.enabled must be a boolean",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.skillSetEnabled?.({
          name,
          enabled,
          ...(optionalStringParam(body.params, "workspaceID")
            ? { workspaceID: optionalStringParam(body.params, "workspaceID") }
            : {}),
        }),
      };
    }
    if (body.method === "skill.remove") {
      optionsGuard(client, "skillRemove");
      const params = body.params;
      if (!params || typeof params !== "object")
        throw invalidParams("skill.remove.params must be an object");
      const name = (params as { name?: unknown }).name;
      if (typeof name !== "string" || !name)
        throw invalidParams("skill.remove.params.name must be a string");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.skillRemove?.({
          name,
          ...(optionalStringParam(body.params, "workspaceID")
            ? { workspaceID: optionalStringParam(body.params, "workspaceID") }
            : {}),
        }),
      };
    }
    if (body.method === "cache.response") {
      // The response cache's runtime face (rina Phase 4): omitted params
      // read, `enabled` flips the live process's opt-in.
      optionsGuard(client, "responseCache");
      const params = body.params as Record<string, unknown> | undefined;
      const enabled = params?.enabled;
      if (enabled !== undefined && typeof enabled !== "boolean")
        throw invalidParams("cache.response.params.enabled must be a boolean");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: (await client.responseCache?.({
          ...(enabled === undefined ? {} : { enabled }),
        })) ?? {
          enabled: false,
          hits: 0,
          misses: 0,
          entries: 0,
        },
      };
    }
    if (body.method === "settings.set") {
      optionsGuard(client, "settingsSet");
      const params = body.params as Record<string, unknown> | undefined;
      const patch = params?.patch;
      const scope = params?.scope;
      if (!patch || typeof patch !== "object")
        throw invalidParams("settings.set.params.patch must be an object");
      if (scope !== "global" && scope !== "project")
        throw invalidParams(
          "settings.set.params.scope must be global or project",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.settingsSet?.(
          patch as Record<string, unknown>,
          scope,
        ),
      };
    }
    // --- P0-C: submission with attachments, resources and agent mentions ---
    if (body.method === "submit.input") {
      const params = body.params;
      if (!params || typeof params !== "object")
        throw invalidParams("submit.input.params must be an object");
      if (typeof params.text !== "string")
        throw invalidParams("submit.input.params.text must be a string");
      const input = params as Record<string, unknown>;
      for (const field of ["attachments", "resources", "agents"] as const) {
        const value = input[field];
        if (value !== undefined && !Array.isArray(value))
          throw invalidParams(`submit.input.params.${field} must be an array`);
      }
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.submitInput?.(input as never),
      };
    }
    // --- P8: durable inbox mutations (cancel / edit / promote a queued input) ---
    if (
      body.method === "input.remove" ||
      body.method === "input.replace" ||
      body.method === "input.promote"
    ) {
      const params = body.params;
      if (!params || typeof params !== "object")
        throw invalidParams(`${body.method}.params must be an object`);
      const record = params as Record<string, unknown>;
      if (typeof record.id !== "string")
        throw invalidParams(`${body.method}.params.id must be a string`);
      if (
        record.sessionID !== undefined &&
        typeof record.sessionID !== "string"
      )
        throw invalidParams(`${body.method}.params.sessionID must be a string`);
      const target = {
        id: record.id,
        ...(record.sessionID ? { sessionID: record.sessionID as string } : {}),
      };
      if (body.method === "input.replace") {
        if (typeof record.text !== "string")
          throw invalidParams("input.replace.params.text must be a string");
        optionsGuard(client, "replaceInput");
        return {
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: await client.replaceInput({ ...target, text: record.text }),
        };
      }
      if (body.method === "input.remove") {
        optionsGuard(client, "removeInput");
        return {
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: await client.removeInput(target),
        };
      }
      optionsGuard(client, "promoteInput");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.promoteInput(target),
      };
    }
    if (body.method === "config.reload") {
      optionsGuard(client, "reloadConfig");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.reloadConfig!(),
      };
    }
    if (body.method === "config.canReload") {
      optionsGuard(client, "canReloadConfig");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.canReloadConfig!(),
      };
    }
    if (body.method === "runtime.availability") {
      // Derived from the client, so there is deliberately no options guard: this
      // answers "what does this runtime implement", and a runtime that implements
      // little must still be able to say so. Asking the runtime to declare it
      // would let the declaration drift from the code.
      //
      // The report carries the RPC channel's own reachability: what the runtime
      // implements intersected with the route table above. A consumer can now
      // tell "this runtime cannot" from "this connection cannot reach it" — the
      // `terminal`/`terminalSharing` retirement and the P0-B gap list both show
      // up here before any code outside this package does.
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: cullAvailabilityReport(
          describeRuntimeCapabilities(client, {
            name: "rpc",
            routedMembers: RPC_ROUTED_MEMBERS,
            // Members routed away on purpose keep their reason, so the report
            // distinguishes "forgotten" from "intentionally local".
            unreachableReasons: RPC_INTENTIONALLY_LOCAL,
          }),
          authorization,
        ),
      };
    }
    if (body.method === "runtime.status") {
      optionsGuard(client, "runtimeStatus");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.runtimeStatus?.(
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "diagnostics.list") {
      optionsGuard(client, "diagnostics");
      const limit = body.params?.limit;
      if (
        limit !== undefined &&
        (typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 500)
      )
        throw invalidParams(
          "diagnostics.list.params.limit must be an integer between 1 and 500",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.diagnostics(
          typeof limit === "number" ? limit : undefined,
          optionalStringParam(body.params, "sessionID"),
        ),
      };
    }
    if (body.method === "ast.move") {
      optionsGuard(client, "astMove");
      const record = (body.params ?? {}) as Record<string, unknown>;
      const before = record.before;
      const after = record.after;
      if (!Array.isArray(before) || !Array.isArray(after))
        throw invalidParams("invalid_parameters: before and after");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: (await client.astMove?.({
          before: before as never,
          after: after as never,
        })) ?? { moves: [] },
      };
    }
    if (body.method === "workspace.ast_move") {
      optionsGuard(client, "workspaceAstMove");
      const paths = stringArrayParam(body.params, "paths");
      const from = optionalStringParam(body.params, "from");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: (await client.workspaceAstMove?.(
          paths ? { paths, ...(from ? { from } : {}) } : from ? { from } : {},
        )) ?? {
          from: from ?? "HEAD",
          scanned: 0,
          skipped: [],
          moves: [],
        },
      };
    }
    if (body.method === "growth.promote") {
      optionsGuard(client, "promoteGrowthTrigger");
      const capability = optionalStringParam(body.params, "capability");
      if (!capability) throw invalidParams("invalid_parameters: capability");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: (await client.promoteGrowthTrigger?.({ capability })) ?? {
          promoted: false,
          reason: "no_session",
        },
      };
    }
    if (body.method === "growth.promotions") {
      optionsGuard(client, "growthPromotions");
      const sessionID = optionalStringParam(body.params, "sessionID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: (await client.growthPromotions?.(sessionID)) ?? [],
      };
    }
    if (body.method === "growth.triggers") {
      optionsGuard(client, "growthTriggers");
      const sessionID = optionalStringParam(body.params, "sessionID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: (await client.growthTriggers?.(sessionID)) ?? [],
      };
    }
    if (body.method === "eval.joined_tasks") {
      optionsGuard(client, "externalJoinedTasks");
      const sessionID = optionalStringParam(body.params, "sessionID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: (await client.externalJoinedTasks?.(sessionID)) ?? [],
      };
    }
    if (body.method === "corrections.patterns") {
      optionsGuard(client, "correctionPatterns");
      const sessionID = optionalStringParam(body.params, "sessionID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: (await client.correctionPatterns?.(sessionID)) ?? {
          suggestions: [],
          considered: { corrections: 0 },
        },
      };
    }
    if (body.method === "eval.external_run") {
      optionsGuard(client, "recordExternalRun");
      const record = (body.params ?? {}) as Record<string, unknown>;
      const taskID = optionalStringParam(body.params, "taskID");
      const turnID = optionalStringParam(body.params, "turnID");
      if (!taskID || !turnID)
        throw invalidParams("invalid_parameters: taskID and turnID");
      const dir = optionalStringParam(body.params, "dir");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: (await client.recordExternalRun?.({
          taskID,
          turnID,
          ...(dir ? { dir } : {}),
        })) ?? { recorded: false, reason: "no_eval_dir" },
      };
    }
    if (body.method === "eval.external_benchmark") {
      optionsGuard(client, "externalBenchmark");
      const dir = optionalStringParam(body.params, "dir");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: (await client.externalBenchmark?.(
          dir ? { dir } : undefined,
        )) ?? {
          joined: false,
          reason: "no_eval_dir",
          note: "name the frozen eval's directory",
        },
      };
    }
    if (body.method === "prompt.run_groups") {
      optionsGuard(client, "promptRunGroups");
      const sessionID = optionalStringParam(body.params, "sessionID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: (await client.promptRunGroups?.(sessionID)) ?? [],
      };
    }
    if (body.method === "growth.propose") {
      optionsGuard(client, "growthPropose");
      const params = body.params as Record<string, unknown> | undefined;
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: (await client.growthPropose?.(
          params?.planID === undefined
            ? undefined
            : { planID: String(params.planID) },
        )) ?? {
          proposalID: "growth:none",
          at: new Date().toISOString(),
          suggestions: [],
          considered: { tasks: 0, gaps: 0 },
        },
      };
    }
    if (body.method === "growth.proposals") {
      optionsGuard(client, "growthProposals");
      const sessionID = optionalStringParam(body.params, "sessionID");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: (await client.growthProposals?.(sessionID)) ?? [],
      };
    }
    if (body.method === "diagnostics.operations") {
      // T3/T4: the operation log's records for a host — the same records
      // the debug bundle reads. Filter-shaped params, no defaults invented.
      optionsGuard(client, "operationRecords");
      const params = body.params ?? {};
      for (const key of ["level", "component", "contains", "since"])
        if (params[key] !== undefined && typeof params[key] !== "string")
          throw invalidParams(
            `diagnostics.operations.params.${key} must be a string`,
          );
      const limit = params.limit;
      if (
        limit !== undefined &&
        (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)
      )
        throw invalidParams(
          "diagnostics.operations.params.limit must be a positive integer",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result:
          (await client.operationRecords?.({
            ...(typeof params.level === "string"
              ? {
                  level: params.level as
                    | "error"
                    | "warn"
                    | "info"
                    | "debug"
                    | "trace",
                }
              : {}),
            ...(typeof params.component === "string"
              ? { component: params.component }
              : {}),
            ...(typeof params.contains === "string"
              ? { contains: params.contains }
              : {}),
            ...(typeof params.since === "string"
              ? { since: params.since }
              : {}),
            ...(typeof limit === "number" ? { limit } : {}),
          })) ?? [],
      };
    }
    if (body.method === "mcp.prompt") {
      optionsGuard(client, "getMcpPrompt");
      const arguments_ = body.params?.arguments;
      if (
        arguments_ !== undefined &&
        (!arguments_ ||
          typeof arguments_ !== "object" ||
          Array.isArray(arguments_))
      )
        throw invalidParams("mcp.prompt.params.arguments must be an object");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.getMcpPrompt(
          stringParam(body.params, "server"),
          stringParam(body.params, "name"),
          arguments_ as Record<string, string> | undefined,
          optionalStringParam(body.params, "workspaceID"),
        ),
      };
    }
    if (body.method === "mcp.resource") {
      optionsGuard(client, "readMcpResource");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.readMcpResource(
          stringParam(body.params, "server"),
          stringParam(body.params, "uri"),
          optionalStringParam(body.params, "workspaceID"),
        ),
      };
    }
    if (body.method === "mcp.server.add") {
      optionsGuard(client, "mcpServerAdd");
      const params = body.params;
      if (!params || typeof params !== "object")
        throw invalidParams("mcp.server.add.params must be an object");
      const name = (params as { name?: unknown }).name;
      const config = (params as { config?: unknown }).config;
      if (typeof name !== "string" || !name)
        throw invalidParams(
          "mcp.server.add.params.name must be a non-empty string",
        );
      if (!config || typeof config !== "object")
        throw invalidParams("mcp.server.add.params.config must be an object");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.mcpServerAdd?.({
          name,
          config: config as never,
          ...(optionalStringParam(body.params, "workspaceID")
            ? { workspaceID: optionalStringParam(body.params, "workspaceID")! }
            : {}),
        }),
      };
    }
    if (body.method === "mcp.server.remove") {
      optionsGuard(client, "mcpServerRemove");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.mcpServerRemove(
          stringParam(body.params, "name"),
          optionalStringParam(body.params, "workspaceID"),
        ),
      };
    }
    if (body.method === "permission.list") {
      optionsGuard(client, "permissionList");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.permissionList?.(),
      };
    }
    if (body.method === "permission.save") {
      optionsGuard(client, "permissionSave");
      const params = body.params;
      if (!params || typeof params !== "object")
        throw invalidParams("permission.save.params must be an object");
      const name = (params as { name?: unknown }).name;
      const profile = (params as { profile?: unknown }).profile;
      if (typeof name !== "string" || !name)
        throw invalidParams(
          "permission.save.params.name must be a non-empty string",
        );
      if (!profile || typeof profile !== "object")
        throw invalidParams("permission.save.params.profile must be an object");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.permissionSave?.({
          name,
          profile: profile as never,
        }),
      };
    }
    if (body.method === "permission.delete") {
      optionsGuard(client, "permissionDelete");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.permissionDelete(stringParam(body.params, "name")),
      };
    }
    // --- P0-K: agent, provider and plugin management ---
    const managementName = (params: unknown, method: string) => {
      const value = (params as { name?: unknown })?.name;
      if (typeof value !== "string" || !value)
        throw invalidParams(`${method}.params.name must be a non-empty string`);
      return value;
    };
    const managementObject = (params: unknown, method: string) => {
      const value = (params as { config?: unknown })?.config;
      if (!value || typeof value !== "object")
        throw invalidParams(`${method}.params.config must be an object`);
      return value as never;
    };
    if (body.method === "agent.create" || body.method === "agent.update") {
      const member =
        body.method === "agent.create" ? "agentCreate" : "agentUpdate";
      optionsGuard(client, member);
      const name = managementName(body.params, body.method);
      const config = managementObject(body.params, body.method);
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result:
          body.method === "agent.create"
            ? await client.agentCreate?.({
                name,
                config,
                ...(optionalStringParam(body.params, "workspaceID")
                  ? {
                      workspaceID: optionalStringParam(
                        body.params,
                        "workspaceID",
                      )!,
                    }
                  : {}),
              })
            : await client.agentUpdate?.({
                name,
                config,
                ...(optionalStringParam(body.params, "workspaceID")
                  ? {
                      workspaceID: optionalStringParam(
                        body.params,
                        "workspaceID",
                      )!,
                    }
                  : {}),
              }),
      };
    }
    if (body.method === "agent.delete") {
      optionsGuard(client, "agentDelete");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.agentDelete(
          managementName(body.params, "agent.delete"),
          optionalStringParam(body.params, "workspaceID"),
        ),
      };
    }
    if (body.method === "provider.discover") {
      optionsGuard(client, "providerDiscover");
      const params = body.params;
      if (!params || typeof params !== "object")
        throw invalidParams("provider.discover.params must be an object");
      const type = (params as { type?: unknown }).type;
      const baseURL = (params as { baseURL?: unknown }).baseURL;
      const apiKey = (params as { apiKey?: unknown }).apiKey;
      const headers = (params as { headers?: unknown }).headers;
      if (typeof type !== "string" || !type)
        throw invalidParams(
          "provider.discover.params.type must be a non-empty string",
        );
      if (typeof baseURL !== "string" || !baseURL)
        throw invalidParams(
          "provider.discover.params.baseURL must be a non-empty string",
        );
      if (typeof apiKey !== "string")
        throw invalidParams("provider.discover.params.apiKey must be a string");
      if (
        headers !== undefined &&
        (typeof headers !== "object" ||
          headers === null ||
          Array.isArray(headers) ||
          !Object.values(headers as Record<string, unknown>).every(
            (value) => typeof value === "string",
          ))
      )
        throw invalidParams(
          "provider.discover.params.headers must contain only string values",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.providerDiscover?.({
          type,
          baseURL,
          apiKey,
          headers: headers as Record<string, string> | undefined,
        }),
      };
    }
    if (body.method === "provider.add") {
      optionsGuard(client, "providerAdd");
      const params = body.params;
      if (!params || typeof params !== "object")
        throw invalidParams("provider.add.params must be an object");
      const name = (params as { name?: unknown }).name;
      const type = (params as { type?: unknown }).type;
      const apiKey = (params as { apiKey?: unknown }).apiKey;
      const baseURL = (params as { baseURL?: unknown }).baseURL;
      if (typeof name !== "string" || !name)
        throw invalidParams(
          "provider.add.params.name must be a non-empty string",
        );
      if (typeof type !== "string" || !type)
        throw invalidParams(
          "provider.add.params.type must be a non-empty string",
        );
      if (typeof apiKey !== "string")
        throw invalidParams("provider.add.params.apiKey must be a string");
      const headers = (params as { headers?: unknown }).headers;
      const models = (params as { models?: unknown }).models;
      const label = (params as { label?: unknown }).label;
      const previousName = (params as { previousName?: unknown }).previousName;
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.providerAdd?.({
          name,
          type,
          apiKey,
          baseURL: typeof baseURL === "string" && baseURL ? baseURL : undefined,
          ...(typeof label === "string" && label ? { label } : {}),
          ...(typeof previousName === "string" && previousName
            ? { previousName }
            : {}),
          ...(headers && typeof headers === "object"
            ? { headers: headers as Record<string, string> }
            : {}),
          ...(Array.isArray(models)
            ? {
                models: models as Array<{
                  id: string;
                  name?: string;
                  reasoning?: boolean;
                  image?: boolean;
                }>,
              }
            : {}),
        }),
      };
    }
    if (body.method === "provider.remove") {
      optionsGuard(client, "providerRemove");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.providerRemove(
          managementName(body.params, "provider.remove"),
        ),
      };
    }
    if (body.method === "plugin.unload" || body.method === "plugin.reload") {
      const member =
        body.method === "plugin.unload" ? "pluginUnload" : "pluginReload";
      optionsGuard(client, member);
      const id = managementName(body.params, body.method);
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result:
          body.method === "plugin.unload"
            ? await client.pluginUnload?.(id)
            : await client.pluginReload?.(id),
      };
    }
    if (body.method === "plugin.install") {
      optionsGuard(client, "pluginInstall");
      const params = body.params as { spec?: unknown };
      if (!params || typeof params.spec !== "string")
        throw invalidParams("plugin.install.params.spec must be a string");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.pluginInstall?.({ spec: params.spec }),
      };
    }
    if (body.method === "plugin.uninstall") {
      optionsGuard(client, "pluginUninstall");
      const params = body.params as { pluginID?: unknown };
      if (!params || typeof params.pluginID !== "string")
        throw invalidParams(
          "plugin.uninstall.params.pluginID must be a string",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.pluginUninstall?.({ pluginID: params.pluginID }),
      };
    }
    if (body.method === "plugin.catalog") {
      optionsGuard(client, "pluginCatalog");
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.pluginCatalog?.(),
      };
    }
    if (body.method === "plugin.set-enabled") {
      optionsGuard(client, "pluginSetEnabled");
      const params = body.params as { pluginID?: unknown; enabled?: unknown };
      if (
        !params ||
        typeof params.pluginID !== "string" ||
        typeof params.enabled !== "boolean"
      )
        throw invalidParams(
          "plugin.set-enabled.params.pluginID/enabled is required",
        );
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.pluginSetEnabled?.({
          pluginID: params.pluginID,
          enabled: params.enabled,
        }),
      };
    }
    if (body.method === "tools.reload") {
      const member = "toolFamilyReload";
      optionsGuard(client, member);
      const id = managementName(body.params, body.method);
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: await client.toolFamilyReload?.(id),
      };
    }
    // A name the route table accepted but no dispatch block serves: the table
    // and the code drifted. `-32601` still, so a consumer gets the same answer
    // it would for a truly unknown name.
    throw new RuntimeMethodNotFound(body.method ?? "");
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id: request?.id ?? null,
      error: describeFailure(error, client, request?.method),
    };
  }
}

/**
 * Turns a thrown error into a JSON-RPC error object.
 *
 * Classification comes from the typed failure the thrower attached, never from
 * reading its message: matching on prose is how a refusal quietly becomes a bug
 * report the day someone rewords a string.
 *
 * An error with no classification is internal by definition. Its message is
 * dropped rather than forwarded, because at this point we do not know what is in
 * it — `ENOENT: ... stat '/home/someone/project/secret'` is a real example. The
 * detail is published as a durable diagnostic under an ID that travels with the
 * error, so whoever can read `diagnostics.list` can still find it.
 */
function describeFailure(
  error: unknown,
  client: RuntimeClient,
  method: string | undefined,
): { code: number; message: string; data: RuntimeFailureData } {
  const classified = runtimeFailureData(error);
  if (classified)
    return {
      code: RUNTIME_RPC_ERROR_CODES[classified.kind],
      message: error instanceof Error ? error.message : String(error),
      data: classified,
    };
  const message = error instanceof Error ? error.message : String(error);
  const errorID = `err_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  // Reporting a failure must not be able to fail. `diagnostic` is required by the
  // contract, but this path runs for clients that are wrong about that, and a
  // throw here would replace the caller's answer with a broken connection. The
  // reply is the same either way; only the durable copy of the detail is lost.
  try {
    client.diagnostic(
      `rpc ${method ?? "request"} failed [${errorID}]: ${message}`,
      "error",
    );
  } catch {
    /* a runtime that cannot record its own failure still owes the caller a reply */
  }
  return {
    code: RUNTIME_RPC_ERROR_CODES.internal,
    message: "internal runtime failure",
    data: { kind: "internal", errorID },
  };
}
