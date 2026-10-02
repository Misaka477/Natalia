/**
 * Work Graph source facts.
 *
 * The Work Graph answers "why did this change happen, who approved it, what
 * validated it". WG1 shipped the schema, projector and query, but nothing in
 * production ever emitted a node, so every query returned an empty graph. This
 * module is the writer.
 *
 * Two rules shape it:
 *
 * 1. **No parallel identity system.** Node ids are derived from ids that already
 *    exist — the turn, the tool call id, the approval id — and the episode
 *    (`epi_*`) rides along as the correlation field `publish()` already stamps on
 *    every event. Nothing here invents a new way to name an execution.
 * 2. **No secrets, no reasoning, no raw output.** A summary is built from a tool
 *    name and a status, never from arguments, results, command text or thinking.
 *    The graph is replayable and shareable, so anything sensitive that reached it
 *    would be permanent. `workGraphSummary` is the only place a summary is
 *    constructed, so that rule has one enforcement point.
 */
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";

export type WorkGraphNodeEvent = Extract<
  RuntimeEvent,
  { type: "workgraph.node_added" }
>;
export type WorkGraphEdgeEvent = Extract<
  RuntimeEvent,
  { type: "workgraph.edge_added" }
>;

/**
 * The WG1 node vocabulary, taken from `workGraphNodeSchema` in
 * `@anthelia/contracts` rather than invented here. The event type declares
 * `kind: string`, so nothing would have stopped this writer from choosing its own
 * names — and a second vocabulary is the same failure as a second id system:
 * every consumer would have to know which spelling it is looking at.
 * `work-graph.test.ts` validates emitted facts against those schemas, so the
 * vocabulary is enforced rather than merely documented.
 */
export const WORK_GRAPH_KIND = {
  agentAction: "agent_action",
  toolCall: "tool_call",
  approval: "approval",
  checkpoint: "checkpoint",
  workspaceChange: "workspace_change",
  constraint: "constraint",
  decision: "decision",
} as const;

/** Edge vocabulary, likewise from `workGraphEdgeSchema`. */
export const WORK_GRAPH_EDGE_KIND = {
  caused: "caused",
  approvedBy: "approved_by",
  rejectedBy: "rejected_by",
  modified: "modified",
  rolledBackBy: "rolled_back_by",
  validatedBy: "validated_by",
  constrainedBy: "constrained_by",
} as const;

export function agentActionNodeID(turnID: string): string {
  return `wg:action:${turnID}`;
}

export function toolCallNodeID(turnID: string, callID: string): string {
  return `wg:tool:${turnID}:${callID}`;
}

export function approvalNodeID(approvalID: string): string {
  return `wg:approval:${approvalID}`;
}

/**
 * The only summary builder. Keeps free text out of the graph: a caller cannot
 * pass a command line or a tool result through it.
 */
function workGraphSummary(parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part))
    .map((part) => part.replaceAll(/\s+/gu, " ").trim())
    .join(" · ")
    .slice(0, 200);
}

/** One node per turn: the agent acted. */
export function agentActionNode(input: {
  turnID: string;
  sessionID: SessionID;
  agent?: string;
}): WorkGraphNodeEvent {
  return {
    type: "workgraph.node_added",
    id: agentActionNodeID(input.turnID),
    nodeID: agentActionNodeID(input.turnID),
    kind: WORK_GRAPH_KIND.agentAction,
    // Deliberately not the prompt text: a prompt can contain anything.
    summary: workGraphSummary(["turn", input.agent]),
    actor: input.agent ?? "agent",
    sessionID: input.sessionID,
    turnID: input.turnID,
  };
}

/**
 * One node per settled tool call, plus the edge to the turn that caused it. Only
 * settled calls are recorded, because an in-flight call is not yet a fact.
 */
export function toolCallNode(input: {
  turnID: string;
  callID: string;
  toolName: string;
  status: string;
  sessionID: SessionID;
}): WorkGraphNodeEvent {
  return {
    type: "workgraph.node_added",
    id: toolCallNodeID(input.turnID, input.callID),
    nodeID: toolCallNodeID(input.turnID, input.callID),
    kind: WORK_GRAPH_KIND.toolCall,
    summary: workGraphSummary([input.toolName, input.status]),
    actor: input.toolName,
    sessionID: input.sessionID,
    turnID: input.turnID,
  };
}

export function toolCallEdge(input: {
  turnID: string;
  callID: string;
}): WorkGraphEdgeEvent {
  return {
    type: "workgraph.edge_added",
    id: `wg:edge:action-tool:${input.turnID}:${input.callID}`,
    sourceID: agentActionNodeID(input.turnID),
    targetID: toolCallNodeID(input.turnID, input.callID),
    kind: WORK_GRAPH_EDGE_KIND.caused,
  };
}

/**
 * One node per resolved approval. The decision is a fact worth keeping; the
 * preview text is not, because it can contain a command line.
 */
export function approvalNode(input: {
  approvalID: string;
  decision: string;
  toolName?: string;
  sessionID: SessionID;
  turnID?: string;
}): WorkGraphNodeEvent {
  return {
    type: "workgraph.node_added",
    id: approvalNodeID(input.approvalID),
    nodeID: approvalNodeID(input.approvalID),
    kind: WORK_GRAPH_KIND.approval,
    summary: workGraphSummary([input.toolName, input.decision]),
    actor: "user",
    sessionID: input.sessionID,
    turnID: input.turnID,
  };
}

/** Links an approval to the tool call it authorized, when that is known. */
export function approvalEdge(input: {
  approvalID: string;
  decision: string;
  turnID: string;
  callID: string;
}): WorkGraphEdgeEvent {
  return {
    type: "workgraph.edge_added",
    id: `wg:edge:tool-approval:${input.turnID}:${input.callID}`,
    sourceID: toolCallNodeID(input.turnID, input.callID),
    targetID: approvalNodeID(input.approvalID),
    // A refusal is as much a fact as an approval, and calling it `approved_by`
    // would make the graph answer "who authorized this" with someone who
    // refused. `rejected_by` is a deliberate addition to the WG1 edge
    // vocabulary, not a second vocabulary.
    kind:
      input.decision === "reject"
        ? WORK_GRAPH_EDGE_KIND.rejectedBy
        : WORK_GRAPH_EDGE_KIND.approvedBy,
  };
}

/**
 * One node per constitution rule (CST4 Work Graph linkage). A rule is a
 * `constraint` in the graph — the durable "this may not happen" fact that
 * tool calls and drift findings relate to. The statement is safe prose; the
 * rule id is the identity.
 */
export function constitutionRuleNode(input: {
  ruleID: string;
  statement: string;
  sessionID: SessionID;
  /**
   * The rule's scope. Release-scope rules are the runtime's own
   * self-protection rules — background facts, not the user's causal chain — so
   * the node's actor is marked `"runtime"` (vs `"constitution"` for the
   * user/project rules). The Work Graph default view filters the runtime ones
   * out of its roots; they still appear when a tool call is constrained by them.
   */
  scope?: "project" | "package" | "sandbox" | "task" | "release";
}): WorkGraphNodeEvent {
  return {
    type: "workgraph.node_added",
    id: `wg:constraint:${input.ruleID}`,
    nodeID: `wg:constraint:${input.ruleID}`,
    kind: WORK_GRAPH_KIND.constraint,
    summary: workGraphSummary(["constraint", input.ruleID]),
    actor: input.scope === "release" ? "runtime" : "constitution",
    target: input.ruleID,
    sessionID: input.sessionID,
  };
}

/**
 * One node per recorded decision (CST4 Work Graph linkage). A decision is a
 * `decision` node in the graph. The decision text is safe prose; the decision
 * id is the identity.
 */
export function decisionNode(input: {
  decisionID: string;
  decision: string;
  sessionID: SessionID;
}): WorkGraphNodeEvent {
  return {
    type: "workgraph.node_added",
    id: `wg:decision:${input.decisionID}`,
    nodeID: `wg:decision:${input.decisionID}`,
    kind: WORK_GRAPH_KIND.decision,
    summary: workGraphSummary(["decision", input.decisionID]),
    actor: "decision",
    target: input.decisionID,
    sessionID: input.sessionID,
  };
}

export function checkpointNode(input: {
  checkpointID: string;
  reason: string;
  sessionID: SessionID;
  turnID?: string;
  /**
   * The plan this checkpoint was taken under (B7 provenance): the Work Graph
   * answers "which plan's commitment does this rollback point belong to".
   */
  planID?: string;
}): WorkGraphNodeEvent {
  const nodeID = `wg:checkpoint:${input.sessionID}:${input.checkpointID}`;
  return {
    type: "workgraph.node_added",
    id: nodeID,
    nodeID,
    kind: WORK_GRAPH_KIND.checkpoint,
    summary: workGraphSummary(["checkpoint", input.reason]),
    actor: "checkpoint",
    target: input.checkpointID,
    sessionID: input.sessionID,
    turnID: input.turnID,
    ...(input.planID ? { planID: input.planID } : {}),
  };
}

export function rollbackCheckpointEdge(input: {
  checkpointID: string;
  safetyCheckpointID: string;
  sessionID: SessionID;
}): WorkGraphEdgeEvent {
  return {
    type: "workgraph.edge_added",
    id: `wg:edge:rollback:${input.sessionID}:${input.checkpointID}:${input.safetyCheckpointID}`,
    sourceID: checkpointNode({
      checkpointID: input.checkpointID,
      reason: "rollback",
      sessionID: input.sessionID,
    }).nodeID,
    targetID: checkpointNode({
      checkpointID: input.safetyCheckpointID,
      reason: "rollback_safety",
      sessionID: input.sessionID,
    }).nodeID,
    kind: WORK_GRAPH_EDGE_KIND.rolledBackBy,
  };
}

export function workspaceChangeNodeID(
  identityID: string,
  path: string,
): string {
  return `wg:change:${identityID}:${path}`;
}

/**
 * One node per workspace file a call changed.
 *
 * The path is recorded here, unlike everywhere else in this module, because it is
 * the fact: a graph that cannot say which file changed cannot answer the question
 * it exists for. What stays out is still everything sensitive — the content
 * written, the arguments, the diff and the output. A workspace-relative path is
 * the identity of the changed thing, not its contents.
 */
export function workspaceChangeNode(input: {
  /** Existing turn identity, when a model tool call caused the change. */
  turnID?: string;
  /** Non-turn operation identity, used by direct runtime side-effect APIs. */
  operationID?: string;
  /** An external confirmed change with no reliable identity (WG4 Phase 4). */
  externalID?: string;
  path: string;
  toolName: string;
  sessionID: SessionID;
}): WorkGraphNodeEvent {
  const identityID = input.turnID ?? input.operationID ?? input.externalID;
  if (!identityID) throw new Error("workspace change requires an identity");
  const actor =
    (input.turnID ?? input.operationID)
      ? input.toolName
      : input.externalID
        ? "external"
        : input.toolName;
  return {
    type: "workgraph.node_added",
    id: workspaceChangeNodeID(identityID, input.path),
    nodeID: workspaceChangeNodeID(identityID, input.path),
    kind: WORK_GRAPH_KIND.workspaceChange,
    summary: workGraphSummary([actor, "changed"]),
    target: input.path,
    actor,
    sessionID: input.sessionID,
    turnID: input.turnID,
  };
}

/**
 * A confirmed external change with no reliable identity becomes an isolated
 * `workspace_change` node (§56.9: "确认的外部变化可以生成孤立 workspace_change 节点…
 * 没有可靠 turnID/callID 时不建立因果边"). The identity is the confirmed-change
 * id, so replay stays stable; no `tool_call --modified-->` edge is created.
 */
export function externalWorkspaceChangeNode(input: {
  confirmedChangeID: string;
  path: string;
  sessionID: SessionID;
}): WorkGraphNodeEvent {
  return workspaceChangeNode({
    externalID: `external:${input.confirmedChangeID}`,
    path: input.path,
    toolName: "external",
    sessionID: input.sessionID,
  });
}

/** Links the tool call to the file it changed. */
export function workspaceChangeEdge(input: {
  turnID: string;
  callID: string;
  path: string;
}): WorkGraphEdgeEvent {
  return {
    type: "workgraph.edge_added",
    id: `wg:edge:tool-change:${input.turnID}:${input.callID}:${input.path}`,
    sourceID: toolCallNodeID(input.turnID, input.callID),
    targetID: workspaceChangeNodeID(input.turnID, input.path),
    kind: WORK_GRAPH_EDGE_KIND.modified,
  };
}

/**
 * One node per recorded completion card (P2 E4). The completion is a
 * validation-class fact in the graph: it is the durable "this task reached a
 * judge-able state" answer that workspace changes link to through
 * `validated_by`. The summary never carries the completion prose.
 */
export function completionNode(input: {
  completionID: string;
  taskID: string;
  sessionID: SessionID;
  turnID?: string;
}): WorkGraphNodeEvent {
  return {
    type: "workgraph.node_added",
    id: `wg:completion:${input.completionID}`,
    nodeID: `wg:completion:${input.completionID}`,
    kind: "validation",
    summary: workGraphSummary(["completion", input.taskID]),
    actor: "completion",
    target: input.completionID,
    sessionID: input.sessionID,
    ...(input.turnID ? { turnID: input.turnID } : {}),
  };
}

/**
 * A completion card validates a workspace change (P2 E4): the change node is
 * connected to a validation-node-style fact through a `validated_by` edge. The
 * edge exists in `workGraphEdgeSchema`; this is the writer that emits it. The
 * target is the workspace-change node the completion rests on.
 */
export function completionValidationEdge(input: {
  changeID: string;
  path: string;
  completionID: string;
}): WorkGraphEdgeEvent {
  return {
    type: "workgraph.edge_added",
    id: `wg:edge:completion-validated:${input.completionID}:${input.path}`,
    sourceID: workspaceChangeNodeID(input.changeID, input.path),
    targetID: `wg:completion:${input.completionID}`,
    kind: WORK_GRAPH_EDGE_KIND.validatedBy,
  };
}

/**
 * A constitution preflight that blocked a tool call connects the call to the
 * rule that constrained it (CST4: the `constrained_by` edge kind in
 * `workGraphEdgeSchema`, previously never emitted). Only a conflict is an edge:
 * a rule a call merely passed is not news, so a passing check does not spam the
 * graph with "constrained by" relations on every tool call. The target is the
 * `constraint` node the runtime seeds for each rule at startup (§56.37).
 */
export function constitutionCheckEdge(input: {
  turnID: string;
  callID: string;
  ruleID: string;
}): WorkGraphEdgeEvent {
  return {
    type: "workgraph.edge_added",
    id: `wg:edge:tool-constraint:${input.turnID}:${input.callID}:${input.ruleID}`,
    sourceID: toolCallNodeID(input.turnID, input.callID),
    targetID: `wg:constraint:${input.ruleID}`,
    kind: WORK_GRAPH_EDGE_KIND.constrainedBy,
  };
}

/**
 * A Work Graph integrity report (EI WG4 / Phase 3 D): the graph is a
 * projection of the append-only journal, rebuilt by replay. This verifies the
 * rebuild is internally consistent — the causal chain is not faked.
 *
 * - **dangling edges**: an edge whose endpoint references no node. A dangling
 *   edge is a broken causal claim (the thing it points at was never recorded).
 * - **incomplete nodes**: a node with no session correlation. Per EI §2
 *   principle 4/5, missing correlation is marked incomplete, never silently
 *   attributed — the graph refuses to fake a complete causal chain.
 * - **duplicate node ids**: a writer re-emitted the same node; the projection
 *   is idempotent by id, so a duplicate signals a non-idempotent writer.
 * - **stable**: no dangling edges and no duplicate ids — the replay is sound.
 */
export type WorkGraphIntegrityReport = {
  nodeCount: number;
  edgeCount: number;
  danglingEdges: Array<{
    edgeID: string;
    sourceID: string;
    targetID: string;
    missing: "source" | "target" | "both";
  }>;
  incompleteNodes: Array<{ nodeID: string; kind: string; summary: string }>;
  duplicateNodeIDs: string[];
  stable: boolean;
};

/**
 * Rebuilds the Work Graph from the event stream and verifies its integrity
 * (EI WG4 / Phase 3 D). Pure: the same events always rebuild the same graph,
 * so this doubles as the replay check — a non-deterministic writer (e.g. a
 * `Date.now()` node id) would surface as a duplicate id or a dangling edge.
 */
export function verifyWorkGraphIntegrity(
  events: RuntimeEvent[],
): WorkGraphIntegrityReport {
  const nodeEvents = events.filter(
    (event): event is WorkGraphNodeEvent =>
      event.type === "workgraph.node_added",
  );
  const edgeEvents = events.filter(
    (event): event is WorkGraphEdgeEvent =>
      event.type === "workgraph.edge_added",
  );
  const nodeIDs = new Set(nodeEvents.map((node) => node.nodeID));
  const seen = new Set<string>();
  const duplicateNodeIDs: string[] = [];
  for (const node of nodeEvents) {
    if (seen.has(node.nodeID)) duplicateNodeIDs.push(node.nodeID);
    else seen.add(node.nodeID);
  }
  const danglingEdges: WorkGraphIntegrityReport["danglingEdges"] = [];
  for (const edge of edgeEvents) {
    const missingSource = !nodeIDs.has(edge.sourceID);
    const missingTarget = !nodeIDs.has(edge.targetID);
    if (missingSource || missingTarget)
      danglingEdges.push({
        edgeID: edge.id,
        sourceID: edge.sourceID,
        targetID: edge.targetID,
        missing:
          missingSource && missingTarget
            ? "both"
            : missingSource
              ? "source"
              : "target",
      });
  }
  const incompleteNodes = nodeEvents
    .filter((node) => !node.sessionID)
    .map((node) => ({
      nodeID: node.nodeID,
      kind: node.kind,
      summary: node.summary,
    }));
  return {
    nodeCount: nodeEvents.length,
    edgeCount: edgeEvents.length,
    danglingEdges,
    incompleteNodes,
    duplicateNodeIDs,
    stable: danglingEdges.length === 0 && duplicateNodeIDs.length === 0,
  };
}

/**
 * The unattributed workspace changes in a graph (EI WG4 / Phase 3 D): the
 * `workspace_change` nodes an external reconcile produced with no reliable
 * turn identity (`actor: "external"`, no `turnID`). These are the changes the
 * runtime could not attribute to a tool call — surfaced for diagnosis, never
 * silently folded into the causal chain.
 */
export function unattributedChangeNodes(
  events: RuntimeEvent[],
): WorkGraphNodeEvent[] {
  return events.filter(
    (event): event is WorkGraphNodeEvent =>
      event.type === "workgraph.node_added" &&
      event.kind === WORK_GRAPH_KIND.workspaceChange &&
      event.actor === "external" &&
      !event.turnID,
  );
}
