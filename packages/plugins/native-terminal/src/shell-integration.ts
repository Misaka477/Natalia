/**
 * Shell integration: the command-level read surface.
 *
 * The screen is the any-moment read: a model asking "where am I" gets the grid as
 * it is right now. That is necessary but not sufficient — for "what did that
 * command produce" the model would have to diff screenshots against a prompt it
 * recognises itself. So the terminal also carries the command-level view that
 * VSCode's shell integration provides: a structured record per command, with its
 * command line, exit code and output.
 *
 * THE TWO SURFACES COMPOSE RATHER THAN COMPETE. The command's output is not a
 * second capture of the bytes: it is a PROJECTION of the screen, delimited by the
 * markers. The screen remains the single source of truth for what a terminal
 * shows; the markers only say where one command ended and the next began. That is
 * what keeps the two from drifting — the alternative, maintaining a second buffer
 * for command output, is a second truth that can disagree with the first.
 *
 * WHY THE STANDARD SEQUENCES. This uses the FinalTerm-family OSC 133 markers
 * (`A` prompt start, `B` command start, `C` executed, `D` finished with exit
 * code), which is the interoperable spelling every modern terminal understands.
 * VSCode moved to its own 633 namespace for reliability against confused
 * applications; we use 133 for the lifecycle and additionally read 633's
 * command-line marker, because 133 has no way to carry the command text and
 * inventing a private sequence would be worse than reusing the one that exists.
 */

/** One marker, as it appeared in the stream. */
export type ShellMarker =
  | { kind: "prompt-start" }
  | { kind: "command-start" }
  | { kind: "command-executed" }
  | { kind: "command-finished"; exitCode?: number }
  | { kind: "command-line"; command: string }
  | { kind: "cwd"; cwd: string };

/** OSC 133/633 runs to BEL or ST (`ESC \`). */
const TERMINATORS = "(?:\\u0007|\\x1b\\\\)";

/**
 * Both marker families, in one ordered pass.
 *
 * One regex rather than two: the stream order IS the semantics (a command line
 * precedes the `C` that starts its output), and collecting each family separately
 * then concatenating reorders them. `matchAll` walks the stream left to right, so
 * a single alternation preserves it.
 *
 * Group 1 is the OSC 7 path, group 2 the lifecycle letter and group 3 its exit
 * code, group 4 the command line. Exactly one family is present per match, which
 * is what makes the dispatch below total.
 *
 * Group 4 takes everything after `E;` and does not split the sequence's optional
 * third field (a nonce). Our injector escapes `;` to `\x3b` before emitting, so a
 * sequence from it never carries a raw semicolon; the nonce is still not split
 * out, because we never generate one and a foreign script that emits one
 * unescaped could make a raw semicolon mean either a separator or part of the
 * command. Carrying it is the failure that cannot mislead.
 *
 * OSC 7 (`file://host/path`) is the cwd family: where the shell IS, not what it
 * ran. The host part is skipped — this repo reads one machine's panes — and the
 * path is captured WITH its leading slash: the first version consumed the `/`
 * and produced the RELATIVE form (`tmp` for `/tmp`), which silently made every
 * reported directory wrong. The path is kept percent-encoded until the marker is
 * built, since decoding is a place to get it wrong (a literal `%` in a directory
 * name) and the caller can decode with the same rules the encoder used.
 */
const MARKER_RE = new RegExp(
  `\\x1b\\](?:7;file://[^/\\u0007\\x1b]*(/[^\\u0007\\x1b]*)|133;([A-D])(?:;([^\\u0007\\x1b]*))?|633;E;([^\\u0007\\x1b]*))${TERMINATORS}`,
  "g",
);

/** Percent-decode an OSC 7 path; a malformed escape keeps its raw form. */
function decodeCwd(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    // A lone `%` or a truncated escape is a producer bug, not a reason to lose
    // the directory: the raw form is still more useful than nothing.
    return path;
  }
}

/**
 * Extract the markers from a chunk of terminal output, in stream order.
 *
 * This does not consume anything: the chunk is passed on to the screen unchanged,
 * and the markers are read out of it in the same pass the screen parses it. The
 * sequences are invisible on screen either way — the screen's own OSC handling
 * drops them — so reading them here costs nothing visually.
 */
export function parseShellMarkers(text: string): ShellMarker[] {
  const markers: ShellMarker[] = [];
  for (const match of text.matchAll(MARKER_RE)) {
    const cwd = match[1];
    const letter = match[2];
    const argument = match[3];
    const command = match[4];
    if (cwd !== undefined) {
      markers.push({ kind: "cwd", cwd: decodeCwd(cwd) });
      continue;
    }
    if (letter === undefined) {
      if (command !== undefined)
        markers.push({ kind: "command-line", command });
      continue;
    }
    switch (letter) {
      case "A":
        markers.push({ kind: "prompt-start" });
        break;
      case "B":
        markers.push({ kind: "command-start" });
        break;
      case "C":
        markers.push({ kind: "command-executed" });
        break;
      case "D":
        markers.push({
          kind: "command-finished",
          // Absent per the sequence's contract when no code is carried: no
          // command ran, an empty prompt or an interrupt. Never 0 by default.
          exitCode: argument ? Number(argument) : undefined,
        });
        break;
    }
  }
  return markers;
}

/**
 * The command the stream is currently in, and the last one it finished.
 *
 * `finish` is deliberately NOT the end of the record: the output lives on the
 * screen, and a caller that wants it reads the screen between this command's
 * `outputFrom` and its end. What this object carries is the metadata that the
 * screen cannot state about itself — which command, its exit code, and where its
 * output began.
 */
export type CommandState = {
  /** The last command line seen, with the markers that bracket it. */
  commandLine?: string;
  /** The exit code of the last FINISHED command; absent while one runs. */
  exitCode?: number;
  /** Whether the terminal is at a prompt right now. */
  atPrompt: boolean;
  /**
   * The screen revision when the current command's output began, for a caller
   * that wants the output slice. `undefined` between prompts.
   */
  outputFrom?: number;
};

/**
 * Fold markers into the command state.
 *
 * `revision` is the screen revision the caller has just produced, so `outputFrom`
 * names a revision rather than a byte offset — revisions survive the screen's
 * scrollback trimming, byte offsets do not.
 */
export function foldShellMarkers(
  state: CommandState,
  markers: readonly ShellMarker[],
  revision: number,
): CommandState {
  let next = state;
  for (const marker of markers) {
    switch (marker.kind) {
      case "prompt-start":
        next = { ...next, atPrompt: true };
        break;
      case "command-start":
        next = { ...next, atPrompt: false };
        break;
      case "command-line":
        next = { ...next, commandLine: marker.command };
        break;
      case "command-executed":
        // Output starts after the execution marker, at the revision the screen
        // reached having just consumed it.
        next = { ...next, atPrompt: false, outputFrom: revision };
        break;
      case "command-finished":
        next = {
          ...next,
          atPrompt: true,
          exitCode: marker.exitCode,
          outputFrom: undefined,
        };
        break;
    }
  }
  return next;
}

/** The initial state: at a prompt, nothing running. */
export function initialCommandState(): CommandState {
  return { atPrompt: true };
}
