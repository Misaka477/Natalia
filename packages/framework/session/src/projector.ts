import type {
  ChatChannel,
  CollaborationMessage,
  GoalView,
  RuntimeEvent,
  RuntimeMessagePage,
  RuntimeProjectedMessage,
  RuntimeProjectedMessageRowKind,
} from "@anthelia/contracts";
import { admittedInputs, type AdmittedSessionInput } from "./inbox";
import type { SessionRecord } from "./index";

export type SessionProjection = {
  activeTurnIDs: string[];
  completedTurnIDs: string[];
  pendingInputs: AdmittedSessionInput[];
  replayableEvents: RuntimeEvent[];
  selectedAgent?: string;
  selectedModel?: { modelID?: string; variant?: string };
  reasoningEffort?: import("@anthelia/contracts").RuntimeReasoningEffort;
  chatModelProfile?: Record<
    string,
    import("@anthelia/contracts").ChatModelProfile
  >;
  permissionMode?: "ask" | "auto" | "read_only";
  permissionProfile?: string;
  /** The settlement notices this session was told (the spine's durable face). */
  settlements: SettlementNoticeRecord[];
  /** The subagents' mid-run messages this session was told. */
  subagentMessages: Array<{ agentId: string; text: string; at: string }>;
  /**
   * Cumulative per-channel usage folded from the same events — a whole-session
   * total, so paging and compaction cannot change it and a restart reads it
   * from the durable checkpoint instead of replaying history.
   */
  usage: SessionUsageTotals;
};

/**
 * A settlement notice as the projection carries it: what settled, why,
 * and when — the notice stream's replayable form (the full summary and
 * detail stay on the event itself; the projection keeps the index).
 */
export type SettlementNoticeRecord = {
  subject: string;
  reason: import("@anthelia/contracts").SettlementReason;
  sourceKind: string;
  at: string;
};

/** Selects the model-visible durable context after the latest epoch baseline. */
export function modelVisibleEvents(events: RuntimeEvent[]) {
  const checkpointIndex = events.reduce(
    (latest, event, index) =>
      event.type === "context.checkpoint" ? index : latest,
    -1,
  );
  if (checkpointIndex < 0) return events;
  return events.slice(checkpointIndex + 1);
}

/**
 * Projects append-only runtime events without attempting to replay an
 * incomplete provider/tool turn after restart.
 */
export function projectSession(session: SessionRecord): SessionProjection {
  const active = new Set<string>();
  const completed = new Set<string>();
  const usage = emptySessionUsageTotals();
  for (const event of session.events) {
    if (event.type === "turn.submitted") {
      active.add(event.id);
      continue;
    }
    if (event.type === "turn.finished") {
      active.delete(event.id);
      completed.add(event.id);
    }
    foldSessionUsageInto(usage, event);
  }
  // A crashed turn may contain partial model/tool state. Keep its durable
  // audit events on disk, but do not feed its input back into a new model turn.
  const replayable = session.events.filter(
    (event) => !belongsToInterruptedTurn(event, active),
  );
  return {
    activeTurnIDs: [...active],
    completedTurnIDs: [...completed],
    pendingInputs: admittedInputs(session).filter((input) => !input.promotedAt),
    replayableEvents: replayable,
    selectedAgent: selectedAgentFromEvents(replayable),
    selectedModel: selectedModelFromEvents(replayable),
    reasoningEffort: reasoningEffortFromEvents(replayable),
    chatModelProfile: chatModelProfileFromEvents(replayable),
    permissionMode: permissionModeFromEvents(replayable),
    permissionProfile: permissionProfileFromEvents(replayable),
    settlements: settlementRecordsFromEvents(replayable),
    subagentMessages: subagentMessageRecordsFromEvents(replayable),
    usage,
  };
}

/**
 * The settlement notices a session was told, oldest first. A notice is a
 * durable fact, so replay sees exactly what the model was told — and the
 * record is the index (the summary stays on the event).
 */
export function settlementRecordsFromEvents(
  events: readonly RuntimeEvent[],
): SettlementNoticeRecord[] {
  return events
    .filter(
      (event): event is Extract<RuntimeEvent, { type: "settlement.notice" }> =>
        event.type === "settlement.notice",
    )
    .map((event) => ({
      subject: event.subject,
      reason: event.reason,
      sourceKind: event.sourceKind,
      at: event.at,
    }));
}

/**
 * The child's mid-run messages a session was told, oldest first — the same
 * replayability a settlement gets: a fact the journal holds is a fact the
 * projection can re-read.
 */
export function subagentMessageRecordsFromEvents(
  events: readonly RuntimeEvent[],
): Array<{ agentId: string; text: string; at: string }> {
  return events
    .filter(
      (event): event is Extract<RuntimeEvent, { type: "subagent.message" }> =>
        event.type === "subagent.message",
    )
    .map((event) => ({
      agentId: event.agentId,
      text: event.text,
      at: event.at,
    }));
}

/**
 * Version of the durable projection fold. Bump this whenever the fold's state
 * shape or semantics change so a persisted checkpoint from an older build is
 * discarded rather than mis-replayed.
 */
export const PROJECTION_STATE_VERSION = 3;

/** One channel's cumulative usage buckets; field names mirror the UI's. */
export type SessionUsageBuckets = {
  steps: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  llmMs: number;
  toolMs: number;
  ttftMs: number;
  ttftSteps: number;
  decodeMs: number;
};

export type SessionUsageTotals = Record<
  "main" | "navi" | "nia",
  SessionUsageBuckets
>;

const emptyUsageBuckets = (): SessionUsageBuckets => ({
  steps: 0,
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  llmMs: 0,
  toolMs: 0,
  ttftMs: 0,
  ttftSteps: 0,
  decodeMs: 0,
});

/** Zeroed totals for every channel, so a channel with no steps still reports. */
export function emptySessionUsageTotals(): SessionUsageTotals {
  return {
    main: emptyUsageBuckets(),
    navi: emptyUsageBuckets(),
    nia: emptyUsageBuckets(),
  };
}

/** The channel a `runtime.step_usage` event belongs to (legacy events: main). */
function usageChannelOf(event: {
  channel?: "main" | "navi" | "nia";
  type: string;
}): "main" | "navi" | "nia" {
  if (event.channel) return event.channel;
  if (event.type === "navi.runtime.step_usage") return "navi";
  if (event.type === "nia.runtime.step_usage") return "nia";
  return "main";
}

/**
 * Folds the durable usage of one event into `totals`.
 *
 * `runtime.step_usage` (and its navi/nia namespaced forms) is the token
 * authority — one event per provider step, carrying that step's provider
 * sample and measured timing. `turn.finished` counts the turn and adds its
 * wall time; the chat streams count their own turns through
 * `*.chat.turn.finished`. A whole-log fold of these is the session's static
 * usage: the numbers a restarting UI starts from before any live step.
 */
export function foldSessionUsageInto(
  totals: SessionUsageTotals,
  event: RuntimeEvent,
): SessionUsageTotals {
  if (
    event.type === "runtime.step_usage" ||
    event.type === "navi.runtime.step_usage" ||
    event.type === "nia.runtime.step_usage"
  ) {
    const bucket = totals[usageChannelOf(event)];
    bucket.steps += 1;
    bucket.inputTokens += event.inputTokens ?? 0;
    bucket.outputTokens += event.outputTokens ?? 0;
    bucket.cacheReadInputTokens += event.cacheReadInputTokens ?? 0;
    bucket.cacheCreationInputTokens += event.cacheCreationInputTokens ?? 0;
    bucket.llmMs += event.llmMs ?? 0;
    bucket.toolMs += event.toolMs ?? 0;
    if (event.ttftMs !== undefined) {
      bucket.ttftMs += event.ttftMs;
      bucket.ttftSteps += 1;
    }
    bucket.decodeMs += event.decodeMs ?? 0;
    return totals;
  }
  if (event.type === "turn.finished") {
    const bucket = totals.main;
    bucket.turns += 1;
    bucket.llmMs += Math.max(0, event.durationMs ?? 0);
    return totals;
  }
  if (
    event.type === "navi.chat.turn.finished" ||
    event.type === "nia.chat.turn.finished"
  ) {
    const bucket =
      totals[event.type === "navi.chat.turn.finished" ? "navi" : "nia"];
    bucket.turns += 1;
    bucket.llmMs += Math.max(0, event.endedAt - event.startedAt);
    return totals;
  }
  return totals;
}

/**
 * Foldable session projection state. The same shape can be advanced one event
 * at a time (`applyProjection`), persisted as a per-session checkpoint, and
 * resumed from a stored sequence number by folding only the tail. `view` always
 * reproduces the full `projectSession` result for the events folded so far.
 */
export type ProjectionState = {
  version: number;
  /** Every event folded so far; the source for the replayable filter. */
  events: RuntimeEvent[];
  activeTurnIDs: Set<string>;
  completedTurnIDs: Set<string>;
  /** Cumulative per-channel usage, folded from the same events. */
  usage: SessionUsageTotals;
};

export function initProjection(): ProjectionState {
  return {
    version: PROJECTION_STATE_VERSION,
    events: [],
    activeTurnIDs: new Set(),
    completedTurnIDs: new Set(),
    usage: emptySessionUsageTotals(),
  };
}

/** Folds one event into the projection state in place and returns it. */
export function applyProjection(
  state: ProjectionState,
  event: RuntimeEvent,
): ProjectionState {
  state.events.push(event);
  if (event.type === "turn.submitted") state.activeTurnIDs.add(event.id);
  else if (event.type === "turn.finished") {
    state.activeTurnIDs.delete(event.id);
    state.completedTurnIDs.add(event.id);
  }
  foldSessionUsageInto(state.usage, event);
  return state;
}

/**
 * Materializes the view from a folded state. `inbox` carries the pending-input
 * slice (session state, not event-derived). Scalar selections are read from the
 * replayable surface exactly as `projectSession` does, so a checkpoint resumed
 * from a stored sequence plus a tail replay is indistinguishable from a full
 * projection.
 */
export function viewProjection(
  state: ProjectionState,
  inbox: AdmittedSessionInput[] = [],
): SessionProjection {
  const replayable = state.events.filter(
    (event) => !belongsToInterruptedTurn(event, state.activeTurnIDs),
  );
  return {
    activeTurnIDs: [...state.activeTurnIDs],
    completedTurnIDs: [...state.completedTurnIDs],
    pendingInputs: inbox.filter((input) => !input.promotedAt),
    replayableEvents: replayable,
    selectedAgent: selectedAgentFromEvents(replayable),
    selectedModel: selectedModelFromEvents(replayable),
    reasoningEffort: reasoningEffortFromEvents(replayable),
    chatModelProfile: chatModelProfileFromEvents(replayable),
    permissionMode: permissionModeFromEvents(replayable),
    permissionProfile: permissionProfileFromEvents(replayable),
    settlements: settlementRecordsFromEvents(replayable),
    subagentMessages: subagentMessageRecordsFromEvents(replayable),
    usage: {
      main: { ...state.usage.main },
      navi: { ...state.usage.navi },
      nia: { ...state.usage.nia },
    },
  };
}

/** Convenience: fold a full event log in one call (equivalent to projectSession). */
export function foldProjection(
  events: readonly RuntimeEvent[],
  inbox: AdmittedSessionInput[] = [],
): SessionProjection {
  const state = initProjection();
  for (const event of events) applyProjection(state, event);
  return viewProjection(state, inbox);
}

/**
 * Restores a session projection through the cold-read ladder: prefer a persisted
 * disk checkpoint replayed over the tail (B), and fail soft to a full projection
 * (C) when no usable checkpoint exists. The in-memory tier (A) is the caller's
 * already-loaded exec; this helper owns the disk+tail and full-fallback tiers so
 * a missing, stale-versioned, or corrupt checkpoint never regresses attach.
 */
export function restoreProjection(
  sessionID: string,
  session: SessionRecord,
  store: {
    loadProjectionCheckpoint(
      id: string,
    ): { serializedState: string; lastSeq: number } | undefined;
    eventsAfter(id: string, after: number): RuntimeEvent[];
  },
): SessionProjection {
  const checkpoint = store.loadProjectionCheckpoint(sessionID);
  if (checkpoint) {
    const state = deserializeProjectionState(checkpoint.serializedState);
    if (state) {
      for (const event of store.eventsAfter(sessionID, checkpoint.lastSeq))
        applyProjection(state, event);
      return viewProjection(state, session.inbox ?? []);
    }
  }
  return projectSession(session);
}

/** JSON shape of a persisted projection checkpoint. */
export type SerializedProjectionState = {
  version: number;
  events: RuntimeEvent[];
  activeTurnIDs: string[];
  completedTurnIDs: string[];
  usage?: SessionUsageTotals;
};

export function serializeProjectionState(state: ProjectionState): string {
  const payload: SerializedProjectionState = {
    version: state.version,
    events: state.events,
    activeTurnIDs: [...state.activeTurnIDs],
    completedTurnIDs: [...state.completedTurnIDs],
    usage: state.usage,
  };
  return JSON.stringify(payload);
}

/**
 * Restores a persisted projection checkpoint. A row written by an older
 * `PROJECTION_STATE_VERSION` (or a corrupt payload) is discarded so the caller
 * fails soft to a full projection instead of mis-replaying stale state.
 */
export function deserializeProjectionState(
  json: string,
): ProjectionState | undefined {
  let payload: SerializedProjectionState;
  try {
    payload = JSON.parse(json) as SerializedProjectionState;
  } catch {
    return undefined;
  }
  if (payload.version !== PROJECTION_STATE_VERSION) return undefined;
  if (!Array.isArray(payload.events)) return undefined;
  // The set fields feed `new Set(...)`; a same-version payload carrying a
  // non-array there would throw instead of failing soft, so guard them too.
  if (
    payload.activeTurnIDs !== undefined &&
    !Array.isArray(payload.activeTurnIDs)
  )
    return undefined;
  if (
    payload.completedTurnIDs !== undefined &&
    !Array.isArray(payload.completedTurnIDs)
  )
    return undefined;
  // A same-version payload without usage predates the accumulator; fold it
  // from the replayed events rather than reporting zeros for a live session.
  const usage =
    payload.usage ??
    (() => {
      const totals = emptySessionUsageTotals();
      for (const event of payload.events) foldSessionUsageInto(totals, event);
      return totals;
    })();
  return {
    version: payload.version,
    events: payload.events,
    activeTurnIDs: new Set(payload.activeTurnIDs ?? []),
    completedTurnIDs: new Set(payload.completedTurnIDs ?? []),
    usage,
  };
}

function belongsToInterruptedTurn(event: RuntimeEvent, active: Set<string>) {
  if (!("id" in event) || typeof event.id !== "string") return false;
  return [...active].some(
    (turnID) => event.id === turnID || event.id.startsWith(`${turnID}:`),
  );
}

export function selectedModelFromEvents(events: RuntimeEvent[]) {
  for (const event of [...events].reverse())
    if (event.type === "model.selection")
      return { modelID: event.modelID, variant: event.variant };
  return undefined;
}

export function reasoningEffortFromEvents(
  events: RuntimeEvent[],
): import("@anthelia/contracts").RuntimeReasoningEffort | undefined {
  for (const event of [...events].reverse())
    if (event.type === "model.reasoning.set") return event.reasoningEffort;
  return undefined;
}

export function chatModelProfileFromEvents(
  events: RuntimeEvent[],
): Record<string, import("@anthelia/contracts").ChatModelProfile> | undefined {
  let profile:
    | Record<string, import("@anthelia/contracts").ChatModelProfile>
    | undefined;
  for (const event of events) {
    if (event.type === "navi.chat.model.profile") {
      profile = profile ?? {};
      profile.navi = event.profile;
      continue;
    }
    if (event.type === "nia.chat.model.profile") {
      profile = profile ?? {};
      profile.nia = event.profile;
      continue;
    }
    if (event.type === "chat.model.profile") {
      profile = profile ?? {};
      profile[event.channel] = event.profile;
    }
  }
  return profile;
}

export function permissionModeFromEvents(
  events: RuntimeEvent[],
): "ask" | "auto" | "read_only" | undefined {
  for (const event of [...events].reverse())
    if (event.type === "session.permission.mode") return event.mode;
  return undefined;
}

export function permissionProfileFromEvents(
  events: RuntimeEvent[],
): string | undefined {
  for (const event of [...events].reverse())
    if (event.type === "session.permission.mode") return event.profile;
  return undefined;
}

/** Returns the last committed, rather than pending, runtime agent selection. */
export function selectedAgentFromEvents(events: RuntimeEvent[]) {
  for (const event of [...events].reverse())
    if (event.type === "agent.selection" && !event.pending) return event.name;
  return undefined;
}

/**
 * Projects durable events into stable user-turn messages. A message page never
 * splits a turn, so a consumer can group user, reasoning, tool, and interactive
 * rows before it applies its own measured virtualization.
 */
export function projectSessionMessages(
  session: SessionRecord,
  options: { limit?: number; order?: "asc" | "desc"; cursor?: string } = {},
): RuntimeMessagePage {
  const order = options.cursor
    ? decodeMessageCursor(options.cursor).order
    : (options.order ?? "desc");
  if (options.cursor && options.order)
    throw new Error("message cursor cannot be combined with order");
  const messages = projectTurnMessages(session.events);
  const ordered = order === "asc" ? messages : [...messages].reverse();
  const limit = Math.min(200, Math.max(1, options.limit ?? 100));
  const start = messagePageStart(ordered, options.cursor, limit);
  const data = ordered.slice(start, start + limit);
  return {
    data,
    cursor: {
      previous:
        start > 0 && data[0]
          ? encodeMessageCursor({
              order,
              direction: "previous",
              anchor: data[0].id,
            })
          : undefined,
      next:
        start + data.length < ordered.length && data.at(-1)
          ? encodeMessageCursor({
              order,
              direction: "next",
              anchor: data.at(-1)!.id,
            })
          : undefined,
    },
  };
}

export type MessageCursor = {
  version: 1;
  order: "asc" | "desc";
  direction: "previous" | "next";
  anchor: string;
};

function messagePageStart(
  messages: RuntimeProjectedMessage[],
  cursor: string | undefined,
  limit: number,
) {
  if (!cursor) return 0;
  const value = decodeMessageCursor(cursor);
  const index = messages.findIndex((message) => message.id === value.anchor);
  if (index < 0)
    throw new Error("message cursor anchor is no longer available");
  if (value.direction === "next") return index + 1;
  return Math.max(0, index - limit);
}

/**
 * Historical static history can contain a late durable `thinking.done` after
 * a `content.partial` batch that belongs to the following answer. The partials
 * are an early durable copy of the same content step, so restore the logical
 * order `thinking.done -> content.partial -> content.done` when the partial
 * text reconstructs that answer. Do not cross tool/other barriers.
 *
 * New provider-runner writes stamp `thinking.done` with the provider attempt
 * and publish it before the first content chunk, so only un-stamped historical
 * records are normalized here. This keeps a real answer-then-reasoning stream
 * in the order the model produced it.
 */
function normalizeTurnEventOrder(events: RuntimeEvent[]): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  let pendingPartials: RuntimeEvent[] = [];
  const partialText = () =>
    pendingPartials
      .map((event) => ("text" in event ? (event.text ?? "") : ""))
      .join("");
  const matchesDone = (event: RuntimeEvent) => {
    if (!("text" in event) || typeof event.text !== "string") return false;
    const partial = partialText();
    if (!partial) return false;
    return (
      event.text === partial ||
      event.text.startsWith(partial) ||
      partial.startsWith(event.text)
    );
  };
  const flushPartials = () => {
    if (pendingPartials.length === 0) return;
    out.push(...pendingPartials);
    pendingPartials = [];
  };
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (event.type === "content.partial") {
      pendingPartials.push(event);
      continue;
    }
    if (
      pendingPartials.length > 0 &&
      event.type === "thinking.done" &&
      event.attempt === undefined
    ) {
      const barrier = events
        .slice(index + 1)
        .find(
          (candidate) =>
            candidate.type === "content.done" ||
            candidate.type === "tool.update" ||
            candidate.type === "turn.finished",
        );
      if (barrier?.type === "content.done" && matchesDone(barrier)) {
        // Keep the partials pending; emit them before their content.done.
        out.push(event);
        continue;
      }
      flushPartials();
      out.push(event);
      continue;
    }
    if (event.type === "content.done" && pendingPartials.length > 0) {
      if (matchesDone(event)) {
        flushPartials();
        out.push(event);
        continue;
      }
      flushPartials();
    }
    flushPartials();
    out.push(event);
  }
  flushPartials();
  return out;
}

export function projectTurnMessage(
  submitted: Extract<RuntimeEvent, { type: "turn.submitted" }>,
  events: RuntimeEvent[],
): RuntimeProjectedMessage {
  const rowIDCounts = new Map<string, number>();
  const rows = normalizeTurnEventOrder(events).flatMap((candidate) => {
    const kind = projectedRowKind(candidate, submitted.id);
    if (!kind) return [];
    const baseID = projectedRowID(candidate, submitted.id);
    const occurrence = rowIDCounts.get(baseID) ?? 0;
    rowIDCounts.set(baseID, occurrence + 1);
    return [
      {
        // Durable rows can repeat the same event type/id within one turn
        // (multiple provider steps, partial/done pairs). The row id is a
        // consumer-facing key, so keep the first id stable and disambiguate
        // later occurrences instead of returning duplicates.
        id: occurrence === 0 ? baseID : `${baseID}:${occurrence}`,
        turnID: submitted.id,
        kind,
        event: candidate,
      },
    ];
  });
  const terminal = rows.findLast((row) => row.event.type === "turn.finished");
  return {
    id: submitted.id,
    turnID: submitted.id,
    submitted,
    rows,
    stopReason:
      terminal?.event.type === "turn.finished"
        ? terminal.event.stopReason
        : undefined,
  };
}

/**
 * Projects all submitted turns in one event pass. The former implementation
 * scanned the complete journal once per turn, which made JSON-mode history
 * projection quadratic while producing the same row membership.
 */
export function projectTurnMessages(events: RuntimeEvent[]) {
  const byID = new Map<
    string,
    {
      submitted: Extract<RuntimeEvent, { type: "turn.submitted" }>;
      rows: RuntimeProjectedMessage["rows"];
    }
  >();
  const ordered: string[] = [];
  for (const event of events)
    if (event.type === "turn.submitted" && !byID.has(event.id)) {
      byID.set(event.id, { submitted: event, rows: [] });
      ordered.push(event.id);
    }
  let currentTurnID: string | undefined;
  const rowIDCounts = new Map<string, Map<string, number>>();
  for (const event of normalizeTurnEventOrder(events)) {
    if (event.type === "turn.submitted" && byID.has(event.id))
      currentTurnID = event.id;
    const turnID = projectedTurnID(event, byID, currentTurnID);
    if (!turnID) continue;
    const message = byID.get(turnID)!;
    const kind = projectedRowKind(event, turnID);
    if (!kind) continue;
    const baseID = projectedRowID(event, turnID);
    const counts = rowIDCounts.get(turnID) ?? new Map<string, number>();
    rowIDCounts.set(turnID, counts);
    const occurrence = counts.get(baseID) ?? 0;
    counts.set(baseID, occurrence + 1);
    message.rows.push({
      id: occurrence === 0 ? baseID : `${baseID}:${occurrence}`,
      turnID,
      kind,
      event,
    });
  }
  return ordered.map((id) => {
    const message = byID.get(id)!;
    const terminal = message.rows.findLast(
      (row) => row.event.type === "turn.finished",
    );
    return {
      id,
      turnID: id,
      submitted: message.submitted,
      rows: message.rows,
      stopReason:
        terminal?.event.type === "turn.finished"
          ? terminal.event.stopReason
          : undefined,
    } satisfies RuntimeProjectedMessage;
  });
}

function projectedTurnID(
  event: RuntimeEvent,
  messages: Map<string, unknown>,
  currentTurnID?: string,
) {
  if (event.type === "policy.decision")
    return messages.has(event.turnID) ? event.turnID : undefined;
  if (event.type === "turn.input")
    return messages.has(event.turnID) ? event.turnID : undefined;
  // `input.*` events describe a durable admission, not a turn row. Without this
  // they would attach to the started turn carrying the same id.
  if (event.type.startsWith("input.")) return undefined;
  // Collaboration messages carry their identity under `message.id`, not a
  // top-level `id` prefixed by the turn. They still belong to the turn that was
  // open when they were emitted, so attach them by event-stream order.
  if (event.type === "natalia.collab.message") return currentTurnID;
  if (!("id" in event) || typeof event.id !== "string") return undefined;
  let candidate = event.id;
  while (candidate) {
    if (messages.has(candidate)) return candidate;
    const separator = candidate.lastIndexOf(":");
    if (separator < 0) return undefined;
    candidate = candidate.slice(0, separator);
  }
  return undefined;
}

function projectedRowKind(
  event: RuntimeEvent,
  turnID: string,
): RuntimeProjectedMessageRowKind | undefined {
  if (event.type === "turn.submitted" && event.id === turnID)
    return event.internal ? "system" : "user";
  if (event.type === "policy.decision" && event.turnID === turnID)
    return "system";
  if (event.type === "turn.input") return event.internal ? "system" : "user";
  if (event.type === "natalia.collab.message") return "system";
  if (!("id" in event) || typeof event.id !== "string") return undefined;
  if (event.id !== turnID && !event.id.startsWith(`${turnID}:`))
    return undefined;
  if (event.type === "thinking.delta" || event.type === "thinking.done")
    return "thinking";
  if (
    event.type === "content.delta" ||
    event.type === "content.done" ||
    event.type === "content.partial"
  )
    return "assistant";
  if (event.type === "tool.update") return "tool";
  if (event.type === "approval.request" || event.type === "approval.response")
    return "approval";
  if (event.type === "question.request" || event.type === "question.response")
    return "question";
  return "system";
}

function projectedRowID(event: RuntimeEvent, turnID: string) {
  if (event.type === "turn.input")
    return `${event.turnID}:user:${event.inputID}`;
  if (event.type === "natalia.collab.message")
    return `${turnID}:collab:${event.message.id}`;
  if (event.type === "policy.decision")
    return `${turnID}:policy:${event.toolCallID ?? event.toolName}:${event.decision}`;
  if ("id" in event && typeof event.id === "string")
    return `${event.id}:${event.type}`;
  return `${turnID}:${event.type}`;
}

export function encodeMessageCursor(input: Omit<MessageCursor, "version">) {
  return Buffer.from(JSON.stringify({ version: 1, ...input })).toString(
    "base64url",
  );
}

export function decodeMessageCursor(cursor: string): MessageCursor {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<MessageCursor>;
    if (
      value.version !== 1 ||
      (value.order !== "asc" && value.order !== "desc") ||
      (value.direction !== "previous" && value.direction !== "next") ||
      typeof value.anchor !== "string" ||
      !value.anchor
    )
      throw new Error("invalid message cursor");
    return value as MessageCursor;
  } catch {
    throw new Error("invalid message cursor");
  }
}

/**
 * Settles only interactive requests owned by a crashed turn. Provider and tool
 * execution cannot be resumed safely without a durable continuation record.
 */
export function settleInterruptedTurns(session: SessionRecord) {
  const activeTurnIDs = projectSession(session).activeTurnIDs;
  if (!activeTurnIDs.length) return [];
  const pendingApprovals = new Set<string>();
  const pendingQuestions = new Set<string>();
  for (const event of session.events) {
    if (event.type === "approval.request") pendingApprovals.add(event.id);
    if (event.type === "approval.response") pendingApprovals.delete(event.id);
    if (event.type === "question.request") pendingQuestions.add(event.id);
    if (event.type === "question.response") pendingQuestions.delete(event.id);
  }
  const settled = settleInterruptedTurnIDs(
    activeTurnIDs,
    [...pendingApprovals],
    [...pendingQuestions],
  );
  session.events.push(...settled);
  return settled;
}

/**
 * The next `context.instructions` revision for a session (ADR Phase C):
 * one past the highest revision already in the journal, so a later change
 * supersedes an earlier one without mutating history.
 */
export function nextContextInstructionsRevision(
  events: RuntimeEvent[],
): number {
  let max = 0;
  for (const event of events)
    if (event.type === "context.instructions" && event.revision > max)
      max = event.revision;
  return max + 1;
}

/**
 * Projects the runtime notices from the journal (ADR Phase C): the latest
 * prompt-level instruction change per kind. A later `context.instructions`
 * event supersedes an earlier same-kind notice by revision — the projection
 * never mutates history, it just reports the current state per kind.
 */
export function projectedRuntimeNotices(
  events: RuntimeEvent[],
): import("@anthelia/contracts").RuntimeProjectedNotice[] {
  const latest = new Map<
    string,
    import("@anthelia/contracts").RuntimeProjectedNotice
  >();
  for (const event of events) {
    if (event.type !== "context.instructions") continue;
    const existing = latest.get(event.kind);
    if (existing && existing.revision >= event.revision) continue;
    latest.set(event.kind, {
      noticeID: event.id,
      kind: event.kind,
      revision: event.revision,
      at: event.at,
      summary: event.summary,
      ...(event.detail ? { detail: event.detail } : {}),
    });
  }
  return [...latest.values()].sort((left, right) =>
    left.at.localeCompare(right.at),
  );
}

export function projectedConstitutionRules(events: RuntimeEvent[]) {
  const state = emptySessionConstitutionFactState();
  for (const event of events) applySessionConstitutionFact(state, event);
  return sessionConstitutionRulesFrom(state);
}

/**
 * Projects the work contracts from the journal (EI §8.2): the latest accepted
 * contract or draft per plan. Used by the handoff gate, which refuses to hand
 * off a plan the user has not committed to.
 */
export function projectedWorkContracts(events: RuntimeEvent[]) {
  const state = emptySessionWorkContractFactState();
  for (const event of events) applySessionWorkContractFact(state, event);
  return sessionWorkContractsFrom(state);
}

export function projectedConstitutionOverrides(
  events: RuntimeEvent[],
  now = Date.now(),
) {
  const state = emptySessionConstitutionFactState();
  for (const event of events) applySessionConstitutionFact(state, event);
  return sessionConstitutionOverridesFrom(state, now);
}

export function latestSessionSnapshot(events: RuntimeEvent[]) {
  let latest: Extract<RuntimeEvent, { type: "session.snapshot" }> | undefined;
  for (const event of events) {
    if (event.type === "session.snapshot") latest = event;
  }
  return latest;
}

/**
 * A drift finding as projected from the journal. This is deliberately not the
 * `drift.finding_opened` event type: the current status is the result of
 * replaying later `drift.finding_updated` events, so it belongs to the
 * projection rather than to any single event.
 */
export type ProjectedDriftFinding = {
  findingID: string;
  severity: "advisory" | "warning" | "high";
  confidence: number;
  originalObjective: string;
  currentActivity: string;
  evidence: string[];
  applicableConstraints: string[];
  status:
    | "open"
    | "explained"
    | "disputed"
    | "dismissed"
    | "corrected"
    | "detour_declared";
  /**
   * How many times this finding was reopened (翻案, EI §3.5): a user lifted a
   * terminal disposition (dismissed/explained) back to open. A rising count is a
   * rule-tuning signal — the same suspicion keeps being reopened.
   */
  reopenedCount: number;
  rationale?: string;
  /** The evaluation contract version the finding was judged under (EI §8.6). */
  contractVersion: number;
  /** Which rules fired with their confidences (EI §8.6 judgment matrix). */
  ruleHits: Array<{ rule: string; confidence: number }>;
  /** The accepted contract's planID, when the finding was judged against one. */
  planID?: string;
};

export function projectedDriftFindings(
  events: RuntimeEvent[],
): ProjectedDriftFinding[] {
  const state = emptySessionDriftFactState();
  for (const event of events) applySessionDriftFact(state, event);
  return sessionDriftFindingsFrom(state);
}

export function projectedCanonicalTools(events: RuntimeEvent[]) {
  const tools = new Map<string, RuntimeEvent>();
  for (const event of events) {
    if (event.type === "tool.registered") tools.set(event.name, event);
    if (event.type === "tool.unregistered") tools.delete(event.name);
  }
  return [...tools.values()].filter(
    (e): e is Extract<RuntimeEvent, { type: "tool.registered" }> =>
      e.type === "tool.registered",
  );
}

/**
 * A loaded capability as projected from the journal. The nested manifest mirrors
 * `capabilityManifestSchema`, but only carries the fields the journal actually
 * records: `description` and `dependencies` are not part of the
 * `capability.loaded` event and are therefore not invented here.
 */
export type ProjectedCapability = {
  id: string;
  name: string;
  manifest: {
    apiVersion: number;
    id: string;
    name: string;
    version: string;
    scope: "process" | "workspace" | "session";
    grants: string[];
  };
};

export function projectedCapabilities(
  events: RuntimeEvent[],
): ProjectedCapability[] {
  const loaded = new Map<string, ProjectedCapability>();
  for (const event of events) {
    if (event.type === "capability.loaded")
      loaded.set(event.id, {
        id: event.id,
        name: event.name,
        manifest: {
          apiVersion: event.apiVersion,
          id: event.id,
          name: event.name,
          version: event.version,
          scope: event.scope,
          grants: event.grants,
        },
      });
    if (event.type === "capability.unloaded") loaded.delete(event.id);
  }
  return [...loaded.values()];
}

export function projectedWorkGraphNodes(events: RuntimeEvent[]) {
  return events.filter(
    (event): event is Extract<RuntimeEvent, { type: "workgraph.node_added" }> =>
      event.type === "workgraph.node_added",
  );
}

export function projectedWorkGraphEdges(events: RuntimeEvent[]) {
  return events.filter(
    (event): event is Extract<RuntimeEvent, { type: "workgraph.edge_added" }> =>
      event.type === "workgraph.edge_added",
  );
}

export function projectedEvidenceRecords(events: RuntimeEvent[]) {
  return events.filter(
    (event): event is Extract<RuntimeEvent, { type: "evidence.recorded" }> =>
      event.type === "evidence.recorded",
  );
}

/** Growth promotions (block ②), newest first. */
export function projectedGrowthPromotions(events: RuntimeEvent[]) {
  return events
    .filter(
      (event): event is Extract<RuntimeEvent, { type: "growth.promoted" }> =>
        event.type === "growth.promoted",
    )
    .reverse();
}

/** External-run joins (Discovery G-c), newest first. */
export function projectedExternalRuns(events: RuntimeEvent[]) {
  return events
    .filter(
      (
        event,
      ): event is Extract<RuntimeEvent, { type: "external_run.recorded" }> =>
        event.type === "external_run.recorded",
    )
    .reverse();
}

/** Growth proposals (Discovery G-a), newest first (each derives the whole
 * curriculum, so the latest is the current state of the question). */
export function projectedGrowthProposals(events: RuntimeEvent[]) {
  return events
    .filter(
      (event): event is Extract<RuntimeEvent, { type: "growth.proposed" }> =>
        event.type === "growth.proposed",
    )
    .reverse();
}

/** Completion cards (P2 E4), in journal order. */
export function projectedCompletions(events: RuntimeEvent[]) {
  return events.filter(
    (event): event is Extract<RuntimeEvent, { type: "completion.recorded" }> =>
      event.type === "completion.recorded",
  );
}

export function projectedDecisionRecords(events: RuntimeEvent[]) {
  const state = emptySessionDecisionFactState();
  for (const event of events) applySessionDecisionFact(state, event);
  return sessionDecisionRecordsFrom(state);
}

/**
 * Projects the current mailbox state from the durable journal. The lifecycle is
 * event-sourced: `mailbox.queued` creates a message and each transition event
 * (`delivered`/`acknowledged`/`deferred`/`superseded`) moves it forward. The
 * projected status is the result of replaying the whole journal, so replay
 * reproduces the same mailbox the live session saw.
 */
export type ProjectedMailboxMessage = {
  messageID: string;
  source: "user_via_live_chat" | "system";
  priority: "normal" | "high" | "urgent";
  intent:
    | "clarification"
    | "constraint"
    | "reprioritize"
    | "pause"
    | "cancel"
    | "request_report"
    | "proposed_change"
    | "next_plan_handoff";
  text: string;
  safeSummary: string;
  relatedPlanID?: string;
  deliveryPolicy:
    | "next_safe_boundary"
    | "before_next_tool"
    | "before_next_side_effect"
    | "immediate_control";
  createdAt: string;
  status: "queued" | "delivered" | "acknowledged" | "deferred" | "superseded";
  reason?: string;
};

export function projectedMailboxMessages(
  events: RuntimeEvent[],
): ProjectedMailboxMessage[] {
  const state = emptySessionMailboxFactState();
  for (const event of events) applySessionMailboxFact(state, event);
  return sessionMailboxMessagesFrom(state);
}

/**
 * Projects the independent Navi and Nia conversations from the durable journal.
 * New records route by their `navi.chat.*` or `nia.chat.*` prefix. The legacy
 * `chat.*` branch is retained only to ingest journals persisted before the
 * namespace migration.
 */
export type ProjectedChatMessage = {
  messageID: string;
  role: "user" | "chat" | "system";
  text: string;
  at: string;
  kind?: "message" | "thinking" | "tool" | "compaction" | "collab";
  attachments?: import("@anthelia/contracts").LocalAttachment[];
  tool?: {
    /** Durable event id, stable across replay and live hydration. */
    eventID?: string;
    name: string;
    status: string;
    summary: string;
    result?: string;
    argumentsRaw?: string;
    startedAt?: number;
    endedAt?: number;
  };
};

/**
 * Legacy `chat.*` compatibility projection needs the old channel discriminator
 * internally. It is stripped at the public boundary; new producers use
 * `navi.chat.*` / `nia.chat.*` and never expose a channel field.
 */
type InternalProjectedChatMessage = ProjectedChatMessage & {
  channel: ChatChannel;
};

function stripChatChannel(
  message: InternalProjectedChatMessage,
): ProjectedChatMessage {
  const { channel: _channel, ...rest } = message;
  return rest;
}

export function projectedChatMessages(
  events: RuntimeEvent[],
): ProjectedChatMessage[] {
  const messages: InternalProjectedChatMessage[] = [];
  const thinkingByMessage = new Map<string, InternalProjectedChatMessage>();
  for (const event of events) {
    const channel = chatEventChannel(event);
    if (!channel) continue;
    if (isChatThinkingDelta(event)) {
      const key = `${channel}:${event.messageID}`;
      const existing = thinkingByMessage.get(key);
      if (existing) {
        existing.text += event.text;
      } else {
        const thinking: InternalProjectedChatMessage = {
          messageID: event.messageID,
          role: "chat",
          text: event.text,
          // Chat deltas do not carry a timestamp. Keeping journal order avoids
          // making replay depend on the wall clock used by the projector.
          at: "",
          channel,
          kind: "thinking",
        };
        thinkingByMessage.set(key, thinking);
        messages.push(thinking);
      }
      continue;
    }
    if (isChatThinkingDone(event)) {
      const key = `${channel}:${event.messageID}`;
      const existing = thinkingByMessage.get(key);
      if (existing) {
        // The durable settlement is the complete record. It supersedes any
        // live-only delta captured by a caller that projects both streams.
        existing.text = event.text;
      } else {
        const thinking: InternalProjectedChatMessage = {
          messageID: event.messageID,
          role: "chat",
          text: event.text,
          at: "",
          channel,
          kind: "thinking",
        };
        thinkingByMessage.set(key, thinking);
        messages.push(thinking);
      }
      continue;
    }
    if (isChatMessageSettlement(event)) {
      messages.push({
        messageID: event.messageID,
        role: event.role,
        text: event.text,
        at: event.at,
        channel,
        kind: "message",
        ...(event.attachments ? { attachments: event.attachments } : {}),
      });
      continue;
    }
    if (isChatToolUsed(event)) {
      messages.push({
        messageID: event.messageID,
        role: "chat",
        text: event.summary,
        at: event.at,
        channel,
        kind: "tool",
        tool: {
          eventID: event.id,
          name: event.toolName,
          status: event.status,
          summary: event.summary,
          ...(event.result !== undefined ? { result: event.result } : {}),
          ...(event.argumentsRaw !== undefined
            ? { argumentsRaw: event.argumentsRaw }
            : {}),
          ...(event.startedAt !== undefined
            ? { startedAt: event.startedAt }
            : {}),
          ...(event.endedAt !== undefined ? { endedAt: event.endedAt } : {}),
        },
      });
      continue;
    }
    if (isChatRollback(event)) {
      const boundary = messages.findIndex(
        (message) =>
          message.messageID === event.toMessageID &&
          message.channel === channel,
      );
      if (boundary !== -1) {
        for (let index = messages.length - 1; index >= 0; index -= 1)
          if (messages[index]?.channel === channel && index > boundary)
            messages.splice(index, 1);
      } else {
        for (let index = messages.length - 1; index >= 0; index -= 1)
          if (messages[index]?.channel === channel) messages.splice(index, 1);
      }
      thinkingByMessage.clear();
      for (const message of messages)
        if (message.kind === "thinking")
          thinkingByMessage.set(
            `${message.channel}:${message.messageID}`,
            message,
          );
    }
    if (isChatCompacted(event)) {
      const boundary = messages.findIndex(
        (message) =>
          message.messageID === event.compactedThroughMessageID &&
          message.channel === channel,
      );
      if (boundary !== -1) {
        for (let index = messages.length - 1; index >= 0; index -= 1)
          if (messages[index]?.channel === channel && index >= boundary)
            messages.splice(index, 1);
      } else {
        for (let index = messages.length - 1; index >= 0; index -= 1)
          if (messages[index]?.channel === channel) messages.splice(index, 1);
      }
      messages.push({
        messageID: event.messageID,
        role: "chat",
        text: `[已压缩的聊天历史]
${event.summary}`,
        at: event.at,
        channel,
        kind: "compaction",
      });
    }
  }
  return messages.map(stripChatChannel);
}

export function projectedNaviChatMessages(
  events: RuntimeEvent[],
): ProjectedChatMessage[] {
  return projectNaviChatMessages(events);
}

export function projectedNiaChatMessages(
  events: RuntimeEvent[],
): ProjectedChatMessage[] {
  return projectNiaChatMessages(events);
}

function projectNaviChatMessages(
  events: RuntimeEvent[],
): ProjectedChatMessage[] {
  return projectChatStream(events, "navi", isNaviChatEvent);
}

function projectNiaChatMessages(
  events: RuntimeEvent[],
): ProjectedChatMessage[] {
  return projectChatStream(events, "nia", isNiaChatEvent);
}

function collabChatRow(
  event: RuntimeEvent,
  channel: ChatChannel,
): InternalProjectedChatMessage | undefined {
  const message = normalizeCollaborationEvent(event);
  if (!message) return undefined;
  if (channel === "navi" && message.from !== "live_chat") return undefined;
  if (channel === "nia" && message.from !== "nia") return undefined;
  const from =
    message.from === "main_agent"
      ? "Natalia"
      : message.from === "live_chat"
        ? "Navi"
        : "Nia";
  const to =
    message.to === "main_agent"
      ? "Natalia"
      : message.to === "live_chat"
        ? "Navi"
        : "Nia";
  const text =
    message.kind === "response"
      ? `Natalia ${message.decision} the suggestion${message.reason ? ` (${message.reason})` : ""}`
      : `${from} → ${to}: ${message.text}`;
  return {
    messageID: message.id,
    role: "system",
    text,
    at: message.at,
    channel,
    kind: "collab",
  };
}

function projectChatStream(
  events: RuntimeEvent[],
  channel: ChatChannel,
  owns: (event: RuntimeEvent) => boolean,
): ProjectedChatMessage[] {
  const messages: InternalProjectedChatMessage[] = [];
  const thinkingByMessage = new Map<string, InternalProjectedChatMessage>();
  for (const event of events) {
    const collab = collabChatRow(event, channel);
    if (collab) {
      messages.push(collab);
      continue;
    }
    if (!owns(event)) continue;
    if (isChatThinkingDelta(event)) {
      const existing = thinkingByMessage.get(event.messageID);
      if (existing) existing.text += event.text;
      else {
        const thinking = {
          messageID: event.messageID,
          role: "chat" as const,
          text: event.text,
          at: "",
          channel,
          kind: "thinking" as const,
        };
        thinkingByMessage.set(event.messageID, thinking);
        messages.push(thinking);
      }
      continue;
    }
    if (isChatThinkingDone(event)) {
      const existing = thinkingByMessage.get(event.messageID);
      if (existing) existing.text = event.text;
      else {
        const thinking = {
          messageID: event.messageID,
          role: "chat" as const,
          text: event.text,
          at: "",
          channel,
          kind: "thinking" as const,
        };
        thinkingByMessage.set(event.messageID, thinking);
        messages.push(thinking);
      }
      continue;
    }
    if (isChatMessageSettlement(event)) {
      messages.push({
        messageID: event.messageID,
        role: event.role,
        text: event.text,
        at: event.at,
        channel,
        kind: "message",
        ...(event.attachments ? { attachments: event.attachments } : {}),
      });
      continue;
    }
    if (isChatToolUsed(event)) {
      messages.push({
        messageID: event.messageID,
        role: "chat",
        text: event.summary,
        at: event.at,
        channel,
        kind: "tool",
        tool: {
          eventID: event.id,
          name: event.toolName,
          status: event.status,
          summary: event.summary,
          ...(event.result !== undefined ? { result: event.result } : {}),
          ...(event.argumentsRaw !== undefined
            ? { argumentsRaw: event.argumentsRaw }
            : {}),
          ...(event.startedAt !== undefined
            ? { startedAt: event.startedAt }
            : {}),
          ...(event.endedAt !== undefined ? { endedAt: event.endedAt } : {}),
        },
      });
      continue;
    }
    if (isChatRollback(event)) {
      const boundary = messages.findIndex(
        (message) => message.messageID === event.toMessageID,
      );
      messages.splice(boundary === -1 ? 0 : boundary + 1);
      thinkingByMessage.clear();
      for (const message of messages)
        if (message.kind === "thinking")
          thinkingByMessage.set(message.messageID, message);
      continue;
    }
    if (isChatCompacted(event)) {
      const boundary = messages.findIndex(
        (message) => message.messageID === event.compactedThroughMessageID,
      );
      messages.splice(boundary === -1 ? 0 : boundary);
      messages.push({
        messageID: event.messageID,
        role: "chat",
        text: `[已压缩的聊天历史]\n${event.summary}`,
        at: event.at,
        channel,
        kind: "compaction",
      });
    }
  }
  return messages.map(stripChatChannel);
}

function isNaviChatEvent(event: RuntimeEvent): boolean {
  return (
    event.type.startsWith("navi.chat.") ||
    (event.type.startsWith("chat.") &&
      (event as { channel?: ChatChannel }).channel !== "nia")
  );
}

function isNiaChatEvent(event: RuntimeEvent): boolean {
  return (
    event.type.startsWith("nia.chat.") ||
    (event.type.startsWith("chat.") &&
      (event as { channel?: ChatChannel }).channel === "nia")
  );
}

function chatEventChannel(event: RuntimeEvent): ChatChannel | undefined {
  if (event.type.startsWith("navi.chat.")) return "navi";
  if (event.type.startsWith("nia.chat.")) return "nia";
  if (event.type.startsWith("chat."))
    return (event as { channel?: ChatChannel }).channel ?? "navi";
  return undefined;
}

function isChatCompacted(
  event: RuntimeEvent,
): event is Extract<RuntimeEvent, { type: `${ChatChannel}.chat.compacted` }> {
  return (
    event.type === "navi.chat.compacted" || event.type === "nia.chat.compacted"
  );
}

function isChatThinkingDelta(
  event: RuntimeEvent,
): event is Extract<
  RuntimeEvent,
  { type: `${ChatChannel}.chat.thinking.delta` | "chat.thinking.delta" }
> {
  return (
    event.type === "navi.chat.thinking.delta" ||
    event.type === "nia.chat.thinking.delta" ||
    event.type === "chat.thinking.delta"
  );
}

function isChatToolUsed(
  event: RuntimeEvent,
): event is Extract<
  RuntimeEvent,
  { type: `${ChatChannel}.chat.tool.used` | "chat.tool.used" }
> {
  return (
    event.type === "navi.chat.tool.used" ||
    event.type === "nia.chat.tool.used" ||
    event.type === "chat.tool.used"
  );
}

function isChatMessageSettlement(event: RuntimeEvent): event is Extract<
  RuntimeEvent,
  {
    type:
      | `${ChatChannel}.chat.message.new`
      | `${ChatChannel}.chat.message.added`
      | "chat.message.added";
  }
> {
  return (
    event.type === "navi.chat.message.new" ||
    event.type === "nia.chat.message.new" ||
    event.type === "navi.chat.message.added" ||
    event.type === "nia.chat.message.added" ||
    event.type === "chat.message.added"
  );
}

function isChatThinkingDone(
  event: RuntimeEvent,
): event is Extract<
  RuntimeEvent,
  { type: `${ChatChannel}.chat.thinking.done` }
> {
  return (
    event.type === "navi.chat.thinking.done" ||
    event.type === "nia.chat.thinking.done"
  );
}

function isChatRollback(
  event: RuntimeEvent,
): event is Extract<
  RuntimeEvent,
  { type: `${ChatChannel}.chat.rollback` | "chat.rollback" }
> {
  return (
    event.type === "navi.chat.rollback" ||
    event.type === "nia.chat.rollback" ||
    event.type === "chat.rollback"
  );
}

/**
 * Projects the agent-to-agent collaboration channel (Chat Navi ↔ Main Natalia):
 * suggestions, notices, questions, answers and responses as one durable
 * conversation. Reply relationships are resolved after normalization so
 * replay order does not change pending state.
 */
export type ProjectedCollabMessage = CollaborationMessage & {
  status: "pending" | "replied" | "informational";
  /** Legacy alias retained while the public tool still calls this questionID. */
  questionID?: string;
};

export function normalizeCollaborationEvent(
  event: RuntimeEvent,
  targets: ReadonlyMap<string, CollaborationMessage> = new Map(),
): CollaborationMessage | undefined {
  if (
    event.type === "collab.message" ||
    event.type === "natalia.collab.message" ||
    event.type === "navi.collab.message" ||
    event.type === "nia.collab.message"
  )
    return event.message;
  if (event.type === "collab.suggestion")
    return {
      id: event.id,
      threadID: event.id,
      kind: "suggestion",
      from: event.from,
      to: event.to,
      text: event.suggestion,
      expectsReply: true,
      priority: event.priority,
      ...(event.rationale ? { rationale: event.rationale } : {}),
      at: event.at,
    };
  if (event.type === "collab.notice")
    return {
      id: event.id,
      threadID: event.id,
      kind: "notice",
      from: event.from,
      to: event.to,
      text: event.notice,
      expectsReply: false,
      noticeType: event.noticeType,
      at: event.at,
    };
  if (event.type === "collab.question")
    return {
      id: event.id,
      threadID: event.id,
      kind: "question",
      from: event.from,
      to: event.to,
      text: event.question,
      expectsReply: true,
      at: event.at,
    };
  if (event.type === "collab.answer")
    return {
      id: event.id,
      threadID: targets.get(event.questionID)?.threadID ?? event.questionID,
      replyToID: event.questionID,
      kind: "answer",
      from: event.from,
      to: event.to,
      text: event.answer,
      expectsReply: false,
      at: event.at,
    };
  if (event.type === "collab.chat")
    return {
      id: event.id,
      threadID: event.threadID,
      ...(event.replyToID ? { replyToID: event.replyToID } : {}),
      kind: "chat",
      from: event.from,
      to: event.to,
      text: event.text,
      expectsReply: event.expectsReply,
      round: event.round,
      at: event.at,
    };
  if (event.type === "collab.response")
    return {
      id: event.id,
      threadID: targets.get(event.messageID)?.threadID ?? event.messageID,
      replyToID: event.messageID,
      kind: "response",
      from: "main_agent",
      to: "live_chat",
      text: event.reason ?? event.decision,
      expectsReply: false,
      decision: event.decision,
      ...(event.reason ? { reason: event.reason } : {}),
      at: event.at,
    };
  return undefined;
}

export function projectedCollabMessages(
  events: RuntimeEvent[],
): ProjectedCollabMessage[] {
  const targets = new Map<string, CollaborationMessage>();
  for (const event of events) {
    const message = normalizeCollaborationEvent(event, targets);
    if (message && !targets.has(message.id)) targets.set(message.id, message);
  }
  const normalized = events
    .map((event) => normalizeCollaborationEvent(event, targets))
    .filter((message): message is CollaborationMessage => Boolean(message));
  const unique = normalized.filter(
    (message, index) =>
      normalized.findIndex((candidate) => candidate.id === message.id) ===
      index,
  );
  const replied = new Set<string>();
  for (const message of unique) {
    if (!message.replyToID) continue;
    const target = targets.get(message.replyToID);
    if (
      target &&
      target.expectsReply &&
      target.threadID === message.threadID &&
      target.from === message.to &&
      target.to === message.from &&
      ((message.kind === "answer" && target.kind === "question") ||
        (message.kind === "response" && target.kind === "suggestion") ||
        (message.kind === "chat" && target.kind === "chat"))
    )
      replied.add(target.id);
  }
  return unique.map((message) => ({
    ...message,
    status: replied.has(message.id)
      ? "replied"
      : message.expectsReply
        ? "pending"
        : "informational",
    ...(message.kind === "answer" ? { questionID: message.replyToID } : {}),
  }));
}

/**
 * Projects the current lightweight plan document registry from the journal.
 *
 * Unlike the former C4 plan ledger, this does not store plan content. It only
 * tracks which Markdown document is a formal Plan, where it lives, and the
 * lifecycle status used by handoff/execution/audit routing.
 */
export type ProjectedPlanDoc = {
  planID: string;
  title: string;
  documentPath: string;
  createdBy: "user" | "live_chat" | "main_agent";
  createdAt: string;
  updatedAt: string;
  markedAt?: string;
  status: string;
};

export function projectedPlanDocs(events: RuntimeEvent[]): ProjectedPlanDoc[] {
  const plans = new Map<string, ProjectedPlanDoc>();
  for (const event of events) {
    if (event.type === "plan.doc.created") {
      plans.set(event.planID, {
        planID: event.planID,
        title: event.title,
        documentPath: event.documentPath,
        createdBy: event.createdBy,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        status: event.status,
      });
      continue;
    }
    if (event.type === "plan.doc.deleted") {
      plans.delete(event.planID);
      continue;
    }
    if (
      event.type !== "plan.doc.updated" &&
      event.type !== "plan.doc.marked" &&
      event.type !== "plan.doc.status"
    )
      continue;
    const plan = plans.get(event.planID);
    if (!plan) continue;
    switch (event.type) {
      case "plan.doc.updated":
        plan.updatedAt = event.updatedAt;
        if (event.reason) plan.status = plan.status;
        break;
      case "plan.doc.marked":
        plan.markedAt = event.markedAt;
        plan.updatedAt = event.markedAt;
        break;
      case "plan.doc.status":
        plan.status = event.status;
        plan.updatedAt = event.at;
        break;
    }
  }
  return [...plans.values()];
}

export function settleInterruptedTurnIDs(
  activeTurnIDs: string[],
  pendingApprovalIDs: string[],
  pendingQuestionIDs: string[],
) {
  const settled: RuntimeEvent[] = [];
  for (const requestID of pendingApprovalIDs)
    if (requestBelongsToInterruptedTurn(requestID, activeTurnIDs))
      settled.push({
        type: "approval.response",
        id: requestID,
        decision: "reject",
        feedback: "interrupted turn cannot continue after runtime restart",
      });
  for (const requestID of pendingQuestionIDs)
    if (requestBelongsToInterruptedTurn(requestID, activeTurnIDs))
      settled.push({
        type: "question.response",
        id: requestID,
        answers: [],
        rejected: true,
      });
  for (const id of activeTurnIDs)
    settled.push({ type: "turn.finished", id, stopReason: "error" });
  return settled;
}

function requestBelongsToInterruptedTurn(requestID: string, turnIDs: string[]) {
  return turnIDs.some(
    (turnID) =>
      requestID === turnID ||
      requestID.startsWith(`${turnID}:`) ||
      requestID.includes(`:${turnID}:`),
  );
}

/* ---------------------------------------------------------------------------
 * Incremental session fact state.
 *
 * The projections in this file are pure folds over the durable event log. The
 * runtime keeps the same folds materialised incrementally at the event-sink
 * choke point (`applySessionFactEvent`), so a surface can read a fact set in
 * O(active set) instead of re-scanning every event. Equivalence is enforced by
 * construction: `projectedX(events)` folds through the same reducer the fact
 * state uses.
 *
 * `collabEvents` is the one deliberate exception: `projectedCollabMessages`
 * resolves out-of-order replies with a second pass, so we collect the relevant
 * events verbatim and re-fold that (small) subset on read rather than trying to
 * make the two-pass fold streaming-safe.
 * ------------------------------------------------------------------------- */

type ConstitutionRuleAdded = Extract<
  RuntimeEvent,
  { type: "constitution.rule_added" }
>;
type ConstitutionOverrideGranted = Extract<
  RuntimeEvent,
  { type: "constitution.override_granted" }
>;
type DecisionRecorded = Extract<RuntimeEvent, { type: "decision.recorded" }>;
type SessionSnapshotEvent = Extract<RuntimeEvent, { type: "session.snapshot" }>;

/** Turn ids still open, plus completed ids. */
export type SessionTurnFactState = {
  activeTurnIDs: Set<string>;
  completedTurnIDs: Set<string>;
};

export function emptySessionTurnFactState(): SessionTurnFactState {
  return { activeTurnIDs: new Set(), completedTurnIDs: new Set() };
}

export function applySessionTurnFact(
  state: SessionTurnFactState,
  event: RuntimeEvent,
): void {
  if (event.type === "turn.submitted") {
    state.activeTurnIDs.add(event.id);
    return;
  }
  if (event.type === "turn.finished") {
    state.activeTurnIDs.delete(event.id);
    state.completedTurnIDs.add(event.id);
  }
}

/** Effective constitution rules keyed by ruleID, plus raw override grants and
 * the set of rules disabled by `rule_updated(enabled:false)`. */
export type SessionConstitutionFactState = {
  rules: Map<string, ConstitutionRuleAdded>;
  disabled: Set<string>;
  overrides: ConstitutionOverrideGranted[];
};

export function emptySessionConstitutionFactState(): SessionConstitutionFactState {
  return { rules: new Map(), disabled: new Set(), overrides: [] };
}

export function applySessionConstitutionFact(
  state: SessionConstitutionFactState,
  event: RuntimeEvent,
): void {
  if (event.type === "constitution.rule_added") {
    if (!state.rules.has(event.ruleID)) state.rules.set(event.ruleID, event);
    state.disabled.delete(event.ruleID);
    return;
  }
  if (event.type === "constitution.rule_updated") {
    // A disable is reversible (enabled:false) and keeps the rule in the
    // journal; only rule_removed is the durable tombstone.
    if (event.enabled === false) state.disabled.add(event.ruleID);
    else if (event.enabled === true) state.disabled.delete(event.ruleID);
    const existing = state.rules.get(event.ruleID);
    if (!existing) return;
    state.rules.set(event.ruleID, {
      ...existing,
      ...(event.statement ? { statement: event.statement } : {}),
      ...(event.priority ? { priority: event.priority } : {}),
      ...(event.enforcement ? { enforcement: event.enforcement } : {}),
      ...(event.overridePolicy ? { overridePolicy: event.overridePolicy } : {}),
      ...(event.appliesTo ? { appliesTo: event.appliesTo } : {}),
    });
    return;
  }
  if (event.type === "constitution.rule_removed") {
    // The tombstone stays in the journal (history is complete); the effective
    // set simply drops the rule.
    state.rules.delete(event.ruleID);
    state.disabled.delete(event.ruleID);
    return;
  }
  if (event.type === "constitution.override_granted")
    state.overrides.push(event);
}

export function sessionConstitutionRulesFrom(
  state: SessionConstitutionFactState,
): ConstitutionRuleAdded[] {
  return [...state.rules.values()].filter(
    (rule) => !state.disabled.has(rule.ruleID),
  );
}

/** Overrides are time-filtered at read time, so the fold stays deterministic. */
export function sessionConstitutionOverridesFrom(
  state: SessionConstitutionFactState,
  now = Date.now(),
): ConstitutionOverrideGranted[] {
  return state.overrides.filter((event) => {
    if (!event.expiresAt) return true;
    const expires = Date.parse(event.expiresAt);
    return !Number.isFinite(expires) || expires > now;
  });
}

/** Drift findings keyed by findingID. */
export type SessionDriftFactState = {
  findings: Map<string, ProjectedDriftFinding>;
};

export function emptySessionDriftFactState(): SessionDriftFactState {
  return { findings: new Map() };
}

export function applySessionDriftFact(
  state: SessionDriftFactState,
  event: RuntimeEvent,
): void {
  if (event.type === "drift.finding_opened") {
    state.findings.set(event.findingID, {
      findingID: event.findingID,
      severity: event.severity,
      confidence: event.confidence,
      originalObjective: event.originalObjective,
      currentActivity: event.currentActivity,
      evidence: event.evidence,
      applicableConstraints: event.applicableConstraints,
      status: "open",
      reopenedCount: 0,
      contractVersion: event.contractVersion,
      ruleHits: event.ruleHits ?? [],
      ...(event.planID ? { planID: event.planID } : {}),
    });
    return;
  }
  if (event.type === "drift.finding_updated") {
    const existing = state.findings.get(event.findingID);
    // An update carries no objective or evidence, so a finding that was never
    // opened cannot be reconstructed from it alone.
    if (!existing) return;
    // A reopen (翻案) is a user lifting a terminal disposition back to open; count
    // it so the card can show "reopened N times" as a rule-tuning signal.
    const reopened =
      existing.status !== "open" && event.status === "open"
        ? existing.reopenedCount + 1
        : existing.reopenedCount;
    state.findings.set(event.findingID, {
      ...existing,
      status: event.status,
      reopenedCount: reopened,
      ...(event.rationale === undefined ? {} : { rationale: event.rationale }),
    });
  }
}

export function sessionDriftFindingsFrom(
  state: SessionDriftFactState,
): ProjectedDriftFinding[] {
  return [...state.findings.values()];
}

/** Mailbox messages keyed by messageID. */
export type SessionMailboxFactState = {
  messages: Map<string, ProjectedMailboxMessage>;
};

export function emptySessionMailboxFactState(): SessionMailboxFactState {
  return { messages: new Map() };
}

export function applySessionMailboxFact(
  state: SessionMailboxFactState,
  event: RuntimeEvent,
): void {
  if (event.type === "mailbox.queued") {
    state.messages.set(event.messageID, {
      messageID: event.messageID,
      source: event.source,
      priority: event.priority,
      intent: event.intent,
      text: event.text,
      safeSummary: event.safeSummary,
      ...(event.relatedPlanID ? { relatedPlanID: event.relatedPlanID } : {}),
      deliveryPolicy: event.deliveryPolicy,
      createdAt: event.createdAt,
      status: "queued",
    });
    return;
  }
  if (event.type === "mailbox.delivered") {
    const message = state.messages.get(event.messageID);
    if (message) message.status = "delivered";
    return;
  }
  if (event.type === "mailbox.acknowledged") {
    const message = state.messages.get(event.messageID);
    if (message) message.status = "acknowledged";
    return;
  }
  if (event.type === "mailbox.deferred") {
    const message = state.messages.get(event.messageID);
    if (message) {
      message.status = "deferred";
      message.reason = event.reason;
    }
    return;
  }
  if (event.type === "mailbox.superseded") {
    const message = state.messages.get(event.messageID);
    if (message) {
      message.status = "superseded";
      message.reason = event.reason;
    }
  }
}

export function sessionMailboxMessagesFrom(
  state: SessionMailboxFactState,
): ProjectedMailboxMessage[] {
  return [...state.messages.values()];
}

/** Decision records in journal order, deduped by event id. */
export type SessionDecisionFactState = {
  records: DecisionRecorded[];
  seen: Set<string>;
};

export function emptySessionDecisionFactState(): SessionDecisionFactState {
  return { records: [], seen: new Set() };
}

export function applySessionDecisionFact(
  state: SessionDecisionFactState,
  event: RuntimeEvent,
): void {
  if (event.type !== "decision.recorded") return;
  if (state.seen.has(event.id)) return;
  state.seen.add(event.id);
  state.records.push(event);
}

export function sessionDecisionRecordsFrom(
  state: SessionDecisionFactState,
): DecisionRecorded[] {
  return state.records;
}

/**
 * The goal slice of the hot fact state.
 *
 * The same step the goal domain folds strictly (`foldGoalStep`), minus its
 * write-time validation: the event sink feeds EVERY durable event here, so an
 * orphan or out-of-sequence round/cost is ignored, never thrown — a strict
 * twin would make one malformed history crash the sink. On a well-formed
 * journal the two folds agree exactly (the cross-package equivalence test in
 * the client tree pins that). Replay never arms continuation, so `activation`
 * is always `disarmed` here.
 */
function applySessionGoalFact(
  state: SessionFactState,
  event: RuntimeEvent,
): void {
  if (event.type === "goal.changed") {
    if (event.operation === "clear") {
      state.goal = undefined;
      return;
    }
    const snapshot = event.snapshot;
    if (snapshot === undefined) return;
    const previous = state.goal;
    const sameGoal =
      previous !== undefined && previous.goalID === snapshot.goalID;
    state.goal = {
      ...snapshot,
      roundsStarted: event.roundsStarted,
      createdAt: sameGoal ? previous!.createdAt : event.at,
      updatedAt: event.at,
      // Replay never arms continuation.
      activation: "disarmed",
    };
    return;
  }
  if (event.type === "goal.round") {
    const current = state.goal;
    if (
      current === undefined ||
      event.goalID !== current.goalID ||
      event.revision !== current.revision ||
      event.round !== current.roundsStarted + 1
    )
      return;
    state.goal = { ...current, roundsStarted: event.round };
    return;
  }
  if (event.type === "goal.round.cost") {
    const current = state.goal;
    if (
      current === undefined ||
      event.goalID !== current.goalID ||
      event.revision !== current.revision ||
      event.round !== current.roundsStarted
    )
      return;
    state.goal = {
      ...current,
      spentGoalTokens: current.spentGoalTokens + event.tokens,
      goalWallClockMs: current.goalWallClockMs + event.durationMs,
    };
  }
}

/** The goal slice from the hot fact state: the durable live projection. */
export function sessionFactGoal(state: SessionFactState): GoalView | undefined {
  return state.goal;
}

/**
 * Work contracts keyed by planID (EI §8.2): the latest accepted contract
 * ("current" — the R drift is judged against) or, when none was accepted, the
 * latest draft. A draft is marked stale when the plan document changed after
 * it was extracted: the draft is bound to a planVersion, and a document edit
 * produces a new version, so the draft must be re-proposed. An accepted
 * contract is the user's promise and stays current until a new one is
 * approved — nothing replaces it silently.
 */
export type SessionWorkContractFactState = {
  contracts: Map<string, ProjectedWorkContract>;
};

export type ProjectedWorkContract = {
  planID: string;
  version: number;
  scope?: string[];
  verification?: string[];
  constraints?: string[];
  status: "current" | "draft";
  /** The plan document changed after this draft was written. */
  stale?: boolean;
  /** Approved with no extractable fields — advisory-only judgment. */
  unverifiable?: boolean;
  acceptedBy?: "user";
  acceptedAt?: string;
};

export function emptySessionWorkContractFactState(): SessionWorkContractFactState {
  return { contracts: new Map() };
}

export function applySessionWorkContractFact(
  state: SessionWorkContractFactState,
  event: RuntimeEvent,
): void {
  if (event.type === "work_contract.drafted") {
    state.contracts.set(event.planID, {
      planID: event.planID,
      version: event.planVersion,
      ...(event.scope ? { scope: event.scope } : {}),
      ...(event.verification ? { verification: event.verification } : {}),
      ...(event.constraints ? { constraints: event.constraints } : {}),
      status: "draft",
    });
    return;
  }
  if (event.type === "work_contract.accepted") {
    state.contracts.set(event.planID, {
      planID: event.planID,
      version: event.planVersion,
      ...(event.scope ? { scope: event.scope } : {}),
      ...(event.verification ? { verification: event.verification } : {}),
      ...(event.constraints ? { constraints: event.constraints } : {}),
      status: "current",
      acceptedBy: event.acceptedBy,
      acceptedAt: event.acceptedAt,
      ...(event.unverifiable ? { unverifiable: true } : {}),
    });
    return;
  }
  // A plan document edit invalidates a draft extracted from an older
  // revision; an accepted contract is the user's commitment and survives
  // until a new one is approved. The update carries the document's new
  // revision, so a draft is stale only when the document moved past the
  // version it was extracted from (revision > planVersion); re-proposing
  // against the current revision clears the marker.
  if (event.type === "plan.doc.updated") {
    const contract = state.contracts.get(event.planID);
    if (
      contract &&
      contract.status === "draft" &&
      event.revision > contract.version
    )
      contract.stale = true;
  }
}

export function sessionWorkContractsFrom(
  state: SessionWorkContractFactState,
): ProjectedWorkContract[] {
  return [...state.contracts.values()];
}

/**
 * Intelligence snapshot facts, folded so `buildSessionIntelligenceSnapshot`
 * and the incremental hot state share one reducer. Counts are cumulative
 * workspace facts; latest output / terminal / sandbox are last-write-wins.
 */
export type SessionIntelligenceFactState = {
  changedFiles: number;
  validatedChanges: number;
  latestOutput?: string;
  terminalActions: Map<string, string>;
  sandboxStatuses: Map<string, string>;
  /**
   * The evidence/completion events folded into the hot state (B6): read by the
   * evidence/completion surfaces without rescanning the journal.
   */
  journalEvents: Array<
    | Extract<RuntimeEvent, { type: "evidence.recorded" }>
    | Extract<RuntimeEvent, { type: "completion.recorded" }>
    | Extract<RuntimeEvent, { type: "growth.proposed" }>
    | Extract<RuntimeEvent, { type: "external_run.recorded" }>
    | Extract<RuntimeEvent, { type: "growth.promoted" }>
  >;
  /**
   * EI Phase 0: the latest human validation note per completion taskID. The
   * user records it from the Completions tab; the read surface merges it onto
   * the completion card (last write wins).
   */
  humanValidationByTask: Map<string, string>;
  /**
   * The last confinement escalation (sandbox study §6b①): last-write-wins,
   * like the terminal/sandbox maps. The danger indicator reads the derived
   * fact; the journal keeps every entry for the audit trail.
   */
  lastEscalation?: {
    escalatedAt: string;
    escalatedTo: import("@anthelia/contracts").ConfinementMode;
    justification: string;
  };
};

export type SessionIntelligenceFacts = {
  changedFiles: number;
  validatedChanges: number;
  unvalidatedChanges: number;
  latestOutput?: string;
  hasPTY: boolean;
  hasSandbox: boolean;
  /**
   * The last confinement escalation (sandbox study §6b①): the journal's
   * `confinement.escalated` fact, folded so the danger indicator reads
   * the same source the audit trail reads.
   */
  lastEscalation?: {
    escalatedAt: string;
    escalatedTo: import("@anthelia/contracts").ConfinementMode;
    justification: string;
  };
};

export function emptySessionIntelligenceFactState(): SessionIntelligenceFactState {
  return {
    changedFiles: 0,
    validatedChanges: 0,
    terminalActions: new Map(),
    sandboxStatuses: new Map(),
    journalEvents: [],
    humanValidationByTask: new Map(),
  };
}

export function applySessionIntelligenceFact(
  state: SessionIntelligenceFactState,
  event: RuntimeEvent,
): void {
  if (event.type === "workgraph.node_added") {
    if (event.kind === "workspace_change") state.changedFiles += 1;
    return;
  }
  if (event.type === "evidence.recorded") {
    state.validatedChanges += event.changes?.length ?? 0;
    state.journalEvents.push(event);
    return;
  }
  if (event.type === "completion.recorded") {
    state.journalEvents.push(event);
    return;
  }
  if (event.type === "growth.proposed") {
    state.journalEvents.push(event);
    return;
  }
  if (event.type === "external_run.recorded") {
    state.journalEvents.push(event);
    return;
  }
  if (event.type === "growth.promoted") {
    state.journalEvents.push(event);
    return;
  }
  if (event.type === "completion.human_validation") {
    state.humanValidationByTask.set(event.taskID, event.validation);
    return;
  }
  if (event.type === "content.done") {
    if (event.text) state.latestOutput = event.text;
    return;
  }
  if (event.type === "terminal.timeline") {
    state.terminalActions.set(event.id, event.action);
    return;
  }
  if (event.type === "sandbox.update") {
    state.sandboxStatuses.set(event.id, event.status);
    return;
  }
  if (event.type === "confinement.escalated") {
    // The last one wins: the indicator names the most recent entry, and
    // the journal keeps every earlier one for the audit trail.
    state.lastEscalation = {
      escalatedAt: event.at,
      escalatedTo: event.to,
      justification: event.justification,
    };
  }
}

export function sessionIntelligenceFactsFrom(
  state: SessionIntelligenceFactState,
): SessionIntelligenceFacts {
  return {
    changedFiles: state.changedFiles,
    validatedChanges: state.validatedChanges,
    unvalidatedChanges: Math.max(
      0,
      state.changedFiles - state.validatedChanges,
    ),
    ...(state.latestOutput ? { latestOutput: state.latestOutput } : {}),
    hasPTY: [...state.terminalActions.values()].some(
      (action) => action !== "exit",
    ),
    hasSandbox: [...state.sandboxStatuses.values()].some(
      (status) =>
        status !== "deleted" && status !== "stopped" && status !== "failed",
    ),
    ...(state.lastEscalation ? { lastEscalation: state.lastEscalation } : {}),
  };
}

export function sessionIntelligenceFactsFromEvents(
  events: RuntimeEvent[],
): SessionIntelligenceFacts {
  const state = emptySessionIntelligenceFactState();
  for (const event of events) applySessionIntelligenceFact(state, event);
  return sessionIntelligenceFactsFrom(state);
}

/**
 * The incremental hot memory for one session: active-set facts a surface can
 * read without re-scanning the journal. This is deliberately the *memory* hot
 * tier (see the RINA plan); the model-visible working set stays in
 * `ContextLedger`.
 */
export type SessionFactState = {
  turns: SessionTurnFactState;
  constitution: SessionConstitutionFactState;
  workContracts: SessionWorkContractFactState;
  drift: SessionDriftFactState;
  mailbox: SessionMailboxFactState;
  decisions: SessionDecisionFactState;
  intelligence: SessionIntelligenceFactState;
  /**
   * The live goal projection folded from the log: the durable snapshot plus
   * rounds-start/cost facts. `activation` is always `disarmed` here — replay
   * never arms continuation; the live process holds that authority in the goal
   * service's cache, which is why the consumers read this as the durable view
   * and the service as the live one.
   */
  goal?: GoalView;
  latestSnapshot?: SessionSnapshotEvent;
  /**
   * Every event the drift-judgement and live-context folds consume:
   * `invariant.*` (the D2 edges), `context.instructions` (the epoch
   * reference), `audit.requested` (the wake idempotency family) and
   * `constitution.check` (the conflict display). Collected verbatim so the
   * boundary's reconcile and the live-context builders fold the complete
   * slice without the raw journal — a fast-attach tail cannot hide a
   * pre-epoch violation, instruction notice, audit request or conflict.
   */
  diagnosticStreamEvents: RuntimeEvent[];
  /**
   * Every event the collaboration projections consume: `collab.*`,
   * `*.collab.*`, `plan.doc.*` and `mailbox.*`. Collected verbatim so the collab
   * snapshot, mailbox page and collaboration tools can fold the complete slice
   * without the raw journal.
   */
  collaborationEvents: RuntimeEvent[];
  /**
   * Channel-scoped chat events, collected verbatim like `collaborationEvents`. The
   * chat projector resolves thinking accumulations, rollback boundaries and
   * compaction in one pass, and only ever looks at events where a collab row or
   * the channel predicate matches — so folding just those events is equivalent
   * to folding the whole journal while keeping the transcript out of the raw
   * log.
   */
  naviChatEvents: RuntimeEvent[];
  niaChatEvents: RuntimeEvent[];
};

/** Events the collaboration / collab-snapshot projections consume. */
export function isCollaborationStreamEvent(event: RuntimeEvent): boolean {
  return (
    event.type.startsWith("collab.") ||
    event.type.includes(".collab.") ||
    event.type.startsWith("plan.doc.") ||
    event.type.startsWith("mailbox.")
  );
}

/**
 * Events the drift-judgement and live-context folds consume — the four
 * disjoint families the boundary's reconcile (invariant edges, the
 * instruction epoch) and the live-context builders (audit requests,
 * constitution conflicts) fold from. Collected verbatim in the fact state
 * so a fast-attach tail cannot hide a pre-epoch member of any family.
 */
export function isDiagnosticStreamEvent(event: RuntimeEvent): boolean {
  return (
    event.type.startsWith("invariant.") ||
    event.type === "context.instructions" ||
    event.type === "audit.requested" ||
    event.type === "constitution.check"
  );
}

/** Would `projectChatStream` render this event on the `navi` channel? */
function naviChatStreamEvent(event: RuntimeEvent): boolean {
  const collab = normalizeCollaborationEvent(event);
  if (collab) return collab.from === "live_chat";
  return isNaviChatEvent(event);
}

/** Would `projectChatStream` render this event on the `nia` channel? */
function niaChatStreamEvent(event: RuntimeEvent): boolean {
  const collab = normalizeCollaborationEvent(event);
  if (collab) return collab.from === "nia";
  return isNiaChatEvent(event);
}

export function emptySessionFactState(): SessionFactState {
  return {
    turns: emptySessionTurnFactState(),
    constitution: emptySessionConstitutionFactState(),
    workContracts: emptySessionWorkContractFactState(),
    drift: emptySessionDriftFactState(),
    mailbox: emptySessionMailboxFactState(),
    decisions: emptySessionDecisionFactState(),
    intelligence: emptySessionIntelligenceFactState(),
    diagnosticStreamEvents: [],
    collaborationEvents: [],
    naviChatEvents: [],
    niaChatEvents: [],
  };
}

export function applySessionFactEvent(
  state: SessionFactState,
  event: RuntimeEvent,
): void {
  applySessionTurnFact(state.turns, event);
  applySessionConstitutionFact(state.constitution, event);
  applySessionWorkContractFact(state.workContracts, event);
  applySessionDriftFact(state.drift, event);
  applySessionMailboxFact(state.mailbox, event);
  applySessionDecisionFact(state.decisions, event);
  applySessionIntelligenceFact(state.intelligence, event);
  applySessionGoalFact(state, event);
  if (isDiagnosticStreamEvent(event)) state.diagnosticStreamEvents.push(event);
  if (event.type === "session.snapshot") state.latestSnapshot = event;
  if (isCollaborationStreamEvent(event)) state.collaborationEvents.push(event);
  if (naviChatStreamEvent(event)) state.naviChatEvents.push(event);
  if (niaChatStreamEvent(event)) state.niaChatEvents.push(event);
}

export function sessionFactStateFromEvents(
  events: RuntimeEvent[],
): SessionFactState {
  const state = emptySessionFactState();
  for (const event of events) applySessionFactEvent(state, event);
  return state;
}

export function sessionFactActiveTurnIDs(state: SessionFactState): string[] {
  return [...state.turns.activeTurnIDs];
}

export function sessionFactConstitutionRules(
  state: SessionFactState,
): ConstitutionRuleAdded[] {
  return sessionConstitutionRulesFrom(state.constitution);
}

export function sessionFactWorkContracts(
  state: SessionFactState,
): ProjectedWorkContract[] {
  return sessionWorkContractsFrom(state.workContracts);
}

export function sessionFactConstitutionOverrides(
  state: SessionFactState,
  now = Date.now(),
): ConstitutionOverrideGranted[] {
  return sessionConstitutionOverridesFrom(state.constitution, now);
}

export function sessionFactDriftFindings(
  state: SessionFactState,
): ProjectedDriftFinding[] {
  return sessionDriftFindingsFrom(state.drift);
}

/**
 * The evidence slice from the hot fact state (B6): `evidence.recorded` events
 * folded into the intelligence slice, read without rescanning the journal.
 */
export function sessionFactEvidenceRecords(
  state: SessionFactState,
): Array<Extract<RuntimeEvent, { type: "evidence.recorded" }>> {
  return state.intelligence.journalEvents.filter(
    (event): event is Extract<RuntimeEvent, { type: "evidence.recorded" }> =>
      event.type === "evidence.recorded",
  );
}

/**
 * The completion slice from the hot fact state (B6): `completion.recorded`
 * events folded into the intelligence slice.
 */
export function sessionFactCompletions(
  state: SessionFactState,
): Array<Extract<RuntimeEvent, { type: "completion.recorded" }>> {
  return state.intelligence.journalEvents.filter(
    (event): event is Extract<RuntimeEvent, { type: "completion.recorded" }> =>
      event.type === "completion.recorded",
  );
}

/** The growth promotions from the hot fact state (block ②). */
export function sessionFactGrowthPromotions(
  state: SessionFactState,
): Array<Extract<RuntimeEvent, { type: "growth.promoted" }>> {
  return state.intelligence.journalEvents.filter(
    (event): event is Extract<RuntimeEvent, { type: "growth.promoted" }> =>
      event.type === "growth.promoted",
  );
}

/** The external-run joins from the hot fact state (B6 / G-c). */
export function sessionFactExternalRuns(
  state: SessionFactState,
): Array<Extract<RuntimeEvent, { type: "external_run.recorded" }>> {
  return state.intelligence.journalEvents.filter(
    (
      event,
    ): event is Extract<RuntimeEvent, { type: "external_run.recorded" }> =>
      event.type === "external_run.recorded",
  );
}

/** The growth proposals from the hot fact state (B6 / G-a). */
export function sessionFactGrowthProposals(
  state: SessionFactState,
): Array<Extract<RuntimeEvent, { type: "growth.proposed" }>> {
  return state.intelligence.journalEvents.filter(
    (event): event is Extract<RuntimeEvent, { type: "growth.proposed" }> =>
      event.type === "growth.proposed",
  );
}

/** The terminal-keep count for the hot fact state (EI Phase 1 "降档"). */
export const FACT_TERMINAL_LIMIT = 200;

const ACTIVE_EVIDENCE_STATUS = new Set(["planned", "implemented", "validated"]);

/**
 * EI Phase 1 "降档" (RINA boundary): bound the hot fact state's *terminal*
 * entries so memory does not grow with the whole session. `降档≠丢失` — the
 * entries are not deleted from the journal; a read that needs them pages the
 * durable store (the intelligence surface reconstructs when
 * `factStateTerminalEvicted` is set).
 *
 * - evidence: active statuses (planned/implemented/validated) kept in full;
 *   terminal kept to the most recent `limit`.
 * - completion: kept to the most recent `limit`.
 * - decision: kept to the most recent `limit`.
 * - drift: open/disputed kept in full (their dedup depends on the open set);
 *   terminal kept to the most recent `limit`.
 *
 * Mutates `state` and returns whether anything was evicted. Pure otherwise.
 */
export function evictTerminalFacts(
  state: SessionFactState,
  limit = FACT_TERMINAL_LIMIT,
): boolean {
  let evicted = false;
  const journal = state.intelligence.journalEvents;
  const evidence = journal.filter(
    (event) => event.type === "evidence.recorded",
  );
  const completions = journal.filter(
    (event) => event.type === "completion.recorded",
  );
  const activeEvidence = evidence.filter((event) =>
    ACTIVE_EVIDENCE_STATUS.has(event.status),
  );
  const terminalEvidence = evidence.filter(
    (event) => !ACTIVE_EVIDENCE_STATUS.has(event.status),
  );
  const keptEvidence = new Set([
    ...activeEvidence,
    ...terminalEvidence.slice(-limit),
  ]);
  const keptCompletions = new Set(completions.slice(-limit));
  if (
    keptEvidence.size !== evidence.length ||
    keptCompletions.size !== completions.length
  ) {
    state.intelligence.journalEvents = journal.filter((event) =>
      event.type === "evidence.recorded"
        ? keptEvidence.has(event)
        : event.type === "completion.recorded"
          ? keptCompletions.has(event)
          : true,
    );
    evicted = true;
  }
  if (state.decisions.records.length > limit) {
    state.decisions.records = state.decisions.records.slice(-limit);
    evicted = true;
  }
  const findings = [...state.drift.findings.values()];
  const isOpen = (status: string) => status === "open" || status === "disputed";
  const openFindings = findings.filter((finding) => isOpen(finding.status));
  const terminalFindings = findings.filter(
    (finding) => !isOpen(finding.status),
  );
  if (terminalFindings.length > limit) {
    const keep = new Set([...openFindings, ...terminalFindings.slice(-limit)]);
    for (const [id, finding] of state.drift.findings)
      if (!keep.has(finding)) {
        state.drift.findings.delete(id);
        evicted = true;
      }
  }
  return evicted;
}

/** EI Phase 0: the latest human validation note per completion taskID. */
export function sessionFactHumanValidation(
  state: SessionFactState,
): ReadonlyMap<string, string> {
  return state.intelligence.humanValidationByTask;
}

export function sessionFactMailboxMessages(
  state: SessionFactState,
): ProjectedMailboxMessage[] {
  return sessionMailboxMessagesFrom(state.mailbox);
}

export function sessionFactDecisionRecords(
  state: SessionFactState,
): DecisionRecorded[] {
  return sessionDecisionRecordsFrom(state.decisions);
}

export function sessionFactLatestSnapshot(
  state: SessionFactState,
): SessionSnapshotEvent | undefined {
  return state.latestSnapshot;
}

export function sessionFactCollabMessages(
  state: SessionFactState,
): ProjectedCollabMessage[] {
  return projectedCollabMessages(state.collaborationEvents);
}

/** The complete collaboration slice (collab + plan.doc + mailbox events). */
/** The complete diagnostic slice (invariant edges, instruction notices,
 * audit requests, constitution checks). */
export function sessionFactDiagnosticStreamEvents(
  state: SessionFactState,
): RuntimeEvent[] {
  return state.diagnosticStreamEvents;
}

export function sessionFactCollaborationEvents(
  state: SessionFactState,
): RuntimeEvent[] {
  return state.collaborationEvents;
}

export function sessionFactIntelligenceFacts(
  state: SessionFactState,
): SessionIntelligenceFacts {
  return sessionIntelligenceFactsFrom(state.intelligence);
}

export function sessionFactNaviChatMessages(
  state: SessionFactState,
): ProjectedChatMessage[] {
  return projectedNaviChatMessages(state.naviChatEvents);
}

export function sessionFactNiaChatMessages(
  state: SessionFactState,
): ProjectedChatMessage[] {
  return projectedNiaChatMessages(state.niaChatEvents);
}
