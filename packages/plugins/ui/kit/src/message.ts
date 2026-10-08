import {
  projectToolCard,
  projectToolCall,
  projectToolRender,
  toolResultSummary,
} from "@natalia/ui-model";
import type { ToolCard } from "@natalia/ui-model";

export { projectToolCall, projectToolRender, toolResultSummary };

export type { ToolCard };

/**
 * The row's leading label, the `classifyTool` table.
 *
 * The collapsed row reads `<Label> · <the sentence the model wrote>` — never
 * the raw command or path, which is what the EXPANDED card is for. Measured
 * against the reference rows (`Bash · Verify all three families in dist`): the
 * family name first, the human sentence second, the command nowhere in the
 * collapsed state.
 *
 * A tool absent from this table falls back to its own name, which is the
 * honest answer for a tool nobody has classified yet.
 */
const TOOL_ROW_LABELS: Record<string, string> = {
  run_shell: "Bash",
  process_start: "Process",
  process_list: "Process",
  process_status: "Process",
  process_output: "Process",
  process_ready: "Process",
  process_wait: "Process",
  process_stop: "Process",
  process_cleanup: "Process",
  process_audit: "Process",
  read_file: "Read",
  read_media_file: "Read",
  image_read: "Read",
  write_file: "Write",
  edit_file: "Edit",
  apply_edits: "Edit",
  glob: "Glob",
  grep: "Grep",
  web_fetch: "Fetch",
  web_search: "Search",
  todo_read: "Todo",
  todo_write: "Todo",
  ask_user: "Question",
  agent_spawn: "Agent",
  agent_message: "Agent",
  agent_wait: "Agent",
  list_agents: "Agents",
  list_subagent_models: "Models",
  skill: "Skill",
  job_output: "Job",
  job_list: "Jobs",
  job_kill: "Job",
  lsp: "Code",
  terminal_open: "Terminal",
  terminal_send: "Terminal",
  terminal_read: "Terminal",
  terminal_close: "Terminal",
  terminal_list: "Terminals",
  plan: "Plan",
};

export function toolRowLabel(toolName: string): string {
  return TOOL_ROW_LABELS[toolName] ?? toolName;
}

/**
 * Relativize a path for display (presentation plan P3.3, the
 * `relativizeToCwd` + `abbreviateHomePath`): a path under the session's
 * cwd becomes relative to it, one under the user's home folds to `~`, and
 * everything else passes through. A reader scanning a row wants the short
 * form; the full path stays in the expanded card's body.
 */
export function relativizePath(path: string, cwd?: string): string {
  if (!path) return path;
  const home = globalThis.process?.env?.HOME;
  if (home && path === home) return "~";
  if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  if (cwd && path === cwd) return ".";
  if (cwd && path.startsWith(`${cwd}/`)) {
    const relative = path.slice(cwd.length + 1);
    return relative.length > 0 ? relative : ".";
  }
  return path;
}

/**
 * The raw tool block the view-store carries (mirrored here so the kit needs
 * no dependency on the store package).
 */
export type ToolBlockLike = {
  name: string;
  status: string;
  /** The event's stored summary — a HINT, never trusted for display. */
  summary: string;
  /** The durable result the presentation is derived from. */
  result?: string;
  metadata?: Record<string, unknown>;
  /** The reassembled raw arguments (streamed in fragments by the runtime). */
  argumentsRaw?: string;
  /**
   * The tool's own card, carried on the event's structured slot (UI
   * refactor R0). Absent on an event recorded before the slot existed —
   * those fall back to the legacy `metadata.render` blob, which is the
   * same shape (see {@link toolCallCard}).
   */
  card?: ToolCard;
};

/**
 * The transcript row for a tool call — a FUNCTION OF THE DATA (the user's
 * 2026-10-07 ruling): the same block renders identically whether it was
 * recorded a minute ago or replayed from the journal tomorrow.
 *
 * That is why the stored `summary` is not used: it is a snapshot the event
 * carried when it was written, so an event recorded before the presentation
 * existed shows raw JSON forever. The row's one-liner is derived from the
 * RESULT (the durable fact) and the tool's own projected card wins whenever
 * the event carries one; the body is the raw result, which the kit presents
 * (keyed checklist or the flatten) — again per call, never per recording.
 */
export function toolCallRow(tool: ToolBlockLike): ToolCall {
  const card = toolCallCard(tool);
  const raw = tool.result ?? tool.summary;
  const args = parseArguments(tool.argumentsRaw);
  return {
    name: tool.name,
    output: raw,
    status: tool.status,
    summary: card?.summary ?? toolResultSummary(raw),
    ...(card ? { card } : {}),
    ...(args ? { arguments: args } : {}),
  };
}

/** The reassembled arguments, or undefined when there are none / they are not JSON. */
function parseArguments(
  argumentsRaw: string | undefined,
): Record<string, unknown> | undefined {
  if (!argumentsRaw) return undefined;
  try {
    const parsed = JSON.parse(argumentsRaw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The tool's own projected card for this block (UI refactor R0), or
 * `undefined` when the event carried none.
 *
 * The "structured slot first, legacy blob second" rule lives in ONE place —
 * {@link projectToolCard} — because every later batch that touches how a
 * card arrives must change one decoder, not two. The kit keeps this wrapper
 * for its own type (`ToolBlockLike`) and for the row's fallback summary.
 */
export function toolCallCard(tool: ToolBlockLike): ToolCard | undefined {
  return projectToolCard(tool);
}

/**
 * The tool's own projected card, carried verbatim from the `tool.update`
 * event. A tool declares this in its `output` definition; the runtime
 * publishes it (structured `card` slot since R0, `metadata.call`/
 * `metadata.render` before). The UI renders it INSTEAD OF synthesizing a
 * card from the name — the tool knows what its call means, a UI can only
 * guess.
 */
export type ToolCallCard = ToolCard;

export interface ToolCall {
  name: string;
  output?: string;
  status?: string;
  summary?: string;
  /** The tool's self-projected card, when it declared one. */
  card?: ToolCallCard;
  /**
   * The call's parsed arguments — the DURABLE half of a keyed card's input
   * (ask_user's question and options live here, its result holds only the
   * answers). Carried so a replayed event renders exactly like a live one:
   * the presentation is derived from arguments + result, never from the
   * card body the event happened to record.
   */
  arguments?: Record<string, unknown>;
}

export interface MessageAction {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

export interface Attachment {
  id?: string;
  path: string;
  name: string;
  mediaType?: string;
  width?: number;
  height?: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
  status?: "running" | "completed" | "error" | "done" | "failed";
  /** A user input injected into a running turn rather than starting one. */
  steering?: boolean;
  thinking?: boolean;
  streaming?: boolean;
  /**
   * A goal round (`<goal_round>` internal turn). The transcript renders it as a
   * compact `Round N/M` row with the full prompt behind a disclosure.
   */
  goalRound?: {
    round: number;
    maxGoalRounds: number;
    objective: string;
    detail: string;
  };
  toolCalls?: ToolCall[];
  actions?: MessageAction[];
  attachments?: Attachment[];
}
