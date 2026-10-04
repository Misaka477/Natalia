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
