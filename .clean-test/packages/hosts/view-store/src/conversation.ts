/**
 * Conversation projection: turns, streaming text, tool cards and the
 * interactive requests the runtime is waiting on.
 *
 * Streaming is the subtle part. Live consumers receive `content.delta` and watch
 * text accumulate. Consumers replaying durable history receive none of those,
 * because deltas are live-only events and are never journaled; they see one bare
 * `content.done` per provider step instead. Both paths must produce the same
 * transcript, which is the main reason this layer exists rather than every
 * consumer writing its own reducer.
 */
import type {
  CollaborationMessage,
  CollaborationParticipant,
  RuntimeEvent,
} from "@anthelia/contracts";
import {
  appendWithRetrySkip,
  splitMarkdownAtSafeBoundary,
  providerSafeThinkingSummary,
} from "@natalia/ui-model";
import {
  emptySessionUsageStats,
  streamSegmentChars,
  upsertBlock,
  type AppState,
  type AgentStreamState,
  type StreamActivityView,
  type MessageBlock,
  type PendingInputView,
  type StreamState,
  type ToolBlock,
} from "./state";

/**
 * The part of projected state the streaming helpers write to. The main
 * transcript and the Live Work Chat conversation both stream with the same
 * markdown-safe segmentation machinery; `AppState` satisfies this structurally,
 * and the Chat projection passes its own arrays.
 */
export type StreamTarget = {
  messages: MessageBlock[];
  streams: Record<string, StreamState>;
  streamPhases: Record<string, "thinking" | "assistant">;
};

/** Upserts into an explicit messages array (the generic form of upsertBlock). */
export function upsertInto(
  messages: MessageBlock[],
  id: string,
  role: MessageBlock["role"],
  text: string,
  status?: string,
  extra?: Partial<MessageBlock>,
): void {
  const block = messages.find((item) => item.id === id);
  if (block) {
    block.text = text;
    if (status !== undefined) block.status = status;
    if (extra) Object.assign(block, extra);
    return;
  }
  messages.push({ id, role, text, pendingText: "", status, ...extra });
}

export function newStream(): StreamState {
  return {
    committed: "",
    tail: "",
    retrySkip: "",
    attempt: 1,
    segmentIndex: 0,
  };
}

/**
 * Prepares a turn's streams for a retry the runtime has announced.
 *
 * A retry means the attempt did not finish, so the two halves of a stream are
 * treated differently. Text markdown had already completed stays: a provider that
 * resumes rather than restarts continues from it, and it becomes the overlap a
 * provider that restarts will re-send and must have skipped. Text still in flight
 * is dropped, because it is a fragment of an attempt that failed — keeping it
 * would glue half of the failed attempt onto the front of the new answer whenever
 * the retry does not happen to re-send exactly that fragment.
 *
 * The announced attempt is recorded on the stream because the resent deltas may
 * carry an `attempt` stamp. That stamp is the *other* way a supersede can be
 * signalled — for a retry nobody announced — and the two must not both act: the
 * stamp discards the confirmed text while the overlap skip assumes it is still
 * there, which drops everything up to the point where the resend diverges.
 */
export function resetStreamsForRetry(
  state: AppState,
  turnID: string,
  attempt?: number,
): void {
  for (const role of ["thinking", "assistant"] as const) {
    const id = streamID(turnID, role);
    const stream = state.streams[id];
    if (!stream) continue;
    stream.tail = "";
    stream.retrySkip = stream.committed;
    if (attempt !== undefined) stream.attempt = attempt;
    const block = state.messages.find(
      (item) => item.id === segmentID(id, stream.segmentIndex),
    );
    if (block) {
      block.text = stream.committed;
      block.pendingText = "";
    }
  }
}

export function streamID(turnID: string, role: "thinking" | "assistant") {
  return `${turnID}:${role}`;
}

export function segmentID(baseID: string, index: number) {
  if (index === 0) return baseID;
  return `${baseID}:segment:${index}`;
}

/**
 * The turn a tool event belongs to.
 *
 * The runtime publishes tool events with `id` set to `${turnID}:${callID}` and
 * the call id repeated in `callID`, so the id has to be normalised before it can
 * be used to reach the turn's streams. Taking `id` at face value files the card
 * under a turn that does not exist: the model text streaming above the call is
 * never committed and no new segment opens, so the card sinks below text that
 * arrived after it and the text from before and after the call merge into one
 * block.
 */
export function turnIDForTool(event: { id: string; callID?: string }): string {
  // Only a suffix that is actually there is stripped, so a producer that already
  // publishes the bare turn id is left alone.
  const suffix = `:${event.callID}`;
  return event.callID && event.id.endsWith(suffix)
    ? event.id.slice(0, -suffix.length)
    : event.id;
}

/**
 * Projects the Work Graph backbone from a durable tool.update event (EI): the
 * agent_action root and the tool_call child it caused. The runtime also emits
 * dedicated workgraph.node_added events for live turns, but a replayed or older
 * session's journal carries the tool.update events without those graph events —
 * this projection reconstructs the same causal chain from the tool events alone,
 * so the forest is never empty for a session that ran tools. Node/edge ids match
 * the runtime's builders, so the two sources are idempotent (same id overwrites).
 */
function projectWorkGraphFromTool(
  state: import("./state").AppState,
  turnID: string,
  event: Extract<
    import("@anthelia/contracts").RuntimeEvent,
    { type: "tool.update" }
  >,
) {
  const callID = event.callID ?? event.name;
  const actionID = `wg:action:${turnID}`;
  const toolID = `wg:tool:${turnID}:${callID}`;
  if (!state.workGraphNodes[actionID])
    state.workGraphNodes[actionID] = {
      type: "workgraph.node_added",
      id: actionID,
      nodeID: actionID,
      kind: "agent_action",
      summary: "agent acted",
      turnID,
    };
  if (!state.workGraphNodes[toolID])
    state.workGraphNodes[toolID] = {
      type: "workgraph.node_added",
      id: toolID,
      nodeID: toolID,
      kind: "tool_call",
      summary: `${event.name} ${event.status}`,
      target: event.name,
      turnID,
    };
  const edgeID = `wg:edge:caused:${toolID}`;
  if (!state.workGraphEdges[edgeID])
    state.workGraphEdges[edgeID] = {
      type: "workgraph.edge_added",
      id: edgeID,
      sourceID: actionID,
      targetID: toolID,
      kind: "caused",
    };
}

export function toolStateID(event: {
  id: string;
  name: string;
  callID?: string;
}) {
  return `${turnIDForTool(event)}:tool:${event.callID ?? event.name}`;
}

/** Returns true when the event belongs to this projection. */
export function applyConversationEvent(
  state: AppState,
  event: RuntimeEvent,
): boolean {
  switch (event.type) {
    case "session.created":
      if (state.sessionID && state.sessionID !== event.sessionID) return false;
      state.sessionID = event.sessionID;
      state.title = event.title;
      return true;
    case "session.title.updated":
      if (state.sessionID && state.sessionID !== event.sessionID) return false;
      state.title = event.title;
      return true;
    case "session.ready":
      if (state.sessionID && state.sessionID !== event.sessionID) return false;
      if (!state.sessionID) state.sessionID = event.sessionID;
      state.status = "ready";
      return true;
    case "input.admitted":
      if (!acceptsSession(state, event.sessionID)) return false;
      // Admission is not a turn: the input waits in the queue slice until a
      // `turn.submitted` starts it or a `turn.input` claims it. Internal wakes
      // are runtime-generated and never belong in the user-editable queue.
      if (event.internal) return true;
      upsertPendingInput(state, {
        id: event.id,
        text: event.text,
        delivery: event.delivery,
        internal: false,
        admittedAt: event.admittedAt,
        admittedSeq: event.admittedSeq,
        status: event.delivery === "next-step" ? "steering" : "queued",
      });
      return true;
    case "input.updated": {
      if (!acceptsSession(state, event.sessionID)) return false;
      const input = state.pendingInputs.find((item) => item.id === event.id);
      if (input) input.text = event.text;
      return true;
    }
    case "input.removed":
      if (!acceptsSession(state, event.sessionID)) return false;
      state.pendingInputs = state.pendingInputs.filter(
        (item) => item.id !== event.id,
      );
      return true;
    case "input.promoted": {
      if (!acceptsSession(state, event.sessionID)) return false;
      const input = state.pendingInputs.find((item) => item.id === event.id);
      if (input) {
        input.delivery = "next-step";
        input.status = "steering";
      }
      return true;
    }
    case "turn.submitted":
      if (
        state.sessionID &&
        event.sessionID &&
        state.sessionID !== event.sessionID
      )
        return false;
      if (!state.sessionID && event.sessionID)
        state.sessionID = event.sessionID;
      // `turn.submitted` now means a turn is actually starting: it leaves the
      // queue and becomes the first user row of the transcript.
      if (!event.internal) state.lastSubmission = event;
      state.lastStopReason = undefined;
      state.pendingInputs = state.pendingInputs.filter(
        (item) => item.id !== event.id,
      );
      const messageID = `${event.id}:${event.internal ? "system" : "user"}`;
      // Durable replay and message-page hydration can deliver the same turn
      // boundary into one projection. Re-applying it must be idempotent: a
      // second user row with the same id corrupts virtualizer keys and makes
      // the whole turn appear duplicated.
      if (state.messages.some((block) => block.id === messageID)) return true;
      state.streams[streamID(event.id, "thinking")] = newStream();
      state.streams[streamID(event.id, "assistant")] = newStream();
      state.messages.push({
        id: messageID,
        role: event.internal ? "system" : "user",
        text: userText(event),
        pendingText: "",
        ...(event.attachments?.length
          ? { attachments: event.attachments }
          : {}),
      });
      return true;
    case "turn.input":
      if (!acceptsSession(state, event.sessionID)) return false;
      // A `next-step` input claimed by the running turn becomes a user message
      // inside that turn, not a turn of its own.
      state.pendingInputs = state.pendingInputs.filter(
        (item) => item.id !== event.inputID,
      );
      {
        const messageID = `${event.turnID}:user:${event.inputID}`;
        if (state.messages.some((block) => block.id === messageID)) return true;
        state.messages.push({
          id: messageID,
          role: event.internal ? "system" : "user",
          text: event.text,
          pendingText: "",
          // Marks a mid-turn injected input so the transcript can label it
          // without pretending it is a turn of its own.
          status: "steering",
        });
      }
      return true;
    case "turn.started":
      markTurnStarted(state, event.id);
      return true;
    case "turn.paused":
      state.paused = true;
      state.footer = `paused: ${event.reason}`;
      return true;
    case "turn.resumed":
      state.paused = false;
      state.footer = "resumed";
      return true;
    case "thinking.delta":
      markTurnStarted(state, event.id);
      prepareStreamPhase(state, event.id, "thinking");
      // A provider that forbids showing its reasoning is obeyed by never
      // retaining the text: not in the block, and not in the stream either, so
      // there is nowhere for a consumer to read it from.
      if (event.visible === false) {
        recordHiddenThinking(state, streamID(event.id, "thinking"));
        return true;
      }
      appendStream(state, {
        id: streamID(event.id, "thinking"),
        role: "thinking",
        text: event.text,
        attempt: event.attempt,
        reasoningVisible: true,
      });
      return true;
    case "thinking.done": {
      const key = streamID(event.id, "thinking");
      if (event.visible === false) {
        recordHiddenThinking(state, key);
        markBlockStatus(state, key, "completed");
        return true;
      }
      // Thinking deltas are live-only; on durable replay only the done event
      // is present. `turn.submitted` already created an empty thinking stream,
      // so "no stream" is not enough to detect replay: materialize the full
      // text whenever the stream holds no text yet.
      const stream = state.streams[key];
      if (event.text && (!stream || (!stream.committed && !stream.tail))) {
        appendStream(state, {
          id: key,
          role: "thinking",
          text: event.text,
          attempt: event.attempt,
          reasoningVisible: true,
        });
      }
      flushStream(state, key);
      markBlockStatus(state, key, "completed");
      return true;
    }
    case "content.delta":
    case "content.partial":
      markTurnStarted(state, event.id);
      prepareStreamPhase(state, event.id, "assistant");
      appendStream(state, {
        id: streamID(event.id, "assistant"),
        role: "assistant",
        text: event.text,
        attempt: "attempt" in event ? event.attempt : undefined,
      });
      return true;
    case "content.done": {
      const key = streamID(event.id, "assistant");
      flushStream(state, key);
      const stream = state.streams[key];
      const currentID = stream ? segmentID(key, stream.segmentIndex) : key;
      const current = state.messages.find((block) => block.id === currentID);
      // Live streaming has already filled this segment from deltas, so there is
      // nothing to synthesize. Durable replay is the opposite case: this is the
      // only place the text can come from.
      const alreadyRendered = Boolean(
        current && (current.text || current.pendingText),
      );
      if (event.text && !alreadyRendered) {
        upsertBlock(state, currentID, "assistant", event.text);
        // One `content.done` is one message. Advance so the next step's text
        // becomes its own block instead of overwriting this one — a turn that
        // calls tools produces several, and on replay they would otherwise
        // collapse into the first.
        if (stream) {
          stream.segmentIndex += 1;
          stream.committed = "";
          stream.tail = "";
        }
      }
      return true;
    }
    case "tool.update": {
      const turnID = turnIDForTool(event);
      markTurnStarted(state, turnID);
      // Model output is committed before its tool card, so a tool update never
      // reorders text around itself.
      flushStream(state, streamID(turnID, "thinking"));
      flushStream(state, streamID(turnID, "assistant"));
      beginPostToolSegment(state, turnID);
      delete state.streamPhases[turnID];
      upsertTool(state, event);
      projectWorkGraphFromTool(state, turnID, event);
      return true;
    }
    case "approval.request":
      state.pendingApprovals = [
        ...state.pendingApprovals.filter((item) => item.id !== event.id),
        event,
      ];
      return true;
    case "approval.response":
      state.pendingApprovals = state.pendingApprovals.filter(
        (item) => item.id !== event.id,
      );
      return true;
    case "question.request":
      state.pendingQuestions = [
        ...state.pendingQuestions.filter((item) => item.id !== event.id),
        event,
      ];
      return true;
    case "question.response":
      state.pendingQuestions = state.pendingQuestions.filter(
        (item) => item.id !== event.id,
      );
      return true;
    case "interactive.request":
      if (!acceptsSession(state, event.sessionID)) return false;
      state.pendingInteractives = [
        ...state.pendingInteractives.filter((item) => item.id !== event.id),
        event,
      ];
      return true;
    case "interactive.response":
      if (!acceptsSession(state, event.sessionID)) return false;
      state.pendingInteractives = state.pendingInteractives.filter(
        (item) => item.id !== event.id,
      );
      return true;
    case "turn.cancelled":
      if (state.activeTurn === event.id) state.activeTurn = undefined;
      markTurnCancelled(state, event.id);
      state.paused = false;
      state.lastStopReason = "cancelled";
      state.status = "ready";
      state.footer = `cancelled: ${event.reason}`;
      dropStreamTail(state, event.id);
      upsertBlock(
        state,
        `${event.id}:cancelled`,
        "system",
        `cancelled: ${event.reason}`,
      );
      // A cancelled turn must not leave a pending request nobody will answer, or
      // a consumer renders a prompt forever.
      state.pendingApprovals = [];
      state.pendingQuestions = [];
      return true;
    case "turn.finished":
      markTurnStarted(state, event.id);
      // Durable per-turn usage (available for every session, historical turns
      // included): count the turn and add its wall time. Input/output tokens
      // are not summed here — turn.finished carries only the final step's
      // provider sample, not the turn total; the per-step runtime.step_usage is
      // the token authority for turns that ran under it.
      state.sessionUsage.turns += 1;
      if (!state.usageByChannel.main)
        state.usageByChannel.main = emptySessionUsageStats();
      state.usageByChannel.main.turns += 1;
      if (event.durationMs !== undefined) {
        state.sessionUsage.llmMs += event.durationMs;
        state.usageByChannel.main.llmMs += event.durationMs;
      }
      flushStream(state, streamID(event.id, "thinking"));
      flushStream(state, streamID(event.id, "assistant"));
      // A turn that has finished has finished reasoning, whether or not the
      // provider bothered to send `thinking.done` — many do not, and the row would
      // otherwise sit there unmarked for the rest of the session.
      markBlockStatus(state, streamID(event.id, "thinking"), "completed");
      releaseStreams(state, event.id);
      if (state.activeTurn === event.id) state.activeTurn = undefined;
      state.paused = false;
      state.lastStopReason = event.stopReason;
      state.status =
        event.stopReason === "done" || event.stopReason === "cancelled"
          ? "ready"
          : event.stopReason;
      state.footer =
        event.stopReason === "done"
          ? "Ready"
          : event.stopReason === "cancelled"
            ? `cancelled: ${event.reason ?? "user cancel"}`
            : event.stopReason === "waiting_human"
              ? "Waiting for a human on a terminal"
              : `turn ${event.stopReason}${event.reason ? `: ${event.reason}` : ""}`;
      if (event.stopReason !== "done") {
        state.pendingApprovals = [];
        state.pendingQuestions = [];
      }
      return true;
    default:
      return false;
  }
}

function acceptsSession(
  state: AppState,
  sessionID: import("@anthelia/contracts").SessionID | undefined,
): boolean {
  if (state.sessionID && sessionID && state.sessionID !== sessionID)
    return false;
  if (!state.sessionID && sessionID) state.sessionID = sessionID;
  return true;
}

function upsertPendingInput(state: AppState, input: PendingInputView) {
  const index = state.pendingInputs.findIndex((item) => item.id === input.id);
  if (index >= 0) state.pendingInputs[index] = input;
  else state.pendingInputs.push(input);
}

function markTurnStarted(state: AppState, turnID: string) {
  state.activeTurn = turnID;
  const user = state.messages.find((block) => block.id === `${turnID}:user`);
  if (user?.status === "queued") user.status = undefined;
}

function markTurnCancelled(state: AppState, turnID: string) {
  const user = state.messages.find((block) => block.id === `${turnID}:user`);
  if (user?.status === "queued") user.status = "cancelled";
}

function upsertTool(
  state: AppState,
  event: Extract<RuntimeEvent, { type: "tool.update" }>,
): void {
  const stateID = toolStateID(event);
  const previous = state.tools[stateID];
  // Arguments stream in fragments, so a consumer only sees the whole request
  // once they are reassembled.
  const argumentsRaw =
    (previous?.argumentsRaw ?? "") + (event.argumentsDelta ?? "");
  const tool: ToolBlock = {
    ...previous,
    name: event.name,
    callID: event.callID,
    status: event.status,
    summary: event.summary,
    argumentsRaw,
    ...(event.result !== undefined ? { result: event.result } : {}),
    ...(event.startedAt !== undefined ? { startedAt: event.startedAt } : {}),
    ...(event.endedAt !== undefined ? { endedAt: event.endedAt } : {}),
    ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
  };
  state.tools[stateID] = tool;
  upsertBlock(state, stateID, "tool", event.summary, event.status, { tool });
}

/**
 * Notes that hidden reasoning arrived, without keeping any of it. The block shows
 * the provider-safe summary so a consumer can tell thinking happened, and
 * `reasoningVisible: false` lets it hide the row entirely if it prefers.
 */
function recordHiddenThinking(state: AppState, id: string): void {
  const stream = (state.streams[id] ??= newStream());
  upsertBlock(
    state,
    segmentID(id, stream.segmentIndex),
    "thinking",
    providerSafeThinkingSummary(false, "x"),
    undefined,
    { pendingText: "", reasoningVisible: false },
  );
}

/**
 * Whether the text ends inside an unclosed fenced block. Counting fence openers is
 * enough: they alternate open/close, so an odd count means one is still open.
 */
function insideFence(text: string): boolean {
  let open = 0;
  for (const line of text.split("\n"))
    if (/^\s*(?:```+|~~~+)/u.test(line)) open += 1;
  return open % 2 === 1;
}

function prepareStreamPhase(
  target: StreamTarget,
  turnID: string,
  phase: "thinking" | "assistant",
): void {
  const previous = target.streamPhases[turnID];
  if (previous === phase) return;
  if (previous) flushStream(target, streamID(turnID, previous));
  // Returning to a phase that already rendered text means the model alternated
  // between reasoning and answering. The new text belongs *below* whatever the
  // other phase wrote in between, so it opens a new segment instead of growing
  // the block above it — otherwise a second thought merges into the first and the
  // answer that came before it ends up rendered underneath, which is no longer
  // the order the model produced them in.
  const stream = target.streams[streamID(turnID, phase)];
  if (stream && (stream.committed || stream.tail)) {
    stream.segmentIndex += 1;
    stream.committed = "";
    stream.tail = "";
  }
  target.streamPhases[turnID] = phase;
}

function appendStream(
  target: StreamTarget,
  input: {
    id: string;
    role: "thinking" | "assistant";
    text: string;
    attempt?: number;
    reasoningVisible?: boolean;
  },
): void {
  const stream = (target.streams[input.id] ??= newStream());
  // A retried attempt replaces the text of the attempt it supersedes rather than
  // appending to it, so a UI never shows two copies of one response.
  if (input.attempt !== undefined && input.attempt !== stream.attempt) {
    stream.attempt = input.attempt;
    stream.committed = "";
    stream.tail = "";
    target.messages = target.messages.filter(
      (block) =>
        block.id !== input.id && !block.id.startsWith(`${input.id}:segment:`),
    );
  }
  const applied = appendWithRetrySkip(input.text, stream.retrySkip);
  stream.retrySkip = applied.retrySkip;
  if (!applied.text && applied.retrySkip) {
    // The whole chunk was text we already have; nothing to render yet.
    writeStreamBlock(target, input.id, input.role, input.reasoningVisible);
    return;
  }
  stream.tail += applied.text;
  // Confirm as much as markdown says is complete, as it arrives. `text` claims to
  // be the confirmed record and `pendingText` the part not confirmed yet, and
  // nothing else in this layer moves text between them until some later event
  // flushes the stream. Without this the claim was false for the whole of a live
  // response: it stayed unconfirmed to the end, so cancelling a turn discarded an
  // answer the reader had already read, and a consumer rendering `text` as
  // markdown and `pendingText` as provisional had nothing to render until the
  // turn was over.
  const settled = splitMarkdownAtSafeBoundary(stream.tail);
  if (settled.committed) {
    stream.committed += settled.committed;
    stream.tail = settled.tail;
  }
  if (stream.committed.length + stream.tail.length > streamSegmentChars) {
    // One enormous response must not become a single unbounded block. Close the
    // segment at the boundary already confirmed above; that is by construction
    // outside any markdown construct, so neither segment is left holding an
    // unpaired fence that would make a renderer swallow the rest.
    //
    // With nothing confirmed there is no boundary to use: a hard split is still
    // safe while we are outside a fence, which keeps the size bound real for
    // prose that offers no boundary at all. Inside an open fence, keep
    // accumulating — a readable block beats an exactly sized one, and the fence
    // must close.
    const cut = stream.committed
      ? 0
      : insideFence(stream.tail)
        ? -1
        : Math.max(0, streamSegmentChars - stream.committed.length);
    if (cut >= 0) {
      const carried = stream.tail.slice(cut);
      stream.tail = stream.tail.slice(0, cut);
      commitStream(target, input.id, input.role, input.reasoningVisible);
      stream.segmentIndex += 1;
      stream.committed = "";
      stream.tail = carried;
      writeStreamBlock(target, input.id, input.role, input.reasoningVisible);
      return;
    }
  }
  writeStreamBlock(target, input.id, input.role, input.reasoningVisible);
}

/** Reflects the stream into its block without confirming the tail. */
function writeStreamBlock(
  target: StreamTarget,
  id: string,
  role: "thinking" | "assistant",
  reasoningVisible?: boolean,
): void {
  const stream = target.streams[id];
  if (!stream) return;
  // A segment that has just opened with nothing carried into it has nothing to
  // show, and a block with no text renders as an empty gap in the transcript.
  if (!stream.committed && !stream.tail) return;
  upsertInto(
    target.messages,
    segmentID(id, stream.segmentIndex),
    role,
    stream.committed,
    undefined,
    {
      pendingText: stream.tail,
      ...(role === "thinking" ? { reasoningVisible } : {}),
    },
  );
}

function commitStream(
  target: StreamTarget,
  id: string,
  role: "thinking" | "assistant",
  reasoningVisible?: boolean,
): void {
  const stream = target.streams[id];
  if (!stream) return;
  stream.committed += stream.tail;
  stream.tail = "";
  upsertInto(
    target.messages,
    segmentID(id, stream.segmentIndex),
    role,
    stream.committed,
    undefined,
    {
      pendingText: "",
      ...(role === "thinking" ? { reasoningVisible } : {}),
    },
  );
}

/** Commits any buffered text so later output cannot interleave with it. */
export function flushStream(target: StreamTarget, id: string): void {
  const stream = target.streams[id];
  if (!stream) return;
  if (!stream.tail && !stream.committed) return;
  const block = target.messages.find(
    (item) => item.id === segmentID(id, stream.segmentIndex),
  );
  commitStream(
    target,
    id,
    id.endsWith(":thinking") ? "thinking" : "assistant",
    block?.reasoningVisible,
  );
}

/**
 * After a tool card, subsequent model text belongs to a fresh segment so it
 * renders below the card instead of growing the block above it.
 */
function beginPostToolSegment(target: StreamTarget, turnID: string): void {
  for (const role of ["thinking", "assistant"] as const) {
    const stream = target.streams[streamID(turnID, role)];
    if (!stream || (!stream.committed && !stream.tail)) continue;
    stream.segmentIndex += 1;
    stream.committed = "";
    stream.tail = "";
  }
}

/**
 * Releases a settled turn's streaming buffers.
 *
 * A stream holds the confirmed text of its turn, which the transcript already
 * has. Keeping it after the turn ends means the projection carries a second copy
 * of every response for the life of the session, growing with two entries per
 * turn and untouched by transcript eviction, because eviction bounds `messages`
 * and nothing bounds this. The phase marker goes too: it only describes a turn in
 * progress.
 */
function releaseStreams(state: AppState, turnID: string): void {
  for (const role of ["thinking", "assistant"] as const)
    delete state.streams[streamID(turnID, role)];
  delete state.streamPhases[turnID];
}

/**
 * Discards text that streamed but was never confirmed. A cancelled turn must not
 * leave half a sentence in the record as though the model had said it.
 */
function dropStreamTail(state: AppState, turnID: string): void {
  for (const role of ["thinking", "assistant"] as const) {
    const id = streamID(turnID, role);
    const stream = state.streams[id];
    if (!stream) continue;
    stream.tail = "";
    const block = state.messages.find(
      (item) => item.id === segmentID(id, stream.segmentIndex),
    );
    if (block) block.pendingText = "";
  }
}

/** Marks the last segment of a stream, which is the block a reader ends on. */
function markBlockStatus(state: AppState, id: string, status: string): void {
  const stream = state.streams[id];
  const target = stream ? segmentID(id, stream.segmentIndex) : id;
  const block = state.messages.find((item) => item.id === target);
  if (block) block.status = status;
}

function userText(
  event: Extract<RuntimeEvent, { type: "turn.submitted" }>,
): string {
  if (!event.attachments?.length) return event.text;
  const attachments = event.attachments
    .map(
      (attachment) =>
        `${attachment.filename} (${attachment.mediaType}, ${attachment.byteLength} bytes)`,
    )
    .join(", ");
  return `${event.text}\n\nAttachments: ${attachments}`;
}

/** Shared mechanics for explicit stream-specific projectors. */
function applyAgentChatEvent(
  root: AppState,
  target: AgentStreamState,
  event: RuntimeEvent,
): boolean {
  switch (event.type) {
    case "navi.chat.turn.started":
    case "nia.chat.turn.started":
    case "chat.turn.started": {
      const activity: StreamActivityView = {
        messageID: event.messageID,
        phase: "waiting",
        startedAt: event.startedAt,
      };
      target.activity = activity;
      return true;
    }
    case "navi.chat.turn.phase":
    case "nia.chat.turn.phase":
    case "chat.turn.phase": {
      if (target.activity?.messageID === event.messageID) {
        target.activity.phase = event.phase;
        target.activity.toolName = event.toolName;
      }
      return true;
    }
    case "navi.chat.turn.finished":
    case "nia.chat.turn.finished":
    case "chat.turn.finished": {
      if (target.activity?.messageID === event.messageID)
        target.activity = undefined;
      const channel = event.type.startsWith("navi.")
        ? "navi"
        : event.type.startsWith("nia.")
          ? "nia"
          : (event as { channel?: "navi" | "nia" }).channel;
      if (channel) {
        // usageByChannel lives on the root AppState, not the agent sub-state
        // (target), so the per-channel token bars accumulate across panes.
        if (!root.usageByChannel?.[channel])
          root.usageByChannel[channel] = emptySessionUsageStats();
        root.usageByChannel[channel].turns += 1;
        root.usageByChannel[channel].llmMs += Math.max(
          0,
          event.endedAt - event.startedAt,
        );
      }
      return true;
    }
    case "navi.chat.message.new":
    case "nia.chat.message.new":
    case "navi.chat.message.added":
    case "nia.chat.message.added":
    case "chat.message.added": {
      if (event.role === "user") {
        // Internal synthetic prompts (advisor wake, mailbox steering) are
        // not human user turns. Render them as system rows so a chat pane
        // does not show an internal instruction as if the user sent it.
        const internal = event.text.startsWith("(internal");
        target.messages.push({
          id: `chat:${event.messageID}:${internal ? "system" : "user"}`,
          role: internal ? "system" : "user",
          text: event.text,
          pendingText: "",
          ...(event.attachments?.length
            ? { attachments: event.attachments }
            : {}),
        });
        return true;
      }
      const key = `chat:${event.messageID}:assistant`;
      flushStream(target, key);
      const stream = target.streams[key];
      const currentID = stream ? segmentID(key, stream.segmentIndex) : key;
      const current = target.messages.find((block) => block.id === currentID);
      // Live streaming has already filled the segment; durable replay is the
      // case where this is the only place the text can come from.
      const alreadyRendered = Boolean(
        current && (current.text || current.pendingText),
      );
      if (event.text && !alreadyRendered)
        upsertInto(target.messages, currentID, "assistant", event.text);
      delete target.streams[key];
      delete target.streams[`chat:${event.messageID}:thinking`];
      delete target.streamPhases[`chat:${event.messageID}`];
      return true;
    }
    case "navi.chat.message.delta":
    case "nia.chat.message.delta":
    case "chat.message.delta": {
      prepareStreamPhase(target, `chat:${event.messageID}`, "assistant");
      appendStream(target, {
        id: `chat:${event.messageID}:assistant`,
        role: "assistant",
        text: event.text,
      });
      return true;
    }
    case "navi.chat.thinking.delta":
    case "nia.chat.thinking.delta":
    case "chat.thinking.delta": {
      prepareStreamPhase(target, `chat:${event.messageID}`, "thinking");
      appendStream(target, {
        id: `chat:${event.messageID}:thinking`,
        role: "thinking",
        text: event.text,
      });
      return true;
    }
    case "navi.chat.thinking.done":
    case "nia.chat.thinking.done": {
      settleChatThinking(target, event.messageID, event.text);
      return true;
    }
    case "navi.chat.tool.used":
    case "nia.chat.tool.used":
    case "chat.tool.used": {
      // Mirrors the transcript's `tool.update`: commit any in-flight text,
      // open a fresh segment so the model's post-tool reply renders BELOW the
      // card (not merged into the block above it), then insert the card.
      const turnKey = `chat:${event.messageID}`;
      flushStream(target, `${turnKey}:thinking`);
      flushStream(target, `${turnKey}:assistant`);
      beginPostToolSegment(target, turnKey);
      delete target.streamPhases[turnKey];
      const tool: ToolBlock = {
        name: event.toolName,
        status: event.status,
        summary: event.summary,
        argumentsRaw: event.argumentsRaw ?? "",
        ...(event.result !== undefined ? { result: event.result } : {}),
        ...(event.startedAt !== undefined
          ? { startedAt: event.startedAt }
          : {}),
        ...(event.endedAt !== undefined ? { endedAt: event.endedAt } : {}),
      };
      upsertInto(
        target.messages,
        `chat:${event.id}:tool`,
        "tool",
        event.summary,
        event.status,
        { tool },
      );
      return true;
    }
    case "navi.chat.rollback":
    case "nia.chat.rollback":
    case "chat.rollback": {
      const boundary = `chat:${event.toMessageID}`;
      const index = target.messages.findIndex((block) =>
        block.id.startsWith(`${boundary}:`),
      );
      if (index !== -1) {
        const isUser = target.messages[index]?.role === "user";
        // A user-message rollback moves that message into the composer as a
        // draft, so remove the card itself as well as everything after it.
        target.messages.splice(isUser ? index : index + 1);
      } else target.messages.length = 0;
      target.streams = {};
      target.streamPhases = {};
      return true;
    }
    default:
      return false;
  }
}

export function applyNaviEvent(state: AppState, event: RuntimeEvent): boolean {
  if (event.type.startsWith("navi.chat."))
    return applyAgentChatEvent(state, state.navi, event);
  // Legacy journals are the sole place payload channel compatibility remains.
  if (
    event.type.startsWith("chat.") &&
    (event as { channel?: string }).channel !== "nia"
  )
    return applyAgentChatEvent(state, state.navi, event);
  return applyNaviCollabEvent(state, event);
}

export function applyNiaEvent(state: AppState, event: RuntimeEvent): boolean {
  if (event.type.startsWith("nia.chat."))
    return applyAgentChatEvent(state, state.nia, event);
  if (
    event.type.startsWith("chat.") &&
    (event as { channel?: string }).channel === "nia"
  )
    return applyAgentChatEvent(state, state.nia, event);
  return applyNiaCollabEvent(state, event);
}

/**
 * Routes Natalia-sent collaboration messages into the main/Natalia stream.
 *
 * New producers use `natalia.collab.*`; legacy shared `collab.*` events are
 * accepted here only when their sender is `main_agent`, never by their
 * recipient.
 */
export function applyNataliaCollabEvent(
  state: AppState,
  event: RuntimeEvent,
): boolean {
  if (event.type.startsWith("natalia.collab."))
    return applyCollabRow(state.messages, event);
  if (event.type.startsWith("collab.") && collabFrom(event) === "main_agent")
    return applyCollabRow(state.messages, event);
  return false;
}

/**
 * Routes Navi-sent collaboration messages into the Navi stream by `from`.
 */
export function applyNaviCollabEvent(
  state: AppState,
  event: RuntimeEvent,
): boolean {
  if (event.type.startsWith("navi.collab."))
    return applyCollabRow(state.navi.messages, event);
  if (event.type.startsWith("collab.") && collabFrom(event) === "live_chat")
    return applyCollabRow(state.navi.messages, event);
  return false;
}

/**
 * Routes Nia-sent collaboration messages into the Nia stream by `from`.
 */
export function applyNiaCollabEvent(
  state: AppState,
  event: RuntimeEvent,
): boolean {
  if (event.type.startsWith("nia.collab."))
    return applyCollabRow(state.nia.messages, event);
  if (event.type.startsWith("collab.") && collabFrom(event) === "nia")
    return applyCollabRow(state.nia.messages, event);
  return false;
}

function applyCollabRow(
  messages: MessageBlock[],
  event: RuntimeEvent,
): boolean {
  const id = collabID(event);
  if (!id) return false;
  upsertInto(messages, `chat:${id}:collab`, "system", collabText(event));
  return true;
}

function collabMessageOf(
  event: RuntimeEvent,
): CollaborationMessage | undefined {
  if (!("message" in event)) return undefined;
  const message = event.message;
  return typeof message === "object" && message !== null ? message : undefined;
}

function collabFrom(event: RuntimeEvent): CollaborationParticipant | undefined {
  if (!event.type.startsWith("collab.")) return undefined;
  const message = collabMessageOf(event);
  if (message) return message.from;
  if ("from" in event && typeof event.from === "string")
    return event.from as CollaborationParticipant;
  return undefined;
}

function collabID(event: RuntimeEvent): string | undefined {
  if (
    event.type === "collab.message" ||
    event.type.endsWith(".collab.message")
  ) {
    const message = collabMessageOf(event);
    if (message) return message.id;
    return undefined;
  }
  if ("id" in event && typeof event.id === "string") return event.id;
  return undefined;
}

function collabText(event: RuntimeEvent): string {
  if (event.type === "collab.suggestion")
    return `Navi → Natalia: ${event.suggestion}`;
  if (event.type === "collab.notice")
    return `Natalia → Navi: [${event.noticeType}] ${event.notice}`;
  if (event.type === "collab.question")
    return `Natalia → Navi: ${event.question}`;
  if (event.type === "collab.answer") return `Navi → Natalia: ${event.answer}`;
  if (event.type === "collab.response")
    return `Natalia ${event.decision} the suggestion${event.reason ? ` (${event.reason})` : ""}`;
  const message =
    collabMessageOf(event) ?? (event as unknown as CollaborationMessage);
  if (message.kind === "response")
    return `Natalia ${message.decision} the suggestion${message.reason ? ` (${message.reason})` : ""}`;
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
  return `${from} → ${to}: ${message.text}`;
}

function settleChatThinking(
  target: StreamTarget,
  messageID: string,
  text: string,
): void {
  const id = `chat:${messageID}:thinking`;
  const first = target.messages.findIndex(
    (block) => block.id === id || block.id.startsWith(`${id}:segment:`),
  );
  target.messages.splice(
    0,
    target.messages.length,
    ...target.messages.filter(
      (block) => block.id !== id && !block.id.startsWith(`${id}:segment:`),
    ),
  );
  delete target.streams[id];
  delete target.streamPhases[`chat:${messageID}`];
  if (!text) return;
  const block: MessageBlock = {
    id,
    role: "thinking",
    text,
    pendingText: "",
    reasoningVisible: true,
    status: "completed",
  };
  if (first === -1) target.messages.push(block);
  else target.messages.splice(first, 0, block);
}
