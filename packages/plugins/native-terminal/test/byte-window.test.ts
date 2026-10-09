import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyTerminalController } from "../src/index";
import type { TerminalController } from "@anthelia/runtime-services";

/**
 * The byte window: a pane read addressed in bytes, not lines.
 *
 * The line window is the right default, and it cannot serve two shapes. One
 * huge line — a minified bundle `cat`-ed into a pane — has no bound a line
 * window can give it: `startLine` selects whole lines, and the answer is one
 * 10 MB line regardless of the `maxLines` a caller asked for. And exact resume
 * wants the successor window to start where this one ended, with no arithmetic
 * in between that a wrap or a trim can invalidate.
 *
 * Both windows report BOTH extents (the byte family beside the line family),
 * so a caller never has to guess which one it is holding. The panes here are
 * real: a real bash through the default bridge, content it actually printed,
 * read back through the controller — a hand-fed document would prove only the
 * arithmetic.
 */
type PaneRead = Awaited<ReturnType<TerminalController["read"]>>;

function requireByteExtent(read: PaneRead, what: string) {
  const { startByte, endByte, totalBytes } = read;
  if (startByte === null || endByte === null || totalBytes === null)
    throw new Error(
      `${what}: the pty controller must report a real byte extent`,
    );
  return { startByte, endByte, totalBytes };
}

async function paneIn(root: string, id: string) {
  const controller = createPtyTerminalController({
    workspaceRoot: root,
    publish: () => undefined,
    onPerformance: () => undefined,
    runtimeID: () => "runtime-test",
    userRuntimeHome: () => undefined,
    windowMode: () => "windowless",
  });
  await controller.start({ command: "bash", cwd: root, id });
  // The predicate is AWAITED, and that is load-bearing: an async predicate
  // handed to a sync `!predicate()` check is always truthy — a Promise is an
  // object — so the loop would exit on its first check and the assertions
  // would run before the pane has produced anything. (This exact trap cost a
  // debugging session once already; the helper here is the fix.)
  const waitFor = async (
    predicate: () => boolean | Promise<boolean>,
    ms = 15_000,
  ) => {
    const deadline = Date.now() + ms;
    while (!(await predicate()) && Date.now() < deadline) await Bun.sleep(50);
    return predicate();
  };
  await waitFor(() => controller.lastCommand?.(id)?.atPrompt ?? false);
  return { controller, waitFor };
}

test("one huge line gets a bound no line window can give it", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-bytes-"));
  const { controller, waitFor } = await paneIn(root, "t_huge");
  try {
    // A single line far past any line window's useful bound: 70 KiB of one
    // uninterrupted run. `maxLines: 1` on the LINE window would serve all of
    // it, because it is one line.
    //
    // Streamed, not built as one argv: `$(seq 1 70000)` expands to 70000
    // arguments and a runner with a small ARG_MAX (the CI one, measured) runs
    // the command with none of them — the pane then holds only its prompt and
    // the assertions test nothing. `head -c` through `tr` cannot hit that.
    //
    // And the string is DOUBLE-backslashed (`'\\0'`), which is load-bearing:
    // `tr '\0'` in a TS source is the NUL escape, so the first version of this
    // test wrote a real NUL byte into the pane. The line discipline echoed it
    // as `^@`, bash read a command with a NUL in the middle of its quoted
    // argument and waited at a continuation prompt for the quote to close —
    // the pane echoed the line and never ran it, and the assertion saw a
    // 148-byte document. A shell's input is bytes; every layer the test's
    // string crosses (TS literal, JSON control line, the bridge's parse) has
    // its own escape rules, and only the shell's spelling is the one that
    // matters.
    controller.write(
      "t_huge",
      "head -c 70000 /dev/zero | tr '\\0' 'x'; echo; echo HUGE_DONE\n",
    );
    await waitFor(async () =>
      (await controller.read("t_huge", { maxLines: 200 })).text.includes(
        "HUGE_DONE",
      ),
    );
    const whole = await controller.read("t_huge", { maxLines: 200 });
    const { totalBytes } = requireByteExtent(whole, "the whole document");
    // The document really is bigger than the byte window's default cap, so the
    // assertions below test a bound and not a coincidence.
    expect(totalBytes).toBeGreaterThan(64 * 1024);

    // A byte window bounds it: the served text is the window's size, not the
    // line's.
    const window = await controller.read("t_huge", {
      startByte: 0,
      endByte: 4096,
    });
    const bytes = requireByteExtent(window, "the byte window");
    expect(bytes.startByte).toBe(0);
    expect(bytes.endByte).toBe(4096);
    expect(Buffer.byteLength(window.text, "utf8")).toBe(4096);

    // And the line extent travels with it: the caller can still tell which
    // lines the window covers without re-deriving anything.
    const { startLine, totalLines } = window;
    if (startLine === null || totalLines === null)
      throw new Error("the pty controller must report a real line extent");
    expect(startLine).toBe(0);
    expect(totalLines).toBeGreaterThan(0);
  } finally {
    await controller.close();
  }
}, 40_000);

test("a byte read resumes from its end with no arithmetic between windows", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-bytes-resume-"));
  const { controller, waitFor } = await paneIn(root, "t_resume");
  try {
    controller.write("t_resume", "seq 1 40 | tr '\\n' '-'; echo; echo DONE\n");
    await waitFor(async () =>
      (await controller.read("t_resume", { maxLines: 200 })).text.includes(
        "DONE",
      ),
    );
    const whole = await controller.read("t_resume", { maxLines: 200 });
    const { totalBytes } = requireByteExtent(whole, "the whole document");

    // Walk the document in fixed byte windows, each successor addressed from
    // its predecessor's reported end — the property that makes the walk
    // exact rather than recomputed.
    const first = await controller.read("t_resume", {
      startByte: 0,
      endByte: 1000,
    });
    const firstExtent = requireByteExtent(first, "the first window");
    const second = await controller.read("t_resume", {
      startByte: firstExtent.endByte,
      endByte: firstExtent.endByte + 1000,
    });
    const secondExtent = requireByteExtent(second, "the second window");
    expect(secondExtent.startByte).toBe(firstExtent.endByte);

    // The two windows concatenate to a prefix of the whole document, byte for
    // byte — the join a line-window walk can only approximate at boundaries.
    const document = await controller.read("t_resume", {
      startByte: 0,
      endByte: secondExtent.endByte,
    });
    const joined = first.text + second.text;
    expect(Buffer.byteLength(joined, "utf8")).toBe(
      Buffer.byteLength(document.text, "utf8"),
    );
    expect(joined).toBe(document.text);
    expect(totalBytes).toBeGreaterThanOrEqual(secondExtent.endByte);
  } finally {
    await controller.close();
  }
}, 40_000);

test("the byte window respects the document's bounds and its default cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-bytes-bounds-"));
  const { controller, waitFor } = await paneIn(root, "t_bounds");
  try {
    controller.write("t_bounds", "echo BOUNDS_MARKER\n");
    await waitFor(async () =>
      (await controller.read("t_bounds", { maxLines: 200 })).text.includes(
        "BOUNDS_MARKER",
      ),
    );
    const whole = await controller.read("t_bounds", { maxLines: 200 });
    const { totalBytes } = requireByteExtent(whole, "the whole document");

    // Past the end: the window is empty and says so, rather than throwing or
    // inventing content. The line window's pin is the same shape.
    const past = await controller.read("t_bounds", {
      startByte: totalBytes + 500,
      endByte: totalBytes + 900,
    });
    expect(past.text).toBe("");
    const pastExtent = requireByteExtent(past, "the window past the end");
    expect(pastExtent.startByte).toBe(totalBytes);
    expect(pastExtent.endByte).toBe(totalBytes);

    // An end past the total clamps to the total (the caller learns the real
    // extent from the answer rather than from an error).
    const clamped = await controller.read("t_bounds", {
      startByte: 0,
      endByte: totalBytes + 5000,
    });
    const clampedExtent = requireByteExtent(clamped, "the clamped window");
    expect(clampedExtent.endByte).toBe(totalBytes);

    // A start with no end gets the default cap — this document is smaller than
    // the cap, so it is served whole, which is the cap's contract: bound the
    // answer, never truncate silently below it.
    const defaulted = await controller.read("t_bounds", { startByte: 0 });
    expect(Buffer.byteLength(defaulted.text, "utf8")).toBe(totalBytes);
  } finally {
    await controller.close();
  }
}, 40_000);

test("the two windows agree on where the other one sits", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-bytes-agree-"));
  const { controller, waitFor } = await paneIn(root, "t_agree");
  try {
    controller.write("t_agree", "seq 1 30; echo AGREE_DONE\n");
    await waitFor(async () =>
      (await controller.read("t_agree", { maxLines: 200 })).text.includes(
        "AGREE_DONE",
      ),
    );
    // A line window: its byte extent names the bytes those lines occupy.
    const lines = await controller.read("t_agree", {
      startLine: 2,
      maxLines: 4,
    });
    const lineExtent = requireByteExtent(lines, "the line window");
    const { startLine, endLine, totalLines } = lines;
    if (startLine === null || endLine === null || totalLines === null)
      throw new Error("the pty controller must report a real line extent");
    expect(lineExtent.startByte).toBeGreaterThanOrEqual(0);

    // The byte window over the same span names the same lines: neither family
    // is the source of truth — they are two addresses for one document.
    const bytes = await controller.read("t_agree", {
      startByte: lineExtent.startByte,
      endByte: lineExtent.endByte,
    });
    const { startLine: byteStartLine, endLine: byteEndLine } = bytes;
    if (byteStartLine === null || byteEndLine === null)
      throw new Error("the pty controller must report a real line extent");
    expect(byteStartLine).toBe(startLine);
    expect(byteEndLine).toBe(endLine);
    expect(bytes.text).toBe(lines.text);
  } finally {
    await controller.close();
  }
}, 40_000);

test("a full-speed flood does not starve the keyboard", async () => {
  // The question the throughput number cannot answer. `yes` at full rate is
  // the worst producer a pane can have, and the number that gates human use
  // is not MiB/s but this: while the flood runs, how long does a keystroke's
  // echo take? Measured after the screen-fold fix: 14.5ms. Before the fold
  // fix the same probe would have waited on the fold's backlog.
  //
  // The budget is deliberately loose (20s against a 14.5ms reality) so CI
  // noise cannot flake it; what it catches is the real failure — the echo
  // arriving only after the flood ends, which is what a fold that blocks the
  // input path looks like. 5s had been "loose" and still flaked three times
  // on the runner (a shared CPU running `yes` at full rate is exactly where
  // the echo latency is not the local 14.5ms); 20s keeps the real failure
  // unambiguous — a blocked input path never echoes at all.
  const root = await mkdtemp(join(tmpdir(), "natalia-flood-latency-"));
  const { controller } = await paneIn(root, "t_flood");
  try {
    controller.write("t_flood", "yes FLOODLINE\n");
    await new Promise((r) => setTimeout(r, 400));
    let echoed = false;
    const unsub = controller.subscribeOutput!("t_flood", (chunk) => {
      if (chunk.includes("ECHO_MARKER_XYZ")) echoed = true;
    });
    const started = performance.now();
    controller.write("t_flood", "echo ECHO_MARKER_XYZ\n");
    while (!echoed && performance.now() - started < 20_000) await Bun.sleep(5);
    unsub();
    expect(echoed).toBe(true);
    // Stop the flood so the pane's exit does not wait on `yes`.
    controller.write("t_flood", "\u0003");
  } finally {
    await controller.close();
  }
}, 30_000);
