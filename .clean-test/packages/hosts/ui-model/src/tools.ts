export type ToolStatus =
  | "receiving_arguments"
  | "queued"
  | "awaiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "rejected"
  | "cancelled";

export type ToolKind =
  | "generic"
  | "diff"
  | "workflow"
  | "background"
  | "subagent"
  | "shell"
  | "read"
  | "write"
  | "grep"
  | "glob"
  | "webfetch"
  | "websearch"
  | "question"
  | "execute"
  | "terminal"
  | "sandbox"
  | "skill";

export type ToolResultView = {
  summary: string;
  preview: string;
  detail: string;
  truncated: boolean;
  totalChars: number;
  totalLines: number;
};

export type ToolResultPresentation = {
  kind?: ToolKind;
  name?: string;
};

/**
 * The UI-facing card a tool projects for a call or a result.
 *
 * Tools declare this in their `output` definition (`@anthelia/tools`); it reaches
 * the client through the `tool.update` event's `metadata.call` (running) and
 * `metadata.render` (result). `ui-model` cannot depend on `@anthelia/tools` (a
 * kernel package), so this is a structural mirror the TUI decodes from the
 * event metadata.
 */
export type ToolRenderIntent = {
  kind: "generic" | "terminal" | "diff" | "search" | "read" | "web";
  title: string;
  summary: string;
  body?: string;
  meta?: Array<[label: string, value: string]>;
};

/** Decodes a projected card from a metadata slot, or `undefined` when absent. */
function decodeIntent(raw: unknown): ToolRenderIntent | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.kind !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.summary !== "string"
  )
    return undefined;
  return {
    kind: candidate.kind as ToolRenderIntent["kind"],
    title: candidate.title,
    summary: candidate.summary,
    ...(typeof candidate.body === "string" ? { body: candidate.body } : {}),
    ...(Array.isArray(candidate.meta)
      ? { meta: candidate.meta as Array<[string, string]> }
      : {}),
  };
}

/**
 * Decodes a tool's self-projected call card from the event metadata
 * (`metadata.call`), or `undefined` when the tool declared none.
 */
export function projectToolCall(
  metadata: Record<string, unknown> = {},
): ToolRenderIntent | undefined {
  return decodeIntent(metadata.call);
}

/**
 * Decodes a tool's self-projected result card from the event metadata
 * (`metadata.render`), or `undefined` when the tool declared none. A malformed
 * intent is treated as absent — the client falls back to the plain result.
 */
export function projectToolRender(
  metadata: Record<string, unknown> = {},
): ToolRenderIntent | undefined {
  return decodeIntent(metadata.render);
}

export type ParsedToolArguments = {
  complete: boolean;
  keyArguments: string[];
  redactedJson?: string;
};

const sensitiveKey =
  /(?:api[_-]?key|token|secret|password|passphrase|credential|authorization|cookie)/iu;

export function classifyTool(
  name: string,
  metadata: Record<string, unknown> = {},
): ToolKind {
  const lower = name.toLowerCase();
  const kind =
    typeof metadata.kind === "string" ? metadata.kind.toLowerCase() : "";
  if (
    kind === "diff" ||
    lower.includes("diff") ||
    lower === "apply_edits" ||
    lower === "edit"
  )
    return "diff";
  if (kind === "workflow" || lower.includes("workflow")) return "workflow";
  if (kind === "background" || lower.includes("background"))
    return "background";
  if (
    kind === "subagent" ||
    lower === "task" ||
    lower.includes("subagent") ||
    lower.startsWith("agent_")
  )
    return "subagent";
  if (
    kind === "shell" ||
    lower === "run_shell" ||
    lower === "shell" ||
    lower === "bash"
  )
    return "shell";
  if (kind === "read" || lower === "read" || lower === "read_file")
    return "read";
  if (kind === "write" || lower === "write" || lower === "write_file")
    return "write";
  if (kind === "grep" || lower === "grep") return "grep";
  if (kind === "glob" || lower === "glob") return "glob";
  if (kind === "webfetch" || lower === "web_fetch" || lower === "webfetch")
    return "webfetch";
  if (kind === "websearch" || lower === "web_search" || lower === "websearch")
    return "websearch";
  if (kind === "question" || lower === "ask_user" || lower === "question")
    return "question";
  if (kind === "execute" || lower === "execute") return "execute";
  if (kind === "terminal" || lower.includes("terminal")) return "terminal";
  if (kind === "sandbox" || lower.includes("sandbox")) return "sandbox";
  if (kind === "skill" || lower.includes("skill")) return "skill";
  return "generic";
}

export function parseToolArguments(raw: string): ParsedToolArguments {
  const trimmed = raw.trim();
  if (!trimmed) return { complete: false, keyArguments: [] };
  try {
    const value = JSON.parse(trimmed) as unknown;
    const redacted = redactValue(value);
    return {
      complete: true,
      keyArguments: keyArguments(redacted),
      redactedJson: JSON.stringify(redacted, undefined, 2),
    };
  } catch {
    return { complete: false, keyArguments: [] };
  }
}

export function resultView(
  result: string,
  maxLines = 8,
  maxChars = 1200,
  presentation: ToolResultPresentation = {},
): ToolResultView {
  const human = humanReadableResult(result, presentation);
  const lines = human.preview.split("\n");
  const chars = Array.from(human.preview);
  const lineLimited = lines.length > maxLines;
  const charLimited = chars.length > maxChars;
  const previewByLine = lines.slice(0, maxLines).join("\n");
  const previewChars = Array.from(previewByLine).slice(0, maxChars).join("");
  const truncated =
    lineLimited || charLimited || previewChars.length < previewByLine.length;
  const preview = truncated ? `${previewChars}\n...` : human.preview;
  return {
    summary: human.summary,
    preview,
    detail: result,
    truncated,
    totalChars: Array.from(result).length,
    totalLines: result.split("\n").length,
  };
}

function humanReadableResult(
  result: string,
  presentation: ToolResultPresentation,
) {
  let value: unknown;
  try {
    value = JSON.parse(result);
  } catch {
    return { summary: plainSummary(result), preview: result };
  }
  if (presentation.kind === "diff" && Array.isArray(value)) {
    const changes = value.filter(isRecord);
    return {
      summary: `${changes.length} sandbox change${changes.length === 1 ? "" : "s"}`,
      preview:
        changes.map((change) => formatChange(change)).join("\n") ||
        "No sandbox changes.",
    };
  }
  if (presentation.kind === "subagent" && isRecord(value)) {
    const id = stringValue(value.id);
    const status = stringValue(value.status);
    const task = stringValue(value.task);
    return {
      summary: `${id || "Subagent"}${status ? ` · ${status}` : ""}`,
      preview: [task ? `Task: ${task}` : undefined, "Subagent started."]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (presentation.kind === "workflow" && isRecord(value)) {
    const status = stringValue(value.status) ?? "unknown";
    const workflow =
      stringValue(value.workflow) ?? stringValue(value.name) ?? "workflow";
    const completed = Array.isArray(value.completedStepIDs)
      ? value.completedStepIDs.length
      : undefined;
    return {
      summary: `Workflow ${workflow} · ${status}`,
      preview:
        completed === undefined
          ? "Workflow result available."
          : `Completed steps: ${completed}`,
    };
  }
  if (presentation.name === "browser_visit" && isRecord(value)) {
    const url = stringValue(value.url);
    const status = value.status;
    const title = stringValue(value.title);
    const preview = stringValue(value.textPreview);
    const contentType = stringValue(value.contentType);
    return {
      summary: `Visited ${title || url || "page"}${status ? ` · HTTP ${status}` : ""}`,
      preview: [
        title ? `Title: ${title}` : undefined,
        url ? `URL: ${url}` : undefined,
        contentType ? `Content type: ${contentType}` : undefined,
        preview ? `Preview: ${truncateLine(preview, 280)}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (presentation.name === "ask_user" && isRecord(value)) {
    const answers = Array.isArray(value.answers)
      ? value.answers
          .map((answer) =>
            Array.isArray(answer)
              ? answer.map(String).join(", ")
              : String(answer),
          )
          .filter(Boolean)
      : [];
    return {
      summary: answers.length ? "User answered" : "Question completed",
      preview: answers.length
        ? `Answer: ${answers.join("; ")}`
        : "No answer selected.",
    };
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, item]) =>
      isDisplayValue(item),
    );
    return {
      summary: `${presentation.name ?? "Tool"} completed`,
      preview:
        entries
          .slice(0, 8)
          .map(([key, item]) => `${humanKey(key)}: ${formatValue(item)}`)
          .join("\n") || "Structured result available.",
    };
  }
  if (Array.isArray(value)) {
    return {
      summary: `${value.length} result item${value.length === 1 ? "" : "s"}`,
      preview: value.slice(0, 8).map(formatValue).join("\n") || "No results.",
    };
  }
  return { summary: plainSummary(result), preview: String(value) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDisplayValue(value: unknown) {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) &&
      value.length <= 4 &&
      value.every((item) => typeof item !== "object"))
  );
}

function formatChange(change: Record<string, unknown>) {
  const kind = stringValue(change.kind) ?? "changed";
  const path = stringValue(change.path) ?? "unknown path";
  const oldPath = stringValue(change.oldPath);
  const content = stringValue(change.content);
  const label =
    kind === "rename" && oldPath
      ? `Renamed ${oldPath} -> ${path}`
      : `${changeVerb(kind)} ${path}`;
  return [label, content ? `  ${truncateLine(content, 160)}` : undefined]
    .filter(Boolean)
    .join("\n");
}

function changeVerb(kind: string) {
  if (kind === "modify") return "Modified";
  if (kind === "add") return "Added";
  if (kind === "delete") return "Deleted";
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

function formatValue(value: unknown) {
  if (Array.isArray(value)) return value.map(String).join(", ");
  return String(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function humanKey(key: string) {
  return key.replace(/([a-z])([A-Z])/gu, "$1 $2");
}

function truncateLine(value: string, max: number) {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max).join("")}...` : value;
}

function plainSummary(result: string) {
  const lines = result.split("\n");
  const chars = Array.from(result);
  return `${lines.length} line${lines.length === 1 ? "" : "s"}, ${chars.length} chars`;
}

export function elapsedLabel(
  startedAt?: number,
  endedAt?: number,
  now = Date.now(),
) {
  if (!startedAt) return "";
  const elapsed = Math.max(0, (endedAt ?? now) - startedAt);
  if (elapsed < 1000) return `${elapsed}ms`;
  return `${(elapsed / 1000).toFixed(elapsed < 10_000 ? 1 : 0)}s`;
}

export function collapseToolOutput(
  output: string,
  maxLines: number,
  maxChars: number,
) {
  const lines = output.split("\n");
  if (lines.length <= maxLines && Array.from(output).length <= maxChars)
    return { output, overflow: false };

  const preview = lines.slice(0, maxLines).join("\n");
  if (Array.from(preview).length > maxChars)
    return {
      output:
        Array.from(preview)
          .slice(0, Math.max(0, maxChars - 1))
          .join("") + "…",
      overflow: true,
    };
  return {
    output: [...lines.slice(0, maxLines), "…"].join("\n"),
    overflow: true,
  };
}

export function providerSafeThinkingSummary(
  reasoningVisible: boolean,
  text: string,
) {
  if (reasoningVisible) return text;
  if (!text.trim())
    return "Thinking received; details hidden by provider policy.";
  return "Thinking details hidden by provider policy.";
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKey.test(key) ? "[REDACTED]" : redactValue(item),
    ]),
  );
}

function keyArguments(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(
      ([_, item]) =>
        item !== undefined && item !== null && typeof item !== "object",
    )
    .slice(0, 4)
    .map(([key, item]) => `${key}=${String(item).slice(0, 80)}`);
}
