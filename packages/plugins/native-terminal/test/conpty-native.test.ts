import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The ConPTY bridge on REAL Windows — and specifically its INPUT path.
 *
 * The Linux-side sibling (conpty-bridge-wine.test.ts) compiles the bridge with
 * mingw and runs it under wine, and it measured why it stops there: wine's
 * ConPTY implements the output side but its input side is unreliable (typed
 * input advanced the prompt once and not again, and never echoed, across
 * 15s waits). So the handshake, the output frames and the exit frame are
 * verified on Linux, and the input and kill paths were verified NOWHERE —
 * which is exactly where issue #2 (P23, the mute pane: input side broken)
 * lived, undetected by any test in this repo.
 *
 * This file is that gap closed. It runs only on Windows (it starts the real
 * bridge.exe against the real ConPTY), and it asserts the three things wine
 * could not: a typed line reaches the child, the child's response comes back,
 * and the kill control produces the exit frame.
 *
 * The bridge binary is the one `native-terminal:build-conpty:windows` writes
 * into prebuilt/windows-x64/ — the CI job builds it first, and a developer
 * without it gets a skip rather than a failure that says nothing.
 */
const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
const bridgeExe = join(
  repoRoot,
  "packages",
  "plugins",
  "native-terminal",
  "prebuilt",
  "windows-x64",
  "natalia-conpty-bridge.exe",
);
const canRun = process.platform === "win32" && existsSync(bridgeExe);

/** The frames the protocol defines: `{kind} {len}\n` then exactly len bytes.
 *  The pid handshake is a bare JSON line, not a frame — it is recorded as
 *  kind `pid` so the two shapes live in one list. */
type Frame = { kind: string; payload: string };

async function drive(
  spec: Record<string, unknown>,
  script: (
    send: (message: Record<string, unknown>) => Promise<void>,
  ) => Promise<void>,
  until: (frames: Frame[]) => boolean,
  ms = 30_000,
): Promise<{ frames: Frame[]; text: string; exit: Frame | undefined }> {
  const bridge = Bun.spawn([bridgeExe], {
    cwd: await mkdtemp(join(tmpdir(), "conpty-native-")),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  // COMPACT JSON, always: the bridge's parser looks for `"key":"value"` and a
  // space after the colon makes it miss the field. Default json.dumps emits
  // the spaced form.
  const send = async (message: Record<string, unknown>) => {
    bridge.stdin.write(`${JSON.stringify(message)}\n`);
    await bridge.stdin.flush();
  };
  await send(spec);
  void script(send);
  const frames: Frame[] = [];
  const deadline = Date.now() + ms;
  const reader = bridge.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (Date.now() < deadline && !until(frames)) {
    const read = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined }>((resolve) =>
        setTimeout(() => resolve({ value: undefined }), 500),
      ),
    ]);
    if (!read.value) continue;
    buffer += decoder.decode(read.value, { stream: true });
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("{")) {
        // The handshake.
        frames.push({ kind: "pid", payload: line });
        continue;
      }
      const space = line.indexOf(" ");
      if (space < 0) continue;
      const length = Number(line.slice(space + 1));
      if (!Number.isFinite(length)) continue;
      // The payload may not have arrived yet: wait for the next read.
      if (buffer.length < length) break;
      frames.push({
        kind: line.slice(0, space),
        payload: buffer.slice(0, length),
      });
      buffer = buffer.slice(length);
    }
  }
  reader.cancel();
  bridge.kill();
  const text = frames.map((frame) => frame.payload).join("");
  return { frames, text, exit: frames.find((frame) => frame.kind === "x") };
}

const count = (frames: Frame[], needle: string) =>
  frames
    .filter((f) => f.kind === "o")
    .join("")
    .split(needle).length - 1;

test.skipIf(!canRun)(
  "the real bridge answers a spec with pid, output and exit",
  async () => {
    const { frames, text, exit } = await drive(
      {
        file: "cmd.exe",
        args: ["/c", "echo CONPTY_NATIVE_OK"],
        cwd: tmpdir(),
        cols: 80,
        rows: 25,
        env: {},
      },
      async () => undefined,
      (seen) => seen.some((frame) => frame.kind === "x"),
    );
    // The handshake the controller adopts the pane's pid from.
    expect(frames.some((frame) => frame.kind === "pid")).toBe(true);
    // The child's own screen bytes, through the real ConPTY.
    expect(text).toContain("CONPTY_NATIVE_OK");
    // And the exit frame — the gap the wine test found first: a child exiting
    // on its own produced NO exit frame and the pane stayed "running".
    expect(exit).toBeDefined();
  },
  60_000,
);

test.skipIf(!canRun)(
  "a typed line reaches the child, and the kill produces the exit frame",
  async () => {
    // THE input path, which wine could not test and which is exactly where
    // issue #2 (P23, the mute pane) lived. A typed `echo` must come back
    // twice over: once as the terminal's echo of the typed line, once as the
    // command's own output. A bridge whose input side is broken produces
    // neither — the pane sits there looking alive and answering nothing,
    // which is what "mute pane" means. Then the kill control ends the child
    // and the exit frame proves the loop observed it: the third thing wine
    // could not verify.
    const { frames, text, exit } = await drive(
      {
        file: "cmd.exe",
        args: [],
        cwd: tmpdir(),
        cols: 80,
        rows: 25,
        env: {},
      },
      async (send) => {
        await send({ type: "input", data: "echo CONPTY_INPUT_OK\r\n" });
      },
      (seen) => count(seen, "CONPTY_INPUT_OK") >= 2,
    );
    expect(text).toContain("CONPTY_INPUT_OK");
    expect(count(frames, "CONPTY_INPUT_OK")).toBeGreaterThanOrEqual(2);

    // And the kill: a second drive whose script stops the child by protocol.
    const killed = await drive(
      {
        file: "cmd.exe",
        args: [],
        cwd: tmpdir(),
        cols: 80,
        rows: 25,
        env: {},
      },
      async (send) => {
        await send({ type: "kill" });
      },
      (seen) => seen.some((frame) => frame.kind === "x"),
    );
    expect(killed.exit).toBeDefined();
  },
  90_000,
);
