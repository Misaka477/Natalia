/**
 * `@natalia/view-store` — the pure TypeScript projection of a `RuntimeEvent`
 * stream into displayable state.
 *
 * This is the layer an externally built UI consumes so it does not have to
 * reimplement the runtime's event semantics. It is framework-free: no Solid, no
 * OpenTUI, no DOM. `applyEvent` mutates a plain object and `reduceState` returns
 * a new one by explicit copy rather than `structuredClone`, because cloning a
 * reactive proxy is what broke the first attempt at this layer.
 *
 * What this layer must never do:
 *   - execute tools
 *   - own session persistence
 *   - decide policy or approval
 *   - hold credentials
 *   - invent UI-only durable truth
 *
 * The last rule is why dialog stacks, pane focus, scroll anchors and keybindings
 * are absent: those belong to a specific UI. `pendingApprovals` and
 * `terminalApprovals` are present because they are runtime facts — this layer
 * reports them; the runtime decides them.
 *
 * Projections live in three modules so adding a surface is a local edit:
 * `conversation.ts` (turns, streaming, tools, interactive),
 * `resources.ts` (terminals, sandboxes, subagents, checkpoints, rollback, MCP,
 * plugins, capabilities) and `status.ts` (context, compaction, retries,
 * selections, policy, intelligence).
 *
 * Deliberately **not** projected, and why:
 *   - `dialog.open` / `dialog.close`, `terminal.pane.select` — UI-only state,
 *     owned by whichever UI renders it.
 *   - `drift.finding_opened` stays a session query until a second UI needs the
 *     live list in `facts`; constitution/decision/evidence/plan/mailbox/workgraph
 *     now have production writers and project here for any host.
 */
import { subagentHistoryRowKey, type ToolBlock } from "./state";
import type {
  ChatMessageRow,
  RuntimeEvent,
  RuntimeProjectedMessage,
  RuntimeSubagentView,
} from "@anthelia/contracts";
import { applyActivityEvent } from "./activity";
import {
  applyNataliaCollabEvent,
  applyNaviCollabEvent,
  applyNiaCollabEvent,
  applyNaviEvent,
  applyNiaEvent,
  applyConversationEvent,
} from "./conversation";
import { applyResourceEvent } from "./resources";
import { applyStatusEvent } from "./status";
import { applyWorkspaceEvent } from "./workspace";
import {
  cloneState,
  emptySessionUsageStats,
  initialState,
  synchronizeStreamSlices,
  type AppState,
} from "./state";

export {
  type ActivityKind,
  type ActivityState,
  type ActivityView,
  appendBounded,
  boundTranscript,
  checkpointLimit,
  cloneState,
  displayText,
  emptySessionUsageStats,
  initialState,
  policyDecisionLimit,
  streamSegmentChars,
  subagentHistoryLimit,
  terminalTimelineLimit,
  terminalTranscriptChars,
  transcriptLimit,
  transcriptWatermark,
  upsertBlock,
  type AppState,
  type Banner,
  type StreamActivityView,
  type AgentStreamState,
  type CapabilityView,
  type CheckpointView,
  type ContextUsageView,
  type McpView,
  type MessageBlock,
  type PendingApproval,
  type PendingQuestion,
  type PluginView,
  type PolicyDecisionView,
  type RollbackView,
  type SandboxDiffView,
  type SandboxView,
  type SessionIntelligenceView,
  type StreamState,
  type SubagentView,
  type TerminalApprovalView,
  type TerminalTimelineEntry,
  type TerminalView,
  type ToolBlock,
  type TranscriptBound,
  type WorkGraphEdgeView,
  type WorkGraphNodeView,
  type MailboxMessageView,
  type PlanDocView,
  type SessionUsageStats,
  type SessionUsageView,
  type WorkContractView,
} from "./state";
export {
  applyActivityEvent,
  selectActiveActivities,
  selectPrimaryActivity,
} from "./activity";
export {
  flushStream,
  newStream,
  segmentID,
  streamID,
  toolStateID,
  turnIDForTool,
} from "./conversation";
/**
 * The projection composed in pieces, for a consumer migrating onto this layer one
 * concern at a time. A UI that still owns its own transcript can take the resource
 * facts from here without also taking the conversation model.
 */
export { applyResourceEvent } from "./resources";
export { applyStatusEvent } from "./status";
export { applyWorkspaceEvent } from "./workspace";
export {
  applyNataliaCollabEvent,
  applyNaviCollabEvent,
  applyNiaCollabEvent,
  applyNaviEvent,
  applyNiaEvent,
  applyConversationEvent,
} from "./conversation";
export {
  buildWorkGraphForest,
  buildWorkGraphFileNavigation,
  buildWorkGraphNavigation,
  selectWorkGraphByPlan,
  selectUnattributedWorkGraphNodes,
  selectWorkGraphNeighborhood,
  deriveSessionUsageView,
  type WorkGraphFileNavigation,
  type WorkGraphSlice,
  type WorkGraphState,
  type WorkGraphTreeNode,
  type WorkGraphNavigation,
} from "./graph";

/**
 * Mutates `state` in place. Unknown and deliberately unprojected events are
 * ignored rather than fatal, so a consumer built against an older contract keeps
 * working when the runtime adds an event.
 */
export function applyEvent(state: AppState, event: RuntimeEvent): void {
  if (event.agentID) {
    // Events belonging to a subagent are projected into that subagent's own
    // isolated state, so the main Natalia/Navi transcript and the subagent
    // stream do not mix.
    const agentID = event.agentID;
    const child = (state.subagentStates[agentID] ??= initialState());
    applyEvent(child, { ...event, agentID: undefined });
    synchronizeStreamSlices(state);
    return;
  }
  if (applyWorkspaceEvent(state, event)) return;
  if (applyConversationEvent(state, event)) {
    applyActivityEvent(state, event);
    synchronizeStreamSlices(state);
    return;
  }
  if (
    applyNataliaCollabEvent(state, event) ||
    applyNaviCollabEvent(state, event) ||
    applyNiaCollabEvent(state, event) ||
    applyNaviEvent(state, event) ||
    applyNiaEvent(state, event)
  ) {
    applyActivityEvent(state, event);
    synchronizeStreamSlices(state);
    return;
  }
  if (applyResourceEvent(state, event)) {
    if (event.type === "rollback.end")
      truncateHistoryAfterRollback(state, event);
    applyActivityEvent(state, event);
    synchronizeStreamSlices(state);
    return;
  }
  applyStatusEvent(state, event);
  applyActivityEvent(state, event);
  synchronizeStreamSlices(state);
}

/**
 * A Main Agent checkpoint rollback is a return to a prior execution point.
 * Keep the rollback-fact resource projection intact, but also drop the visible
 * transcript rows for turns after that checkpoint so the UI does not show
 * work the runtime has undone.
 */
function truncateHistoryAfterRollback(
  state: AppState,
  event: Extract<RuntimeEvent, { type: "rollback.end" }>,
): void {
  const checkpoint = state.checkpoints.find(
    (candidate) => candidate.id === event.checkpointID,
  );
  const turnID = checkpoint?.turnID;
  if (!turnID) return;
  const prefix = `${turnID}:`;
  const index = state.messages.findIndex((block) =>
    block.id.startsWith(prefix),
  );
  if (index === -1) return;
  state.messages.splice(index);
  for (const key of Object.keys(state.streams))
    if (!key.startsWith(prefix)) delete state.streams[key];
  for (const key of Object.keys(state.streamPhases))
    if (!key.startsWith(prefix)) delete state.streamPhases[key];
  for (const key of Object.keys(state.tools))
    if (!key.startsWith(prefix)) delete state.tools[key];
}

/**
 * Folds one event into a new state. The copy is explicit rather than
 * `structuredClone` so this stays safe when a caller keeps the previous state
 * behind a reactive proxy.
 */
export function reduceState(state: AppState, event: RuntimeEvent): AppState {
  const next = cloneState(state);
  applyEvent(next, event);
  return next;
}

/** Folds a whole stream, which is how an external UI replays history. */
export function projectEvents(
  events: Iterable<RuntimeEvent>,
  from: AppState = initialState(),
): AppState {
  const state = cloneState(from);
  for (const event of events) applyEvent(state, event);
  return state;
}

/**
 * Rows that carry live/streaming state and must survive a durable hydration
 * merge: an in-flight answer, a thinking block, a tool card, or a
 * collaboration row. Completed rows can be replaced by the hydrated version.
 */
function isLiveHydrationRow(message: AppState["messages"][number]): boolean {
  return (
    message.pendingText.length > 0 ||
    message.role === "thinking" ||
    message.tool !== undefined ||
    message.status === "running" ||
    message.id.endsWith(":collab")
  );
}

/**
 * Hydrates UI transcript rows from server-projected messages. Used by UIs that
 * adopt message-page loading instead of replaying every raw session event.
 * Merges by message id so a live projection can keep its own streaming rows.
 */
/** The transcript row id is the render key; duplicates are never valid. */
function dedupeMessagesByID<T extends { id: string }>(messages: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    out.push(message);
  }
  return out;
}

export function hydrateProjectedMessages(
  state: AppState,
  messages: RuntimeProjectedMessage[],
  direction: "older" | "newer" = "older",
  options: { replace?: boolean } = {},
): boolean {
  // Project every row in the page. The merge below deduplicates by row id, so
  // a turn that is already partly present still contributes its missing rows
  // (for example an answer row lost to a reconnect) instead of being skipped
  // wholesale because its user row survived.
  const projected = initialState();
  for (const message of messages) {
    for (const row of message.rows) applyEvent(projected, row.event);
  }
  if (options.replace) {
    // An empty page must never wipe a transcript that was already projected
    // from replay or live events. A later non-empty page will replace it.
    if (messages.length === 0) {
      synchronizeStreamSlices(state);
      return false;
    }
    const incoming = projected.messages.map((message) => ({ ...message }));
    const incomingIDs = new Set(incoming.map((message) => message.id));
    const liveRows = state.messages.filter(
      (message) => !incomingIDs.has(message.id) && isLiveHydrationRow(message),
    );
    // Hydration owns a contiguous event window. Do not destructively trim it
    // here: an earlier version capped `state.messages` with `boundTranscript`,
    // which made rows dropped inside the already-loaded page unreachable
    // because the server cursor only pages by turn.
    state.messages = dedupeMessagesByID([...incoming, ...liveRows]);
    const liveStreams = Object.fromEntries(
      Object.entries(state.streams).filter(
        ([id]) => !(id in projected.streams),
      ),
    );
    const livePhases = Object.fromEntries(
      Object.entries(state.streamPhases).filter(
        ([id]) => !(id in projected.streamPhases),
      ),
    );
    const liveTools = Object.fromEntries(
      Object.entries(state.tools).filter(([id]) => !(id in projected.tools)),
    );
    state.streams = { ...projected.streams, ...liveStreams };
    state.streamPhases = { ...projected.streamPhases, ...livePhases };
    state.tools = { ...projected.tools, ...liveTools };
    // The metering surfaces the page's fold COMPUTED. This is the whole
    // reason the session usage bar and the context ring read zero after a
    // restart: `projected` above folds every row's event through
    // applyEvent, which accumulates `runtime.step_usage` into
    // projected.sessionUsage / projected.usageByChannel — and then this
    // branch copied only the transcript-shaped fields back, so the
    // numbers were computed and thrown away. The live path never refills
    // them on a cold attach (attach does not replay the durable log), so
    // the bar stayed at "0 轮 · 0 步" until the next provider step.
    //
    // Replacing (not adding) is right for the initial page: the page's
    // fold is the session's own accounting for the window it covers, and
    // a cold start has nothing accumulated yet. The older-page path
    // below adds, because its pages are disjoint turn windows.
    state.sessionUsage = projected.sessionUsage;
    state.usageByChannel = projected.usageByChannel;
    // The context meters: carried when the page's fold produced one. A
    // live `context.status` (attach republishes it) still wins afterwards
    // because it mutates state directly.
    if (projected.context) state.context = projected.context;
    if (projected.navi?.context) state.navi.context = projected.navi.context;
    if (projected.nia?.context) state.nia.context = projected.nia.context;
    if (projected.footer) state.footer = projected.footer;
    synchronizeStreamSlices(state);
    return false;
  }
  // Merge by row id. A missing row (for example an answer row that a
  // reconnect dropped) is contributed by the page, while an existing row is
  // only replaced when the page carries strictly more text, so a stale page
  // cannot roll a newer live row back.
  const stateByID = new Map(
    state.messages.map((message) => [message.id, message]),
  );
  const incoming = projected.messages.map((message) => {
    const existing = stateByID.get(message.id);
    if (!existing) return { ...message };
    const existingText = existing.text + existing.pendingText;
    const incomingText = message.text + message.pendingText;
    return existingText.length >= incomingText.length
      ? { ...existing }
      : { ...message };
  });
  if (!incoming.length) return false;
  const incomingIDs = new Set(incoming.map((message) => message.id));
  const retained = state.messages.filter(
    (message) => !incomingIDs.has(message.id),
  );
  const merged =
    direction === "older"
      ? [...incoming, ...retained]
      : [...retained, ...incoming];
  state.messages = dedupeMessagesByID(merged);
  // Keep stream/tool state for hydrated turns when the live project has not
  // seen them yet.
  for (const id of Object.keys(projected.streams))
    if (!(id in state.streams)) state.streams[id] = projected.streams[id];
  for (const id of Object.keys(projected.streamPhases))
    if (!(id in state.streamPhases))
      state.streamPhases[id] = projected.streamPhases[id];
  for (const id of Object.keys(projected.tools))
    if (!(id in state.tools)) state.tools[id] = projected.tools[id];
  // The older-page counterpart of the replace path above: the pages are
  // disjoint turn windows (the cursor pages by turn), so each step's usage
  // appears in exactly one page and ADDING is the correct fold — no double
  // count, and paging back through history grows the bar.
  for (const [channel, stats] of Object.entries(projected.usageByChannel)) {
    const target =
      state.usageByChannel[channel as keyof typeof state.usageByChannel] ??
      emptySessionUsageStats();
    target.steps += stats.steps;
    target.turns += stats.turns;
    target.inputTokens += stats.inputTokens;
    target.outputTokens += stats.outputTokens;
    target.cacheReadInputTokens += stats.cacheReadInputTokens;
    target.cacheCreationInputTokens += stats.cacheCreationInputTokens;
    target.llmMs += stats.llmMs;
    target.toolMs += stats.toolMs;
    target.ttftMs += stats.ttftMs;
    target.ttftSteps += stats.ttftSteps;
    target.decodeMs += stats.decodeMs;
    state.usageByChannel[channel as keyof typeof state.usageByChannel] = target;
  }
  state.sessionUsage.steps += projected.sessionUsage.steps;
  state.sessionUsage.turns += projected.sessionUsage.turns;
  state.sessionUsage.inputTokens += projected.sessionUsage.inputTokens;
  state.sessionUsage.outputTokens += projected.sessionUsage.outputTokens;
  state.sessionUsage.cacheReadInputTokens +=
    projected.sessionUsage.cacheReadInputTokens;
  state.sessionUsage.cacheCreationInputTokens +=
    projected.sessionUsage.cacheCreationInputTokens;
  state.sessionUsage.llmMs += projected.sessionUsage.llmMs;
  state.sessionUsage.toolMs += projected.sessionUsage.toolMs;
  state.sessionUsage.ttftMs += projected.sessionUsage.ttftMs;
  state.sessionUsage.ttftSteps += projected.sessionUsage.ttftSteps;
  state.sessionUsage.decodeMs += projected.sessionUsage.decodeMs;
  // Preserve interactive requests projected from the hydrated turns so a
  // message-first startup still surfaces pending approvals/questions.
  const approvalIDs = new Set(
    state.pendingApprovals.map((approval) => approval.id),
  );
  for (const approval of projected.pendingApprovals)
    if (!approvalIDs.has(approval.id)) state.pendingApprovals.push(approval);
  const questionIDs = new Set(
    state.pendingQuestions.map((question) => question.id),
  );
  for (const question of projected.pendingQuestions)
    if (!questionIDs.has(question.id)) state.pendingQuestions.push(question);

  if (!state.sessionID && projected.sessionID)
    state.sessionID = projected.sessionID;
  if (!state.title && projected.title) state.title = projected.title;
  synchronizeStreamSlices(state);
  return false;
}

/**
 * Hydrates the Live Work Chat rows from the durable chat projection. This is
 * the chat counterpart of `hydrateProjectedMessages`: it lets the UI reuse the
 * same lazy-loading path instead of replaying every raw chat event.
 */
function chatRowToBlock(row: ChatMessageRow): {
  id: string;
  role: "user" | "assistant" | "thinking" | "system" | "tool";
  text: string;
  pendingText: string;
  reasoningVisible?: boolean;
  status?: string;
  attachments?: import("@anthelia/contracts").LocalAttachment[];
  tool?: ToolBlock;
} {
  if (row.kind === "thinking") {
    return {
      id: `chat:${row.messageID}:thinking`,
      role: "thinking",
      text: row.text,
      pendingText: "",
      reasoningVisible: true,
    };
  }
  if (row.kind === "tool" && row.tool) {
    const toolID =
      row.tool.eventID ??
      `${row.tool.name}:${row.tool.status}:${row.messageID}`;
    return {
      id: `chat:${toolID}:tool`,
      role: "tool",
      text: row.tool.summary,
      pendingText: "",
      status: row.tool.status,
      tool: {
        name: row.tool.name,
        status: row.tool.status,
        summary: row.tool.summary,
        ...(row.tool.result !== undefined ? { result: row.tool.result } : {}),
        argumentsRaw: row.tool.argumentsRaw ?? "",
        ...(row.tool.startedAt !== undefined
          ? { startedAt: row.tool.startedAt }
          : {}),
        ...(row.tool.endedAt !== undefined
          ? { endedAt: row.tool.endedAt }
          : {}),
      },
    };
  }
  if (row.role === "system") {
    return {
      id: `chat:${row.messageID}:${row.kind === "collab" ? "collab" : "system"}`,
      role: "system",
      text: row.text,
      pendingText: "",
    };
  }
  const internal = row.role === "user" && row.text.startsWith("(internal");
  return {
    id: internal
      ? `chat:${row.messageID}:system`
      : row.role === "user"
        ? `chat:${row.messageID}:user`
        : `chat:${row.messageID}:assistant`,
    role: internal
      ? ("system" as const)
      : row.role === "user"
        ? ("user" as const)
        : ("assistant" as const),
    text: row.text,
    pendingText: "",
    ...(row.attachments ? { attachments: row.attachments } : {}),
  };
}

/**
 * Hydrates the Live Work Chat rows from the durable chat projection. Navi and
 * Nia are independent streams: the channel on each durable row routes it into
 * that agent's own projection so neither UI can read the other's transcript.
 */
export type HydrateAgentMessagesOptions = {
  direction?: "older" | "newer";
  replace?: boolean;
};

export function hydrateNaviMessages(
  state: AppState,
  rows: ChatMessageRow[],
  options?: HydrateAgentMessagesOptions,
): boolean {
  return applyAgentMessagePage(state.navi, rows, options);
}

export function hydrateNiaMessages(
  state: AppState,
  rows: ChatMessageRow[],
  options?: HydrateAgentMessagesOptions,
): boolean {
  return applyAgentMessagePage(state.nia, rows, options);
}

/**
 * Dual ingestion for the runtime notices (ADR Phase C): the server-projected
 * `notices` contract merges into the same `runtimeNotices` view the live
 * `context.instructions` event stream feeds, so a replayed session and a live
 * session converge. Later revisions supersede earlier same-kind notices; a
 * lower-revision projection result never clobbers a newer live event.
 */
export function hydrateRuntimeNotices(
  state: AppState,
  notices: import("@anthelia/contracts").RuntimeProjectedNotice[],
): boolean {
  let changed = false;
  for (const notice of notices) {
    const existing = state.runtimeNotices.find(
      (candidate) => candidate.kind === notice.kind,
    );
    if (existing && existing.revision >= notice.revision) continue;
    if (existing)
      state.runtimeNotices = state.runtimeNotices.filter(
        (candidate) => candidate.kind !== notice.kind,
      );
    state.runtimeNotices = [...state.runtimeNotices, { ...notice }].sort(
      (left, right) => left.at.localeCompare(right.at),
    );
    changed = true;
  }
  return changed;
}

function applyAgentMessagePage(
  target: AppState["navi"],
  rows: ChatMessageRow[],
  options?: HydrateAgentMessagesOptions,
): boolean {
  const replace = options?.replace ?? options?.direction === undefined;
  return replace
    ? replaceAgentMessages(target, rows)
    : mergeAgentMessages(target, rows, options?.direction ?? "newer");
}

/**
 * Merge one page of durable Chat rows into an already-paged stream. Existing
 * rows win over duplicates so a stale page can never roll back a live row or a
 * newer page.
 */
function mergeAgentMessages(
  target: AppState["navi"],
  rows: ChatMessageRow[],
  direction: "older" | "newer",
): boolean {
  const incoming = rows.map(chatRowToBlock);
  const existing = new Set(target.messages.map((row) => row.id));
  const additions = incoming.filter((row) => !existing.has(row.id));
  if (!additions.length) return false;
  target.messages = dedupeMessagesByID(
    direction === "older"
      ? [...additions, ...target.messages]
      : [...target.messages, ...additions],
  );
  return true;
}

function replaceAgentMessages(
  target: AppState["navi"],
  rows: ChatMessageRow[],
): boolean {
  const incoming = rows.map(chatRowToBlock);
  const incomingIDs = new Set(incoming.map((row) => row.id));
  const baseline = new Map(
    target.hydrationBaseline?.map((row) => [row.id, row]) ?? [],
  );
  // A successful snapshot is authoritative for rows unchanged since its request
  // began. Retain only post-request live changes, including same-ID deltas,
  // compaction, and rollback updates. A failed request never calls this method,
  // leaving the warm cache untouched.
  const liveChanges = target.messages.filter((row) => {
    const before = baseline.get(row.id);
    return !before || JSON.stringify(before) !== JSON.stringify(row);
  });
  for (const row of liveChanges) {
    const snapshot = incoming.find((candidate) => candidate.id === row.id);
    if (snapshot) snapshot.pendingText = row.pendingText;
  }
  const liveOnly = target.messages.filter(
    (row) =>
      !incomingIDs.has(row.id) &&
      (row.pendingText.length > 0 ||
        row.role === "thinking" ||
        row.tool !== undefined ||
        row.status === "running" ||
        row.id.endsWith(":collab")),
  );
  target.messages.splice(
    0,
    target.messages.length,
    ...dedupeMessagesByID([...incoming, ...liveOnly]),
  );
  delete target.hydrationBaseline;
  return true;
}

export function beginNaviHydration(state: AppState): void {
  state.navi.hydrationBaseline = state.navi.messages.map((row) => ({ ...row }));
}

export function beginNiaHydration(state: AppState): void {
  state.nia.hydrationBaseline = state.nia.messages.map((row) => ({ ...row }));
}

/**
 * Hydrates the current subagent registry into the projected subagent tree.
 * Existing live entries win over this lazy snapshot so a newer subagent.update
 * that arrived after the RPC still takes precedence.
 */
export function hydrateSubagents(
  state: AppState,
  subagents: RuntimeSubagentView[],
): boolean {
  if (!subagents.length) return false;
  const incoming: Record<string, RuntimeSubagentView> = {};
  for (const subagent of subagents) incoming[subagent.id] = subagent;
  state.subagents = { ...incoming, ...state.subagents };
  return true;
}

export type HydrateSubagentHistoryOptions = {
  direction?: "older" | "newer";
  replace?: boolean;
  subagentID?: string;
};

export function hydrateSubagentHistory(
  state: AppState,
  history: RuntimeSubagentView[],
  options?: HydrateSubagentHistoryOptions,
): boolean {
  if (!history.length) {
    if (options?.replace && options.subagentID) {
      state.subagentHistory = {
        ...state.subagentHistory,
        [options.subagentID]: [],
      };
      return true;
    }
    return false;
  }
  const groups = new Map<string, RuntimeSubagentView[]>();
  for (const event of history) {
    const key = subagentHistoryRowKey(event);
    const rows = groups.get(event.id) ?? [];
    if (!rows.some((row) => subagentHistoryRowKey(row) === key))
      rows.push(event);
    groups.set(event.id, rows);
  }
  let changed = false;
  for (const [id, incoming] of groups) {
    const existing = options?.replace ? [] : (state.subagentHistory[id] ?? []);
    const ordered =
      options?.direction === "older"
        ? [...incoming, ...existing]
        : [...existing, ...incoming];
    const keyed = new Map<string, RuntimeSubagentView>();
    for (const row of ordered) {
      const key = subagentHistoryRowKey(row);
      if (!keyed.has(key)) keyed.set(key, row);
    }
    state.subagentHistory = {
      ...state.subagentHistory,
      [id]: [...keyed.values()],
    };
    changed = true;
  }
  return changed;
}
