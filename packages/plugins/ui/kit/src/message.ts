import {
  projectToolCall,
  projectToolRender,
  shouldCollapseToolOutput,
} from "@natalia/ui-model";
import type { ToolRenderIntent } from "@natalia/ui-model";

export { shouldCollapseToolOutput };

/**
 * Decodes a tool's self-projected card from the raw event metadata, or
 * `undefined` when the tool declared none (or the payload is malformed).
 *
 * A running call projects from `metadata.call`; a settled one from
 * `metadata.render`, which is the tool's result-time presentation. Both
 * slots carry the same {@link ToolRenderIntent} shape, so this one function
 * serves both and the UI never has to know which phase it is in.
 *
 * @param metadata - the tool block's raw metadata, as the view-store keeps it.
 * @returns the decoded card, or undefined.
 */
/**
 * The row's leading label, dsh's `classifyTool` table.
 *
 * The collapsed row reads `<Label> · <the sentence the model wrote>` — never
 * the raw command or path, which is what the EXPANDED card is for. Measured
 * against dsh's own rows (`Bash · Verify all three families in dist`): the
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
 * Relativize a path for display (presentation plan P3.3, dsh's
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
 * The tools with a keyed toolview (presentation plan P2.1): a keyed hit
 * REPLACES the generic card, the same dispatch dsh's ToolCallTree performs.
 * A name absent from this set falls through to the generic card — the
 * honest answer for a tool nobody has keyed yet.
 */
const KEYED_TOOLVIEW_NAMES: ReadonlySet<string> = new Set([
  // dsh's AskQuestionCard: the Q&A transcript.
  "ask_user",
  // The todo checklist (P2.3), both halves of the surface.
  "todo_read",
  "todo_write",
]);

export function hasKeyedToolview(toolName: string): boolean {
  return KEYED_TOOLVIEW_NAMES.has(toolName);
}

/** One Q&A transcript line: the question, a choice line, or the answer. */
export type QATranscriptLine = {
  text: string;
  kind: "question" | "choices" | "answer" | "plain";
};

/**
 * Parses the ask_user card's transcript body into its lines.
 *
 * The tool writes `Q:` / `Options:` / `A:` lines (ask-tools.ts); this reads
 * them back for the keyed card. A body that is not that transcript yields
 * its lines verbatim as `plain` — the card shows what the tool wrote.
 */
export function parseAskTranscript(body: string): QATranscriptLine[] {
  return body
    .split(String.fromCharCode(10))
    .filter((line) => line.length > 0)
    .map((line) => ({
      text: line,
      kind: line.startsWith("Q:")
        ? ("question" as const)
        : line.startsWith("Options:")
          ? ("choices" as const)
          : line.startsWith("A:")
            ? ("answer" as const)
            : ("plain" as const),
    }));
}

/** One checklist row, decoded from a todo result envelope. */
export type TodoChecklistItem = { content: string; status: string };

/** A keyed card's rendered line: the text and its visual treatment. */
export type KeyedToolviewLine = {
  line: string;
  kind: "plain" | "added" | "removed" | "question" | "choices" | "answer";
};

/**
 * The keyed card's lines, or undefined for a tool with no keyed toolview
 * (presentation plan P2.1).
 *
 * A keyed toolview REPLACES the generic card's BODY, never its row: the
 * reader must still see which tool ran (the label, the status, the title),
 * which is why this returns just the line model and the card's shell is
 * shared with the generic path.
 *
 * The discipline the user's screenshot taught: a keyed card whose payload
 * is missing must fall back to the tool's RAW output, never invent a
 * placeholder — `(no items)` on a row that names no tool is worse than
 * showing the result text the tool actually returned.
 */
export function keyedToolviewLines(toolCall: {
  name: string;
  output?: string;
  card?: { body?: string };
}): KeyedToolviewLine[] | undefined {
  if (!KEYED_TOOLVIEW_NAMES.has(toolCall.name)) return undefined;
  const body = toolCall.card?.body ?? toolCall.output ?? "";
  if (toolCall.name === "ask_user")
    return parseAskTranscript(body).map((entry) => ({
      line: entry.text,
      kind:
        entry.kind === "answer"
          ? ("answer" as const)
          : entry.kind === "question"
            ? ("question" as const)
            : entry.kind === "choices"
              ? ("choices" as const)
              : ("plain" as const),
    }));
  const items = todoItemsFromBody(body);
  return items.length > 0
    ? items.map((item) => ({
        line: `${item.status === "completed" ? "[x]" : "[ ]"} ${item.content}`,
        kind:
          item.status === "completed" ? ("added" as const) : ("plain" as const),
      }))
    : // The envelope is absent (a prose result, an error sentence): show
      // what the tool actually said rather than fabricating an empty list.
      body
        .split(String.fromCharCode(10))
        .filter((line) => line.length > 0)
        .map((line) => ({ line, kind: "plain" as const }));
}

/**
 * The todo items a tool's result envelope carries, or an empty list when
 * the body is not the envelope. Both todo tools answer with it after the
 * T-01 envelope alignment; a prose result simply has no checklist.
 */
export function todoItemsFromBody(body: string): TodoChecklistItem[] {
  try {
    const parsed = JSON.parse(body) as {
      items?: Array<{ content?: unknown; status?: unknown }>;
    };
    if (Array.isArray(parsed.items))
      return parsed.items.map((item) => ({
        content: String(item.content ?? ""),
        status: String(item.status ?? "pending"),
      }));
  } catch {
    // Not the envelope.
  }
  return [];
}

export function toolCallCard(
  metadata: Record<string, unknown> | undefined,
): ToolCallCard | undefined {
  if (!metadata) return undefined;
  const intent: ToolRenderIntent | undefined =
    projectToolRender(metadata) ?? projectToolCall(metadata);
  if (!intent) return undefined;
  return {
    kind: intent.kind,
    title: intent.title,
    summary: intent.summary,
    ...(intent.body === undefined ? {} : { body: intent.body }),
    ...(intent.meta ? { meta: intent.meta } : {}),
  };
}

/**
 * The tool's own projected card, carried verbatim from the `tool.update`
 * event's metadata (`metadata.call` while running, `metadata.render` once
 * settled). A tool declares this in its `output` definition; the host decodes
 * it as a {@link ToolRenderIntent}. The UI renders it INSTEAD OF synthesizing
 * a card from the name — the tool knows what its call means, a UI can only
 * guess.
 */
export interface ToolCallCard {
  /** Card family: picks the icon and the body's treatment. */
  kind?: "generic" | "terminal" | "diff" | "search" | "read" | "web";
  /** The tool-written label: a command, a path, a query. */
  title?: string;
  /** The tool-written one-liner (the model's `description` for shell calls). */
  summary?: string;
  /** Structured facets shown as label:value pairs (exit code, total lines...). */
  meta?: Array<[label: string, value: string]>;
  /**
   * The tool-written body: a command's output, a diff's marked hunk, a
   * read's page. Carried through so a renderer shows what the TOOL wrote
   * rather than the raw model-facing result string, which for a diff is
   * not even the same text.
   */
  body?: string;
}

export interface ToolCall {
  name: string;
  output?: string;
  status?: string;
  summary?: string;
  /** The tool's self-projected card, when it declared one. */
  card?: ToolCallCard;
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
