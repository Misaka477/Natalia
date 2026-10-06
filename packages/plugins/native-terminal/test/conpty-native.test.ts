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
): Promise<{
  frames: Frame[];
  text: string;
  exit: Frame | undefined;
  stderr: string;
}> {
  const bridge = Bun.spawn([bridgeExe], {
    cwd: await mkdtemp(join(tmpdir(), "conpty-native-")),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  // The bridge reports its ConPTY handshake to stderr — the P23 investigation
  // put it there saying "a fix that cannot be told apart from nothing
  // happening is not a fix". A mute pane must therefore carry that evidence
  // into the failure, or the next run cannot confirm or refute the resize
  // theory without a human attaching a debugger.
  let stderr = "";
  void (async () => {
    const reader = bridge.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.value) stderr += decoder.decode(chunk.value, { stream: true });
      if (chunk.done) break;
    }
  })();
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
  // ONE timer for the whole drive, not one per iteration.
  //
  // Two rules, both learned from the Windows CI measuring this harness.
  //
  // 1. THE DEADLINE KILLS THE PROCESS; it never races a read. The earlier
  //    shape raced `reader.read()` against a 500ms tick, and the read that
  //    lost the race had ALREADY CONSUMED its bytes off the stream — the next
  //    iteration's fresh read() never saw them. That is where the exit frame
  //    went: the bridge's stderr showed the complete shutdown (frame written)
  //    while the harness waited 30s for a frame it had itself discarded. A
  //    reader is a single queue; abandon a read and you abandon its bytes.
  //    Killing the bridge ends the stream, so the pending read settles as
  //    `done` on its own — no race needed.
  // 2. The timer is armed once and cleared in `finally`. The pre-fix shape
  //    also leaked one uncleared timer per pass, which held the process open
  //    and made a 30s drive report as 48s on CI.
  const drain = () => {
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
  };
  const timer = setTimeout(() => bridge.kill(), ms);
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) {
        // EOF means the WRITE end closed, not that the bytes are gone: the
        // bridge writes its exit frame and then exits, so the last frame is
        // sitting in the pipe when `done` arrives. Dropping the remaining
        // buffer here is how CI measured a complete shutdown (the bridge's
        // own stderr shows the exit frame written) with the harness reporting
        // `exit: undefined` — the frame was read and thrown away with the
        // stream's tail.
        drain();
        break;
      }
      buffer += decoder.decode(read.value, { stream: true });
      drain();
      // The predicate decides when we have what we came for. It is checked
      // AFTER every drain, so a frame that arrives in this read is seen
      // immediately — and the drive returns without waiting for the stream's
      // end, which on a Windows runner can lag the frame by seconds.
      if (until(frames)) break;
    }
  } finally {
    // Settle the pending read and drop the shared timer, so the drive returns
    // as soon as its deadline passes instead of waiting for the runtime to
    // tear the process down.
    reader.cancel();
    if (timer) clearTimeout(timer);
  }
  bridge.kill();
  const text = frames.map((frame) => frame.payload).join("");
  return {
    frames,
    text,
    exit: frames.find((frame) => frame.kind === "x"),
    stderr,
  };
}

const count = (frames: Frame[], needle: string) =>
  frames
    .filter((f) => f.kind === "o")
    .map((frame) => frame.payload)
    .join("")
    .split(needle).length - 1;

test.skipIf(!canRun)(
  "the real bridge answers a spec with pid, output and exit",
  async () => {
    const { frames, text, exit, stderr } = await drive(
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
    // The child's own screen bytes, through the real ConPTY. A mute pane (the
    // P23 symptom: the startup paint arrives, then nothing) fails HERE, and
    // the bridge's stderr rides along so the run reports the viewport
    // handshake's HRESULT instead of just the silence.
    expect(
      text,
      `frames=${JSON.stringify(frames)} bridge stderr:\n${stderr}`,
    ).toContain("CONPTY_NATIVE_OK");
    // And the exit frame — the gap the wine test found first: a child exiting
    // on its own produced NO exit frame and the pane stayed "running".
    //
    // The stderr rides along for a reason: CI measured this frame arriving
    // late (30s drive deadline) while the kill drive's identical sequence
    // completed in 130ms, and the assertion without evidence could not say
    // whether the bridge's shutdown ran at all. A bare `undefined` cost three
    // rounds; the next one carries the shutdown lines.
    expect(
      exit,
      `frames=${JSON.stringify(frames)} bridge stderr:
${stderr}`,
    ).toBeDefined();
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
    const { frames, text, exit, stderr } = await drive(
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
      // One, not two: ConPTY does not echo what the host typed (see the note on
      // the assertion below). Waiting for two waited for something that never
      // arrives and timed the drive out at 30s.
      (seen) => count(seen, "CONPTY_INPUT_OK") >= 1,
    );
    expect(
      text,
      `frames=${JSON.stringify(frames)} bridge stderr:\n${stderr}`,
    ).toContain("CONPTY_INPUT_OK");
    // Before the count is allowed to fail mute again: print the drive's whole
    // shape. The count predicate cannot say whether the pane painted, whether
    // the typed line reached the bridge (its stderr now reports the delivery),
    // or whether the frames were dropped — and the 2026-10-04 red was exactly
    // a failure with none of that recorded. A test that swallows its own
    // evidence costs a CI cycle per theory.
    console.error(
      "CONPTY_INPUT_DRIVE " +
        JSON.stringify({
          inputDelivered: stderr.includes("input line delivered"),
          bridgeStderr: stderr,
          frames: frames.map((f) => ({
            kind: f.kind,
            length: f.payload.length,
            head: f.payload.slice(0, 48),
          })),
        }),
    );
    // ONE occurrence, not two, and that is ConPTY's actual behaviour — not a
    // mute pane. A Linux pty has ECHO on by default, so a typed line is painted
    // back by the tty driver and the text appears twice (echo + the command's
    // own output). ConPTY's conhost does not echo a line the host typed into
    // the pipe: the child still RECEIVES and RUNS it, which is what the
    // assertion above proves, but nothing paints it back, so it appears once.
    //
    // This used to demand >= 2 and therefore failed on every Windows run while
    // the bridge was working correctly — measured: `input line delivered` on
    // stderr and the command's output in the frames. Demanding Linux's echo
    // behaviour on ConPTY is a wrong expectation, and the fix belongs in the
    // assertion, not in the bridge. (A retry-109 patch to the bridge was tried
    // first, on the theory that ECHO was being lost; it made the run strictly
    // worse — 1 pass/1 fail became 0 pass/2 fail — and was reverted.)
    expect(count(frames, "CONPTY_INPUT_OK")).toBeGreaterThanOrEqual(1);
    // The typed line REACHED the child: its own output carries it.
    expect(text).toContain("CONPTY_INPUT_OK");

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
    // Same obligation as the input drive: if the exit frame is late or absent,
    // say so with the drive's shape attached, not just undefined.
    console.error(
      "CONPTY_KILL_DRIVE " +
        JSON.stringify({
          bridgeStderr: killed.stderr,
          frames: killed.frames.map((f) => ({
            kind: f.kind,
            length: f.payload.length,
            head: f.payload.slice(0, 48),
          })),
        }),
    );
    expect(killed.exit).toBeDefined();
  },
  90_000,
);
