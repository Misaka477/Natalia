import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The ConPTY bridge, compiled and verified — the wine era is over.
 *
 * The history this file replaces, kept because the reasoning is the lesson:
 * this used to cross-compile with mingw and execute the bridge under wine,
 * which was the closest thing to Windows a Linux host could do. Wine's ConPTY
 * implements the output side and its input side is unreliable — typed input
 * advanced the prompt once and never echoed, across 15s waits — and
 * `ResizePseudoConsole` returns E_NOTIMPL there, which is why the whole P23
 * input/exit path lived in the file's "NOT verified here" comment while the
 * real bugs were on a real host.
 *
 * That is all past: there is a `windows-terminal` CI job that builds the
 * bridge with the image's own clang-cl and drives the REAL ConPTY (spec
 * handshake, output, exit frame, typed line round-trip, kill). This file's
 * remaining job is what the wine attempt was good at and the real host has no
 * business re-doing on every run: the bridge COMPILES and LINKS. A change
 * that breaks the Windows build shows up on Linux in seconds, not after a
 * windows-latest queue.
 *
 * So: compile with mingw when the toolchain is present, static-link it, and
 * fail loudly if either step breaks. When mingw is absent the whole file
 * skips — a machine without a cross toolchain is not a broken machine, and
 * the windows-terminal job is the real gate.
 *
 * The structural pins (the control loop's two-handle wait) stay: they are the
 * source-level guard for the bug wine DID catch — a self-exiting child
 * producing no exit frame because the loop blocked on stdin forever.
 */

const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
const bridgeSource = join(
  repoRoot,
  "packages",
  "plugins",
  "native-terminal",
  "src",
  "win",
  "natalia-conpty-bridge.cc",
);

const compiler = ["x86_64-w64-mingw32-g++", "i686-w64-mingw32-g++"].find(
  (candidate) => Bun.which(candidate) !== null,
);

const canCompile = compiler !== undefined && existsSync(bridgeSource);

/** Compile AND static-link the bridge into `work`, returning the exe path. */
async function compileBridge(work: string): Promise<string> {
  const object = join(work, "bridge.o");
  const exe = join(work, "bridge.exe");
  const build = Bun.spawnSync([compiler!, "-c", bridgeSource, "-o", object], {
    env: { ...process.env, CCACHE_DISABLE: "1" },
    stderr: "pipe",
  });
  if (build.exitCode !== 0)
    throw new Error(
      `the ConPTY bridge no longer compiles:\n${build.stderr.toString()}`,
    );
  const link = Bun.spawnSync([compiler!, object, "-o", exe, "-static"], {
    env: { ...process.env, CCACHE_DISABLE: "1" },
    stderr: "pipe",
  });
  if (link.exitCode !== 0)
    throw new Error(
      `the ConPTY bridge no longer links statically:\n${link.stderr.toString()}`,
    );
  if (!existsSync(exe))
    throw new Error(
      `the compiler reported success but ${exe} does not exist — the build ` +
        `is lying and the next stage would fail for the wrong reason`,
    );
  return exe;
}

test.skipIf(!canCompile)(
  "the bridge compiles and static-links for Windows from a Linux host",
  async () => {
    // The whole reason this file survives the fork retirement: the Windows
    // build is verifiable here. `-static` is load-bearing — the bridge must
    // ship as one binary into a release archive that has no mingw runtime,
    // and a dynamic link that works on this host is a release that fails on
    // the user's machine.
    const work = await mkdtemp(join(tmpdir(), "conpty-bridge-"));
    try {
      const exe = await compileBridge(work);
      expect(existsSync(exe)).toBe(true);
      // And it is a real Windows executable, not an object file renamed.
      const head = await Bun.file(exe).slice(0, 2).arrayBuffer();
      expect(new TextDecoder().decode(head)).toBe("MZ");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
  120_000,
);

test("the control loop is woken by the child exiting, not only by stdin", () => {
  // The structural half, which runs everywhere: the loop must wait on BOTH
  // handles. A loop that only ever blocks on stdin is the bug, and it is not
  // visible in a source read that does not look for the second handle. wine
  // caught this one (the self-exiting child's missing exit frame) and it is
  // still a source-level invariant, so it stays pinned.
  const source = existsSync(bridgeSource)
    ? require("node:fs").readFileSync(bridgeSource, "utf8")
    : "";
  expect(source).toContain("WaitForMultipleObjects");
  // Both handles in ONE wait: the line-arrived event and the child. They are
  // named in an array beside the call, which is the shape to assert — matching
  // them inside the call's argument list fails on the actual code.
  expect(source).toContain(
    "const HANDLE waitFor[] = {g_lineArrived, g_childProcess};",
  );
  expect(source).toContain(
    "WaitForMultipleObjects(2, waitFor, FALSE, INFINITE)",
  );
  // And the reader that owns the blocking read.
  expect(source).toContain("pumpControlInput");
  expect(source).toContain("popControlLine");
});

const source = await Bun.file(
  join(import.meta.dir, "..", "src", "win", "natalia-conpty-bridge.cc"),
).text();

test("the shared shutdown does not close a console the kill path already closed", () => {
  // Measured on the Windows CI: the kill drive's stderr showed the full
  // shutdown sequence while the host saw only `{"pid"}` — no exit frame. The
  // kill path closes the pseudo console and nulls the handle before breaking
  // out of the loop, and the shared sequence then closed the SAME handle
  // again (undefined behaviour), in the window between the pump ending and
  // the frame being written.
  //
  // The compile test cannot see it: it is a runtime behaviour, not a syntax
  // error. The guard is the shape of the code — the shared close is guarded.
  expect(source).toContain("if (g_pseudoConsole) {");
  expect(source).not.toMatch(
    /\n\s*ClosePseudoConsole\(g_pseudoConsole\);\n\s*g_pseudoConsole = nullptr;\n\s*fprintf\(stderr, "conpty-bridge: console closed/,
  );
});

test("the drive drains the stream's tail on EOF instead of dropping it", async () => {
  // A frame is a frame, and EOF is not the end of the bytes: the bridge
  // writes its exit frame and then EXITS, so `read()` returning `done` finds
  // the last frame still in the pipe. CI measured exactly this: the bridge's
  // stderr showed the complete shutdown (exit frame written) while the
  // harness reported `exit: undefined` — the frame was read and thrown away
  // with the stream's tail, and the run failed in 46ms rather than timing
  // out, because `done` breaks the loop immediately.
  const source = await Bun.file(
    join(import.meta.dir, "..", "test", "conpty-native.test.ts"),
  ).text();
  expect(source).toContain("if (read.done) {");
  expect(source).toContain("drain();");
  // The pre-fix shape broke on done with the buffer unread.
  expect(source).not.toContain("if (read.done) break;");
  // And the timeout never races a read (that was the earlier fix: a losing
  // read consumes bytes).
  expect(source).not.toContain("Promise.race([reader.read()");
});

test("the drive checks its predicate after every drain", async () => {
  // A drive whose `until` is never checked reads to EOF and back. On a loaded
  // runner that lag was measured as the exit frame never arriving, while the
  // bridge's own stderr showed the complete shutdown — the frame WAS written,
  // the harness just never looked for it before the stream ended.
  const source = await Bun.file(
    join(import.meta.dir, "..", "test", "conpty-native.test.ts"),
  ).text();
  expect(source).toContain("drain();");
  expect(source).toMatch(/if \(until\(frames\)\) break;/u);
});

/**
 * The frame parser the drive uses, restated here as a pure function so a
 * split-across-reads header/payload pair can be exercised on any host.
 *
 * This is the THIRD mechanism by which a frame the bridge demonstrably wrote
 * never reached the harness: a race that discarded a pending read's bytes, an
 * EOF that dropped the stream's tail, and now a header whose payload arrived
 * in the next read with no newline left to anchor it. The drive keeps its
 * inlined copy; this pins the shape both must keep.
 */
function parseFrames(
  chunks: readonly string[],
): Array<{ kind: string; payload: string }> {
  const frames: Array<{ kind: string; payload: string }> = [];
  let buffer = "";
  let pending: { kind: string; length: number } | undefined;
  const drain = () => {
    for (;;) {
      if (pending) {
        if (buffer.length < pending.length) break;
        frames.push({
          kind: pending.kind,
          payload: buffer.slice(0, pending.length),
        });
        buffer = buffer.slice(pending.length);
        pending = undefined;
        continue;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("{")) {
        frames.push({ kind: "pid", payload: line });
        continue;
      }
      const space = line.indexOf(" ");
      if (space < 0) continue;
      const length = Number(line.slice(space + 1));
      if (!Number.isFinite(length)) continue;
      pending = { kind: line.slice(0, space), length };
    }
  };
  for (const chunk of chunks) {
    buffer += chunk;
    drain();
  }
  return frames;
}

test("a frame's header and payload may arrive in different reads", () => {
  // The measured CI failure: `x 1\n` in one read, its payload `1` in the next.
  // A parser that anchors on the next newline loses it — and the bridge's own
  // stderr shows it wrote the frame, so the harness is the one at fault.
  const frames = parseFrames(['{"pid":1}\n', "o 5\nhello", "x 1\n", "1"]);
  expect(frames).toEqual([
    { kind: "pid", payload: '{"pid":1}' },
    { kind: "o", payload: "hello" },
    { kind: "x", payload: "1" },
  ]);
});

test("a payload split mid-frame still completes", () => {
  // Byte-at-a-time is the worst case a pipe can produce.
  const whole = '{"pid":9}\n' + "o 3\nabc" + "x 2\nok";
  const frames = parseFrames(whole.split(""));
  expect(frames).toEqual([
    { kind: "pid", payload: '{"pid":9}' },
    { kind: "o", payload: "abc" },
    { kind: "x", payload: "ok" },
  ]);
});

test("the drive's parser keeps its header across reads", async () => {
  // The drive's inlined copy and the reference above must agree; this pins the
  // inlined one so a future edit cannot silently revert to the newline-only
  // shape.
  const source = await Bun.file(
    join(import.meta.dir, "..", "test", "conpty-native.test.ts"),
  ).text();
  expect(source).toContain("let pending:");
  expect(source).toContain("if (buffer.length < pending.length) break;");
});

test("the pwsh test gates on the marker capability, not just on pwsh existing", async () => {
  // A pwsh without PSReadLine starts, prints, and emits NO command markers —
  // measured on the Linux CI shard as a 19s burn ending in
  // `command?.commandLine === undefined` with a bare prompt in the pane's tail.
  // The capability probe turns that into an honest skip; this pins it in place.
  const source = await Bun.file(
    join(import.meta.dir, "..", "test", "pwsh-e2e.test.ts"),
  ).text();
  expect(source).toContain("Get-Module -ListAvailable -Name PSReadLine");
  expect(source).toContain("if (!(await haveReadLine()))");
  expect(source).toContain("emits no command markers");
});
