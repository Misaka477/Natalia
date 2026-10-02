/**
 * The interactive waiter: approvals and questions the runtime is waiting on.
 *
 * This is the runtime's only blocking conversation with a human, and it owns the
 * whole of it — the pending records, the waiters, the session-scoped grants and
 * the terminal approval scopes. What it takes from the runtime is deliberately
 * narrow: somewhere to publish events, the identity of the session, and a live
 * view of the three things that change underneath it.
 *
 * Those three are passed as functions rather than values because all of them
 * change during the client's life: a captured permission mode would keep asking
 * for approval after a switch to `auto`, and a captured abort signal would leave a
 * waiter listening to a turn that has already ended.
 *
 * Two rules here are load-bearing rather than incidental:
 *
 *   - **Session grants live in memory only.** Reopening a durable session must
 *     never silently restore permission to cause side effects, so granted tools
 *     and terminal scopes belong to this client instance and are never journaled.
 *   - **A timeout is not a cancellation.** Nobody answering is not the same as
 *     someone stopping the work: an expired approval tells the model the call did
 *     not run so the turn can continue, while an abort ends the turn.
 */
import type {
  ApprovalResponse,
  InteractiveResponse,
  InteractiveResponseOutcome,
  JsonValue,
  QuestionResponse,
  RuntimeEvent,
  SessionID,
} from "@anthelia/contracts";
import {
  classifyPermissionFamily,
  PERMISSION_FAMILIES,
} from "@anthelia/contracts";
import type { ProviderToolCall } from "@anthelia/runtime";
import { parseToolArguments, type RuntimeTool } from "@anthelia/tools";
import { projectInteractiveRequests } from "@anthelia/session";
import type {} from "@anthelia/runtime-services";
import type {
  InteractiveWaiter,
  InteractiveWaiterDeps,
} from "@natalia/collaboration";
import {
  defineService,
  readOnlyToolMessage,
  terminalApprovalScope,
} from "@anthelia/runtime-services";
import { projectGrantFamilies } from "./project-grants";

/**
 * The waiter's service token. The id is the wire name the runtime has always
 * used for this binding; the token adds the typed face so consumers resolve it
 * without a `<T>` cast and the id lives in the package that owns the service
 * rather than a central table.
 */
export const collaborationWaiter = defineService<InteractiveWaiter>(
  "collaboration.waiter",
  { scope: "workspace", capability: "services" },
);

export function createInteractiveWaiter(
  deps: InteractiveWaiterDeps,
): InteractiveWaiter {
  const { publish } = deps;
  const pendingApprovals = new Map<string, ApprovalResponse>();
  const pendingApprovalRequests = new Set<string>();
  const approvalSessionByID = new Map<string, SessionID>();
  // These grants only live in this RuntimeClient instance. Reopening a
  // durable session must never silently restore side-effecting permissions.
  // D5.3: they are keyed per session — what session A approved never grants
  // session B, and a background turn of A keeps its grants when the UI
  // attaches to B.
  const sessionApprovedFamilies = new Map<SessionID, Set<string>>();
  // The project-wide grants: a human's standing "always allow in this
  // project" for a permission family. Runtime-wide (the project is the
  // workspace, not the session), seeded from the journal's durable
  // approval.response {decision:"project"} records — the restore fold runs
  // once per session, lazily, before the first approval of that session.
  const projectApprovedFamilies = new Set<string>();
  const projectRestoredSessions = new Set<SessionID>();
  const approvalFamilyByID = new Map<
    string,
    ReturnType<typeof classifyPermissionFamily>
  >();
  const approvalWorkGraphContext = new Map<
    string,
    { turnID: string; callID: string; toolName: string }
  >();
  const approvalWaiters = new Map<
    string,
    (response: ApprovalResponse) => void
  >();
  const pendingQuestions = new Map<string, QuestionResponse>();
  const questionTurnByID = new Map<string, string>();
  const questionWaiters = new Map<
    string,
    (response: QuestionResponse) => void
  >();
  const pendingInteractives = new Map<string, InteractiveResponse>();
  const interactiveSessionByID = new Map<string, SessionID>();
  const interactiveWaiters = new Map<
    string,
    (response: InteractiveResponse) => void
  >();

  async function requireApproval(
    approvalID: string,
    tool: RuntimeTool,
    call: ProviderToolCall,
    turnID: string,
    options?: { force?: boolean; reason?: string },
  ): Promise<{ reason: string } | undefined> {
    const permissionMode = deps.permissionMode(turnID);
    if (permissionMode === "read_only")
      return { reason: readOnlyToolMessage(tool.name) };
    if (permissionMode === "auto" && !options?.force) return undefined;
    const session = deps.sessionIDForTurn(turnID);
    const agentID = deps.agentIDForTurn?.(turnID);
    const permissionFamily = classifyPermissionFamily(
      tool.name,
      deps.capabilityOwnerForTool?.(tool.name),
    );
    if (!options?.force) {
      if (sessionApprovedFamilies.get(session)?.has(permissionFamily.id))
        return undefined;
      restoreProjectGrantsForSession(session);
      if (projectApprovedFamilies.has(permissionFamily.id)) return undefined;
    }
    const terminalApproval = terminalApprovalScope(tool.name, call.arguments);
    const presentation = approvalPresentation(tool.name, call.arguments);
    const expiresAt =
      terminalApproval?.risk === "terminal_low"
        ? Date.now() + terminalApproval.ttlMs
        : undefined;
    // Establish every lookup before publishing. Event sinks are allowed to reply
    // synchronously; publishing first made an immediate `respondApproval()` look
    // like a response to a non-pending request and silently ignored it.
    pendingApprovalRequests.add(approvalID);
    approvalSessionByID.set(approvalID, session);
    approvalWorkGraphContext.set(approvalID, {
      turnID,
      callID: call.id,
      toolName: tool.name,
    });
    approvalFamilyByID.set(approvalID, permissionFamily);
    deps.publishForSession(session, {
      type: "approval.request",
      id: approvalID,
      title: options?.force
        ? `Approve ${options.reason ?? tool.name}`
        : `Approve ${tool.name}`,
      preview: presentation.preview,
      detail: options?.reason
        ? `${options.reason}\n${presentation.detail ?? ""}`.trim()
        : presentation.detail,
      keyArguments: presentation.keyArguments,
      sensitive: presentation.sensitive,
      risk: terminalApproval?.risk,
      scope: terminalApproval?.scope,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      revocable: terminalApproval ? true : undefined,
      ...(options?.force ? { allowSession: false, allowProject: false } : {}),
      permissionFamily,
      agentID,
    });
    try {
      const response = await waitForResponse(
        approvalID,
        pendingApprovals,
        approvalWaiters,
        deps.abortSignal(turnID),
        `approval timed out: ${tool.name}`,
        expiresAt === undefined
          ? undefined
          : Math.max(0, expiresAt - Date.now()),
      );
      if (response.decision !== "reject") return undefined;
      deps.publishForSession(session, {
        type: "policy.decision",
        turnID,
        toolName: tool.name,
        toolCallID: call.id,
        decision: "rejected",
        reason: response.feedback,
        agentID,
      });
      return { reason: rejectedToolMessage(tool.name, response.feedback) };
    } catch (error) {
      // A cancellation is a deliberate stop and still ends the turn. A timeout
      // is not: nobody answered, and discarding the whole turn after a long
      // wait loses more work than telling the model the request expired. Both
      // must settle the durable request, or the UI re-opens it forever.
      const aborted = deps.abortSignal(turnID)?.aborted === true;
      const reason = aborted
        ? "turn cancelled before an answer"
        : "approval expired without an answer";
      settleApproval(session, approvalID, reason, agentID);
      if (aborted) throw error;
      deps.publishForSession(session, {
        type: "policy.decision",
        turnID,
        toolName: tool.name,
        toolCallID: call.id,
        decision: "rejected",
        reason,
        agentID,
      });
      return { reason: expiredToolMessage(tool.name) };
    } finally {
      pendingApprovalRequests.delete(approvalID);
      approvalFamilyByID.delete(approvalID);
      approvalWorkGraphContext.delete(approvalID);
      approvalSessionByID.delete(approvalID);
    }
  }

  async function requireQuestion(
    requestID: string,
    turnID: string,
    request: {
      title: string;
      questions: Array<{
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description?: string }>;
        multiple?: boolean;
        custom?: boolean;
      }>;
    },
  ) {
    const session = deps.sessionIDForTurn(turnID);
    const agentID = deps.agentIDForTurn?.(turnID);
    questionTurnByID.set(requestID, turnID);
    deps.publishForSession(session, {
      type: "question.request",
      id: requestID,
      ...request,
      agentID,
    });
    let answered = false;
    try {
      const response = await waitForResponse(
        requestID,
        pendingQuestions,
        questionWaiters,
        deps.abortSignal(turnID),
        "question timed out",
        // ask_user has no timeout: it waits for the human until answered or
        // cancelled. Cancel/abort still exits through the signal.
        undefined,
      );
      answered = true;
      if (response.rejected) throw new Error("user rejected question");
      return response.answers;
    } finally {
      if (!answered)
        settleQuestion(
          session,
          requestID,
          deps.abortSignal(turnID)?.aborted === true
            ? "turn cancelled before an answer"
            : "question wait ended without an answer",
          agentID,
        );
      questionTurnByID.delete(requestID);
    }
  }

  /**
   * Issues a generic interactive request and waits for the human/UI response.
   * The runtime publishes an opaque `interactive.request`; `validate` is the
   * in-process business authority and runs after the answer arrives.
   */
  async function requireInteractive(input: {
    requestID: string;
    turnID: string;
    kind: string;
    title: string;
    payload: JsonValue;
    responseSchema?: import("@anthelia/contracts").JsonSchema;
    expiresAt?: string;
    priority?: number;
    validate?(response: JsonValue): string[] | void;
  }) {
    const session = deps.sessionIDForTurn(input.turnID);
    const agentID = deps.agentIDForTurn?.(input.turnID);
    interactiveSessionByID.set(input.requestID, session);
    deps.publishForSession(session, {
      type: "interactive.request",
      id: input.requestID,
      kind: input.kind,
      title: input.title,
      payload: input.payload,
      ...(input.responseSchema ? { responseSchema: input.responseSchema } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      agentID,
    });
    let answered = false;
    try {
      const response = await waitForResponse(
        input.requestID,
        pendingInteractives,
        interactiveWaiters,
        deps.abortSignal(input.turnID),
        "interactive request timed out",
        input.expiresAt === undefined
          ? undefined
          : Math.max(0, Date.parse(input.expiresAt) - Date.now()),
      );
      answered = true;
      if (response.rejected)
        throw new Error("user rejected interactive request");
      const errors = input.validate?.(response.response);
      if (errors && errors.length)
        throw new Error(`invalid interactive response: ${errors.join("; ")}`);
      return { response: response.response, rejected: response.rejected };
    } finally {
      if (!answered)
        settleInteractive(
          session,
          input.requestID,
          input.kind,
          deps.abortSignal(input.turnID)?.aborted === true
            ? "turn cancelled before an answer"
            : "interactive wait ended without an answer",
          agentID,
        );
      interactiveSessionByID.delete(input.requestID);
    }
  }

  /**
   * Answers a generic interactive request. The runtime validates the envelope
   * (id/kind) only; business validation happened in the initiator's `validate`.
   */
  function respondInteractive(
    response: InteractiveResponse,
  ): InteractiveResponseOutcome {
    const respondSession =
      interactiveSessionByID.get(response.requestID) ??
      (response.sessionID as SessionID | undefined) ??
      deps.sessionID();
    if (
      !interactiveWaiters.has(response.requestID) &&
      !pendingInteractives.has(response.requestID) &&
      !deps.isPending(respondSession, response.requestID, response.kind)
    ) {
      publish({
        type: "diagnostic",
        level: "warning",
        message: "ignored interactive response for a non-pending request",
      });
      return {
        accepted: false,
        reason: "the interactive request is no longer pending",
      };
    }
    deps.publishForSession(respondSession, {
      type: "interactive.response",
      id: response.requestID,
      kind: response.kind,
      response: response.response,
      ...(response.rejected ? { rejected: true } : {}),
    });
    pendingInteractives.set(response.requestID, response);
    interactiveWaiters.get(response.requestID)?.(response);
    return { accepted: true };
  }

  function settleInteractive(
    session: SessionID,
    requestID: string,
    kind: string,
    reason: string,
    agentID?: string,
  ) {
    if (!deps.isPending(session, requestID, kind)) return;
    deps.publishForSession(session, {
      type: "interactive.response",
      id: requestID,
      kind,
      response: null,
      rejected: true,
      ...(agentID === undefined ? {} : { agentID }),
    });
    publish({
      type: "diagnostic",
      level: "warning",
      message: `interactive ${requestID} closed without an answer: ${reason}`,
    });
  }

  function restoreInteractiveState(events: RuntimeEvent[]) {
    const pending = projectInteractiveRequests(events);
    restoreRecoveredInteractiveState(
      pending.approvals,
      pending.questions,
      pending.interactives,
    );
  }

  function restoreRecoveredInteractiveState(
    approvals: Array<Extract<RuntimeEvent, { type: "approval.request" }>>,
    questions: Array<Extract<RuntimeEvent, { type: "question.request" }>>,
    interactives: Array<
      Extract<RuntimeEvent, { type: "interactive.request" }>
    > = [],
  ) {
    for (const request of approvals) {
      pendingApprovalRequests.add(request.id);
      publish({
        type: "diagnostic",
        level: "warning",
        message: `Recovered unresolved approval record ${request.id}; active tool execution was not replayed and must be resubmitted after a response.`,
      });
    }
    for (const request of questions)
      publish({
        type: "diagnostic",
        level: "warning",
        message: `Recovered unresolved question record ${request.id}; active tool execution was not replayed and must be resubmitted after an answer.`,
      });
    for (const request of interactives)
      publish({
        type: "diagnostic",
        level: "warning",
        message: `Recovered unresolved interactive record ${request.id} (${request.kind}); active tool execution was not replayed and must be resubmitted after a response.`,
      });
  }

  /**
   * Answers an approval. Everything is published before the waiter is settled, so
   * a sink that replies synchronously cannot observe a half-resolved request.
   */
  function respondApproval(
    response: ApprovalResponse,
  ): InteractiveResponseOutcome {
    const respondGraph = approvalWorkGraphContext.get(response.requestID);
    // Prefer the live waiter's own session. Only when the request has no live
    // waiter (recovered/stale) fall back to the client's routing hint, then to
    // the work-graph turn, then to the attached session.
    const respondSession =
      approvalSessionByID.get(response.requestID) ??
      (response.sessionID as SessionID | undefined) ??
      (respondGraph
        ? deps.sessionIDForTurn(respondGraph.turnID)
        : deps.sessionID());
    if (
      !pendingApprovalRequests.has(response.requestID) &&
      !deps.isPending(respondSession, response.requestID, "approval")
    ) {
      publish({
        type: "diagnostic",
        level: "warning",
        message: "ignored approval response for a non-pending request",
      });
      // The waiter already knew this; the caller did not. An external UI has to
      // learn that its answer arrived too late, because "the model was told this
      // call did not run" is a different fact from "your answer took effect".
      return {
        accepted: false,
        reason: "the approval request is no longer pending",
      };
    }
    const graphContext = approvalWorkGraphContext.get(response.requestID);
    const responseSession = respondSession;
    const agentID = graphContext
      ? deps.agentIDForTurn?.(graphContext.turnID)
      : undefined;
    deps.publishForSession(responseSession, {
      type: "approval.response",
      id: response.requestID,
      decision: response.decision,
      feedback: response.feedback,
      agentID,
    });
    // A resolved approval is a Work Graph fact: who authorized a side effect.
    // The decision is recorded; the preview text is not, because it can carry a
    // command line.
    deps.publishForSession(responseSession, {
      ...deps.workLedger().approvalNode({
        approvalID: response.requestID,
        decision: response.decision,
        toolName: graphContext?.toolName,
        sessionID: responseSession,
        turnID: graphContext?.turnID,
      }),
      agentID,
    });
    if (graphContext)
      deps.publishForSession(responseSession, {
        ...deps.workLedger().approvalEdge({
          approvalID: response.requestID,
          decision: response.decision,
          turnID: graphContext.turnID,
          callID: graphContext.callID,
        }),
        agentID,
      });
    if (response.decision === "session") {
      const session = responseSession;
      const family = approvalFamilyByID.get(response.requestID);
      if (family) {
        const approved = sessionApprovedFamilies.get(session) ?? new Set();
        approved.add(family.id);
        sessionApprovedFamilies.set(session, approved);
      }
    }
    if (response.decision === "project") {
      // The standing grant. The response event published above is its
      // durable record — the restore fold reads exactly that.
      const family = approvalFamilyByID.get(response.requestID);
      if (family) projectApprovedFamilies.add(family.id);
    }
    pendingApprovals.set(response.requestID, response);
    pendingApprovalRequests.delete(response.requestID);
    approvalSessionByID.delete(response.requestID);
    approvalWaiters.get(response.requestID)?.(response);
    return { accepted: true };
  }

  function respondQuestion(
    response: QuestionResponse,
  ): InteractiveResponseOutcome {
    const questionTurn = questionTurnByID.get(response.requestID);
    // Prefer the live waiter's own session; fall back to the client's routing
    // hint for recovered/stale requests, then to the attached session.
    const questionSession =
      (questionTurn ? deps.sessionIDForTurn(questionTurn) : undefined) ??
      (response.sessionID as SessionID | undefined) ??
      deps.sessionID();
    if (
      !questionTurn &&
      !deps.isPending(questionSession, response.requestID, "question")
    ) {
      publish({
        type: "diagnostic",
        level: "warning",
        message: "ignored question response for a non-pending request",
      });
      return {
        accepted: false,
        reason: "the question request is no longer pending",
      };
    }
    deps.publishForSession(questionSession, {
      type: "question.response",
      id: response.requestID,
      answers: response.answers,
      rejected: response.rejected,
      agentID: questionTurn ? deps.agentIDForTurn?.(questionTurn) : undefined,
    });
    pendingQuestions.set(response.requestID, response);
    questionWaiters.get(response.requestID)?.(response);
    return { accepted: true };
  }

  /**
   * Closes a request that will never be answered (cancelled or expired) so the
   * durable journal stops reporting it as pending. Without this, a dismissed or
   * timed-out request re-appears on every session re-attach.
   */
  function settleApproval(
    session: SessionID,
    approvalID: string,
    reason: string,
    agentID?: string,
  ) {
    if (!deps.isPending(session, approvalID, "approval")) return;
    deps.publishForSession(session, {
      type: "approval.response",
      id: approvalID,
      decision: "reject",
      feedback: reason,
      ...(agentID === undefined ? {} : { agentID }),
    });
    publish({
      type: "diagnostic",
      level: "warning",
      message: `approval ${approvalID} closed without an answer: ${reason}`,
    });
  }

  function settleQuestion(
    session: SessionID,
    requestID: string,
    reason: string,
    agentID?: string,
  ) {
    if (!deps.isPending(session, requestID, "question")) return;
    deps.publishForSession(session, {
      type: "question.response",
      id: requestID,
      answers: [],
      rejected: true,
      ...(agentID === undefined ? {} : { agentID }),
    });
    publish({
      type: "diagnostic",
      level: "warning",
      message: `question ${requestID} closed without an answer: ${reason}`,
    });
  }

  /**
   * Drops the current session's interactive-terminal family grant. Someone revoking it expects the model's
   * next keystroke to ask again, so it takes effect now rather than on expiry.
   * Revocation is a UI action, so it targets the currently attached session.
   */
  function revokeTerminalApprovalScope(terminalID: string) {
    const scope = `terminal:${terminalID}:low-risk`;
    const revoked =
      sessionApprovedFamilies
        .get(deps.sessionID())
        ?.delete(PERMISSION_FAMILIES.interactiveTerminal.id) === true;
    if (revoked)
      publish({
        type: "diagnostic",
        level: "info",
        message: `revoked terminal approval scope: ${scope}`,
      });
    return { id: terminalID, scope, revoked };
  }

  /** Whether anyone is still waiting on a human, which teardown has to know. */
  function hasPendingWaiters() {
    return (
      approvalWaiters.size > 0 ||
      questionWaiters.size > 0 ||
      interactiveWaiters.size > 0
    );
  }

  async function requirePlanAcceptance(input: {
    approvalID: string;
    planID: string;
    title: string;
    detail: string;
    preview?: string;
    scope?: string;
    sessionID?: SessionID;
    permissionMode?: "ask" | "auto" | "read_only";
    signal?: AbortSignal;
    permissionFamily?: import("@anthelia/contracts").PermissionFamily;
    /**
     * EI §3.7.1/3.7.2: a rule-class (or other user-tier) change must be
     * confirmed per item by the human. When true, the gate is NOT auto-granted
     * in `auto` mode, the session-level "Allow … for session" shortcut is
     * skipped, and the card is published with `allowSession: false` so the UI
     * never offers it. Only rule/user-safety commitments set this.
     */
    requireExplicit?: boolean;
  }): Promise<ApprovalResponse | undefined> {
    const permissionMode = input.permissionMode ?? deps.permissionMode();
    const sessionID = input.sessionID ?? deps.sessionID();
    const family = input.permissionFamily ?? PERMISSION_FAMILIES.planning;
    if (permissionMode === "auto" && !input.requireExplicit)
      return { requestID: input.approvalID, decision: "once" };
    if (permissionMode === "read_only")
      return {
        requestID: input.approvalID,
        decision: "reject",
        feedback: "read_only",
      };
    if (
      !input.requireExplicit &&
      sessionApprovedFamilies.get(sessionID)?.has(family.id)
    )
      return { requestID: input.approvalID, decision: "session" };
    // Establish the pending record before publishing, so a synchronous
    // `respondApproval` from an event sink is not mistaken for a response to a
    // non-pending request (same rule as tool approvals, §waiter).
    pendingApprovalRequests.add(input.approvalID);
    approvalSessionByID.set(input.approvalID, sessionID);
    approvalFamilyByID.set(input.approvalID, family);
    deps.publishForSession(sessionID, {
      type: "approval.request",
      id: input.approvalID,
      title: input.title,
      preview: input.preview ?? `Accept plan ${input.planID}`,
      detail: input.detail,
      keyArguments: [input.planID],
      sensitive: false,
      scope: input.scope ?? family.scope,
      permissionFamily: family,
      ...(input.requireExplicit ? { allowSession: false } : {}),
    });
    try {
      return await waitForResponse(
        input.approvalID,
        pendingApprovals,
        approvalWaiters,
        input.signal,
        `plan acceptance timed out: ${input.planID}`,
        // Plan acceptance waits for the human; cancel/abort still exits.
        undefined,
      );
    } catch (error) {
      settleApproval(
        sessionID,
        input.approvalID,
        input.signal?.aborted
          ? "turn cancelled before an answer"
          : "plan acceptance ended without an answer",
      );
      if (input.signal?.aborted) throw error;
      return undefined;
    } finally {
      pendingApprovalRequests.delete(input.approvalID);
      approvalSessionByID.delete(input.approvalID);
    }
  }

  /**
   * The project-grant restore, once per session: fold the journal's
   * durable `approval.response {decision:"project"}` records and merge
   * the granted families. Idempotent per session; a later session's
   * journal can only add grants (a revoke is a separate explicit act).
   */
  function restoreProjectGrantsForSession(session: SessionID): void {
    if (projectRestoredSessions.has(session)) return;
    projectRestoredSessions.add(session);
    const events = deps.sessionEvents?.(session);
    if (!events) return;
    for (const family of projectGrantFamilies(events))
      projectApprovedFamilies.add(family);
  }

  return {
    requireApproval,
    requireQuestion,
    requireInteractive,
    requirePlanAcceptance,
    respondApproval,
    respondQuestion,
    respondInteractive,
    restoreInteractiveState,
    restoreRecoveredInteractiveState,
    revokeTerminalApprovalScope,
    hasPendingWaiters,
    restoreProjectGrants(families: Iterable<string>) {
      for (const family of families) projectApprovedFamilies.add(family);
    },
    projectGrantedFamilies() {
      return [...projectApprovedFamilies];
    },
  };
}

function waitForResponse<T>(
  id: string,
  responses: Map<string, T>,
  waiters: Map<string, (response: T) => void>,
  signal: AbortSignal | undefined,
  timeoutMessage: string,
  timeoutMs: number | undefined,
) {
  const existing = responses.get(id);
  if (existing) {
    responses.delete(id);
    return Promise.resolve(existing);
  }
  return new Promise<T>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = () =>
      finish(() => reject(signal?.reason ?? new Error("request cancelled")));
    const finish = (settle: () => void) => {
      if (timeout !== undefined) clearTimeout(timeout);
      waiters.delete(id);
      signal?.removeEventListener("abort", abort);
      settle();
    };
    // A timeout is optional: questions wait for a human until answered or
    // cancelled, while approvals/plan acceptance may carry their own expiry.
    if (timeoutMs !== undefined)
      timeout = setTimeout(
        () => finish(() => reject(new Error(timeoutMessage))),
        timeoutMs,
      );
    waiters.set(id, (response) => {
      responses.delete(id);
      finish(() => resolve(response));
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    const raced = responses.get(id);
    if (raced) waiters.get(id)?.(raced);
  });
}

function approvalPresentation(toolName: string, rawArguments: string) {
  let args: Record<string, unknown> | undefined;
  try {
    const parsed = parseToolArguments(rawArguments);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      args = parsed as Record<string, unknown>;
  } catch {
    // Keep malformed raw arguments only in the explicit detail pane.
  }
  const keyArguments = [`tool=${toolName}`];
  const terminalID = typeof args?.id === "string" ? args.id : undefined;
  if (terminalID && toolName.startsWith("interactive_terminal_"))
    keyArguments.push(`terminal=${terminalID}`);
  const path = typeof args?.path === "string" ? args.path : undefined;
  if (path) keyArguments.push(`path=${path}`);
  const sensitive = Object.keys(args ?? {}).some((key) =>
    /api[_-]?key|token|secret|password|authorization|cookie/iu.test(key),
  );
  const content = typeof args?.content === "string" ? args.content : undefined;
  const command = typeof args?.command === "string" ? args.command : undefined;
  const preview =
    toolName === "write_file" && path
      ? [
          `Write ${path}`,
          content === undefined
            ? "Content: unavailable"
            : `Content: ${Array.from(content).length} chars${content.trim() ? ` · ${singleLine(content, 160)}` : ""}`,
        ].join("\n")
      : command
        ? `Run command: ${singleLine(command, 220)}`
        : path
          ? `${toolName}: ${path}`
          : `${toolName} requires approval`;
  return { preview, detail: rawArguments, keyArguments, sensitive };
}

function singleLine(value: string, max: number) {
  const compact = value.replace(/\s+/gu, " ").trim();
  const chars = Array.from(compact);
  return chars.length > max ? `${chars.slice(0, max).join("")}...` : compact;
}

/**
 * The refusal a read-only session reports. Exported because the executor refuses
 * the same way before a call ever reaches an approval.
 */
/**
 * The refusal the model reads. The reason has to be actionable, because the
 * turn continues: repeating the same call would only be refused again.
 */
function rejectedToolMessage(toolName: string, feedback?: string) {
  const reason = feedback?.trim();
  return reason
    ? `tool "${toolName}" was rejected by the user: ${reason}. Do not retry the same call; take this into account and continue.`
    : `tool "${toolName}" was rejected by the user without a reason. Do not retry the same call; consider a different approach or ask what to do instead.`;
}

/**
 * An unanswered approval must never read as permission. The model is told the
 * call did not run so it can continue without it rather than assume success.
 */
function expiredToolMessage(toolName: string) {
  return `approval for tool "${toolName}" expired without an answer, so the call did not run. Do not assume it was allowed; continue without it or state what you need.`;
}
