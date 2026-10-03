import { describe, expect, test } from "bun:test";
import {
  foldShellMarkers,
  initialCommandState,
  parseShellMarkers,
} from "../src/shell-integration";

/**
 * The escape sequences as real bytes.
 *
 * These are written as `\u001b` rather than `"\\x1b"`, which matters: the latter
 * is the four characters backslash-x-1-b and matches nothing. A test that
 * "passes" against the literal spelling is testing a terminal that does not
 * exist.
 */
const ESC = "\u001b";
const BEL = "\u0007";
const ST = `${ESC}\\`;

/** OSC 133 lifecycle markers, in both terminator spellings. */
const promptStart = `${ESC}]133;A${BEL}`;
const commandStart = `${ESC}]133;B${BEL}`;
const commandExecuted = `${ESC}]133;C${BEL}`;
const commandFinished = `${ESC}]133;D${BEL}`;
const commandExit7 = `${ESC}]133;D;7${BEL}`;
const promptStartST = `${ESC}]133;A${ST}`;
const finishedST = `${ESC}]133;D;3${ST}`;
const commandLine = `${ESC}]633;E;ls -la${BEL}`;
const commandLineWithNonce = `${ESC}]633;E;echo hi;nonce-123${BEL}`;

describe("parseShellMarkers", () => {
  test("reads each lifecycle marker with a BEL terminator", () => {
    expect(parseShellMarkers(promptStart)).toEqual([{ kind: "prompt-start" }]);
    expect(parseShellMarkers(commandStart)).toEqual([
      { kind: "command-start" },
    ]);
    expect(parseShellMarkers(commandExecuted)).toEqual([
      { kind: "command-executed" },
    ]);
    expect(parseShellMarkers(commandFinished)).toEqual([
      { kind: "command-finished", exitCode: undefined },
    ]);
    expect(parseShellMarkers(commandExit7)).toEqual([
      { kind: "command-finished", exitCode: 7 },
    ]);
  });

  test("reads the same markers with an ST terminator", () => {
    expect(parseShellMarkers(promptStartST)).toEqual([
      { kind: "prompt-start" },
    ]);
    expect(parseShellMarkers(finishedST)).toEqual([
      { kind: "command-finished", exitCode: 3 },
    ]);
  });

  test("reads the command line, and a semicolon stays in the command", () => {
    expect(parseShellMarkers(commandLine)).toEqual([
      { kind: "command-line", command: "ls -la" },
    ]);
    // The sequence's optional third field is a nonce we do not generate. Splitting
    // on it would need to know its shape, and guessing would corrupt
    // `echo a; echo b` into `echo a` plus "nonce b". A stray foreign nonce is
    // carried in the command line instead — the failure that cannot mislead.
    expect(parseShellMarkers(commandLineWithNonce)).toEqual([
      { kind: "command-line", command: "echo hi;nonce-123" },
    ]);
    expect(parseShellMarkers(`${ESC}]633;E;echo a; echo b${BEL}`)).toEqual([
      { kind: "command-line", command: "echo a; echo b" },
    ]);
  });

  test("preserves stream order across the two marker families", () => {
    // The order is the semantics: the command line precedes the C that starts its
    // output, and a caller folds these in sequence. Collecting each family
    // separately and concatenating would put every command-line marker after
    // every lifecycle marker, which this test kills — mutate parseShellMarkers
    // back to two passes and it goes red.
    const text =
      `${commandStart}${commandLine}${commandExecuted}` +
      `output${commandExit7}${promptStart}` +
      `${commandStart}${ESC}]633;E;second one${BEL}${commandExecuted}`;
    expect(parseShellMarkers(text).map((m) => m.kind)).toEqual([
      "command-start",
      "command-line",
      "command-executed",
      "command-finished",
      "prompt-start",
      "command-start",
      "command-line",
      "command-executed",
    ]);
    // And the pairing survives: the second command line is the second command's.
    const lines = parseShellMarkers(text).filter(
      (m): m is { kind: "command-line"; command: string } =>
        m.kind === "command-line",
    );
    expect(lines.map((m) => m.command)).toEqual(["ls -la", "second one"]);
  });

  test("finds markers inside ordinary output without disturbing it", () => {
    const text = `building... ${promptStart}\r\n$ ${commandLine}${commandExecuted}done${commandExit7}\r\n`;
    expect(parseShellMarkers(text)).toEqual([
      { kind: "prompt-start" },
      { kind: "command-line", command: "ls -la" },
      { kind: "command-executed" },
      { kind: "command-finished", exitCode: 7 },
    ]);
  });

  test("reads a truncated stream without producing a marker", () => {
    // A chunk that ends mid-sequence must not half-match; the next chunk carries
    // the rest. Callers split wherever the pty delivers.
    const text = `${promptStart}output${ESC}]133;`;
    expect(parseShellMarkers(text)).toEqual([{ kind: "prompt-start" }]);
  });

  test("returns nothing for output with no markers", () => {
    expect(parseShellMarkers("plain text\r\n$ \r\n")).toEqual([]);
    // A bare OSC that is not a shell-integration sequence (a window title).
    expect(parseShellMarkers(`${ESC}]0;my title${BEL}`)).toEqual([]);
  });
});

describe("parseShellMarkers: OSC 7, the working directory", () => {
  /** OSC 7: `ESC ] 7 ; file://host/path TERMINATOR`. */
  const osc7 = (path: string, host = "localhost", terminator = BEL) =>
    `${ESC}]7;file://${host}${path}${terminator}`;

  test("reads the pane's cwd and drops the host part", () => {
    expect(parseShellMarkers(osc7("/tmp/work"))).toEqual([
      { kind: "cwd", cwd: "/tmp/work" },
    ]);
    // The host is this machine's own name and means nothing to the reader.
    expect(parseShellMarkers(osc7("/tmp", "Zephyrus-M16"))).toEqual([
      { kind: "cwd", cwd: "/tmp" },
    ]);
  });

  test("percent-decodes the path, which is where the spaces live", () => {
    expect(parseShellMarkers(osc7("/tmp/my%20dir"))).toEqual([
      { kind: "cwd", cwd: "/tmp/my dir" },
    ]);
    // `%` itself is encoded as %25 by the emitter; decoding restores it.
    expect(parseShellMarkers(osc7("/tmp/100%25"))).toEqual([
      { kind: "cwd", cwd: "/tmp/100%" },
    ]);
  });

  test("reads the ST terminator spelling too", () => {
    expect(parseShellMarkers(osc7("/tmp", "localhost", ST))).toEqual([
      { kind: "cwd", cwd: "/tmp" },
    ]);
  });

  test("a malformed escape keeps the raw form rather than losing the cwd", () => {
    // A lone `%` is a producer bug; the directory is still worth reporting.
    expect(parseShellMarkers(osc7("/tmp/100%"))).toEqual([
      { kind: "cwd", cwd: "/tmp/100%" },
    ]);
    expect(parseShellMarkers(osc7("/tmp/%zz"))).toEqual([
      { kind: "cwd", cwd: "/tmp/%zz" },
    ]);
  });

  test("keeps stream order against the lifecycle markers", () => {
    // A real prompt emits the cwd beside the lifecycle: the directory is read
    // from the same pass, in the order the shell produced them.
    const text = `${osc7("/tmp/work")}${promptStart}${commandStart}`;
    expect(parseShellMarkers(text)).toEqual([
      { kind: "cwd", cwd: "/tmp/work" },
      { kind: "prompt-start" },
      { kind: "command-start" },
    ]);
  });

  test("an empty host (the local form) still reads", () => {
    expect(parseShellMarkers(`${ESC}]7;file:///tmp${BEL}`)).toEqual([
      { kind: "cwd", cwd: "/tmp" },
    ]);
  });
});

describe("foldShellMarkers", () => {
  test("starts at a prompt", () => {
    expect(initialCommandState()).toEqual({ atPrompt: true });
  });

  test("a command's lifecycle moves atPrompt off and on again", () => {
    let state = initialCommandState();
    state = foldShellMarkers(state, parseShellMarkers(commandStart), 2);
    expect(state.atPrompt).toBe(false);
    state = foldShellMarkers(state, parseShellMarkers(commandExecuted), 3);
    expect(state.atPrompt).toBe(false);
    state = foldShellMarkers(state, parseShellMarkers(commandExit7), 4);
    expect(state.atPrompt).toBe(true);
    expect(state.exitCode).toBe(7);
  });

  test("exitCode records the last finished command and survives the next prompt", () => {
    let state = initialCommandState();
    state = foldShellMarkers(state, parseShellMarkers(commandExit7), 1);
    state = foldShellMarkers(state, parseShellMarkers(promptStart), 2);
    expect(state.atPrompt).toBe(true);
    expect(state.exitCode).toBe(7);
  });

  test("a D with no code means no command ran, and does not invent 0", () => {
    let state = initialCommandState();
    state = foldShellMarkers(state, parseShellMarkers(commandStart), 1);
    state = foldShellMarkers(state, parseShellMarkers(commandFinished), 2);
    // Absent, per the sequence's contract: an empty prompt or an interrupt.
    expect(state.exitCode).toBeUndefined();
  });

  test("outputFrom names the revision the screen had just produced", () => {
    let state = initialCommandState();
    state = foldShellMarkers(state, parseShellMarkers(commandStart), 5);
    expect(state.outputFrom).toBeUndefined();
    state = foldShellMarkers(state, parseShellMarkers(commandExecuted), 9);
    expect(state.outputFrom).toBe(9);
    state = foldShellMarkers(state, parseShellMarkers(commandExit7), 12);
    // Cleared at the end: the command is over, and a later prompt starts fresh.
    expect(state.outputFrom).toBeUndefined();
  });

  test("an interrupted command still leaves the stream at a prompt", () => {
    let state = initialCommandState();
    state = foldShellMarkers(state, parseShellMarkers(commandStart), 1);
    state = foldShellMarkers(state, parseShellMarkers(promptStart), 2);
    expect(state.atPrompt).toBe(true);
  });

  test("the whole stream, in order, folds into one record", () => {
    let state = initialCommandState();
    const stream = [
      promptStart,
      commandLine,
      commandStart,
      commandExecuted,
      commandExit7,
      promptStart,
    ];
    stream.forEach((chunk, index) => {
      state = foldShellMarkers(state, parseShellMarkers(chunk), index + 1);
    });
    expect(state).toEqual({
      commandLine: "ls -la",
      exitCode: 7,
      atPrompt: true,
      outputFrom: undefined,
    });
  });
});
