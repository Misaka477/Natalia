import { projectToolCall, projectToolRender } from "@natalia/ui-model";
import type { ToolRenderIntent } from "@natalia/ui-model";

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
