/**
 * Resource projection: terminals, sandboxes, subagents, checkpoints, rollback,
 * MCP servers, plugins and loaded capabilities.
 *
 * These are runtime facts, so this layer only records the latest state and a
 * bounded history. It never decides anything about them: starting, stopping,
 * merging and approving all stay with the runtime.
 */
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  appendBounded,
  checkpointLimit,
  terminalTranscriptChars,
  type TerminalTimelineEntry,
  type TerminalView,
  subagentHistoryRowKey,
  terminalTimelineLimit,
  upsertBlock,
  type AppState,
} from "./state";

/**
 * Keeps the visible tail of a transcript and says how much was dropped, so a
 * consumer never silently renders a truncated scrollback as if it were complete.
 */
function boundTerminalTranscript(event: TerminalView): TerminalView {
  const transcript = event.transcript;
  if (!transcript || transcript.length <= terminalTranscriptChars) return event;
  const omitted = transcript.length - terminalTranscriptChars;
  return {
    ...event,
    transcript: `... ${omitted} earlier chars omitted from live pane ...\n${transcript.slice(
      -terminalTranscriptChars,
    )}`,
  };
}

function sameTimelineEntry(
  previous: TerminalTimelineEntry,
  next: TerminalTimelineEntry,
): boolean {
  return (
    previous.at === next.at &&
    previous.actor === next.actor &&
    previous.action === next.action &&
    previous.status === next.status
  );
}

/**
 * The fields a republished update is compared on. This list is load-bearing: the
 * comparison below is built from it, so a field that is not listed is not
 * compared and a change to it would be dropped.
 */
const comparedTerminalFields = [
  "status",
  "attached",
  "rows",
  "cols",
  "activity",
  "tail",
  "transcript",
  "command",
  "cwd",
  "prompt",
  "lastAction",
  "target",
  "ownership",
  "approvalID",
  "revision",
  "lastOutputAt",
  "viewers",
  "inputOwner",
  "geometryOwner",
  // The execution this pane state was published from. A record left on a stale
  // episode attributes the pane to the wrong run.
  "episodeID",
  // The session that published the update; a pane left on a stale session
  // would render under the wrong ownership.
  "sessionID",
  // Child-owned terminal updates are isolated by their subagent projection.
  "agentID",
] as const;

/**
 * Fields deliberately left out of the comparison, each with a reason:
 *   - `type` and `id` select the record; two updates being compared always agree.
 *   - `screen` is a pure function of `revision`: the terminal registry's
 *     `screenSnapshot()` caches one snapshot per revision, so the frame cannot
 *     change without `revision` changing, and `revision` is compared.
 *     Deep-comparing a cell grid on every keystroke would cost more than the
 *     dedupe saves.
 */
const uncomparedTerminalFields = [
  "type",
  "id",
  "screen",
  "workspaceID",
] as const;

type ClassifiedTerminalField =
  | (typeof comparedTerminalFields)[number]
  | (typeof uncomparedTerminalFields)[number];

type AssertNever<T extends never> = T;
/**
 * Compile-time completeness. Adding a field to `terminal.update` without
 * classifying it above fails typecheck, so the dedupe cannot silently start
 * ignoring an observable fact — the failure mode this guard exists to prevent.
 */
export type UnclassifiedTerminalField = AssertNever<
  Exclude<keyof TerminalView, ClassifiedTerminalField>
>;

/** Structural equality for the small JSON values these fields hold. */
function sameObservedValue(previous: unknown, next: unknown): boolean {
  if (previous === next) return true;
  if (
    typeof previous !== "object" ||
    typeof next !== "object" ||
    previous === null ||
    next === null
  )
    return false;
  if (Array.isArray(previous) !== Array.isArray(next)) return false;
  if (Array.isArray(previous) && Array.isArray(next))
    return (
      previous.length === next.length &&
      previous.every((item, index) => sameObservedValue(item, next[index]))
    );
  const previousKeys = Object.keys(previous as Record<string, unknown>);
  const nextKeys = Object.keys(next as Record<string, unknown>);
  if (previousKeys.length !== nextKeys.length) return false;
  return previousKeys.every(
    (key) =>
      key in (next as Record<string, unknown>) &&
      sameObservedValue(
        (previous as Record<string, unknown>)[key],
        (next as Record<string, unknown>)[key],
      ),
  );
}

/**
 * True when nothing a consumer can observe changed, so the republish can be
 * dropped. Input and geometry ownership are part of this: a UI renders who holds
 * the keyboard, and a projection that stored a stale owner would tell the user
 * the model is typing when a person is.
 */
function sameTerminalState(
  previous: TerminalView,
  next: TerminalView,
): boolean {
  return comparedTerminalFields.every((field) =>
    sameObservedValue(previous[field], next[field]),
  );
}

/** Returns true when the event belongs to this projection. */
export function applyResourceEvent(
  state: AppState,
  event: RuntimeEvent,
): boolean {
  switch (event.type) {
    case "terminal.update": {
      const previous = state.terminals[event.id];
      const next = boundTerminalTranscript(event);
      // A pane republishes on every keystroke, so an update that changes nothing
      // a consumer can see is dropped rather than forcing a re-render.
      if (previous && sameTerminalState(previous, next)) return true;
      state.terminals = { ...state.terminals, [event.id]: next };
      return true;
    }
    case "terminal.timeline": {
      const existing = state.terminalTimeline[event.id] ?? [];
      // Replaying history re-delivers events a consumer may already hold, so an
      // entry identical in time, actor, action and outcome is the same entry, not a
      // second occurrence. Without this, every reconnect doubles the timeline.
      if (existing.some((entry) => sameTimelineEntry(entry, event)))
        return true;
      state.terminalTimeline = {
        ...state.terminalTimeline,
        [event.id]: appendBounded(existing, event, terminalTimelineLimit),
      };
      return true;
    }
    case "terminal.approval":
      // Keyed by approval id, not terminal id: one pane can have several
      // approvals over its life and a UI needs to resolve the right one.
      state.terminalApprovals = {
        ...state.terminalApprovals,
        [event.approvalID]: event,
      };
      return true;
    case "terminal.action":
      return true;
    case "terminal.viewer":
      return true;
    case "sandbox.update":
      state.sandboxes = { ...state.sandboxes, [event.id]: event };
      return true;
    case "sandbox.diff":
      state.sandboxDiffs = { ...state.sandboxDiffs, [event.id]: event };
      return true;
    case "sandbox.audit":
      upsertBlock(
        state,
        `sandbox:${event.id}:${event.action}`,
        "system",
        event.message,
        event.approvalRequired ? "approval_required" : undefined,
      );
      return true;
    case "subagent.update": {
      state.subagents = { ...state.subagents, [event.id]: event };
      const list = state.subagentHistory[event.id] ?? [];
      const key = subagentHistoryRowKey(event);
      if (!list.some((item) => subagentHistoryRowKey(item) === key))
        state.subagentHistory = {
          ...state.subagentHistory,
          [event.id]: [...list, event],
        };
      return true;
    }
    case "checkpoint.created":
      state.checkpoints = appendBounded(
        state.checkpoints,
        event,
        checkpointLimit,
      );
      return true;
    case "checkpoint.failed":
      // An incomplete checkpoint is a rollback-safety fact, so say so rather
      // than dropping it.
      upsertBlock(
        state,
        `checkpoint:failed:${event.reason}`,
        "system",
        event.incomplete
          ? `checkpoint incomplete (${event.reason}): ${event.message}`
          : `checkpoint failed (${event.reason}): ${event.message}`,
        "failed",
      );
      return true;
    case "checkpoint.unavailable":
      upsertBlock(
        state,
        "checkpoint:unavailable",
        "system",
        `checkpoints unavailable (${event.reason}): ${event.suggestion}`,
        event.disabledByConfig ? "disabled" : "unavailable",
      );
      return true;
    case "rollback.previewed":
      state.rollback = {
        checkpointID: event.preview.checkpointID,
        state: "previewed",
      };
      return true;
    case "rollback.begin":
      state.rollback = {
        checkpointID: event.checkpointID,
        safetyCheckpointID: event.safetyCheckpointID,
        state: "running",
        dryRun: event.dryRun,
      };
      return true;
    case "rollback.end":
      state.rollback = {
        checkpointID: event.checkpointID,
        safetyCheckpointID: event.safetyCheckpointID,
        state: "completed",
        restoredFiles: event.restoredFiles,
        deletedFiles: event.deletedFiles,
      };
      return true;
    case "rollback.failed":
      state.rollback = {
        checkpointID: event.checkpointID,
        safetyCheckpointID: event.safetyCheckpointID,
        state: "failed",
        message: event.message,
        recovered: event.recovered,
      };
      return true;
    case "snapshot.created":
      upsertBlock(
        state,
        `snapshot:${event.id}`,
        "system",
        `snapshot ${event.id}: ${event.files.join(", ")}`,
        "created",
      );
      return true;
    case "mcp.status":
      state.mcp = { ...state.mcp, [event.server]: event };
      return true;
    case "plugin.update":
      state.plugins = { ...state.plugins, [event.id]: event };
      return true;
    case "projections.updated":
      state.pluginProjections = event.contributions.map((entry) => ({
        ...entry,
      }));
      return true;
    case "capability.loaded":
      state.capabilities = { ...state.capabilities, [event.id]: event };
      return true;
    case "capability.unloaded": {
      const { [event.id]: _removed, ...rest } = state.capabilities;
      state.capabilities = rest;
      return true;
    }
    case "workgraph.node_added":
      state.workGraphNodes = {
        ...state.workGraphNodes,
        [event.nodeID]: event,
      };
      return true;
    case "workgraph.edge_added":
      state.workGraphEdges = {
        ...state.workGraphEdges,
        [event.id]: event,
      };
      return true;
    default:
      return false;
  }
}
