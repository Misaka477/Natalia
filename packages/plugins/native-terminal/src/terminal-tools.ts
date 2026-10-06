/**
 * Tools that drive the one native terminal pane the model shares with the user.
 */
/**
 * Tools that drive the one native terminal pane the model shares with the user.
 *
 * There is a single pane on purpose: the model and the person are looking at the
 * same screen, so what the model types is visible and what the person typed is
 * part of the model's context. Reads are paged and bounded (`terminal-io.ts`)
 * because a terminal's scrollback is unbounded and a model that asks for "the
 * output" would otherwise receive a session's worth of it.
 */
import {
  numberOr,
  optionalInteger,
  optionalString,
  requireObject,
  requireString,
} from "@anthelia/tools";
import {
  encodeTerminalKey,
  interactiveTerminalToolAliases,
  nativeTerminalReadPage,
  nativeTerminalSearchPage,
} from "@anthelia/tools";
import { truncateProcessOutput } from "@anthelia/tools";
import type {
  RuntimeTool,
  TerminalSessionView,
  ToolExecutionContext,
  ToolFamily,
} from "@anthelia/tools";

export const TERMINAL_OBSERVE_MODES = [
  "full",
  "tail",
  "new_only",
  "cursor",
  "latest",
] as const;

function requireNativeTerminal(context: ToolExecutionContext) {
  if (!context.terminal)
    throw new Error(
      "Native Terminal Host is unavailable. Enable the PTY backend or install the Natalia WezTerm distribution to start an interactive terminal.",
    );
  return context.terminal;
}

function modelNativeTerminalInfo(session: TerminalSessionView) {
  return {
    id: session.id,
    host: session.host,
    paneID: session.paneID,
    windowID: session.windowID,
    muxWindowID: session.muxWindowID,
    tabID: session.tabID,
    command: session.command,
    cwd: session.cwd,
    status: session.status,
    startedAt: session.startedAt,
  };
}

function interactiveStartTool(): RuntimeTool {
  return {
    name: "interactive_terminal_start",
    description:
      "Start a real interactive Terminal session inside the workspace. On Windows the pane shell is Git Bash, not cmd.exe — use POSIX shell syntax.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        id: { type: "string" },
        // The grid to spawn at. Ask for a big one when the command is a
        // full-screen TUI: the default is already practical, but a TUI that
        // wants its own layout says so here instead of resizing afterwards.
        rows: { type: "number" },
        cols: { type: "number" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = requireObject(input);
      const registry = requireNativeTerminal(context);
      const session = await registry.start({
        command: requireString(args.command, "command"),
        cwd: context.workspaceRoot,
        id: optionalString(args.id),
        // I1/I3: the pane belongs to the turn's session. When that session is
        // not the attached one, the registry opens no window and steals no
        // focus — the human's Open terminal brings it up later.
        sessionID: context.parentSessionID,
        ...(context.parentAgentID ? { agentID: context.parentAgentID } : {}),
        ...(optionalInteger(args.rows, "rows") !== undefined
          ? { rows: optionalInteger(args.rows, "rows")! }
          : {}),
        ...(optionalInteger(args.cols, "cols") !== undefined
          ? { cols: optionalInteger(args.cols, "cols")! }
          : {}),
      });
      return JSON.stringify(modelNativeTerminalInfo(session), null, 2);
    },
  };
}

function interactiveReadTool(): RuntimeTool {
  return {
    name: "interactive_terminal_read",
    description:
      "Read a bounded window from the same native Terminal pane used by the human. Returns text plus cursor position. Use startLine/endLine to page through complete scrollback without copying it all at once, or startByte/endByte when a single line is too big to bound (a minified bundle cat-ed into the pane) or when the next window must start exactly where this one ended. The reply carries the served window and the document extent in BOTH families, so a caller can tell how much there is and address a successor from the current window's end instead of guessing; the extents are null on a backend that cannot report them.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        maxLines: { type: "number" },
        startLine: { type: "number" },
        endLine: { type: "number" },
        cursor: { type: "number" },
        // The byte window, for the two cases a line window cannot serve: one
        // huge line has no bound a line window can give it, and exact resume
        // wants no arithmetic between windows.
        startByte: { type: "number" },
        endByte: { type: "number" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = requireObject(input);
      const id = requireString(args.id, "id");
      const startLine = optionalInteger(args.startLine, "startLine");
      const cursor = optionalInteger(args.cursor, "cursor");
      const endLine = optionalInteger(args.endLine, "endLine");
      const startByte = optionalInteger(args.startByte, "startByte");
      const endByte = optionalInteger(args.endByte, "endByte");
      if (startLine !== undefined && cursor !== undefined)
        throw new Error("startLine and cursor cannot be used together");
      if (
        (startByte !== undefined || endByte !== undefined) &&
        (startLine !== undefined ||
          cursor !== undefined ||
          endLine !== undefined)
      )
        throw new Error(
          "the byte window and the line window cannot be used together",
        );
      const pageStartLine = startLine ?? cursor;
      const {
        text,
        cursorX,
        cursorY,
        rows,
        cols,
        startLine: servedStartLine,
        endLine: servedEndLine,
        totalLines,
        startByte: servedStartByte,
        endByte: servedEndByte,
        totalBytes: servedTotalBytes,
      } = await requireNativeTerminal(context).read(id, {
        maxLines: Math.max(1, Math.min(numberOr(args.maxLines, 60), 200)),
        startLine: pageStartLine,
        endLine,
        ...(startByte !== undefined ? { startByte } : {}),
        ...(endByte !== undefined ? { endByte } : {}),
        ...(context.parentSessionID
          ? { sessionID: context.parentSessionID }
          : {}),
      });
      const page = nativeTerminalReadPage(text, {
        startLine: pageStartLine,
        endLine,
      });
      return JSON.stringify(
        {
          id,
          cursorX,
          cursorY,
          rows,
          cols,
          range:
            pageStartLine === undefined
              ? {
                  kind: "tail",
                  maxLines: Math.max(
                    1,
                    Math.min(numberOr(args.maxLines, 60), 200),
                  ),
                }
              : {
                  kind: "lines",
                  startLine: pageStartLine,
                  endLine,
                },
          deliveredRange:
            pageStartLine === undefined
              ? { kind: "tail", deliveredLines: page.deliveredLines }
              : {
                  kind: "lines",
                  startLine: pageStartLine,
                  endLine: page.endLine,
                  deliveredLines: page.deliveredLines,
                },
          // The window the host actually served and the document's extent, from
          // the controller rather than recomputed from the delivered text: what
          // makes the walk navigable instead of guessed. `lineCount` and not a
          // second `endLine` — the controller's end is one past the last line
          // served while this tool's `endLine` parameter is inclusive, and two
          // meanings under one name in one payload is how a walker gets lost.
          // Null is the honest unknown on a backend whose host reports no
          // extent; it says "cannot page" where zeros would say "one line".
          window:
            servedStartLine === null || servedEndLine === null
              ? null
              : {
                  startLine: servedStartLine,
                  // Zero when the window sits past the document's end: the
                  // controller reports the requested start and the document's
                  // extent there, so a bare difference would be negative — the
                  // served window is empty, and empty is what it says.
                  lineCount: Math.max(0, servedEndLine - servedStartLine),
                },
          totalLines,
          nextCursor: page.nextStartLine
            ? {
                startLine: page.nextStartLine,
                ...(endLine === undefined ? {} : { endLine }),
              }
            : undefined,
          // The byte window, same job: the successor of a byte read starts at
          // the end this one reports, with no arithmetic between them. Null
          // when the host reports no byte extent (or nothing was served).
          byteWindow:
            servedStartByte === null || servedEndByte === null
              ? null
              : {
                  startByte: servedStartByte,
                  byteCount: Math.max(0, servedEndByte - servedStartByte),
                },
          totalBytes: servedTotalBytes ?? page.totalBytes,
          nextCursorBytes:
            servedEndByte !== null &&
            servedTotalBytes !== null &&
            servedEndByte < servedTotalBytes
              ? { startByte: servedEndByte }
              : undefined,
          text: page.text,
          truncated: page.truncated,
          rangeDiscovery: "native_scrollback_unbounded",
        },
        null,
        2,
      );
    },
  };
}

function interactiveSearchTool(): RuntimeTool {
  return {
    name: "interactive_terminal_search",
    description:
      "Search a bounded native Terminal scrollback line range for literal UTF-8 text. Continue with nextCursor; it never transports the full terminal screen.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        query: { type: "string" },
        // One of startLine / cursor is required in practice (the schema
        // vocabulary here cannot say "either", so the descriptions and the
        // refusal carry it): T-08 — a search with neither used to be
        // declared-optional and then failed with no guidance.
        startLine: {
          type: "number",
          description:
            "First retained scrollback line to search (1 = the pane's first retained line). Required when cursor is absent.",
        },
        endLine: {
          type: "number",
          description:
            "Last line to search (at most 199 lines past the start). Omit for the default page.",
        },
        cursor: {
          type: "number",
          description:
            "The nextCursor from a previous search's result. Required when startLine is absent.",
        },
        maxMatches: {
          type: "number",
          description: "Maximum matches to return (1-20, default 20).",
        },
      },
      required: ["id", "query"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = requireObject(input);
      const id = requireString(args.id, "id");
      const query = requireString(args.query, "query");
      if (!query) throw new Error("query must not be empty");
      if (new TextEncoder().encode(query).byteLength > 256)
        throw new Error("query must be at most 256 UTF-8 bytes");
      const startLine = optionalInteger(args.startLine, "startLine");
      const cursor = optionalInteger(args.cursor, "cursor");
      const endLine = optionalInteger(args.endLine, "endLine");
      if (startLine !== undefined && cursor !== undefined)
        throw new Error("startLine and cursor cannot be used together");
      const pageStartLine = startLine ?? cursor;
      if (pageStartLine === undefined)
        throw new Error(
          "scrollback search needs a starting point: pass startLine " +
            "(1 = the pane's first retained line) or the cursor from a " +
            "previous search's result",
        );
      if (endLine !== undefined && endLine < pageStartLine)
        throw new Error("endLine must not be before startLine");
      const pageEndLine = Math.min(
        endLine ?? pageStartLine + 199,
        pageStartLine + 199,
      );
      const { text } = await requireNativeTerminal(context).read(id, {
        startLine: pageStartLine,
        endLine: pageEndLine,
      });
      const result = nativeTerminalSearchPage(text, {
        query,
        startLine: pageStartLine,
        endLine: pageEndLine,
        requestedEndLine: endLine,
        maxMatches: Math.max(1, Math.min(numberOr(args.maxMatches, 20), 20)),
      });
      return JSON.stringify({ id, ...result }, null, 2);
    },
  };
}

/**
 * The command-level read, as a tool.
 *
 * It exists alongside `interactive_terminal_read` rather than replacing it: that
 * one answers WHAT IS ON SCREEN NOW, this one answers WHAT A COMMAND PRODUCED. The
 * description says so, because a model handed both needs to know which to reach
 * for and the difference is not obvious from either name.
 *
 * The output it returns is a slice of the same screen the read tool pages, not a
 * second capture — so the two cannot disagree about what a pane showed.
 */
function terminalLastCommandTool(): RuntimeTool {
  return {
    name: "interactive_terminal_last_command",
    description:
      "The last command a native Terminal pane ran, with its exit code and its output. Use this when the question is WHAT A COMMAND PRODUCED. Use interactive_terminal_read when the question is WHAT IS ON SCREEN NOW — this tool answers per command, that one answers per moment, and the command's output is a slice of the same screen. A pane whose shell emits no command markers reports an unknown command rather than guessing one.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = requireObject(input);
      const id = requireString(args.id, "id");
      const terminal = requireNativeTerminal(context);
      const read = terminal.lastCommand;
      // A backend that cannot read a command lifecycle — the mux facade drives a
      // pane in another process — leaves the member off. Absence is the honest
      // answer, and a named alternative is more use than a fabricated record.
      if (!read)
        throw new Error(
          "this terminal backend cannot report commands; use interactive_terminal_read",
        );
      const command = read.call(terminal, id, {
        ...(context.parentSessionID
          ? { sessionID: context.parentSessionID }
          : {}),
      });
      // Same shape every other terminal tool returns: text a model reads, not a
      // structure it has to introspect.
      //
      // A pane that has run NO command yet has no commandLine: the answer says
      // so and names the per-moment read, instead of a record whose command
      // field is simply absent — a model reading that cannot tell "no command
      // ran" from "the backend forgot" (T-07).
      if (command.commandLine === undefined)
        return JSON.stringify(
          {
            id,
            commandLine: null,
            atPrompt: command.atPrompt,
            revision: command.revision,
            note: "no command has run in this pane yet; use interactive_terminal_read for what is on screen now",
          },
          null,
          2,
        );
      return JSON.stringify(
        {
          id,
          commandLine: command.commandLine,
          exitCode: command.exitCode,
          atPrompt: command.atPrompt,
          ...(command.output === undefined ? {} : { output: command.output }),
          revision: command.revision,
        },
        null,
        2,
      );
    },
  };
}

function terminalObserveTool(): RuntimeTool {
  return {
    name: "terminal_observe",
    description:
      "Wait for a terminal screen revision or process exit, then return the current styled framebuffer. Timeout is a normal observation result. afterRevision is optional; omit it to get current state. Use mode='latest' for current state without waiting; mode='tail' for recent lines; mode='new_only' for only new output since last observation; mode='cursor' for lines around the cursor.",
    requiresApproval: false,
    timeoutSec: 35,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        afterRevision: { type: "number" },
        timeoutMs: { type: "number" },
        scrollbackRows: { type: "number" },
        mode: {
          type: "string",
          enum: [...TERMINAL_OBSERVE_MODES],
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = requireObject(input);
      const id = requireString(args.id, "id");
      const mode = args.mode || "full";
      // The default is the session's LAST-OBSERVED revision, not 0: an
      // omitted afterRevision now means "what changed since I last looked"
      // (a bounded wait), not "give me everything right now". The
      // current-state escape hatch is mode='latest'. This is the
      // screenshot's lesson: with 0 the tool returned instantly with a
      // full frame every poll, and the model's only strategy was to spin.
      const nativeTerminal = requireNativeTerminal(context);
      const afterRevision =
        args.afterRevision === undefined
          ? (nativeTerminal.lastObservedRevision(id) ?? 0)
          : numberOr(args.afterRevision, 0);
      if (mode === "latest") {
        const snapshot = await requireNativeTerminal(context).snapshot(id);
        return JSON.stringify({
          id,
          host: "pty",
          revision: snapshot.revision,
          currentRevision: snapshot.revision,
          afterRevision,
          changed: snapshot.revision > afterRevision,
          // This mode reads the screen as it is and never waits, so it cannot
          // report a wait outcome. Saying "timeout" claimed the deadline passed
          // with no output, which reads as a stale frame even though the screen
          // was just reconciled, and "changed" was not one of the outcomes the
          // waiting modes report either.
          reason: "latest",
          cursorX: snapshot.cursorX,
          cursorY: snapshot.cursorY,
          rows: snapshot.rows,
          cols: snapshot.cols,
          mode,
          text: truncateProcessOutput(snapshot.text, 16_384),
        });
      }
      await nativeTerminal.reconcile();
      const observation = await nativeTerminal.observe(id, afterRevision, {
        maxLines: Math.max(1, Math.min(numberOr(args.scrollbackRows, 60), 200)),
        timeoutMs: Math.max(
          1_000,
          Math.min(numberOr(args.timeoutMs, 5_000), 30_000),
        ),
      });
      let text = observation.text;
      const session = nativeTerminal.session(id);
      const previousText = session?.lastObservedText;
      if (mode === "tail") {
        const lines = text.split("\n");
        if (lines.at(-1) === "") lines.pop();
        const tailLines = Math.max(
          1,
          Math.min(numberOr(args.scrollbackRows, 60), 200),
        );
        text = lines.slice(-tailLines).join("\n");
      } else if (mode === "cursor") {
        const lines = text.split("\n");
        if (lines.at(-1) === "") lines.pop();
        const cursorY = observation.cursorY ?? 0;
        const contextLines = 10;
        const startLine = Math.max(0, cursorY - contextLines);
        const endLine = Math.min(lines.length, cursorY + contextLines + 1);
        text = lines.slice(startLine, endLine).join("\n");
      } else if (mode === "new_only") {
        if (previousText && text.startsWith(previousText)) {
          text = text.slice(previousText.length);
        }
      }
      nativeTerminal.markObserved(
        id,
        observation.text,
        observation.session.revision,
      );
      return JSON.stringify(
        {
          id,
          host: "pty",
          revision: observation.session.revision,
          currentRevision: observation.session.revision,
          afterRevision: observation.afterRevision,
          changed: observation.changed,
          reason: observation.reason,
          cursorX: observation.cursorX,
          cursorY: observation.cursorY,
          rows: observation.rows,
          cols: observation.cols,
          mode,
          text: truncateProcessOutput(text, 16_384),
        },
        null,
        2,
      );
    },
  };
}

function interactiveWriteTool(): RuntimeTool {
  return {
    name: "interactive_terminal_write",
    description:
      "Write literal input to the native terminal pane without appending a newline. Prefer interactive_terminal_input with submit=false for new code.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        input: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      required: ["id", "input"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = requireObject(input);
      const id = requireString(args.id, "id");
      const data = requireString(args.input, "input");
      const result = await requireNativeTerminal(context).write(id, data, {
        idempotencyKey: optionalString(args.idempotencyKey),
        ...(context.parentSessionID
          ? { sessionID: context.parentSessionID }
          : {}),
      });
      return JSON.stringify({
        id,
        ...result,
      });
    },
  };
}

function interactiveSendLineTool(): RuntimeTool {
  return {
    name: "interactive_terminal_send_line",
    description:
      "Atomically write text and submit it with Enter to the native terminal pane. Prefer interactive_terminal_input with default submit=true for new code.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        text: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      required: ["id", "text"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = requireObject(input);
      const id = requireString(args.id, "id");
      const text = requireString(args.text, "text");
      const result = await requireNativeTerminal(context).write(
        id,
        `${text}\r`,
        {
          idempotencyKey: optionalString(args.idempotencyKey),
          ...(context.parentSessionID
            ? { sessionID: context.parentSessionID }
            : {}),
        },
      );
      return JSON.stringify({ id, ...result, submitted: true });
    },
  };
}

function interactiveKeyTool(): RuntimeTool {
  return {
    name: "interactive_terminal_keys",
    description:
      "Send normalized key sequences to the native terminal pane. Prefer interactive_terminal_input with the keys array for new code.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        key: { type: "string" },
        keys: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              text: { type: "string" },
              modifiers: { type: "array", items: { type: "string" } },
              repeat: { type: "number" },
            },
            additionalProperties: false,
          },
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = requireObject(input);
      const id = requireString(args.id, "id");
      const sequence = Array.isArray(args.keys)
        ? args.keys.map((item) => requireObject(item))
        : [requireObject({ key: requireString(args.key, "key") })];
      if (!sequence.length) throw new Error("keys must not be empty");
      const bytes = sequence.map(encodeTerminalKey).join("");
      const result = await requireNativeTerminal(context).write(id, bytes, {
        ...(context.parentSessionID
          ? { sessionID: context.parentSessionID }
          : {}),
      });
      return JSON.stringify({ id, keys: sequence, ...result });
    },
  };
}

function interactiveInputTool(): RuntimeTool {
  return {
    name: "interactive_terminal_input",
    description:
      "Unified input for the native terminal pane. Prefer this over interactive_terminal_write, interactive_terminal_send_line, and interactive_terminal_keys. Use `text` alone for a shell command: text='ls -la' sends it and presses Enter (submit=true by default; submit=false suppresses it). Use `keys` when order matters: it is an ordered sequence sent one entry at a time, where each entry is either a key ({key:'Escape'}) or literal text ({text:'hello'}). Entering insert mode and typing is keys=[{key:'i'},{text:'hello'},{key:'Escape'}]; saving is keys=[{key:'Escape'},{text:':wq'},{key:'Enter'}]. Add Enter explicitly as {key:'Enter'} inside a sequence. Do not pass `text` and `keys` in the same call, because their relative order is not expressible that way; put the text inside the sequence instead. Use paste=true with `text` for large blocks in editors like vim (wraps it in bracketed paste escape sequences).",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        text: { type: "string" },
        keys: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              text: { type: "string" },
              modifiers: { type: "array", items: { type: "string" } },
              repeat: { type: "number" },
            },
            additionalProperties: false,
          },
        },
        submit: { type: "boolean" },
        paste: { type: "boolean" },
        idempotencyKey: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = requireObject(input);
      const id = requireString(args.id, "id");
      if (args.text === undefined && !Array.isArray(args.keys))
        throw new Error("either text or keys is required");
      // Two parallel fields cannot express interleaving, so the old behaviour
      // silently sent all text before all keys. In an editor that reverses the
      // intent: text meant for insert mode arrives while still in normal mode.
      // Ordering is expressible inside `keys`, so ask for it there.
      if (args.text !== undefined && Array.isArray(args.keys))
        throw new Error(
          "text and keys cannot be combined because their order is ambiguous; put the text inside the keys sequence instead, for example keys=[{key:'i'},{text:'hello'},{key:'Escape'}]",
        );
      let bytes = "";
      let pasted = false;
      if (args.text !== undefined) {
        const text = requireString(args.text, "text");
        if (args.paste && text) {
          bytes = `\x1b[?2004h${text}\x1b[?2004l`;
          pasted = true;
        } else {
          bytes = text;
        }
      }
      if (Array.isArray(args.keys))
        bytes += args.keys
          .map((item) => encodeTerminalKey(requireObject(item)))
          .join("");
      if (!pasted && args.text !== undefined && args.submit !== false)
        bytes += "\r";
      if (!bytes) throw new Error("input must not be empty");
      const result = await requireNativeTerminal(context).write(id, bytes, {
        idempotencyKey: optionalString(args.idempotencyKey),
        ...(context.parentSessionID
          ? { sessionID: context.parentSessionID }
          : {}),
      });
      return JSON.stringify({
        id,
        ...result,
        submitted: args.submit !== false && !pasted,
      });
    },
  };
}

function interactiveSnapshotTool(): RuntimeTool {
  return {
    name: "interactive_terminal_snapshot",
    description:
      "Return the current terminal screen text with cursor position and revision. Use this to check where you are without specifying afterRevision.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { screen: { type: "string" } },
        required: ["screen"],
        additionalProperties: false,
      },
      presentCall(args) {
        return {
          kind: "terminal",
          title: String(requireObject(args).id ?? ""),
          summary: "snapshot",
        };
      },
      presentResult(args, value) {
        return {
          kind: "terminal",
          title: String(requireObject(args).id ?? ""),
          summary: "screen",
          body: value,
        };
      },
    },
    async execute(input, context) {
      const args = requireObject(input);
      const id = requireString(args.id, "id");
      const snapshot = await requireNativeTerminal(context).snapshot(id);
      return JSON.stringify({
        id,
        host: "pty",
        ...snapshot,
      });
    },
  };
}

function interactiveResizeTool(): RuntimeTool {
  return {
    name: "interactive_terminal_resize",
    description: "Resize an interactive Terminal session.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        rows: { type: "number" },
        cols: { type: "number" },
      },
      required: ["id", "rows", "cols"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = requireObject(input);
      const id = requireString(args.id, "id");
      const rows = numberOr(args.rows, 36);
      const cols = numberOr(args.cols, 120);
      return JSON.stringify(
        modelNativeTerminalInfo(
          await requireNativeTerminal(context).resize(
            id,
            rows,
            cols,
            "model",
            context.parentSessionID,
          ),
        ),
        null,
        2,
      );
    },
  };
}

function interactiveRequestHumanTool(): RuntimeTool {
  return {
    name: "interactive_terminal_request_human",
    description:
      'Ask a human to take over the given native Terminal pane: call this when the pane is asking for something the model cannot and must not supply — a password, a secret, a yes/no judgment, an editor session. The reason must be 240 characters or fewer and state only the kind of input needed (e.g. "needs the sudo password"); never repeat screen content, file content, or anything that looks like a secret. With endTurn=false (default) the call returns immediately and you continue with other work, checking back with interactive_terminal_observe. With endTurn=true the current turn ends with a waiting_human result and the runtime automatically starts a new turn once the human finishes and releases the pane — say that you are waiting and do nothing else after the call.',
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        reason: { type: "string", maxLength: 240 },
        endTurn: { type: "boolean" },
      },
      required: ["id", "reason"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = requireObject(input);
      const id = requireString(args.id, "id");
      const reason = requireString(args.reason, "reason");
      const session = await requireNativeTerminal(context).requestHuman(
        id,
        reason,
        context.parentSessionID,
      );
      return JSON.stringify(
        {
          ...modelNativeTerminalInfo(session),
          humanRequested: true,
          reason,
          endTurn: args.endTurn === true,
        },
        null,
        2,
      );
    },
  };
}

function interactiveStopTool(): RuntimeTool {
  return {
    name: "interactive_terminal_stop",
    description: "Stop the native Terminal pane.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const session = await requireNativeTerminal(context).stop(
        requireString(requireObject(input).id, "id"),
        "model",
      );
      return JSON.stringify({
        ...modelNativeTerminalInfo(session),
        status: "exited",
      });
    },
  };
}

function interactiveListTool(): RuntimeTool {
  return {
    name: "interactive_terminal_list",
    description: "List real interactive Terminal sessions.",
    requiresApproval: false,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_input, context) {
      return JSON.stringify(
        (await requireNativeTerminal(context).list()).map(
          modelNativeTerminalInfo,
        ),
        null,
        2,
      );
    },
  };
}

/** Every interactive terminal tool, including the observe entry point. */
export function terminalTools(): RuntimeTool[] {
  return [
    interactiveStartTool(),
    terminalObserveTool(),
    interactiveReadTool(),
    // Sits next to the read tool on purpose: the pair is what makes the two
    // surfaces discoverable, rather than one of them only being reachable by a
    // model that already knew to ask.
    terminalLastCommandTool(),
    interactiveSearchTool(),
    interactiveWriteTool(),
    interactiveSendLineTool(),
    interactiveKeyTool(),
    interactiveInputTool(),
    interactiveSnapshotTool(),
    interactiveResizeTool(),
    interactiveRequestHumanTool(),
    interactiveStopTool(),
    interactiveListTool(),
  ];
}

/**
 * Session scope: the pane is shared with the user and only exists while the
 * session is alive.
 */
export function terminalToolFamily(): ToolFamily {
  return {
    id: "terminal",
    name: "Terminal Tools",
    version: "1.0.0",
    description: "Native terminal panes and interactive programs.",
    scope: "session",
    tools: [...terminalTools()],
    aliases: { ...interactiveTerminalToolAliases },
  };
}
